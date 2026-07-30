// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildGraph,
  effectiveInboundCount,
  parseSpec,
  rankGraph,
  renderStyle,
  roots,
  SpecError,
} from "../src/index.js";
import { loadGraph } from "../src/node.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

const ALL = ["diamond", "research-desk", "route-auth-audit", "linear-chain"] as const;

describe("fixtures", () => {
  it.each(ALL)("%s parses and indexes", (name) => {
    const graph = fixture(name);
    expect(graph.nodes.size).toBeGreaterThan(0);
    expect(graph.spec.name).toBe(name);
  });
});

describe("rank assignment", () => {
  it("diamond is 4 layers with all five workers on row 1", () => {
    const { rank, layers, layerCount } = rankGraph(fixture("diamond"));

    expect(layerCount).toBe(4);
    expect(rank.get("split")).toBe(0);
    expect(rank.get("checker")).toBe(2);
    expect(rank.get("merge")).toBe(3);

    expect(layers[1]).toEqual([
      "worker_1",
      "worker_2",
      "worker_3",
      "worker_4",
      "worker_5",
    ]);
  });

  it("linear-chain is 6 layers before repair", () => {
    const { rank, layerCount } = rankGraph(fixture("linear-chain"));

    expect(layerCount).toBe(6);
    expect([...rank.entries()].sort()).toEqual([
      ["collate", 4],
      ["lint_docs", 3],
      ["review_a", 1],
      ["review_b", 2],
      ["setup", 0],
      ["write_report", 5],
    ]);
  });

  it("linear-chain collapses to 4 layers when the fake edges are repointed to setup", () => {
    const graph = fixture("linear-chain");
    const repaired = buildGraph({
      ...graph.spec,
      edges: graph.spec.edges.map((edge) =>
        edge.carries.length === 0 ? { ...edge, from: "setup", carries: ["repo"] } : edge,
      ),
    });

    const { rank, layerCount } = rankGraph(repaired);
    expect(layerCount).toBe(4);
    expect(rank.get("review_a")).toBe(1);
    expect(rank.get("review_b")).toBe(1);
    expect(rank.get("lint_docs")).toBe(1);
  });

  // The fixture's header comment claimed 6 layers; the chain
  // plan -> research -> dedupe -> skeptic -> vote -> report -> gate is 7 deep.
  // Comment corrected in the fixture, expectation asserted here.
  it("research-desk is 7 layers with the three skeptics on one row", () => {
    const { layers, layerCount } = rankGraph(fixture("research-desk"));
    expect(layerCount).toBe(7);
    expect(layers[3]).toEqual(["skeptic_correct", "skeptic_current", "skeptic_source"]);
    expect(layers[6]).toEqual(["gate"]);
  });
});

describe("effectiveInboundCount", () => {
  // Every `expects` in the drop must equal the effective inbound count, whether
  // the fan-in is N separate edges or one edge from a capped fanOut node.
  it.each(ALL)("%s: every expects matches", (name) => {
    const graph = fixture(name);
    for (const node of graph.nodes.values()) {
      if (node.expects === undefined) continue;
      expect(effectiveInboundCount(graph, node.id), `${name}/${node.id}`).toBe(node.expects);
    }
  });

  it("counts a capped fanOut source as cap, not as one edge", () => {
    const graph = fixture("route-auth-audit");
    expect(graph.inbound.get("verify")).toHaveLength(1);
    expect(effectiveInboundCount(graph, "verify")).toBe(20);
  });
});

describe("roots", () => {
  it.each(ALL)("%s has exactly one root", (name) => {
    expect(roots(fixture(name))).toHaveLength(1);
  });
});

describe("renderStyle", () => {
  it("treats model:null as code and gate as human", () => {
    const graph = fixture("research-desk");
    expect(renderStyle(graph.nodes.get("dedupe")!)).toBe("code");
    expect(renderStyle(graph.nodes.get("vote")!)).toBe("code");
    expect(renderStyle(graph.nodes.get("gate")!)).toBe("human");
    expect(renderStyle(graph.nodes.get("plan")!)).toBe("agent");
  });
});

describe("the top-level goal is never a node", () => {
  it.each(ALL)("%s has a goal string but no goal node", (name) => {
    const graph = fixture(name);
    expect(graph.spec.goal).toBeTruthy();
    expect([...graph.nodes.values()].some((n) => n.kind === "goal")).toBe(false);
  });
});

describe("validation", () => {
  const base = "version: 1\nname: t\nnodes:\n";

  it("rejects a cycle", () => {
    expect(() =>
      buildGraph(
        parseSpec(
          `${base}  - { id: a, label: A, kind: worker }\n  - { id: b, label: B, kind: worker }\nedges:\n  - { from: a, to: b, carries: [] }\n  - { from: b, to: a, carries: [] }\n`,
        ),
      ),
    ).toThrow(/cycle/);
  });

  it("rejects an edge to an unknown node", () => {
    expect(() =>
      buildGraph(
        parseSpec(
          `${base}  - { id: a, label: A, kind: worker }\nedges:\n  - { from: a, to: ghost, carries: [] }\n`,
        ),
      ),
    ).toThrow(/unknown node 'ghost'/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      buildGraph(
        parseSpec(
          `${base}  - { id: a, label: A, kind: worker }\n  - { id: a, label: B, kind: worker }\n`,
        ),
      ),
    ).toThrow(/duplicate node id/);
  });

  it("reports the field path on a schema failure", () => {
    expect(() => parseSpec(`${base}  - { id: a, label: A, kind: nonsense }\n`)).toThrow(SpecError);
  });
});
