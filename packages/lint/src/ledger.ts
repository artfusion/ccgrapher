// SPDX-License-Identifier: Apache-2.0
import {
  effectiveInboundCount,
  rankGraph,
  type EdgeSpec,
  type Graph,
  type NodeSpec,
} from "@ccgrapher/core";
import { lint } from "./lint.js";
import type { Finding, RuleId } from "./types.js";

/**
 * What changed between two specs, in words: the ledger that goes beside a
 * before and an after picture.
 *
 * It lives here rather than in core because a change in the findings is part
 * of it, and the findings are this package's. It reads the two graphs and
 * nothing else, so the same pair always gives the same ledger.
 *
 * Steps are matched by id. A renamed step is a step removed and a step added:
 * nothing in a spec says two ids are the same step, and guessing would be
 * wrong more quietly than saying so.
 */
export interface Ledger {
  readonly before: LedgerTotals;
  readonly after: LedgerTotals;
  readonly steps: {
    readonly added: readonly LedgerStep[];
    readonly removed: readonly LedgerStep[];
  };
  /** Added, then removed, then repointed, then re-carried; each in spec order. */
  readonly edges: readonly EdgeChange[];
  /** Count guards (`expects`), in spec order. */
  readonly guards: readonly GuardChange[];
  /** Declarations of a step that is in both specs, in spec order, then `FIELDS` order. */
  readonly fields: readonly FieldChange[];
  readonly waves: {
    /** Steps in both specs whose wave changed, in the after spec's order. */
    readonly moved: readonly WaveMove[];
    /** Steps in both specs whose wave did not, in the after spec's order. */
    readonly unchanged: readonly string[];
  };
  /** Findings on each spec as written, matched by rule, nodes and edge. */
  readonly findings: {
    readonly resolved: readonly LedgerFinding[];
    readonly introduced: readonly LedgerFinding[];
  };
  /** How many changes the ledger records. Zero for two specs that say the same thing. */
  readonly changes: number;
}

export interface LedgerTotals {
  readonly name: string;
  readonly steps: number;
  readonly edges: number;
  /** The critical path in waves: the number `ccg lint` reports as layers. */
  readonly waves: number;
  /** The most steps that share one wave. */
  readonly widest: number;
}

export interface LedgerStep {
  readonly id: string;
  readonly label: string;
  /** Counted from 1, in the spec the step is in. */
  readonly wave: number;
}

export type EdgeChange =
  | { readonly change: "added" | "removed"; readonly from: string; readonly to: string; readonly carries: readonly string[] }
  | {
      /** An edge into the same step now comes from somewhere else. */
      readonly change: "repointed";
      readonly from: string;
      readonly to: string;
      readonly carries: readonly string[];
      readonly newFrom: string;
      readonly newCarries: readonly string[];
    }
  | {
      /** Same two steps, different fields carried. */
      readonly change: "carries";
      readonly from: string;
      readonly to: string;
      readonly carries: readonly string[];
      readonly newCarries: readonly string[];
    };

export interface GuardChange {
  readonly id: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: number;
  readonly after?: number;
  /** How many results reach the step, in the spec that has the guard last. */
  readonly arriving: number;
}

/** The declarations compared on a step present in both specs. `expects` is a guard, not a field. */
export const LEDGER_FIELDS = [
  "label",
  "kind",
  "model",
  "in",
  "out",
  "fanOut",
  "writes",
  "uses",
  "effects",
  "guards",
  "freshContext",
  "worktree",
  "priority",
  "prioritySetBy",
  "boundary",
] as const;
export type LedgerField = (typeof LEDGER_FIELDS)[number];

