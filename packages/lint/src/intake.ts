// SPDX-License-Identifier: Apache-2.0
import {
  buildGraph,
  NodeSpec,
  rankGraph,
  SpecError,
  type EdgeSpec,
  type Graph,
  type WorkflowSpec,
} from "@ccgrapher/core";
import { lint } from "./lint.js";
import type { Finding } from "./types.js";

/**
 * Admitting a new step into a spec that already exists, possibly while it runs.
 *
 * A candidate arrives as a node and nothing else: a label, a kind, and honest
 * `in`/`out`. Its edges are never drafted. They are read off the declarations,
 * the same way every other edge in this project is supposed to be: a field the
 * candidate takes comes from the steps that give it, and a field it gives goes
 * to a step that takes it and has nothing supplying it yet. So where the step
 * lands is a consequence of what it reads and writes, which is the whole
 * point, and the placement can be explained in one sentence.
 *
 * Shared by `ccg serve`'s drafting endpoint, which checks each candidate
 * before anyone sees it, and by the canvas, which checks it again against the
 * spec and the run as they are at the moment it is accepted.
 */

/** A step that has started is a fact. Its id is what the trace says ran. */
export type Started = ReadonlySet<string>;

export interface Placement {
  /** Counted from 1, as `ccg plan` counts. */
  readonly wave: number;
  /** One sentence: where it went and why. */
  readonly sentence: string;
}

export interface CandidateCheck {
  /** The edges the candidate's declarations imply, inbound and outbound. */
  readonly edges: readonly EdgeSpec[];
  /** The spec with the candidate and its edges added. Absent when it was refused. */
  readonly spec?: WorkflowSpec;
  readonly placement?: Placement;
  /** Lint findings that name the candidate, against the spec it would join. */
  readonly findings: readonly Finding[];
  /** Why it cannot be placed at all. Present means nothing may be written. */
  readonly refusal?: string;
}

/**
 * The edges a new node's declarations imply.
 *
 * Inbound: one edge from each step that gives a field the node takes,
 * carrying those fields. Outbound: one edge to each step that takes a field
 * the node gives, but only for fields no edge already brings that step. A
 * field that is already supplied stays supplied by what supplies it; a new
 * step does not quietly take over someone else's input.
 */
export function deriveEdges(spec: WorkflowSpec, node: NodeSpec): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  const takes = Object.keys(node.in);
  const gives = new Set(Object.keys(node.out));

  for (const other of spec.nodes) {
    if (other.id === node.id) continue;
    const carries = takes.filter((field) => field in other.out);
    if (carries.length > 0) edges.push({ from: other.id, to: node.id, carries });
  }

  for (const other of spec.nodes) {
    if (other.id === node.id) continue;
    const supplied = new Set(spec.edges.filter((e) => e.to === other.id).flatMap((e) => e.carries));
    const carries = Object.keys(other.in).filter((field) => gives.has(field) && !supplied.has(field));
    if (carries.length > 0) edges.push({ from: node.id, to: other.id, carries });
  }

  return edges;
}

/** The spec with the node and the edges its declarations imply. */
export function placeCandidate(
  spec: WorkflowSpec,
  node: NodeSpec,
): { spec: WorkflowSpec; edges: EdgeSpec[] } {
  const edges = deriveEdges(spec, node);
  return { spec: { ...spec, nodes: [...spec.nodes, node], edges: [...spec.edges, ...edges] }, edges };
}

/**
 * Why a candidate would disturb work that has already started, or undefined.
 *
 * A step that has started (or finished) keeps the inputs it started with. A
 * candidate may read what such a step gives, and may run beside it, but it may
 * not become one of its inputs: that would rewrite the past of a step that is
 * already running on what it had.
 */
export function startedConflict(
  spec: WorkflowSpec,
  edges: readonly EdgeSpec[],
  started: Started,
): string | undefined {
  const into = edges.filter((e) => started.has(e.to));
  if (into.length === 0) return undefined;
  const labels = new Map(spec.nodes.map((n) => [n.id, n.label]));
  const parts = into.map((e) => `${quote(labels.get(e.to) ?? e.to)} (${e.carries.join(", ")})`);
  return (
    `it would hand ${joinAnd(parts)} a new input, and ${into.length === 1 ? "that step has" : "those steps have"} ` +
    `already started. Work that has started is never rewired; take the field out of what this step gives, ` +
    `or leave it for a step that has not started.`
  );
}

/**
 * Where the node sits in a spec that already contains it, and why, in one
 * sentence: the wave, the steps it waits on and what it reads from each.
 */
export function describePlacement(graph: Graph, id: string): Placement {
  const wave = (rankGraph(graph).rank.get(id) ?? 0) + 1;
  const label = (stepId: string) => quote(graph.nodes.get(stepId)?.label ?? stepId);
  const inbound = graph.inbound.get(id) ?? [];
  const outbound = graph.outbound.get(id) ?? [];

  let sentence: string;
  if (inbound.length === 0) {
    sentence = `Placed in wave ${wave}: it reads nothing another step makes, so it can start at once`;
  } else if (inbound.length === 1) {
    const edge = inbound[0]!;
    sentence = `Placed in wave ${wave}, after ${label(edge.from)}, which it reads ${joinAnd(edge.carries)} from`;
  } else {
    const parts = inbound.map((e) => `${label(e.from)} (${e.carries.join(", ")})`);
    sentence = `Placed in wave ${wave}, after ${joinAnd(parts)}, whose outputs it reads`;
  }
  if (outbound.length > 0) {
    const parts = outbound.map((e) => `${e.carries.join(", ")} to ${label(e.to)}`);
    sentence += `; it hands ${joinAnd(parts)}`;
  }
  return { wave, sentence: `${sentence}.` };
}

/**
 * Everything the canvas and the server need to know about one candidate:
 * whether it can be placed at all, where, and what the linter says about the
 * spec once it is in. Each candidate is checked on its own against the spec,
 * because each is accepted on its own.
 */
export function checkCandidate(
  spec: WorkflowSpec,
  candidate: unknown,
  started: Started = new Set(),
): CandidateCheck {
  const parsed = NodeSpec.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "step"}: ${i.message}`);
    return { edges: [], findings: [], refusal: `it is not a valid step (${issues.join("; ")})` };
  }
  const node = parsed.data;
  if (spec.nodes.some((n) => n.id === node.id)) {
    return { edges: [], findings: [], refusal: `the spec already has a step with the id '${node.id}'` };
  }

  const placed = placeCandidate(spec, node);
  const conflict = startedConflict(spec, placed.edges, started);
  if (conflict) return { edges: placed.edges, findings: [], refusal: conflict };

  let graph: Graph;
  try {
    graph = buildGraph(placed.spec);
  } catch (cause) {
    const message = cause instanceof SpecError ? cause.message : String(cause);
    return { edges: placed.edges, findings: [], refusal: `it cannot join this spec: ${message}` };
  }

  const findings = lint(graph).findings.filter((f) => f.nodes.includes(node.id));
  return {
    edges: placed.edges,
    spec: placed.spec,
    placement: describePlacement(graph, node.id),
    findings,
  };
}

/** A step id from a label: lower case, words joined by underscores, unique in the spec. */
export function candidateId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)
      .replace(/_+$/g, "") || "step";
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}_${n}`;
    if (!used.has(next)) return next;
  }
}

function quote(label: string): string {
  return `“${label}”`;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
