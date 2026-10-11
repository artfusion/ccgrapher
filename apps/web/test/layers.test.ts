// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../lib/fixtures";
import { buildModel } from "../lib/graph-model";
import { ALL_LAYERS, applyLayers, type Layers } from "../lib/layers";

function model(name = "linear-chain") {
  const built = buildModel(FIXTURES[name]!, false);
  if (!built.ok) throw new Error(built.error);
  return built;
}

const NONE: Layers = { findings: false, kinds: false, badges: false, fields: false };

describe("layers", () => {
  it("with everything showing, hands the view back as it is", () => {
    const m = model();
    const view = { nodes: m.nodes, edges: m.edges };
    expect(applyLayers(view, ALL_LAYERS)).toBe(view);
  });

  it("never moves, resizes or renames anything, whatever is hidden", () => {
    const m = model();
    const out = applyLayers({ nodes: m.nodes, edges: m.edges }, NONE);
    expect(out.nodes.map((n) => [n.id, n.position, n.width, n.height])).toEqual(
      m.nodes.map((n) => [n.id, n.position, n.width, n.height]),
    );
    expect(out.edges.map((e) => [e.id, e.source, e.target])).toEqual(
      m.edges.map((e) => [e.id, e.source, e.target]),
    );
  });

  it("does not touch the model or its lint result", () => {
    const m = model();
    const before = JSON.stringify({ result: m.result, nodes: m.nodes, edges: m.edges });
    applyLayers({ nodes: m.nodes, edges: m.edges }, NONE);
    expect(JSON.stringify({ result: m.result, nodes: m.nodes, edges: m.edges })).toBe(before);
  });

  it("takes the finding marks off the steps and draws a fake edge as any edge", () => {
    const m = model();
    expect(m.nodes.some((n) => (n.data.problems as string[]).length > 0)).toBe(true);
    const fake = m.edges.find((e) => e.data?.fake === true)!;
    expect(fake.label).toBe("carries no data");

    const out = applyLayers({ nodes: m.nodes, edges: m.edges }, { ...ALL_LAYERS, findings: false });
    expect(out.nodes.every((n) => (n.data.problems as string[]).length === 0)).toBe(true);
    const shown = out.edges.find((e) => e.id === fake.id)!;
    expect(shown.label).not.toBe("carries no data");
    expect(shown.animated).toBe(false);
    expect(shown.style?.strokeDasharray).toBeUndefined();
  });

  it("hides the fan-out badge, the worktree card and the kind tint on their own", () => {
    const m = model("diamond");
    const out = applyLayers({ nodes: m.nodes, edges: m.edges }, { ...ALL_LAYERS, badges: false, kinds: false });
    expect(out.nodes.every((n) => n.data.badge === null && n.data.worktree === false)).toBe(true);
    expect(out.nodes.every((n) => n.data.untinted === true)).toBe(true);
    expect(out.edges.map((e) => e.label)).toEqual(m.edges.map((e) => e.label));
  });

  it("hides the field names on edges but keeps the finding's own wording while findings show", () => {
    const m = model();
    const out = applyLayers({ nodes: m.nodes, edges: m.edges }, { ...ALL_LAYERS, fields: false });
    for (const e of out.edges) {
      if (e.data?.fake === true) expect(e.label).toBe("carries no data");
      else expect(e.label).toBeUndefined();
    }
  });
});
