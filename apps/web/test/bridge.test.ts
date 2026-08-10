// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  graphToSpec,
  inPort,
  outPort,
  specToGraph,
  validateLinkConnection,
  type ElementCell,
  type LinkCell,
} from "../app/canvas/bridge";
import { buildModel } from "../lib/graph-model";

const DIAMOND = readFileSync(
  fileURLToPath(new URL("../../../examples/diamond.yaml", import.meta.url)),
  "utf8",
);

function elements(cells: readonly (ElementCell | LinkCell)[]): ElementCell[] {
  return cells.filter((c): c is ElementCell => c.type === "element");
}
function links(cells: readonly (ElementCell | LinkCell)[]): LinkCell[] {
  return cells.filter((c): c is LinkCell => c.type === "link");
}

describe("specToGraph / graphToSpec round trip", () => {
  it("merges every link sharing a (from, to) pair into one edge with unioned carries", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const cells = specToGraph(model, model.graph.spec.nodes);

    // checker has three inbound ports (claim, source, date) per worker — a
    // user drawing all three by hand would produce three separate links.
    const checkerLinks = links(cells).filter((l) => l.target.id === "checker");
    expect(checkerLinks.length).toBe(5); // one per worker, as buildModel already drew it

    const asDrawn = checkerLinks.flatMap((l) => [
      { source: { id: l.source.id, port: outPort("claim") }, target: { id: l.target.id, port: inPort("claim") } },
      { source: { id: l.source.id, port: outPort("source") }, target: { id: l.target.id, port: inPort("source") } },
      { source: { id: l.source.id, port: outPort("date") }, target: { id: l.target.id, port: inPort("date") } },
    ]);

    const spec = graphToSpec(asDrawn, model.graph.spec);

    // One EdgeSpec per (from, to) pair, not one per field.
    const workerToChecker = spec.edges.filter((e) => e.to === "checker");
    expect(workerToChecker.length).toBe(5);
    for (const edge of workerToChecker) {
      expect(new Set(edge.carries)).toEqual(new Set(["claim", "source", "date"]));
    }
  });

  it("patches only edges — every other spec field survives untouched", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const spec = graphToSpec([], model.graph.spec);

    expect(spec.goal).toBe(model.graph.spec.goal);
    expect(spec.nodes).toBe(model.graph.spec.nodes);
    const worker1 = spec.nodes.find((n) => n.id === "worker_1")!;
    expect(worker1.model).toBe("cheap");
    expect(worker1.uses).toEqual(["mcp:tavily/search"]);
    const checker = spec.nodes.find((n) => n.id === "checker")!;
    expect(checker.expects).toBe(5);
    expect(checker.freshContext).toBe(true);
    const merge = spec.nodes.find((n) => n.id === "merge")!;
    expect(merge.writes).toEqual(["reports/market-scan.md"]);
  });

  it("drops a link with no id on either end rather than emitting a broken edge", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const spec = graphToSpec(
      [{ source: { id: "split", port: null }, target: { id: undefined, port: null } }],
      model.graph.spec,
    );
    expect(spec.edges.length).toBe(0);
  });

  it("gives every node a portMap built from its in:/out: field maps", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const cells = specToGraph(model, model.graph.spec.nodes);
    const worker1 = elements(cells).find((e) => e.id === "worker_1")!;
    expect(Object.keys(worker1.portMap ?? {}).sort()).toEqual(
      [inPort("angle"), outPort("claim"), outPort("date"), outPort("source")].sort(),
    );
  });
});

describe("overlay fields reach the cell", () => {
  // heat.ts and capability.ts write to CCNode's top-level className/style —
  // never to data — because that's the seam every overlay in lib/ is built
  // on. A bridge that only forwarded `n.data` would silently drop every heat
  // wash and capability ring the moment the canvas swapped libraries.
  it("carries CCNode.className/.style into data.overlayClassName/.overlayStyle", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const tinted = {
      ...model,
      nodes: model.nodes.map((n, i) =>
        i === 0 ? { ...n, className: "heat-node heat-measured", style: { "--heat-fill": "#E8763A" } } : n,
      ),
    };
    const cells = specToGraph(tinted, model.graph.spec.nodes);
    const first = elements(cells)[0]!;
    expect(first.data.overlayClassName).toBe("heat-node heat-measured");
    expect(first.data.overlayStyle).toEqual({ "--heat-fill": "#E8763A" });
  });

  it("translates a fake edge's React-Flow-shaped style into JointJS's native link style", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    // No fake edges in diamond.yaml itself — fabricate the same shape
    // graph-model.ts produces for one, to pin the translation independent of
    // which fixture happens to lint dirty.
    const faked = {
      ...model,
      edges: [
        {
          ...model.edges[0]!,
          label: "carries no data",
          style: { stroke: "#C4442E", strokeWidth: 1.6, strokeDasharray: "6 4" },
          labelStyle: { fill: "#C4442E" },
          labelBgStyle: { fill: "#FBF7F0" },
        },
      ],
    };
    const cells = specToGraph(faked, model.graph.spec.nodes);
    const link = links(cells)[0]!;
    expect(link.style).toEqual({
      color: "#C4442E",
      width: 1.6,
      dasharray: "6 4",
      targetMarker: { type: "path", d: "M 10 -5 0 0 10 5 Z", fill: "#C4442E" },
    });
    expect(link.labelMap?.main.text).toBe("carries no data");
    expect(link.labelMap?.main.color).toBe("#C4442E");
  });
});

describe("validateLinkConnection", () => {
  it("rejects a link to itself", () => {
    expect(validateLinkConnection("a", outPort("x"), "a", inPort("x"))).toBe(false);
  });

  it("rejects a link that doesn't run out: -> in:", () => {
    expect(validateLinkConnection("a", inPort("x"), "b", inPort("x"))).toBe(false);
    expect(validateLinkConnection("a", outPort("x"), "b", outPort("x"))).toBe(false);
  });

  it("rejects a drop on a node body rather than a port", () => {
    expect(validateLinkConnection("a", outPort("x"), "b", null)).toBe(false);
  });

  it("accepts a well-formed out: -> in: connection between two nodes", () => {
    expect(validateLinkConnection("a", outPort("x"), "b", inPort("x"))).toBe(true);
  });
});
