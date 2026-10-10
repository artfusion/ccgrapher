// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph, type WorkflowSpec } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, renderSvg } from "../src/index.js";
import { checkSvg } from "./svg-structure.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => layoutGraph(loadGraph(`${examples}${name}.yaml`));
const r = (n: number) => Number(n.toFixed(2));

/** Nodes are emitted one group after another, so slice to the next one. */
function groupFor(svg: string, id: string): string {
  const start = svg.indexOf(`<g data-node="${id}"`);
  if (start < 0) throw new Error(`no group for ${id}`);
  const next = svg.indexOf('<g data-node="', start + 1);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}

/** A worker, a reviewer that runs as a declared agent, a tier-less tidy-up and a code merge. */
const REVIEW: WorkflowSpec = {
  version: 1,
  name: "review-loop",
  nodes: [
    { id: "write", label: "write the patch", kind: "worker", model: "cheap", in: {}, out: { diff: "string" } },
    {
      id: "review",
      label: "review the diff",
      kind: "verifier",
      model: "strong",
      uses: ["agent:reviewer"],
      freshContext: true,
      in: { diff: "string" },
      out: { verdict: "string" },
    },
    {
      id: "tidy",
      label: "tidy",
      kind: "worker",
      uses: ["skill:simplify", "agent:code-simplifier"],
      in: { diff: "string" },
      out: { tidied: "string" },
    },
    {
      id: "merge",
      label: "merge",
      kind: "reduce",
      model: null,
      expects: 2,
      in: { verdict: "string", tidied: "string" },
      out: { ok: "boolean" },
    },
  ],
  edges: [
    { from: "write", to: "review", carries: ["diff"] },
    { from: "write", to: "tidy", carries: ["diff"] },
    { from: "review", to: "merge", carries: ["verdict"] },
    { from: "tidy", to: "merge", carries: ["tidied"] },
  ],
};

describe("the tier mark", () => {
  const positioned = fixture("research-desk");
  const svg = renderSvg(positioned);

  it("names the tier of every node that has one, top left, with data-tier", () => {
    const tiered = positioned.nodes.filter((n) => n.node.model);
    expect(new Set(tiered.map((n) => n.node.model))).toEqual(new Set(["cheap", "strong"]));
    for (const { node, x, y } of tiered) {
      const group = groupFor(svg, node.id);
      expect(group).toContain(`data-tier="${node.model}"`);
      // INSET 8 from the left edge, baseline 17 down: the top-left slot.
      expect(group).toContain(`<text x="${r(x + 8)}" y="${r(y + 17)}" font-size="15"`);
      expect(group).toContain(`text-anchor="start">${node.model}<`);
    }
  });

  it("draws strong darker than cheap, both readable on every tint", () => {
    expect(groupFor(svg, "plan")).toContain(`fill="${DEFAULT_THEME.ink}" text-anchor="start">strong<`);
    expect(groupFor(svg, "research")).toContain(`fill="${DEFAULT_THEME.quiet}" text-anchor="start">cheap<`);
  });

  it("leaves plain code and an unspecified tier unmarked", () => {
    for (const id of ["dedupe", "vote", "gate"]) {
      const group = groupFor(svg, id);
      expect(group).not.toContain("data-tier");
      expect(group).not.toMatch(/>(strong|cheap)</);
    }
  });

  it("gets its room from the layout, not from the renderer", () => {
    const plan = positioned.nodes.find((n) => n.id === "plan")!;
    const untiered = layoutGraph(
      buildGraph({
        ...positioned.graph.spec,
        nodes: positioned.graph.spec.nodes.map((n) => (n.id === "plan" ? { ...n, model: undefined } : n)),
      }),
    ).nodes.find((n) => n.id === "plan")!;
    expect(plan.height).toBeGreaterThan(untiered.height);
  });
});

describe("the agent tag", () => {
  const positioned = layoutGraph(buildGraph(REVIEW));
  const svg = renderSvg(positioned);

  it("draws `agent: <type>` quietly under the label, with data-agent", () => {
    const review = groupFor(svg, "review");
    expect(review).toContain('data-agent="reviewer"');
    expect(review).toContain(`font-size="14" fill="${DEFAULT_THEME.quiet}" text-anchor="middle">agent: reviewer<`);
    // Under the label, not beside it.
    const labelY = Number(/<tspan x="[\d.]+" y="([\d.]+)">review the diff</.exec(review)![1]);
    const tagY = Number(/y="([\d.]+)" font-size="14"[^>]*>agent: reviewer</.exec(review)![1]);
    expect(tagY).toBeGreaterThan(labelY);
  });

  it("shows the agent with no tier, and ignores the other capabilities", () => {
    const tidy = groupFor(svg, "tidy");
    expect(tidy).toContain('data-agent="code-simplifier"');
    expect(tidy).toContain(">agent: code-simplifier<");
    expect(tidy).not.toContain("skill:");
    expect(tidy).not.toContain("data-tier");
  });

  it("is absent where no agent is declared", () => {
    expect(groupFor(svg, "write")).not.toContain("data-agent");
    expect(groupFor(svg, "merge")).not.toContain("data-agent");
  });

  it("passes the structural checker: nothing overflows or collides", () => {
    // The accent orange is a theme-wide fault, allow-listed for every render.
    const faults = checkSvg(svg, positioned).filter(
      (v) => !(v.rule === "contrast" && v.subject.startsWith("graphic #E8763A")),
    );
    expect(faults).toEqual([]);
  });
});

describe("the marks only tint", () => {
  it("add no node, and draw each one where the layout put it", () => {
    const positioned = layoutGraph(buildGraph(REVIEW));
    const svg = renderSvg(positioned);
    expect([...svg.matchAll(/<g data-node="/g)]).toHaveLength(REVIEW.nodes.length);
    const merge = positioned.nodes.find((n) => n.id === "merge")!;
    // Sharp corners for plain code, so the box is a plain rect at the layout's corner.
    expect(groupFor(svg, "merge")).toContain(`<rect x="${r(merge.x)}" y="${r(merge.y)}" width="${r(merge.width)}"`);
  });

  it("render byte for byte the same every time", () => {
    const once = renderSvg(layoutGraph(buildGraph(REVIEW)));
    const twice = renderSvg(layoutGraph(buildGraph(REVIEW)));
    expect(twice).toBe(once);
    expect(renderSvg(fixture("research-desk"))).toBe(renderSvg(fixture("research-desk")));
  });
});
