// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph, parseSpec } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, renderSvg, type FindingMark } from "../src/index.js";
import { findingsOn, fitCaption } from "../src/findings.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => layoutGraph(loadGraph(`${examples}${name}.yaml`));

/** Nodes are emitted one group after another, so slice to the next group of any kind. */
function groupFor(svg: string, id: string): string {
  const start = svg.indexOf(`<g data-node="${id}"`);
  if (start < 0) throw new Error(`no group for ${id}`);
  const next = svg.indexOf("<g data-", start + 1);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}

describe("a mark for each node finding", () => {
  it("rings a verifier that grades its own work and says so", () => {
    const svg = renderSvg(fixture("self-grading"), { findingMarks: [{ rule: "SELF_GRADING", id: "check_own" }] });
    const node = groupFor(svg, "check_own");
    expect(node).toContain('data-findings="SELF_GRADING"');
    expect(node).toContain('data-halo="finding"');
    expect(node).toContain(">grades own work<");
    // The declared count is untouched.
    expect(node).toContain(">expects 2<");
  });

  it("rings a starved node and names the field it is missing", () => {
    const svg = renderSvg(fixture("linear-chain"), {
      findingMarks: [{ rule: "MISSING_INPUT", id: "review_b", field: "repo" }],
    });
    expect(groupFor(svg, "review_b")).toContain(">no repo<");
    expect(groupFor(svg, "review_b")).toContain('data-findings="MISSING_INPUT"');
  });

  it("rings an overloaded node with the count that arrives", () => {
    const svg = renderSvg(fixture("wide-fanin"), {
      findingMarks: [{ rule: "CONTEXT_COLLAPSE", id: "summarise", arriving: 200 }],
    });
    const node = groupFor(svg, "summarise");
    expect(node).toContain('data-findings="CONTEXT_COLLAPSE"');
    expect(node).toMatch(/>200 (in, no reduce|raw in)</);
  });

  it("draws every caption in the small-text danger colour", () => {
    const svg = renderSvg(fixture("self-grading"), { findingMarks: [{ rule: "SELF_GRADING", id: "check_own" }] });
    expect(svg).toContain(`fill="${DEFAULT_THEME.dangerInk}" text-anchor="start">grades own work<`);
  });

  it("draws nothing for a finding on a node that is not in the graph", () => {
    const svg = renderSvg(fixture("diamond"), { findingMarks: [{ rule: "SELF_GRADING", id: "nowhere" }] });
    expect(svg).not.toContain("data-findings");
    expect(svg).not.toContain("data-halo");
  });
});

describe("one caption for several findings", () => {
  const marks: FindingMark[] = [
    { rule: "SELF_GRADING", id: "judge" },
    { rule: "MISSING_INPUT", id: "judge", field: "rubric" },
  ];

  it("names the first in rule order and counts the rest, whatever order they arrive in", () => {
    const a = findingsOn("judge", marks, "missing");
    const b = findingsOn("judge", [...marks].reverse(), "missing");
    expect(a).toEqual(b);
    expect(a.rules).toEqual(["MISSING_INPUT", "SELF_GRADING", "SILENT_FAILURE"]);
    expect(fitCaption(a.captions, 200)).toBe("no rubric +2");
  });

  it("does not caption what is drawn elsewhere: a wrong guard, or a shared write", () => {
    const found = findingsOn(
      "judge",
      [...marks, { rule: "HIDDEN_EDGE", between: ["judge", "other"], file: "a.md" }],
      "mismatch",
    );
    expect(found.rules).toEqual(["MISSING_INPUT", "HIDDEN_EDGE", "SELF_GRADING", "SILENT_FAILURE"]);
    expect(fitCaption(found.captions, 200)).toBe("no rubric +1");
  });

  it("falls back to a shorter form when the room is short, and to the shortest when nothing fits", () => {
    const captions = findingsOn("j", [{ rule: "MISSING_INPUT", id: "j", field: "acceptance_criteria" }], undefined).captions;
    expect(fitCaption(captions, 200)).toBe("no acceptance_cr…");
    expect(fitCaption(captions, 70)).toBe("no accept…");
    expect(fitCaption(captions, 55)).toBe("no input");
    expect(fitCaption(captions, 10)).toBe("no input");
  });

  it("captions nothing when there is nothing to say", () => {
    expect(fitCaption(findingsOn("x", [], undefined).captions, 200)).toBeUndefined();
    expect(fitCaption(findingsOn("x", [], "mismatch").captions, 200)).toBeUndefined();
  });
});

describe("a line between two writers of one file", () => {
  const MARK: FindingMark = { rule: "HIDDEN_EDGE", between: ["draft_a", "draft_b"], file: "out/draft.md" };

  it("joins them with a thin solid danger line labelled with the file, and rings both", () => {
    const svg = renderSvg(fixture("self-grading"), { findingMarks: [MARK] });
    const link = /<g data-link="draft_a~draft_b"[^]*?<\/g>/.exec(svg)![0];
    expect(link).toContain('data-finding="HIDDEN_EDGE"');
    expect(link).toContain('data-writes="out/draft.md"');
    expect(link).toContain(`stroke="${DEFAULT_THEME.danger}"`);
    expect(link).not.toContain("stroke-dasharray");
    expect(link).toContain(">draft.md<");
    for (const id of ["draft_a", "draft_b"]) {
      expect(groupFor(svg, id)).toContain('data-findings="HIDDEN_EDGE"');
      expect(groupFor(svg, id)).toContain('data-halo="finding"');
    }
  });

  it("draws one line per pair, counting the other files", () => {
    const svg = renderSvg(fixture("self-grading"), {
      findingMarks: [MARK, { ...MARK, between: ["draft_b", "draft_a"], file: "out/index.json" }],
    });
    expect(svg.match(/data-link=/g)).toHaveLength(1);
    expect(svg).toContain(">draft.md +1<");
  });

  it("shortens a long file name", () => {
    const svg = renderSvg(fixture("self-grading"), {
      findingMarks: [{ ...MARK, file: "reports/quarterly-engineering-summary.md" }],
    });
    expect(svg).toContain(">quarterly-engin…<");
  });

  it("is byte-identical across renders", () => {
    const options = { findingMarks: [MARK, { rule: "SELF_GRADING", id: "check_own" } as const] };
    expect(renderSvg(fixture("self-grading"), options)).toBe(renderSvg(fixture("self-grading"), options));
  });

  it("draws no line, ring or caption when nothing is passed in", () => {
    const svg = renderSvg(layoutGraph(buildGraph(parseSpec("version: 1\nname: x\nnodes:\n  - { id: a, label: a, kind: worker }"))));
    expect(svg).not.toContain("data-link");
    expect(svg).not.toContain("data-findings");
  });
});
