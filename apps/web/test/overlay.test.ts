// SPDX-License-Identifier: Apache-2.0
import { emptyRunState, reduceRun, type RunState, type TraceEvent } from "@ccgrapher/trace";
import type { Edge, Node } from "@xyflow/react";
import { HeatData } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { applyRunState } from "../lib/overlay";
import { applyHeat } from "../lib/heat";
import { applyCapabilityState } from "../lib/capability";
import { buildModel } from "../lib/graph-model";
import { FIXTURES } from "../lib/fixtures";

// `a` declares a capability so the capability overlay has something to be a
// function of. Nothing about layout reads `uses`, which is the point.
const SPEC = `version: 1
name: two
nodes:
  - { id: a, label: a, kind: worker, in: { t: string }, out: { x: string }, uses: ["mcp:github/pr"] }
  - { id: b, label: b, kind: worker, in: { x: string }, out: { y: string } }
edges:
  - { from: a, to: b, carries: [x] }
`;

function positioned(): { nodes: Node[]; edges: Edge[] } {
  const model = buildModel(SPEC, false);
  if (!model.ok) throw new Error(model.error);
  return { nodes: model.nodes, edges: model.edges };
}

function fold(...events: TraceEvent[]): RunState {
  return events.reduce(reduceRun, emptyRunState("r"));
}

const ts = "2026-08-01T00:00:00.000Z";
const start = (node: string, seq: number): TraceEvent => ({
  v: 1,
  runId: "r",
  seq,
  ts,
  type: "node_started",
  node,
});
const finish = (node: string, seq: number): TraceEvent => ({
  v: 1,
  runId: "r",
  seq,
  ts,
  type: "node_finished",
  node,
  durationMs: 4,
});
const lost = (capability: string, seq: number): TraceEvent => ({
  v: 1,
  runId: "r",
  seq,
  ts,
  type: "capability_lost",
  capability,
  reason: "the server stopped answering",
});
const invoked = (node: string, capability: string, seq: number): TraceEvent => ({
  v: 1,
  runId: "r",
  seq,
  ts,
  type: "capability_invoked",
  capability,
  node,
});

/** A run in which `a` is working, has lost what it declared and used something else. */
const troubled = (): RunState =>
  fold(start("a", 0), lost("mcp:github/pr", 1), invoked("a", "skill:rebase", 2));

/** Everything an overlay is forbidden to be a function of. */
const geometry = (nodes: Node[]) =>
  nodes.map(({ id, position, width, height, type }) => ({ id, position, width, height, type }));

/** Real output of `ccg trace stats --heat`, trimmed to the two nodes of SPEC. */
const heat = HeatData.parse({
  v: 1,
  metric: "duration-ms",
  unit: "ms",
  source: "ccg trace stats examples/traces/live-demo.jsonl",
  values: { a: 42 },
});

