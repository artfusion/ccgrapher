// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildGraph, effectivePriorities, parseSpec, priorityCaption, rankGraph, WorkflowSpec } from "../src/index.js";

function graphOf(nodes: ReadonlyArray<Record<string, unknown>>, edges: ReadonlyArray<[string, string]> = []) {
  return buildGraph(
    WorkflowSpec.parse({
      version: 1,
      name: "fixture",
      nodes: nodes.map((n) => ({ label: String(n.id), kind: "worker", ...n })),
      edges: edges.map(([from, to]) => ({ from, to, carries: ["x"] })),
    }),
  );
}

describe("priority in the schema", () => {
  it("takes urgent, high and normal, and nothing else", () => {
    for (const priority of ["urgent", "high", "normal"]) {
      expect(() => graphOf([{ id: "a", priority }])).not.toThrow();
    }
    expect(() => graphOf([{ id: "a", priority: "asap" }])).toThrow();
  });

  it("keeps who set it to one line", () => {
    expect(() => graphOf([{ id: "a", priority: "urgent", prioritySetBy: "on-call, payments" }])).not.toThrow();
    expect(() => graphOf([{ id: "a", priority: "urgent", prioritySetBy: "on-call\nand more" }])).toThrow();
    expect(() => graphOf([{ id: "a", priority: "urgent", prioritySetBy: " padded" }])).toThrow();
  });

  it("parses from YAML, version still 1", () => {
    const spec = parseSpec(`
version: 1
name: p
nodes:
  - { id: a, label: a, kind: worker, priority: urgent, prioritySetBy: on-call }
`);
    expect(spec.nodes[0]).toMatchObject({ priority: "urgent", prioritySetBy: "on-call" });
  });
});

describe("effectivePriorities", () => {
  it("passes an urgent step's priority to everything it waits on, and nothing else", () => {
    const graph = graphOf(
      [{ id: "root" }, { id: "prep" }, { id: "side" }, { id: "fix", priority: "urgent", prioritySetBy: "on-call" }, { id: "after" }],
      [["root", "prep"], ["root", "side"], ["prep", "fix"], ["fix", "after"]],
    );
    const found = effectivePriorities(graph);
    expect([...found.keys()]).toEqual(["root", "prep", "fix"]);
    expect(found.get("fix")).toEqual({ priority: "urgent", setBy: "on-call" });
    expect(found.get("prep")).toEqual({ priority: "urgent", inheritedFrom: "fix", setBy: "on-call" });
    expect(found.get("root")).toEqual({ priority: "urgent", inheritedFrom: "fix", setBy: "on-call" });
  });

  it("takes the higher of a node's own and what it inherits", () => {
    const graph = graphOf(
      [{ id: "a", priority: "high" }, { id: "b", priority: "urgent" }, { id: "c", priority: "high" }],
      [["a", "b"], ["c", "b"]],
    );
    const found = effectivePriorities(graph);
    expect(found.get("a")).toEqual({ priority: "urgent", inheritedFrom: "b" });
    expect(found.get("c")).toEqual({ priority: "urgent", inheritedFrom: "b" });
  });

  it("keeps its own priority over an equal inherited one, and names the earlier of two equals", () => {
    const own = effectivePriorities(graphOf([{ id: "a", priority: "high" }, { id: "b", priority: "high" }], [["a", "b"]]));
    expect(own.get("a")).toEqual({ priority: "high" });

    const two = effectivePriorities(
      graphOf([{ id: "a" }, { id: "x", priority: "urgent" }, { id: "y", priority: "urgent" }], [["a", "y"], ["a", "x"]]),
    );
    expect(two.get("a")).toEqual({ priority: "urgent", inheritedFrom: "x" });
  });

  it("is empty when nothing is raised, `normal` included", () => {
    const graph = graphOf([{ id: "a", priority: "normal", prioritySetBy: "on-call" }, { id: "b" }], [["a", "b"]]);
    expect(effectivePriorities(graph).size).toBe(0);
  });

  it("moves no node: ranks are the same with and without it", () => {
    const edges: Array<[string, string]> = [["a", "b"], ["a", "c"], ["c", "d"]];
    const plain = graphOf([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], edges);
    const urgent = graphOf([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", priority: "urgent" }], edges);
    expect([...rankGraph(urgent).rank]).toEqual([...rankGraph(plain).rank]);
  });
});

describe("priorityCaption", () => {
  it("says who set it on the step that carries it, and which step needs it upstream", () => {
    expect(priorityCaption({ priority: "urgent", setBy: "on-call" })).toBe("urgent, set by on-call");
    expect(priorityCaption({ priority: "high" })).toBe("high");
    expect(priorityCaption({ priority: "urgent", inheritedFrom: "fix", setBy: "on-call" })).toBe("urgent, needed by fix");
  });
});
