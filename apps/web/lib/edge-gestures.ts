// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import { finish } from "./inspector";

/**
 * What an edge gesture on the canvas does to the spec, kept out of React so
 * it can be tested in plain Node.
 *
 * There are three gestures, and each is one spec edit:
 *
 *   add       a link drawn from one step to another, carrying one field the
 *             source produces. If the edge already exists the field joins its
 *             `carries` (one edge per pair, as the spec writes it); if the
 *             target does not read the field yet, its `in` gains it with the
 *             source's type.
 *   retarget  either end of an edge dropped on another step. The edge keeps
 *             what it carries; a new target that does not read a carried field
 *             gains it in `in`, and a new source must produce every carried
 *             field. Moving onto a pair that already has an edge joins the two.
 *   delete    the edge goes. Deleting a fake edge (one that carries nothing)
 *             is the manual form of the linter's drop repair.
 *
 * ## `in` is never taken away
 *
 * Deleting or moving away the last edge that carries a field to a step leaves
 * that step's `in` as it was. `in` is what the step says it needs, and an edge
 * gesture says nothing about that: the step still needs the field, it is just
 * no longer fed, and the linter reports exactly that (MISSING_INPUT) until it
 * is wired again or removed from `in` in the inspector. Quietly shrinking `in`
 * would hide the very gap the picture is meant to show. `unfedAfterRemoving`
 * names those fields so the panel can say so before the edge goes. One case
 * reads differently: a step whose last inbound edge goes becomes a starting
 * step, and the linter reads a starting step's `in` as what the workflow is
 * invoked with, not as something an edge owes it (`becomesStart`).
 *
 * ## Refusals
 *
 * A gesture the spec cannot take is refused with its reason and changes
 * nothing: a self-loop, a cycle, an edge that already carries the field, a
 * field the source does not produce (so neither side can carry it), a step or
 * an edge that is not in the spec. Whatever passes those is still run through
 * `finish`, the same schema and graph check every inspector edit goes through.
 */

export interface EdgeRef {
  readonly from: string;
  readonly to: string;
}

export type GestureResult =
  | {
      readonly ok: true;
      readonly spec: WorkflowSpec;
      readonly source: string;
      /** What happened, in words, for the status line. */
      readonly summary: string;
      /** The edge the gesture leaves selected, if any. */
      readonly edge?: EdgeRef;
    }
  | { readonly ok: false; readonly reason: string };

const arrow = (e: EdgeRef) => `${e.from} → ${e.to}`;
const refuse = (reason: string): GestureResult => ({ ok: false, reason });

function nodeOf(spec: WorkflowSpec, id: string): NodeSpec | undefined {
  return spec.nodes.find((n) => n.id === id);
}

function indexOf(spec: WorkflowSpec, edge: EdgeRef): number {
  return spec.edges.findIndex((e) => e.from === edge.from && e.to === edge.to);
}

/** The path `from` ... `to` along `edges`, or undefined when `to` cannot be reached. */
function pathBetween(edges: readonly EdgeSpec[], from: string, to: string): string[] | undefined {
  const previous = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(previous.get(path[0]!)!);
      return path;
    }
    for (const e of edges) {
      if (e.from === at && !previous.has(e.to)) {
        previous.set(e.to, at);
        queue.push(e.to);
      }
    }
  }
  return undefined;
}

/** An edge `from -> to` closes a loop when `to` already leads back to `from`. */
function cycleReason(edges: readonly EdgeSpec[], from: string, to: string): string | undefined {
  const back = pathBetween(edges, to, from);
  if (!back) return undefined;
  return `that would make a cycle: ${[...back, to].join(" → ")}. A step cannot wait on its own result`;
}

function done(spec: WorkflowSpec, summary: string, edge?: EdgeRef): GestureResult {
  const result = finish(spec);
  if (!result.ok) return refuse(result.errors.join("; "));
  return { ok: true, spec: result.spec, source: result.source, summary, ...(edge ? { edge } : {}) };
}

/** `target` with every field in `fields` it does not read yet added to `in`, typed by `typeOf`. */
function reading(target: NodeSpec, fields: readonly string[], typeOf: (field: string) => string) {
  const missing = fields.filter((f) => !(f in target.in));
  if (missing.length === 0) return { node: target, added: [] as string[] };
  const extra = Object.fromEntries(missing.map((f) => [f, typeOf(f)]));
  return { node: { ...target, in: { ...target.in, ...extra } }, added: missing };
}