describe("the overlay seam", () => {
  it("moves nothing", () => {
    const before = positioned();
    const run = fold(start("a", 0), finish("a", 1), start("b", 2));
    const after = applyRunState(before.nodes, before.edges, run);

    // The whole invariant, in one assertion: strip `data` and the graph is
    // byte-identical to what layout produced. No position, size, order or rank
    // is a function of what the run did.
    expect(geometry(after.nodes)).toEqual(geometry(before.nodes));
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it("moves nothing for heat either, measured or not", () => {
    const before = positioned();
    const after = applyHeat(before.nodes, heat);

    // `a` is measured and `b` is not, so both halves of the overlay are in this
    // assertion: neither a tint nor a hatch is allowed to resize a card.
    expect(geometry(after.nodes)).toEqual(geometry(before.nodes));
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it("moves nothing when heat is drawn over a run either", () => {
    // The canvas shows one or the other, but the seam must not depend on that:
    // composing them in either order still has to leave layout's output alone.
    const before = positioned();
    const run = fold(start("a", 0), finish("a", 1), start("b", 2));

    const heatFirst = applyRunState(applyHeat(before.nodes, heat).nodes, before.edges, run);
    const runFirst = applyHeat(applyRunState(before.nodes, before.edges, run).nodes, heat);

    expect(geometry(heatFirst.nodes)).toEqual(geometry(before.nodes));
    expect(geometry(runFirst.nodes)).toEqual(geometry(before.nodes));
  });

  it("moves nothing when a capability is in trouble", () => {
    const before = positioned();
    const after = applyCapabilityState(before.nodes, troubled());

    // Not a vacuous assertion: this node really is alerting, and the geometry
    // is still layout's.
    expect((after[0]!.data as { capability?: { alert?: string } }).capability?.alert).toBe("gap");
    expect(geometry(after)).toEqual(geometry(before.nodes));
    expect(after.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it("moves nothing composed with run state in either order", () => {
    const before = positioned();
    const run = troubled();

    const capsFirst = applyRunState(
      applyCapabilityState(before.nodes, run),
      before.edges,
      run,
    );
    const runFirst = applyCapabilityState(
      applyRunState(before.nodes, before.edges, run).nodes,
      run,
    );

    expect(geometry(capsFirst.nodes)).toEqual(geometry(before.nodes));
    expect(geometry(runFirst)).toEqual(geometry(before.nodes));
    // Composition is not just harmless, it is complete: both readings survive.
    const both = runFirst[0]!.data as { run?: { status: string }; capability?: { alert?: string } };
    expect(both.run?.status).toBe("running");
    expect(both.capability?.alert).toBe("gap");
  });

  it("moves nothing composed with heat in either order", () => {
    // The canvas shows heat *or* the run, never both, but the seam must not
    // depend on that: an overlay that only holds in the order the app happens
    // to call it in is an overlay that will break the first time it is reused.
    const before = positioned();
    const run = troubled();

    const capsFirst = applyHeat(applyCapabilityState(before.nodes, run), heat);
    const heatFirst = applyCapabilityState(applyHeat(before.nodes, heat).nodes, run);

    expect(geometry(capsFirst.nodes)).toEqual(geometry(before.nodes));
    expect(geometry(heatFirst)).toEqual(geometry(before.nodes));
  });

  it("keeps capabilities out of the edges entirely", () => {
    // A capability is a fact about a step and about the environment it ran in.
    // `applyCapabilityState` is not given the edges, so it cannot invent a
    // reading for one.
    const before = positioned();
    const after = applyCapabilityState(before.nodes, troubled());
    expect(Array.isArray(after)).toBe(true);
    expect(before.edges[0]!.animated).toBe(false);
  });

  it("keeps heat out of the edges entirely", () => {
    // A heat file is keyed by node id. It has nothing to say about an edge, and
    // `applyHeat` does not take them, so it cannot invent a reading for one.
    const before = positioned();
    const after = applyHeat(before.nodes, heat);
    expect(after).not.toHaveProperty("edges");
    expect(before.edges[0]!.animated).toBe(false);
  });

  it("attaches each node's own run state and nothing else's", () => {
    const before = positioned();
    const run = fold(start("a", 0), finish("a", 1), start("b", 2));
    const after = applyRunState(before.nodes, before.edges, run);

    expect((after.nodes[0]!.data as { run?: { status: string } }).run?.status).toBe("done");
    expect((after.nodes[1]!.data as { run?: { status: string } }).run?.status).toBe("running");
    // The lint data that was already there survives.
    expect(after.nodes[0]!.data.label).toBe(before.nodes[0]!.data.label);
  });

  it("leaves a node the run has not mentioned exactly as it was", () => {
    const before = positioned();
    const after = applyRunState(before.nodes, before.edges, fold(start("a", 0)));
    expect(after.nodes[1]).toBe(before.nodes[1]);
  });

  it("returns the same arrays when there is no run", () => {
    const before = positioned();
    const after = applyRunState(before.nodes, before.edges, undefined);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
  });

  it("animates an edge only while data is moving along it", () => {
    const before = positioned();
    expect(before.edges[0]!.animated).toBe(false);

    // a done, b not started: nothing is in flight yet.
    expect(applyRunState(before.nodes, before.edges, fold(start("a", 0), finish("a", 1))).edges[0]!
      .animated).toBe(false);

    const flowing = applyRunState(
      before.nodes,
      before.edges,
      fold(start("a", 0), finish("a", 1), start("b", 2)),
    );
    expect(flowing.edges[0]!.animated).toBe(true);
    expect(flowing.edges[0]!.className).toBe("edge-flowing");
  });

  it("does not disturb an edge the linter already marked fake", () => {
    const model = buildModel(FIXTURES["linear-chain"]!, false);
    if (!model.ok) throw new Error(model.error);
    const fake = model.edges.find((e) => (e.data as { fake: boolean }).fake);
    expect(fake).toBeDefined();

    const after = applyRunState(model.nodes, model.edges, emptyRunState("r"));
    const same = after.edges.find((e) => e.id === fake!.id)!;
    expect(same).toBe(fake);
  });
});
