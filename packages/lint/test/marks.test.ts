// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { RULE_ORDER, lint, renderMarksFor, type Finding } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const findings = (name: string) => lint(loadGraph(`${examples}${name}.yaml`)).findings;
const variants = fileURLToPath(new URL("./fixtures/daily-brief/", import.meta.url));
const variant = (name: string) => lint(loadGraph(`${variants}${name}.yaml`)).findings;
const ACROSS_RUNS = ["unguarded-post", "early-commit", "agent-writes-preferences"] as const;

describe("renderMarksFor", () => {
  it("gives every rule a mark: each example finding becomes something a renderer draws", () => {
    const all = [
      ...["linear-chain", "release-session", "self-grading", "wide-fanin"].flatMap(findings),
      ...ACROSS_RUNS.flatMap(variant),
    ];
    expect(new Set(all.map((f) => f.rule))).toEqual(new Set(RULE_ORDER));
    for (const f of all) {
      const marks = renderMarksFor([f]);
      const count = marks.fakeEdges.length + marks.guardFindings.length + marks.findingMarks.length;
      expect(count, `${f.rule}: ${f.message}`).toBe(1);
    }
  });

  it("carries the detail each mark needs, taken from the finding rather than worked out again", () => {
    const marks = renderMarksFor([...findings("linear-chain"), ...findings("self-grading"), ...findings("wide-fanin")]);
    expect(marks.findingMarks).toContainEqual({ rule: "MISSING_INPUT", id: "review_b", field: "repo" });
    expect(marks.findingMarks).toContainEqual({
      rule: "HIDDEN_EDGE",
      between: ["review_a", "review_b"],
      file: "notes/findings.md",
    });
    expect(marks.findingMarks).toContainEqual({ rule: "SELF_GRADING", id: "check_own" });
    expect(marks.findingMarks).toContainEqual({ rule: "CONTEXT_COLLAPSE", id: "summarise", arriving: 200 });
    expect(renderMarksFor(findings("release-session")).guardFindings).toEqual([{ id: "ci", arriving: 8 }]);

    const across = renderMarksFor(ACROSS_RUNS.flatMap(variant)).findingMarks;
    expect(across).toEqual([
      { rule: "DUPLICATE_EFFECT", id: "post", effect: "post:brief-channel" },
      { rule: "EARLY_COMMIT", id: "commit_state", store: "bookmarks" },
      { rule: "EARLY_COMMIT", id: "commit_state", store: "ledger" },
      { rule: "AUTHORITY_BREACH", id: "decide", store: "preferences" },
    ]);
  });

  it("marks a read-only breach by its boundary, not by a store", () => {
    const breach: Finding = {
      rule: "AUTHORITY_BREACH",
      severity: "error",
      phase: "raw",
      message: "",
      nodes: ["a"],
      boundary: "look",
    };
    expect(renderMarksFor([breach]).findingMarks).toEqual([{ rule: "AUTHORITY_BREACH", id: "a", boundary: "look" }]);
  });

  it("leaves a finding unmarked rather than drawing it wrong when its detail is missing", () => {
    const bare: Finding = { rule: "MISSING_INPUT", severity: "error", phase: "raw", message: "", nodes: ["x"] };
    expect(renderMarksFor([bare]).findingMarks).toEqual([]);
  });
});
