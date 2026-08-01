// SPDX-License-Identifier: Apache-2.0
import { emptyRunState, reduceRun, type RunState, type TraceEvent } from "@ccgrapher/trace";
import type { Edge, Node } from "@xyflow/react";
import { HeatData } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { applyRunState } from "../lib/overlay";
import { applyHeat } from "../lib/heat";
import { buildModel } from "../lib/graph-model";
import { FIXTURES } from "../lib/fixtures";

const SPEC = `version: 1
name: two
nodes:
  - { id: a, label: a, kind: worker, in: { t: string }, out: { x: string } }
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