export interface FieldChange {
  readonly id: string;
  readonly field: LedgerField;
  /** The value as the spec has it; absent when the spec leaves the field out. */
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface WaveMove {
  readonly id: string;
  readonly before: number;
  readonly after: number;
  /** After minus before: negative is earlier. */
  readonly moved: number;
}

export interface LedgerFinding {
  readonly rule: RuleId;
  readonly nodes: readonly string[];
  readonly edge?: { readonly from: string; readonly to: string };
  readonly message: string;
}

export function changeLedger(before: Graph, after: Graph): Ledger {
  const rankBefore = rankGraph(before);
  const rankAfter = rankGraph(after);
  const waveOf = (ranking: typeof rankBefore, id: string) => ranking.rank.get(id)! + 1;

  const added = after.spec.nodes
    .filter((n) => !before.nodes.has(n.id))
    .map((n) => ({ id: n.id, label: n.label, wave: waveOf(rankAfter, n.id) }));
  const removed = before.spec.nodes
    .filter((n) => !after.nodes.has(n.id))
    .map((n) => ({ id: n.id, label: n.label, wave: waveOf(rankBefore, n.id) }));

  const shared = after.spec.nodes.filter((n) => before.nodes.has(n.id));
  const moved: WaveMove[] = [];
  const unchanged: string[] = [];
  for (const node of shared) {
    const was = waveOf(rankBefore, node.id);
    const now = waveOf(rankAfter, node.id);
    if (was === now) unchanged.push(node.id);
    else moved.push({ id: node.id, before: was, after: now, moved: now - was });
  }

  const edges = edgeChanges(before.edges, after.edges);
  const guards = guardChanges(before, after);
  const fields = shared.flatMap((node) => fieldChanges(before, after, before.nodes.get(node.id)!, node));
  const findings = findingChanges(before, after);

  return {
    before: totals(before, rankBefore.layers),
    after: totals(after, rankAfter.layers),
    steps: { added, removed },
    edges,
    guards,
    fields,
    waves: { moved, unchanged },
    findings,
    changes:
      added.length +
      removed.length +
      edges.length +
      guards.length +
      fields.length +
      moved.length +
      findings.resolved.length +
      findings.introduced.length,
  };
}

function totals(graph: Graph, layers: readonly (readonly string[])[]): LedgerTotals {
  return {
    name: graph.spec.name,
    steps: graph.nodes.size,
    edges: graph.edges.length,
    waves: layers.length,
    widest: Math.max(0, ...layers.map((layer) => layer.length)),
  };
}

/**
 * Edges between the same two steps are the same edge. What is left is paired
 * by the step it goes into: first where the fields carried agree, then in spec
 * order. A pair is a repoint, which is what `--fix` does to a fake edge; the
 * rest were added or removed.
 */
function edgeChanges(before: readonly EdgeSpec[], after: readonly EdgeSpec[]): EdgeChange[] {
  const key = (e: EdgeSpec) => `${e.from}\u0000${e.to}`;
  const unmatched = new Map<string, number[]>();
  after.forEach((edge, i) => {
    const list = unmatched.get(key(edge)) ?? [];
    list.push(i);
    unmatched.set(key(edge), list);
  });

  const recarried: { at: number; change: EdgeChange }[] = [];
  const gone: EdgeSpec[] = [];
  for (const edge of before) {
    const i = unmatched.get(key(edge))?.shift();
    if (i === undefined) {
      gone.push(edge);
      continue;
    }
    const now = after[i]!;
    if (!sameSet(edge.carries, now.carries)) {
      recarried.push({
        at: i,
        change: { change: "carries", from: edge.from, to: edge.to, carries: [...edge.carries], newCarries: [...now.carries] },
      });
    }
  }
  const fresh = [...unmatched.values()].flat().sort((a, b) => a - b);

  const repointed = new Map<EdgeSpec, number>();
  const taken = new Set<number>();
  for (const exact of [true, false]) {
    for (const edge of gone) {
      if (repointed.has(edge)) continue;
      const i = fresh.find(
        (j) => !taken.has(j) && after[j]!.to === edge.to && (!exact || sameSet(after[j]!.carries, edge.carries)),
      );
      if (i === undefined) continue;
      repointed.set(edge, i);
      taken.add(i);
    }
  }

  return [
    ...fresh
      .filter((i) => !taken.has(i))
      .map((i): EdgeChange => ({ change: "added", from: after[i]!.from, to: after[i]!.to, carries: [...after[i]!.carries] })),
    ...gone
      .filter((e) => !repointed.has(e))
      .map((e): EdgeChange => ({ change: "removed", from: e.from, to: e.to, carries: [...e.carries] })),
    ...gone
      .filter((e) => repointed.has(e))
      .map((e): EdgeChange => {
        const now = after[repointed.get(e)!]!;
        return { change: "repointed", from: e.from, to: e.to, carries: [...e.carries], newFrom: now.from, newCarries: [...now.carries] };
      }),
    ...recarried.sort((a, b) => a.at - b.at).map((r) => r.change),
  ];
}

function guardChanges(before: Graph, after: Graph): GuardChange[] {
  const out: GuardChange[] = [];
  for (const id of unionIds(before, after)) {
    const was = before.nodes.get(id)?.expects;
    const now = after.nodes.get(id)?.expects;
    if (was === now) continue;
    if (now === undefined) {
      out.push({ id, change: "removed", before: was!, arriving: effectiveInboundCount(before, id) });
    } else {
      out.push({
        id,
        change: was === undefined ? "added" : "changed",
        ...(was !== undefined && { before: was }),
        after: now,
        arriving: effectiveInboundCount(after, id),
      });
    }
  }
  return out;
}

function fieldChanges(before: Graph, after: Graph, was: NodeSpec, now: NodeSpec): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of LEDGER_FIELDS) {
    const a = field === "boundary" ? boundaryOf(before, was.id) : was[field];
    const b = field === "boundary" ? boundaryOf(after, now.id) : now[field];
    // Lists are compared as sets: `writes: [a, b]` and `[b, a]` declare the same thing.
    if (canonical(asSet(a)) === canonical(asSet(b))) continue;
    out.push({ id: now.id, field, ...(a !== undefined && { before: a }), ...(b !== undefined && { after: b }) });
  }
  return out;
}

