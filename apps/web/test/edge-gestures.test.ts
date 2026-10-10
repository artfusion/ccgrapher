// SPDX-License-Identifier: Apache-2.0
import { buildGraph, parseSpec } from "@ccgrapher/core";
import { lint } from "@ccgrapher/lint";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../lib/fixtures";
import {
  addEdge,
  becomesStart,
  connectionRefusal,
  deleteEdge,
  edgesOf,
  fieldChoices,
  retargetEdge,
  unfedAfterRemoving,
} from "../lib/edge-gestures";

const diamond = () => parseSpec(FIXTURES.diamond!);
const chain = () => parseSpec(FIXTURES["linear-chain"]!);

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`refused: ${(result as unknown as { reason: string }).reason}`);
  return result as Extract<T, { ok: true }>;
}
function reason(result: { ok: boolean }): string {
  if (result.ok) throw new Error("expected a refusal");
  return (result as unknown as { reason: string }).reason;
}

describe("adding an edge", () => {
  it("wires a new edge and gives the target the field, typed as the source produces it", () => {
    const spec = diamond();
    const result = ok(addEdge(spec, "split", "merge", "angle"));
    expect(result.spec.edges.at(-1)).toEqual({ from: "split", to: "merge", carries: ["angle"] });
    expect(result.spec.nodes.find((n) => n.id === "merge")!.in).toEqual({
      claim: "string",
      verdict: "keep|drop",
      angle: "string",
    });
    expect(result.summary).toContain("merge now reads angle");
    expect(result.edge).toEqual({ from: "split", to: "merge" });
    // The text reparses to the same spec, so YAML and picture cannot disagree.
    expect(parseSpec(result.source)).toEqual(result.spec);
  });

  it("leaves `in` alone when the target already reads the field", () => {
    const spec = diamond();
    const result = ok(addEdge(spec, "worker_1", "merge", "claim"));
    expect(result.spec.nodes.find((n) => n.id === "merge")!.in).toEqual(
      spec.nodes.find((n) => n.id === "merge")!.in,
    );
    expect(result.summary).not.toContain("now reads");
  });

  it("joins a field onto an existing edge instead of drawing a second one", () => {
    const spec = diamond();
    const result = ok(addEdge(spec, "checker", "merge", "why"));
    const between = result.spec.edges.filter((e) => e.from === "checker" && e.to === "merge");
    expect(between).toEqual([{ from: "checker", to: "merge", carries: ["claim", "verdict", "why"] }]);
    expect(result.spec.edges).toHaveLength(spec.edges.length);
  });

  it("refuses a duplicate: the edge already carries that field", () => {
    expect(reason(addEdge(diamond(), "worker_1", "checker", "claim"))).toMatch(/already carries 'claim'/);
  });

  it("refuses a cycle and names it", () => {
    expect(reason(addEdge(diamond(), "merge", "split", "report"))).toMatch(
      /cycle: split → worker_1 → checker → merge → split/,
    );
  });

  it("refuses a self-loop", () => {
    expect(reason(addEdge(diamond(), "checker", "checker", "claim"))).toMatch(/self-loop/);
  });

  it("refuses a field neither side can carry, and one the source does not produce", () => {
    expect(reason(addEdge(diamond(), "split", "merge", "nonsense"))).toMatch(/neither side can carry/);
    expect(reason(addEdge(diamond(), "split", "merge", "claim"))).toMatch(/split does not produce 'claim'/);
  });

  it("refuses a step that does not exist", () => {
    expect(reason(addEdge(diamond(), "split", "nowhere", "angle"))).toMatch(/no step 'nowhere'/);
  });
});

describe("the field chooser", () => {
  it("lists the source's out fields, the ones the target reads first, refusals attached", () => {
    const choices = fieldChoices(diamond(), "checker", "merge");
    expect(choices.map((c) => [c.field, c.read, c.refusal === undefined])).toEqual([
      ["claim", true, false],
      ["verdict", true, false],
      ["why", false, true],
    ]);
  });

  it("refuses before any field is chosen when the pair itself is wrong", () => {
    expect(connectionRefusal(diamond(), "merge", "split")).toMatch(/cycle/);
    expect(connectionRefusal(diamond(), "split", "split")).toMatch(/self-loop/);
    expect(connectionRefusal(diamond(), "split", "merge")).toBeUndefined();
  });
});

