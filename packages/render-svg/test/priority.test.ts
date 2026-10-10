// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { renderSvg } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

/** Nodes are emitted one group after another, so slice to the next one. */
function groupFor(svg: string, id: string): string {
  const start = svg.indexOf(`<g data-node="${id}"`);
  if (start < 0) throw new Error(`no group for ${id}`);
  const next = svg.indexOf('<g data-node="', start + 1);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}

/** research-desk with one urgent skeptic, so plan, research and dedupe inherit it. */
function urgentDesk(extra: Record<string, unknown> = { priority: "urgent", prioritySetBy: "on-call" }): Graph {
  const plain = loadGraph(`${examples}research-desk.yaml`);
  return buildGraph({
    ...plain.spec,
    nodes: plain.spec.nodes.map((node) => (node.id === "skeptic_source" ? { ...node, ...extra } : node)),
  });
}

describe("urgency in the picture", () => {
  const plain = loadGraph(`${examples}research-desk.yaml`);
  const svg = renderSvg(layoutGraph(urgentDesk()));

  it("moves nothing: the waves are dependency truth", () => {
    const at = (graph: Graph) => layoutGraph(graph).nodes.map((n) => [n.id, n.rank, n.x, n.y, n.width, n.height]);
    expect(at(urgentDesk())).toEqual(at(plain));
  });

  it("marks the urgent step and says who set it", () => {
    const fix = groupFor(svg, "skeptic_source");
    expect(fix).toContain('data-priority="urgent"');
    expect(fix).toContain('data-priority-set-by="on-call"');
    expect(fix).not.toContain("data-priority-from");
    expect(fix).toContain("<title>urgent, set by on-call</title>");
    expect(fix).toContain('data-mark="priority"');
    expect(fix).toContain('data-wash="priority"');
    // Two chevrons for urgent.
    expect(fix.match(/<polygon /g)).toHaveLength(2);
  });

  it("washes every step it waits on, without a mark, naming the step that needs it", () => {
    for (const id of ["plan", "research", "dedupe"]) {
      const group = groupFor(svg, id);
      expect(group).toContain('data-priority="urgent"');
      expect(group).toContain('data-priority-from="skeptic_source"');
      expect(group).toContain("<title>urgent, needed by skeptic_source</title>");
      expect(group).toContain('data-wash="priority"');
      expect(group).not.toContain('data-mark="priority"');
    }
  });

  it("leaves the steps that do not lead to it alone", () => {
    for (const id of ["skeptic_correct", "skeptic_current", "vote", "report", "gate"]) {
      const group = groupFor(svg, id);
      expect(group).not.toContain("priority");
      expect(group).not.toContain("<title>");
    }
  });

  it("draws one chevron for high", () => {
    const high = groupFor(renderSvg(layoutGraph(urgentDesk({ priority: "high" }))), "skeptic_source");
    expect(high).toContain('data-priority="high"');
    expect(high.match(/<polygon /g)).toHaveLength(1);
  });

  it("draws exactly the old picture when nothing is raised", () => {
    const before = renderSvg(layoutGraph(plain));
    expect(renderSvg(layoutGraph(urgentDesk({ priority: "normal", prioritySetBy: "on-call" })))).toBe(before);
    expect(before).not.toMatch(/priority/);
  });
});