const asSet = (value: unknown) => (Array.isArray(value) ? [...(value as string[])].sort() : value);

function boundaryOf(graph: Graph, id: string): string | undefined {
  return graph.spec.boundaries?.find((b) => b.members.includes(id))?.id;
}

/**
 * Findings on each spec as written: the raw pass only. The repaired pass
 * describes a graph neither spec draws.
 */
function findingChanges(before: Graph, after: Graph): Ledger["findings"] {
  const raw = (graph: Graph) => lint(graph).findings.filter((f) => f.phase === "raw");
  const was = raw(before);
  const now = raw(after);
  return { resolved: unmatchedFindings(was, now), introduced: unmatchedFindings(now, was) };
}

/** Findings in `from` with no counterpart in `against`, counted, so two alike are two. */
function unmatchedFindings(from: readonly Finding[], against: readonly Finding[]): LedgerFinding[] {
  const key = (f: Finding) => `${f.rule}|${[...f.nodes].sort().join(",")}|${f.edge ? `${f.edge.from}->${f.edge.to}` : ""}`;
  const left = new Map<string, number>();
  for (const f of against) left.set(key(f), (left.get(key(f)) ?? 0) + 1);
  const out: LedgerFinding[] = [];
  for (const f of from) {
    const n = left.get(key(f)) ?? 0;
    if (n > 0) {
      left.set(key(f), n - 1);
      continue;
    }
    out.push({ rule: f.rule, nodes: [...f.nodes], ...(f.edge && { edge: { ...f.edge } }), message: f.message });
  }
  return out;
}

/** Ids in the after spec's order, then any only the before spec has. */
function unionIds(before: Graph, after: Graph): string[] {
  return [...after.spec.nodes.map((n) => n.id), ...before.spec.nodes.map((n) => n.id).filter((id) => !after.nodes.has(id))];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return canonical([...a].sort()) === canonical([...b].sort());
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal. Arrays keep their order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  ) ?? "undefined";
}

/** One heading and its lines: the ledger as text, a caption file or an HTML block reads it. */
export interface LedgerSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * The ledger in words, section by section: the totals first, then each kind of
 * change with one line per change. Two specs that say the same thing give one
 * section, "no changes".
 */
export function ledgerSections(ledger: Ledger): LedgerSection[] {
  const { before: b, after: a } = ledger;
  const sections: LedgerSection[] = [
    {
      heading: b.name === a.name ? b.name : `${b.name} to ${a.name}`,
      lines: [
        `${span(b.waves, a.waves, "wave")}, widest wave ${span(b.widest, a.widest, "step")}`,
        `${span(b.steps, a.steps, "step")}, ${span(b.edges, a.edges, "edge")}`,
      ],
    },
  ];
  if (ledger.changes === 0) {
    sections.push({ heading: "no changes", lines: [] });
    return sections;
  }

  const add = (count: number, noun: string, verb: string, lines: string[]) => {
    if (count > 0) sections.push({ heading: `${plural(count, noun)} ${verb}`, lines });
  };

  add(ledger.steps.added.length, "step", "added", ledger.steps.added.map((s) => `${s.id} (${s.label}), wave ${s.wave}`));
  add(ledger.steps.removed.length, "step", "removed", ledger.steps.removed.map((s) => `${s.id} (${s.label}), was wave ${s.wave}`));

  for (const kind of ["added", "removed", "repointed", "carries"] as const) {
    const these = ledger.edges.filter((e) => e.change === kind);
    add(these.length, "edge", kind === "carries" ? "carrying something else" : kind, these.map(edgeLine));
  }

  for (const kind of ["added", "changed", "removed"] as const) {
    const these = ledger.guards.filter((g) => g.change === kind);
    const fanIns = these.length > 1 && these.every((g) => g.arriving > 1) ? " on the fan-ins" : "";
    add(these.length, "count guard", `${kind}${fanIns}`, these.map(guardLine));
  }

  const changedSteps = new Set(ledger.fields.map((f) => f.id)).size;
  add(changedSteps, "step", "redeclared", ledger.fields.map(fieldLine));

  add(
    ledger.waves.moved.length,
    "step",
    "moved",
    ledger.waves.moved.map(
      (m) => `${m.id} from wave ${m.before} to wave ${m.after} (${plural(Math.abs(m.moved), "wave")} ${m.moved < 0 ? "earlier" : "later"})`,
    ),
  );

  add(ledger.findings.resolved.length, "finding", "resolved", ledger.findings.resolved.map(findingLine));
  add(ledger.findings.introduced.length, "finding", "introduced", ledger.findings.introduced.map(findingLine));
  return sections;
}