describe("deleting an edge", () => {
  it("removes exactly that edge and leaves every `in` as it was", () => {
    const spec = diamond();
    const result = ok(deleteEdge(spec, { from: "checker", to: "merge" }));
    expect(result.spec.edges).toHaveLength(spec.edges.length - 1);
    expect(result.spec.edges.some((e) => e.from === "checker" && e.to === "merge")).toBe(false);
    expect(result.spec.nodes).toEqual(spec.nodes);
  });

  it("names the fields left unfed, which the linter then reports", () => {
    const spec = chain();
    const edge = { from: "review_a", to: "collate" };
    expect(unfedAfterRemoving(spec, edge)).toEqual(["issues_a"]);
    expect(becomesStart(spec, edge)).toBe(false);
    const after = ok(deleteEdge(spec, edge));
    expect(lint(buildGraph(after.spec)).findings).toContainEqual(
      expect.objectContaining({ rule: "MISSING_INPUT", field: "issues_a" }),
    );
    // One of five workers still feeds the checker everything it reads.
    expect(unfedAfterRemoving(diamond(), { from: "worker_1", to: "checker" })).toEqual([]);
  });

  it("knows when the last inbound edge goes and the step becomes a starting step", () => {
    expect(becomesStart(diamond(), { from: "checker", to: "merge" })).toBe(true);
    expect(becomesStart(diamond(), { from: "worker_1", to: "checker" })).toBe(false);
  });

  it("deleting a fake edge is the linter's drop repair, made by hand", () => {
    const spec = chain();
    const result = ok(deleteEdge(spec, { from: "review_b", to: "lint_docs" }));
    expect(result.summary).toMatch(/carried nothing/);
    const findings = lint(buildGraph(result.spec)).findings;
    expect(findings.some((f) => f.rule === "FAKE_EDGE" && f.edge?.to === "lint_docs")).toBe(false);
  });

  it("refuses an edge that is not in the spec", () => {
    expect(reason(deleteEdge(diamond(), { from: "split", to: "merge" }))).toMatch(/no edge split → merge/);
  });
});

describe("retargeting an edge", () => {
  it("moves the target end, and the new target gains the carried fields it lacked", () => {
    const spec = diamond();
    const result = ok(retargetEdge(spec, { from: "split", to: "worker_5" }, "to", "checker"));
    expect(result.spec.edges[4]).toEqual({ from: "split", to: "checker", carries: ["angle"] });
    expect(result.spec.nodes.find((n) => n.id === "checker")!.in.angle).toBe("string");
    // The old target keeps its `in`.
    expect(result.spec.nodes.find((n) => n.id === "worker_5")!.in).toEqual({ angle: "string" });
    expect(result.edge).toEqual({ from: "split", to: "checker" });
  });

  it("moves the source end; a fake edge carries nothing, so any step without a cycle will do", () => {
    const spec = chain();
    const result = ok(retargetEdge(spec, { from: "review_a", to: "review_b" }, "from", "setup"));
    expect(result.spec.edges[1]).toEqual({ from: "setup", to: "review_b", carries: [] });
    expect(result.spec.edges).toHaveLength(spec.edges.length);
  });

  it("refuses a new source that cannot produce what the edge carries", () => {
    expect(reason(retargetEdge(diamond(), { from: "worker_5", to: "checker" }, "from", "split"))).toMatch(
      /split does not produce 'claim', 'source', 'date'/,
    );
  });

  it("rewires the diamond's fan-in: a worker's result goes straight to the merge", () => {
    const spec = diamond();
    const result = ok(retargetEdge(spec, { from: "worker_5", to: "checker" }, "to", "merge"));
    const merge = result.spec.nodes.find((n) => n.id === "merge")!;
    expect(merge.in).toMatchObject({ claim: "string", source: "url", date: "YYYY-MM-DD" });
    expect(result.spec.edges.filter((e) => e.to === "checker")).toHaveLength(4);
    expect(parseSpec(result.source)).toEqual(result.spec);
  });

  it("joins an existing edge when moved onto its pair", () => {
    const spec = ok(addEdge(diamond(), "worker_1", "merge", "claim")).spec;
    const result = ok(retargetEdge(spec, { from: "worker_1", to: "checker" }, "to", "merge"));
    expect(result.spec.edges.filter((e) => e.from === "worker_1" && e.to === "merge")).toEqual([
      { from: "worker_1", to: "merge", carries: ["claim", "source", "date"] },
    ]);
    expect(result.spec.edges).toHaveLength(spec.edges.length - 1);
    expect(result.summary).toMatch(/joining the edge already there/);
    // A fake edge moved onto a pair that already has an edge adds nothing.
    expect(reason(retargetEdge(chain(), { from: "review_b", to: "lint_docs" }, "to", "collate"))).toMatch(
      /review_b → collate already exists/,
    );
  });

  it("refuses a cycle, a self-loop, a duplicate and a no-op", () => {
    const spec = diamond();
    expect(reason(retargetEdge(spec, { from: "split", to: "worker_1" }, "from", "merge"))).toMatch(/merge does not produce/);
    expect(reason(retargetEdge(spec, { from: "checker", to: "merge" }, "to", "split"))).toMatch(/cycle/);
    expect(reason(retargetEdge(spec, { from: "checker", to: "merge" }, "to", "checker"))).toMatch(/self-loop/);
    expect(reason(retargetEdge(spec, { from: "split", to: "worker_1" }, "to", "worker_2"))).toMatch(
      /already carries angle/,
    );
    expect(reason(retargetEdge(spec, { from: "split", to: "worker_1" }, "to", "worker_1"))).toMatch(
      /already ends at worker_1/,
    );
  });
});

describe("a step's edges", () => {
  it("lists inbound and outbound in spec order", () => {
    const { inbound, outbound } = edgesOf(diamond(), "checker");
    expect(inbound.map((e) => e.from)).toEqual(["worker_1", "worker_2", "worker_3", "worker_4", "worker_5"]);
    expect(outbound.map((e) => e.to)).toEqual(["merge"]);
  });
});
