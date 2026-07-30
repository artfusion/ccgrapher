// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph, rankGraph, type WorkflowSpec } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { formatReport, lint } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

/** The three fixtures whose every edge carries real data. */
const CLEAN = ["diamond", "research-desk", "route-auth-audit"] as const;

describe("clean fixtures are clean", () => {
  it.each(CLEAN)("%s reports nothing", (name) => {
    const result = lint(fixture(name));
    expect(result.findings).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(result.layersAfter).toBe(result.layersBefore);
  });

  it("diamond's single-inbound merge does not trip the fan-in guard", () => {
    const graph = fixture("diamond");
    expect(graph.inbound.get("merge")).toHaveLength(1);
    expect(graph.nodes.get("merge")!.expects).toBeUndefined();
    expect(lint(graph).findings).toEqual([]);
  });
});

describe("linear-chain — acceptance criterion #2", () => {
  const result = lint(fixture("linear-chain"));
  const of = (rule: string) => result.findings.filter((f) => f.rule === rule);

  it("finds both fake edges", () => {
    expect(of("FAKE_EDGE").map((f) => f.edge)).toEqual([
      { from: "review_a", to: "review_b" },
      { from: "review_b", to: "lint_docs" },
    ]);
  });

  it("finds both missing inputs and exempts the root", () => {
    expect(of("MISSING_INPUT").map((f) => f.message)).toEqual([
      "review_b requires 'repo' but no inbound edge carries it",
      "lint_docs requires 'repo' but no inbound edge carries it",
    ]);
    // `setup` declares in.url with nothing supplying it, but it is a root.
    expect(of("MISSING_INPUT").some((f) => f.nodes.includes("setup"))).toBe(false);
  });

  it("finds the hidden edge only after repair", () => {
    const hidden = of("HIDDEN_EDGE");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.nodes).toEqual(["review_a", "review_b"]);
    expect(hidden[0]!.message).toContain("notes/findings.md");
    // As written, review_a is rank 1 and review_b rank 2 with a path between
    // them, so this is invisible until the fake edges are repointed.
    expect(hidden[0]!.phase).toBe("repaired");
  });

  it("reports exactly the five findings documented in the fixture header", () => {
    expect(result.findings.map((f) => f.rule)).toEqual([
      "FAKE_EDGE",
      "FAKE_EDGE",
      "MISSING_INPUT",
      "MISSING_INPUT",
      "HIDDEN_EDGE",
    ]);
  });

  it("collapses the critical path from 6 layers to 4", () => {
    expect(result.layersBefore).toBe(6);
    expect(result.layersAfter).toBe(4);
  });

  it("repoints to setup rather than deleting", () => {
    expect(result.repairs).toEqual([
      {
        kind: "repoint",
        from: "review_a",
        to: "review_b",
        newFrom: "setup",
        carries: ["repo"],
        why: "setup is the nearest node that supplies 'repo'",
      },
      {
        kind: "repoint",
        from: "review_b",
        to: "lint_docs",
        newFrom: "setup",
        carries: ["repo"],
        why: "setup is the nearest node that supplies 'repo'",
      },
    ]);
  });

  it("puts the three reviewers on one row after repair", () => {
    const { rank } = rankGraph(result.repairedGraph);
    expect(rank.get("review_a")).toBe(1);
    expect(rank.get("review_b")).toBe(1);
    expect(rank.get("lint_docs")).toBe(1);
  });

  it("leaves no fake edges or missing inputs behind", () => {
    const after = lint(result.repairedGraph);
    expect(after.findings.filter((f) => f.rule === "FAKE_EDGE")).toEqual([]);
    expect(after.findings.filter((f) => f.rule === "MISSING_INPUT")).toEqual([]);
  });
});

describe("self-grading fixture", () => {
  const result = lint(fixture("self-grading"));

  it("flags the verifier without a fresh context", () => {
    const found = result.findings.filter((f) => f.rule === "SELF_GRADING");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodes).toEqual(["check_own"]);
  });

  it("flags two concurrent drafters writing the same file", () => {
    const found = result.findings.filter((f) => f.rule === "HIDDEN_EDGE");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodes).toEqual(["draft_a", "draft_b"]);
    expect(found[0]!.phase).toBe("raw");
  });

  it("has nothing to repair — every edge carries real data", () => {
    expect(result.repairs).toEqual([]);
    expect(result.layersBefore).toBe(result.layersAfter);
  });
});

describe("wide-fanin fixture", () => {
  const result = lint(fixture("wide-fanin"));

  it("flags 200 results arriving with no reduce layer", () => {
    const found = result.findings.filter((f) => f.rule === "CONTEXT_COLLAPSE");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("200 inbound results");
  });

  it("does not double-report as a silent failure — expects is set and correct", () => {
    expect(result.findings.filter((f) => f.rule === "SILENT_FAILURE")).toEqual([]);
  });
});

describe("worktree suppresses the hidden-edge warning", () => {
  it("audit is isolated, so its writes cannot collide", () => {
    const graph = fixture("route-auth-audit");
    expect(graph.nodes.get("audit")!.worktree).toBe(true);
    expect(lint(graph).findings.filter((f) => f.rule === "HIDDEN_EDGE")).toEqual([]);
  });
});

describe("silent failure", () => {
  /** diamond's checker with its fan-in guard altered. */
  const checkerWith = (expects: number | undefined) => {
    const spec: WorkflowSpec = fixture("diamond").spec;
    return buildGraph({
      ...spec,
      nodes: spec.nodes.map((n) => (n.id === "checker" ? { ...n, expects } : n)),
    });
  };

  it("fires when a real fan-in has no guard", () => {
    const found = lint(checkerWith(undefined)).findings.filter(
      (f) => f.rule === "SILENT_FAILURE",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("fans in 5 results with no 'expects' guard");
  });

  it("fires when the guard disagrees with the real count", () => {
    const found = lint(checkerWith(4)).findings.filter((f) => f.rule === "SILENT_FAILURE");
    expect(found[0]!.message).toContain("declares expects: 4 but 5 results actually arrive");
  });
});

describe("formatReport", () => {
  it("shows the before/after path for a broken spec", () => {
    const graph = fixture("linear-chain");
    const text = formatReport(graph, lint(graph));
    expect(text).toContain("Critical path: 6 layers -> 4 layers (2 fewer after repair)");
    expect(text).toContain("5 findings (4 errors, 1 warning)");
    expect(text).toContain("repoint  review_a -> review_b becomes setup -> review_b");
  });

  it("says so plainly when there is nothing wrong", () => {
    const graph = fixture("diamond");
    const text = formatReport(graph, lint(graph));
    expect(text).toContain("no findings");
    expect(text).toContain("Critical path: 4 layers");
  });
});