const addedNote = (target: string, added: readonly string[]) =>
  added.length === 0 ? "" : `; ${target} now reads ${added.join(", ")}`;

export interface FieldChoice {
  readonly field: string;
  readonly type: string;
  /** The target already declares this field in its `in`. */
  readonly read: boolean;
  /** Why this field cannot be carried here, when it cannot. */
  readonly refusal?: string;
}

/**
 * The fields a new `from -> to` edge could carry: every field the source
 * produces, each with whether the target already reads it and, when the
 * gesture would be refused, why. Fields the target reads come first.
 */
export function fieldChoices(spec: WorkflowSpec, from: string, to: string): FieldChoice[] {
  const source = nodeOf(spec, from);
  const target = nodeOf(spec, to);
  if (!source || !target) return [];
  return Object.entries(source.out)
    .map(([field, type]) => {
      const result = addEdge(spec, from, to, field);
      return {
        field,
        type,
        read: field in target.in,
        ...(result.ok ? {} : { refusal: result.reason }),
      };
    })
    .sort((a, b) => Number(b.read) - Number(a.read));
}

/**
 * A gesture that is wrong before any field is chosen: a self-loop, a cycle, or
 * a source that produces nothing. The chooser shows this instead of a list.
 */
export function connectionRefusal(spec: WorkflowSpec, from: string, to: string): string | undefined {
  const source = nodeOf(spec, from);
  if (!source) return `there is no step '${from}' in this spec`;
  if (!nodeOf(spec, to)) return `there is no step '${to}' in this spec`;
  if (from === to) return `a step cannot feed itself: ${from} → ${from} is a self-loop`;
  if (Object.keys(source.out).length === 0) {
    return `${from} produces nothing (its out is empty), so there is no field an edge from it could carry`;
  }
  return cycleReason(spec.edges, from, to);
}

/** Draw `from -> to` carrying `field`. */
export function addEdge(spec: WorkflowSpec, from: string, to: string, field: string): GestureResult {
  const early = connectionRefusal(spec, from, to);
  if (early) return refuse(early);
  const source = nodeOf(spec, from)!;
  const target = nodeOf(spec, to)!;

  if (!(field in source.out)) {
    return refuse(
      field in target.in
        ? `${from} does not produce '${field}', so an edge from it cannot carry it`
        : `neither side can carry '${field}': ${from} does not produce it and ${to} does not read it`,
    );
  }

  const at = indexOf(spec, { from, to });
  const existing = at === -1 ? undefined : spec.edges[at]!;
  if (existing?.carries.includes(field)) {
    return refuse(`${arrow({ from, to })} already carries '${field}'; a second edge would say nothing new`);
  }

  const edges =
    existing === undefined
      ? [...spec.edges, { from, to, carries: [field] }]
      : spec.edges.map((e, i) => (i === at ? { ...e, carries: [...e.carries, field] } : e));
  const { node, added } = reading(target, [field], () => source.out[field]!);

  return done(
    { ...spec, nodes: spec.nodes.map((n) => (n.id === to ? node : n)), edges },
    `${existing ? "added" : "wired"} ${arrow({ from, to })}, carrying ${field}${addedNote(to, added)}`,
    { from, to },
  );
}

/** Remove one edge. `in` is left as it is; see the note at the top of this file. */
export function deleteEdge(spec: WorkflowSpec, edge: EdgeRef): GestureResult {
  const at = indexOf(spec, edge);
  if (at === -1) return refuse(`there is no edge ${arrow(edge)} in the spec as written`);
  const fake = spec.edges[at]!.carries.length === 0;
  return done(
    { ...spec, edges: spec.edges.filter((_, i) => i !== at) },
    fake
      ? `deleted ${arrow(edge)}, an edge that carried nothing (the linter's repair, made by hand)`
      : `deleted ${arrow(edge)}`,
  );
}

/**
 * Fields of `edge.to`'s `in` that no edge would carry any more once `edge` is
 * gone. Deleting leaves them declared and unfed, and the linter will say so.
 */