/** The ledger as plain text: a heading per section, its lines indented under it. */
export function formatLedger(ledger: Ledger): string {
  return ledgerSections(ledger)
    .map((s) => [s.heading, ...s.lines.map((line) => `  ${line}`)].join("\n"))
    .join("\n");
}

function edgeLine(e: EdgeChange): string {
  switch (e.change) {
    case "added":
    case "removed":
      return `${e.from} -> ${e.to}${e.carries.length > 0 ? `, carrying ${e.carries.join(", ")}` : ", carrying nothing"}`;
    case "repointed":
      return `${e.from} -> ${e.to} becomes ${e.newFrom} -> ${e.to}${e.newCarries.length > 0 ? `, carrying ${e.newCarries.join(", ")}` : ""}`;
    case "carries":
      return `${e.from} -> ${e.to} carries ${carried(e.newCarries)} (was ${carried(e.carries)})`;
  }
}

const carried = (fields: readonly string[]) => (fields.length > 0 ? fields.join(", ") : "nothing");

function guardLine(g: GuardChange): string {
  const arrive = `${g.arriving} arrive${g.arriving === 1 ? "s" : ""}`;
  switch (g.change) {
    case "added":
      return `${g.id} expects ${g.after} (${arrive})`;
    case "changed":
      return `${g.id} expects ${g.before} to ${g.after} (${arrive})`;
    case "removed":
      return `${g.id} no longer expects ${g.before} (${arrive})`;
  }
}

function fieldLine(f: FieldChange): string {
  const { id, field, before, after } = f;
  if (field === "in" || field === "out") {
    const was = (before ?? {}) as Record<string, string>;
    const now = (after ?? {}) as Record<string, string>;
    const parts = [
      ...names(Object.keys(now).filter((k) => !(k in was)), "gains"),
      ...names(Object.keys(was).filter((k) => !(k in now)), "loses"),
      ...Object.keys(now)
        .filter((k) => k in was && was[k] !== now[k])
        .map((k) => `${k} is now ${now[k]} (was ${was[k]})`),
    ];
    return `${id}: ${field} ${parts.join("; ")}`;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const was = (before ?? []) as string[];
    const now = (after ?? []) as string[];
    const parts = [...names(now.filter((x) => !was.includes(x)), "gains"), ...names(was.filter((x) => !now.includes(x)), "loses")];
    return `${id}: ${field} ${parts.join("; ")}`;
  }
  if (field === "boundary") {
    if (before === undefined) return `${id}: joins boundary ${String(after)}`;
    if (after === undefined) return `${id}: leaves boundary ${String(before)}`;
    return `${id}: moves from boundary ${String(before)} to ${String(after)}`;
  }
  return `${id}: ${field} ${show(field, before)} to ${show(field, after)}`;
}

function names(list: readonly string[], verb: string): string[] {
  return list.length > 0 ? [`${verb} ${list.join(", ")}`] : [];
}

function show(field: LedgerField, value: unknown): string {
  if (value === undefined) return "unset";
  if (field === "model" && value === null) return "code";
  if (field === "fanOut") {
    const f = value as { over: string; cap?: number };
    return f.cap === undefined ? `one per ${f.over}` : `one per ${f.over} up to ${f.cap}`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function findingLine(f: LedgerFinding): string {
  return `${f.rule} ${f.edge ? `${f.edge.from} -> ${f.edge.to}` : f.nodes.join(", ")}`;
}

function span(before: number, after: number, noun: string): string {
  return before === after ? plural(before, noun) : `${before} to ${plural(after, noun)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
