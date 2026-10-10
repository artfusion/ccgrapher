// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUT_PORT, specToGraph, type ElementCell, type LinkCell } from "../app/canvas/bridge";
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

describe("specToGraph", () => {
  it("gives a step that produces something one handle to drag a new edge from", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const cells = specToGraph(model, model.graph.spec.nodes);
    // Three out fields, one handle: the field is chosen on the drop.
    const worker1 = elements(cells).find((e) => e.id === "worker_1")!;
    expect(Object.keys(worker1.portMap ?? {})).toEqual([OUT_PORT]);
  });

  it("gives a step with an empty out no handle, and a read-only canvas none at all", () => {
    const model = buildModel(DIAMOND.replace("out: { report: markdown }", "out: {}"), false);
    if (!model.ok) throw new Error(model.error);

    const merge = elements(specToGraph(model, model.graph.spec.nodes)).find((e) => e.id === "merge")!;
    expect(merge.portMap).toEqual({});
    const readOnly = elements(specToGraph(model, model.graph.spec.nodes, false));
    expect(readOnly.every((e) => Object.keys(e.portMap ?? {}).length === 0)).toBe(true);
  });

  it("names on each link the edge it draws, so a gesture on it can say which edge it means", () => {
    const model = buildModel(DIAMOND, false);
    if (!model.ok) throw new Error(model.error);

    const link = links(specToGraph(model, model.graph.spec.nodes)).find((l) => l.target.id === "merge")!;
    expect(link.data).toMatchObject({ from: "checker", to: "merge", carries: ["claim", "verdict"] });
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
    expect(link.labelMap?.main?.text).toBe("carries no data");
    expect(link.labelMap?.main?.color).toBe("#C4442E");
  });
});