export function unfedAfterRemoving(spec: WorkflowSpec, edge: EdgeRef): string[] {
  const at = indexOf(spec, edge);
  if (at === -1) return [];
  const removed = spec.edges[at]!;
  const target = nodeOf(spec, edge.to);
  if (!target) return [];
  const stillFed = new Set(
    spec.edges.filter((e, i) => i !== at && e.to === edge.to).flatMap((e) => e.carries),
  );
  return removed.carries.filter((f) => f in target.in && !stillFed.has(f));
}

/** Removing `edge` leaves its target with no inbound edge at all: it becomes a starting step. */
export function becomesStart(spec: WorkflowSpec, edge: EdgeRef): boolean {
  return indexOf(spec, edge) !== -1 && spec.edges.filter((e) => e.to === edge.to).length === 1;
}

/** Move one end of an edge to another step. */
export function retargetEdge(
  spec: WorkflowSpec,
  edge: EdgeRef,
  end: "from" | "to",
  nodeId: string,
): GestureResult {
  const at = indexOf(spec, edge);
  if (at === -1) return refuse(`there is no edge ${arrow(edge)} in the spec as written`);
  const moved = spec.edges[at]!;
  if (!nodeOf(spec, nodeId)) return refuse(`there is no step '${nodeId}' in this spec`);
  if (moved[end] === nodeId) return refuse(`${arrow(edge)} already ${end === "from" ? "starts" : "ends"} at ${nodeId}`);

  const next: EdgeRef = end === "from" ? { from: nodeId, to: edge.to } : { from: edge.from, to: nodeId };
  if (next.from === next.to) return refuse(`a step cannot feed itself: ${arrow(next)} is a self-loop`);

  const source = nodeOf(spec, next.from)!;
  const target = nodeOf(spec, next.to)!;

  if (end === "from") {
    const missing = moved.carries.filter((f) => !(f in source.out));
    if (missing.length > 0) {
      return refuse(
        `${nodeId} does not produce ${missing.map((f) => `'${f}'`).join(", ")}, so it cannot carry ${
          missing.length === 1 ? "it" : "them"
        } to ${edge.to}`,
      );
    }
  }

  const others = spec.edges.filter((_, i) => i !== at);
  const cycle = cycleReason(others, next.from, next.to);
  if (cycle) return refuse(cycle);

  const joinAt = others.findIndex((e) => e.from === next.from && e.to === next.to);
  const join = joinAt === -1 ? undefined : others[joinAt]!;
  if (join) {
    const fresh = moved.carries.filter((f) => !join.carries.includes(f));
    if (fresh.length === 0) {
      return refuse(
        moved.carries.length === 0
          ? `${arrow(next)} already exists; a second edge would say nothing new`
          : `${arrow(next)} already carries ${moved.carries.join(", ")}; a second edge would say nothing new`,
      );
    }
  }

  const oldTarget = nodeOf(spec, edge.to)!;
  const { node, added } = reading(
    target,
    moved.carries,
    (f) => source.out[f] ?? oldTarget.in[f] ?? "string",
  );

  // The moved edge takes the place of the original in the list, so the YAML
  // diff is one line; joined onto an existing edge, it disappears into it.
  const edges = join
    ? others.map((e, i) =>
        i === joinAt ? { ...e, carries: [...e.carries, ...moved.carries.filter((f) => !e.carries.includes(f))] } : e,
      )
    : spec.edges.map((e, i) => (i === at ? { ...e, ...next } : e));

  return done(
    { ...spec, nodes: spec.nodes.map((n) => (n.id === next.to ? node : n)), edges },
    `moved ${arrow(edge)} to ${arrow(next)}${join ? ", joining the edge already there" : ""}${addedNote(next.to, added)}`,
    next,
  );
}

/** Every edge into and out of a step, in spec order. */
export function edgesOf(spec: WorkflowSpec, nodeId: string): { inbound: EdgeSpec[]; outbound: EdgeSpec[] } {
  return {
    inbound: spec.edges.filter((e) => e.to === nodeId),
    outbound: spec.edges.filter((e) => e.from === nodeId),
  };
}

/** The edge `ref` names, as written. */
export function edgeAt(spec: WorkflowSpec, ref: EdgeRef): EdgeSpec | undefined {
  const at = indexOf(spec, ref);
  return at === -1 ? undefined : spec.edges[at];
}
