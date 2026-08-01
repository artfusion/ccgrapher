// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildGraph,
  formatSpec,
  SpecError,
  type EdgeSpec,
  type NodeSpec,
  type WorkflowSpec,
} from "@ccgrapher/core";
import { formatReport, lint } from "@ccgrapher/lint";
import type { HeatData } from "@ccgrapher/trace";

/**
 * The slice of `gh pr list --json` output the builder reads. Extra keys are
 * ignored.
 *
 * `createdAt`, `additions` and `deletions` are optional on purpose: a PR built
 * from an older `--from-json` capture, or from a `gh` version that omitted a
 * field, simply does not have it. `--heat` reads that absence honestly rather
 * than defaulting to a value that would misreport that PR as free or instant.
 */
export interface RetroPr {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly headRefName: string;
  readonly body: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
  readonly createdAt?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface RetroResult {
  readonly spec: WorkflowSpec;
  readonly warnings: readonly string[];
}

/** What `--heat` can tint by. */
export type RetroHeatMetric = "pr-duration-hours" | "pr-size-lines";

const GH_FIELDS = "number,title,mergedAt,headRefName,body,files,createdAt,additions,deletions";
const TICKET = /\b[A-Z]{2,}-\d+\b/g;
const LABEL_TITLE_LIMIT = 50;
const RETRO_HEAT_METRICS: readonly RetroHeatMetric[] = ["pr-duration-hours", "pr-size-lines"];
const RETRO_HEAT_UNIT: Readonly<Record<RetroHeatMetric, string>> = {
  "pr-duration-hours": "hours",
  "pr-size-lines": "lines",
};

/**
 * Rebuilds the as-merged workflow from a repo's PR history: one worker per
 * merged PR, a chain edge per consecutive merge. The chain is the claim under
 * audit — it carries nothing unless two PRs actually touched the same file, in
 * which case the shared paths become the carried fields. Everything the linter
 * then drops had no detectable dependency; that is not the same claim as
 * "independent", and the docs are careful about the difference.
 */
export function buildRetroSpec(prs: readonly RetroPr[], repo: string): RetroResult {
  if (prs.length === 0) {
    throw new SpecError(`retro: ${repo} has no merged PRs — nothing to rebuild`);
  }

  // gh returns newest-first; the graph wants merge order.
  const ordered = [...prs].sort(
    (a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number,
  );
  const warnings: string[] = [];

  const nodes: NodeSpec[] = ordered.map((pr) => {
    const ids = ticketIds(pr);
    if (pr.files.length === 0) warnings.push(`PR #${pr.number} has no changed files`);
    if (ids.length === 0) warnings.push(`PR #${pr.number}: no ticket reference found`);
    return {
      id: `pr_${pr.number}`,
      label: labelFor(pr, ids),
      kind: "worker",
      in: {},
      out: {},
      writes: pr.files.map((f) => f.path),
    };
  });

  const edges: EdgeSpec[] = [];
  const chain = new Map<string, EdgeSpec>();
  for (let i = 0; i < ordered.length - 1; i++) {
    const edge: EdgeSpec = { from: nodes[i]!.id, to: nodes[i + 1]!.id, carries: [] };
    chain.set(`${edge.from}->${edge.to}`, edge);
    edges.push(edge);
  }

  // Evidence: for every file, the most recent earlier PR that also changed it.
  const lastToucher = new Map<string, number>();
  const shared = new Map<string, string[]>(); // "sourceIdx->targetIdx" -> paths
  ordered.forEach((pr, index) => {
    for (const file of pr.files) {
      const source = lastToucher.get(file.path);
      if (source !== undefined && source !== index) {
        const key = `${source}->${index}`;
        shared.set(key, [...(shared.get(key) ?? []), file.path]);
      }
      lastToucher.set(file.path, index);
    }
  });

  // Field tokens must be stable on both sides of an edge, so ownership is
  // tracked per map: an existing token is reused for the same path and stepped
  // past for a different one.
  const outPaths = new Map<string, Map<string, string>>();
  const inPaths = new Map<string, Map<string, string>>();
  const owned = (store: Map<string, Map<string, string>>, id: string) => {
    const map = store.get(id) ?? new Map<string, string>();
    store.set(id, map);
    return map;
  };

  for (const [key, paths] of shared) {
    const [sourceIndex, targetIndex] = key.split("->").map(Number) as [number, number];
    const source = nodes[sourceIndex]!;
    const target = nodes[targetIndex]!;
    const sourceOut = owned(outPaths, source.id);
    const targetIn = owned(inPaths, target.id);

    const carries: string[] = [];
    for (const path of paths) {
      const field = fieldToken(path, sourceOut, targetIn);
      sourceOut.set(field, path);
      targetIn.set(field, path);
      (source.out as Record<string, string>)[field] = "file";
      (target.in as Record<string, string>)[field] = "file";
      carries.push(field);
    }

    // The evidence partner may be the merge-order predecessor; upgrade that
    // edge rather than laying a second one alongside it.
    const existing = chain.get(`${source.id}->${target.id}`);
    if (existing) {
      (existing.carries as string[]).push(...carries);
    } else {
      edges.push({ from: source.id, to: target.id, carries });
    }
  }

  const spec: WorkflowSpec = {
    version: 1,
    name: repo,
    goal: `last ${ordered.length} merged PRs, as merged`,
    nodes,
    edges,
  };

  return { spec, warnings };
}

/**
 * `pr-duration-hours` is wall time from `createdAt` to `mergedAt`; `pr-size-lines`
 * is `additions + deletions`. Either metric returns `undefined` — never `0` —
 * when the PR is missing a field it needs, or when a timestamp does not parse.
 */
function retroHeatValue(pr: RetroPr, metric: RetroHeatMetric): number | undefined {
  switch (metric) {
    case "pr-duration-hours": {
      if (pr.createdAt === undefined) return undefined;
      const created = Date.parse(pr.createdAt);
      const merged = Date.parse(pr.mergedAt);
      if (Number.isNaN(created) || Number.isNaN(merged)) return undefined;
      return (merged - created) / (60 * 60 * 1000);
    }
    case "pr-size-lines":
      return pr.additions === undefined || pr.deletions === undefined
        ? undefined
        : pr.additions + pr.deletions;
  }
}

/**
 * A `HeatData` file keyed by the same `pr_<number>` node ids `buildRetroSpec`
 * gives the as-merged graph, so a heatmap tints the same nodes the picture
 * already has without anyone re-deriving the id scheme.
 *
 * A PR missing what the metric needs gets no entry — never a `0`. A `0` here
 * would read as "this PR took no time" or "this PR touched no lines", which is
 * a confident lie a heatmap would happily draw in cool blue.
 */
export function buildRetroHeat(
  prs: readonly RetroPr[],
  metric: RetroHeatMetric,
  source: string,
): HeatData {
  const values: Record<string, number> = {};
  for (const pr of prs) {
    const value = retroHeatValue(pr, metric);
    if (value !== undefined) values[`pr_${pr.number}`] = value;
  }
  return { v: 1, metric, unit: RETRO_HEAT_UNIT[metric], source, values };
}

/** Ticket IDs from the title, then the branch name; the body only as a last resort. */
function ticketIds(pr: RetroPr): string[] {
  const ids = new Set<string>(pr.title.match(TICKET) ?? []);
  for (const match of pr.headRefName.matchAll(/\b([a-z]{2,}-\d+)\b/g)) {
    ids.add(match[1]!.toUpperCase());
  }
  if (ids.size === 0) {
    // Bodies co-cite other PRs' tickets, so only the first is safe to take.
    const fallback = pr.body.match(TICKET);
    if (fallback) ids.add(fallback[0]);
  }
  return [...ids];
}

function labelFor(pr: RetroPr, ids: string[]): string {
  // The IDs lead the label, so the title's own copies just add noise.
  const title = pr.title
    .replace(TICKET, "")
    .replace(/\(\s*[/+,&\s]*\)/g, "")
    .replace(/^[\s:—+&/-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const truncated =
    title.length > LABEL_TITLE_LIMIT
      ? `${title.slice(0, LABEL_TITLE_LIMIT).replace(/\s+\S*$/, "")}…`
      : title;
  return [ids.join(" "), truncated].filter(Boolean).join(" ") || `PR #${pr.number}`;
}

/**
 * A carried field named after the shared file: the basename where that is
 * unambiguous, the full path where it is not.
 */
function fieldToken(
  path: string,
  sourceOut: ReadonlyMap<string, string>,
  targetIn: ReadonlyMap<string, string>,
): string {
  const sanitize = (text: string) => {
    const token = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return /^\d/.test(token) ? `f_${token}` : token;
  };

  const base = sanitize(path.split("/").at(-1) ?? path);
  const candidates = [base, sanitize(path)];
  for (let i = 2; ; i++) {
    for (const candidate of candidates) {
      const takenFor = sourceOut.get(candidate) ?? targetIn.get(candidate);
      if (takenFor === undefined || takenFor === path) return candidate;
    }
    candidates.splice(0, candidates.length, `${sanitize(path)}_${i}`);
  }
}

function fetchMergedPrs(repo: string, limit: number): unknown {
  try {
    const stdout = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json", GH_FIELDS],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (cause) {
    // Without this, gh-not-installed would surface as index.ts's generic
    // "ccg: no such file", which points at entirely the wrong problem.
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new SpecError("ccg retro: gh not found — install the GitHub CLI or pass --from-json");
    }
    const stderr = (cause as { stderr?: string }).stderr?.toString().trim();
    throw new SpecError(stderr ? `ccg retro: gh failed — ${stderr}` : "ccg retro: gh failed");
  }
}

/** Hand-rolled on purpose: zod is core's dependency, not the CLI's. */
function validatePrs(raw: unknown, origin: string): RetroPr[] {
  if (!Array.isArray(raw)) {
    throw new SpecError(`ccg retro: ${origin} is not a JSON array of pull requests`);
  }
  return raw.map((item, index) => {
    const pr = item as Record<string, unknown>;
    const fail = (what: string): never => {
      throw new SpecError(`ccg retro: ${origin}[${index}] has no usable ${what}`);
    };
    if (typeof pr.number !== "number") fail("number");
    if (typeof pr.title !== "string") fail("title");
    if (typeof pr.mergedAt !== "string") fail("mergedAt");
    const files = Array.isArray(pr.files) ? pr.files : [];
    return {
      number: pr.number as number,
      title: pr.title as string,
      mergedAt: pr.mergedAt as string,
      headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
      body: typeof pr.body === "string" ? pr.body : "",
      files: files.map((file, fileIndex) => {
        const path = (file as Record<string, unknown>).path;
        if (typeof path !== "string") {
          throw new SpecError(`ccg retro: ${origin}[${index}].files[${fileIndex}] has no path`);
        }
        return { path };
      }),
      // Absent or wrong-typed stays undefined rather than becoming "" or 0 —
      // --heat depends on being able to tell "unknown" from "measured zero".
      createdAt: typeof pr.createdAt === "string" ? pr.createdAt : undefined,
      additions: typeof pr.additions === "number" ? pr.additions : undefined,
      deletions: typeof pr.deletions === "number" ? pr.deletions : undefined,
    };
  });
}

export function retroCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      limit: { type: "string", default: "15" },
      out: { type: "string", short: "o" },
      /** Lint the as-merged graph straight away. */
      lint: { type: "boolean", default: false },
      "from-json": { type: "string" },
      color: { type: "boolean", default: process.stdout.isTTY ?? false },
      /** Write a HeatData overlay here instead of (or alongside) the spec. */
      heat: { type: "string" },
      metric: { type: "string", default: "pr-duration-hours" satisfies RetroHeatMetric },
    },
    allowPositionals: true,
    // Node's parseArgs needs this for `--no-color` and friends.
    allowNegative: true,
  });

  const repo = positionals[0];
  if (!repo) {
    process.stderr.write("ccg retro: no repository given (owner/repo)\n");
    return 2;
  }

  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    process.stderr.write("ccg retro: --limit must be a whole number from 1 to 50\n");
    return 2;
  }

  if (!(RETRO_HEAT_METRICS as readonly string[]).includes(values.metric)) {
    process.stderr.write(
      `ccg retro: --metric must be one of ${RETRO_HEAT_METRICS.join(", ")}\n`,
    );
    return 2;
  }
  const metric = values.metric as RetroHeatMetric;

  let raw: unknown;
  if (values["from-json"]) {
    try {
      raw = JSON.parse(readFileSync(values["from-json"], "utf8"));
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        process.stderr.write(`ccg retro: ${values["from-json"]} is not valid JSON\n`);
        return 2;
      }
      throw cause;
    }
  } else {
    raw = fetchMergedPrs(repo, limit);
  }

  const prs = validatePrs(raw, values["from-json"] ?? repo);
  const { spec, warnings } = buildRetroSpec(prs, repo);

  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  const evidence = spec.edges.filter((edge) => edge.carries.length > 0).length;
  process.stderr.write(`${repo}: ${spec.nodes.length} merged PRs, ${evidence} evidence edge(s)\n`);

  if (values.heat) {
    const heat = buildRetroHeat(prs, metric, `ccg retro ${repo}`);
    writeFileSync(values.heat, `${JSON.stringify(heat, null, 2)}\n`, "utf8");
    const measured = Object.keys(heat.values).length;
    process.stderr.write(
      `wrote ${values.heat} — ${metric} for ${measured} of ${prs.length} PR(s)\n`,
    );
  }

  const yaml = formatSpec(spec);
  if (values.out) {
    writeFileSync(values.out, yaml, "utf8");
    process.stderr.write(
      `wrote ${values.out} — ${spec.nodes.length} nodes, ${spec.edges.length} edges\n`,
    );
  } else if (!values.lint) {
    process.stdout.write(yaml);
  }

  if (values.lint) {
    // The whole point of rebuilding history: audit what actually happened.
    const graph = buildGraph(spec);
    const result = lint(graph);
    process.stdout.write(`${formatReport(graph, result, { color: values.color })}\n`);
    return result.findings.some((f) => f.severity === "error") ? 1 : 0;
  }

  return 0;
}
