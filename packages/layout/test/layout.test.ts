// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { rankGraph, withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { layoutGraph, measureNode, wrapLabel } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

const ALL = [
  "diamond",
  "research-desk",
  "route-auth-audit",
  "linear-chain",
  "self-grading",
  "wide-fanin",
] as const;

describe("the picture agrees with the linter", () => {
  // If dagre ever laid a node on a different row than core ranks it, the
  // diagram would contradict the layer count the lint report prints. This is
  // the invariant that stops that happening quietly.
  it.each(ALL)("%s: laid-out rows match core ranks exactly", (name) => {
    const graph = fixture(name);
    const positioned = layoutGraph(graph);
    const { rank } = rankGraph(graph);

    // Boxes on a row differ in height when a label wraps, so they share a
    // centreline rather than a top edge.
    const rowOf = new Map<number, number>();
    for (const node of positioned.nodes) {
      const r = rank.get(node.id)!;
      expect(node.rank).toBe(r);
      const centre = node.y + node.height / 2;
      const existing = rowOf.get(r);
      if (existing === undefined) rowOf.set(r, centre);
      else expect(centre).toBeCloseTo(existing, 0);
    }

    // Rows go strictly downward.
    const ys = [...rowOf.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
  });
});

describe("diamond — acceptance criterion #1", () => {
  const positioned = layoutGraph(fixture("diamond"));
  const workers = positioned.nodes.filter((n) => n.id.startsWith("worker_"));

  it("puts all five workers on one row", () => {
    expect(workers).toHaveLength(5);
    expect(new Set(workers.map((w) => w.rank))).toEqual(new Set([1]));
    expect(new Set(workers.map((w) => w.y + w.height / 2)).size).toBe(1);
  });

  it("reads left to right in the order the spec authored them", () => {
    const byX = [...workers].sort((a, b) => a.x - b.x).map((w) => w.id);
    expect(byX).toEqual(["worker_1", "worker_2", "worker_3", "worker_4", "worker_5"]);
  });

  it("is four rows deep", () => {
    expect(new Set(positioned.nodes.map((n) => n.rank)).size).toBe(4);
  });
});

describe("linear-chain — acceptance criterion #3", () => {
  const graph = fixture("linear-chain");
  const before = layoutGraph(graph);
  const after = layoutGraph(
    withEdges(
      graph,
      graph.spec.edges.map((e) =>
        e.carries.length === 0 ? { ...e, from: "setup", carries: ["repo"] } : e,
      ),
    ),
  );

  it("visibly widens once the fake edges are repaired", () => {
    expect(after.width).toBeGreaterThan(before.width * 1.5);
  });

  it("and gets shorter", () => {
    expect(after.height).toBeLessThan(before.height * 0.8);
  });

  it("puts the three reviewers on one row", () => {
    const row = after.nodes.filter((n) => ["review_a", "review_b", "lint_docs"].includes(n.id));
    expect(row).toHaveLength(3);
    expect(new Set(row.map((n) => n.rank))).toEqual(new Set([1]));
    expect(new Set(row.map((n) => n.y + n.height / 2)).size).toBe(1);
  });
});

describe("geometry is sane", () => {
  it.each(ALL)("%s: no two nodes on a row overlap", (name) => {
    const positioned = layoutGraph(fixture(name));
    const byRow = new Map<number, typeof positioned.nodes>();
    for (const node of positioned.nodes) {
      byRow.set(node.rank, [...(byRow.get(node.rank) ?? []), node]);
    }
    for (const row of byRow.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x + sorted[i - 1]!.width);
      }
    }
  });

  it.each(ALL)("%s: everything sits inside the reported canvas", (name) => {
    const p = layoutGraph(fixture(name));
    for (const node of p.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(p.width);
      expect(node.y + node.height).toBeLessThanOrEqual(p.height);
    }
  });

  it.each(ALL)("%s: every edge is routed", (name) => {
    for (const edge of layoutGraph(fixture(name)).edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("acceptance criterion #4 — nothing is positioned by hand", () => {
  it("node size follows the label, so positions cannot be hardcoded", () => {
    const graph: Graph = fixture("diamond");
    const short = graph.nodes.get("checker")!;
    const long = graph.nodes.get("merge")!;
    expect(measureNode(long).width).toBeGreaterThan(measureNode(short).width);
  });

  it("widening a label moves everything downstream of it", () => {
    const graph = fixture("diamond");
    const base = layoutGraph(graph);
    const widened = layoutGraph({
      ...graph,
      spec: {
        ...graph.spec,
        nodes: graph.spec.nodes.map((n) =>
          n.id === "worker_3" ? { ...n, label: "a considerably longer worker label" } : n,
        ),
      },
      nodes: graph.nodes,
    } as Graph);
    expect(widened.width).toBeGreaterThan(base.width);
  });
});

describe("wrapLabel", () => {
  it("keeps short labels on one line", () => {
    expect(wrapLabel("split the job", 18)).toEqual(["split the job"]);
  });

  it("breaks at a word boundary", () => {
    expect(wrapLabel("merge into one answer", 18)).toEqual(["merge into one", "answer"]);
  });

  it("never splits a single long word", () => {
    expect(wrapLabel("supercalifragilistic", 10)).toEqual(["supercalifragilistic"]);
  });
});

describe("fanOut", () => {
  it("stays one node and reserves room for the stack and badge", () => {
    const graph = fixture("route-auth-audit");
    const audit = graph.nodes.get("audit")!;
    expect(audit.fanOut?.cap).toBe(20);
    // One node in the graph, not twenty.
    expect(layoutGraph(graph).nodes.filter((n) => n.id === "audit")).toHaveLength(1);
    expect(measureNode(audit).width).toBeGreaterThan(
      measureNode({ ...audit, fanOut: undefined }).width,
    );
  });
});
