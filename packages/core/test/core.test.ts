// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentTag,
  agentTypes,
  buildGraph,
  effectiveInboundCount,
  formatSpec,
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

describe("agentTypes", () => {
  const node = (uses?: string[]) => ({ id: "n", label: "n", kind: "worker" as const, in: {}, out: {}, ...(uses && { uses }) });

  it("reads every agent:<type> in uses, in the order declared, and nothing else", () => {
    expect(agentTypes(node(["mcp:docs/search", "agent:reviewer", "skill:x", "agent:tester"]))).toEqual([
      "reviewer",
      "tester",
    ]);
    expect(agentTag(node(["agent:reviewer"]))).toBe("agent: reviewer");
  });

  it("is empty with no uses, no agent, or a bare `agent:`", () => {
    expect(agentTypes(node())).toEqual([]);
    expect(agentTypes(node(["skill:x", "agent:"]))).toEqual([]);
    expect(agentTag(node(["skill:x"]))).toBeUndefined();
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

  it("rejects unparsable YAML with its own message, distinct from a schema failure", () => {
    // Missing closing brace: not schema-invalid, not even YAML — parseYaml itself
    // throws before WorkflowSpec ever sees it.
    expect(() => parseSpec(`${base}  - { id: a, label: A, kind: worker\n`)).toThrow(
      /not valid YAML/,
    );
  });

  it("names the origin it was given in a YAML-syntax error, the same as in a schema error", () => {
    let caught: SpecError | undefined;
    try {
      parseSpec(`${base}  - { id: a, label: A, kind: worker\n`, "broken.yaml");
    } catch (cause) {
      caught = cause as SpecError;
    }
    expect(caught).toBeInstanceOf(SpecError);
    expect(caught?.message).toMatch(/^broken\.yaml: not valid YAML/);
  });
});

describe("boundaries", () => {
  const base =
    "version: 1\nname: t\nnodes:\n  - { id: a, label: A, kind: worker }\n  - { id: b, label: B, kind: worker }\n  - { id: c, label: C, kind: worker }\n";
  const withBoundaries = (yaml: string) => buildGraph(parseSpec(`${base}boundaries:\n${yaml}`));

  it("accepts a boundary and keeps its fields", () => {
    const graph = withBoundaries("  - { id: g, label: read the sources, members: [a, b], access: read-only }\n");
    expect(graph.spec.boundaries).toEqual([
      { id: "g", label: "read the sources", members: ["a", "b"], access: "read-only" },
    ]);
  });

  it("is additive: a spec without one has no key at all", () => {
    const spec = parseSpec(base);
    expect(Object.hasOwn(spec, "boundaries")).toBe(false);
  });

  it("rejects a member that is not a node", () => {
    expect(() => withBoundaries("  - { id: g, members: [a, ghost] }\n")).toThrow(
      /boundary 'g' names unknown node 'ghost'/,
    );
  });

  it("rejects two boundaries with one id", () => {
    expect(() => withBoundaries("  - { id: g, members: [a] }\n  - { id: g, members: [b] }\n")).toThrow(
      /duplicate boundary id: g/,
    );
  });

  it("rejects a node in two boundaries, since nesting is out of scope", () => {
    expect(() => withBoundaries("  - { id: g, members: [a, b] }\n  - { id: h, members: [b, c] }\n")).toThrow(
      /node 'b' is in boundary 'g' and boundary 'h'/,
    );
  });

  it("rejects a member listed twice", () => {
    expect(() => withBoundaries("  - { id: g, members: [a, a] }\n")).toThrow(/lists 'a' twice/);
  });

  it("rejects an empty boundary, an unknown access and an id with whitespace", () => {
    expect(() => withBoundaries("  - { id: g, members: [] }\n")).toThrow(SpecError);
    expect(() => withBoundaries("  - { id: g, members: [a], access: write-only }\n")).toThrow(SpecError);
    expect(() => withBoundaries('  - { id: "two words", members: [a] }\n')).toThrow(SpecError);
  });

  it("survives a round trip through formatSpec", () => {
    const spec = parseSpec(`${base}boundaries:\n  - { id: g, label: G, members: [a, c], access: read-write }\n`);
    expect(parseSpec(formatSpec(spec))).toEqual(spec);
  });

  it("changes no rank", () => {
    const edges = "edges:\n  - { from: a, to: b, carries: [] }\n";
    const plain = buildGraph(parseSpec(`${base}${edges}`));
    const bounded = buildGraph(parseSpec(`${base}${edges}boundaries:\n  - { id: g, members: [a, c] }\n`));
    expect(rankGraph(bounded)).toEqual(rankGraph(plain));
  });
});

/**
 * Capability declarations. The ids are opaque to this package on purpose, but
 * two characters are not: a comma or a space inside one would be shredded by
 * the doc-comment format that carries a spec through codegen and back.
 */
describe("uses", () => {
  const base = "version: 1\nname: t\nnodes:\n";
  const withUses = (uses: string) =>
    parseSpec(`${base}  - { id: a, label: A, kind: worker, uses: ${uses} }\n`);

  it("carries namespaced capability ids", () => {
    const spec = withUses('["mcp:search/query", "skill:house-style", "agent:reviewer"]');
    expect(spec.nodes[0]?.uses).toEqual([
      "mcp:search/query",
      "skill:house-style",
      "agent:reviewer",
    ]);
  });

  it("rejects an id containing a comma, naming the path", () => {
    let caught: SpecError | undefined;
    try {
      withUses('["mcp:a,b"]');
    } catch (cause) {
      caught = cause as SpecError;
    }
    expect(caught).toBeInstanceOf(SpecError);
    expect(caught?.message).toContain("nodes.0.uses.0");
  });

  it("rejects an id containing whitespace", () => {
    expect(() => withUses('["skill:two words"]')).toThrow(SpecError);
  });

  // Absent is not empty: a node that declares nothing is a node nobody asked,
  // and the audit needs to tell that from a node that declared none.
  it("leaves the key absent when a node does not declare one", () => {
    const spec = parseSpec(`${base}  - { id: a, label: A, kind: worker }\n`);
    expect(spec.nodes[0]?.uses).toBeUndefined();
    expect(Object.hasOwn(spec.nodes[0] ?? {}, "uses")).toBe(false);
  });

  it("survives a round trip through formatSpec", () => {
    const spec = withUses('["mcp:search/query", "skill:house-style"]');
    expect(parseSpec(formatSpec(spec))).toEqual(spec);
  });
});
