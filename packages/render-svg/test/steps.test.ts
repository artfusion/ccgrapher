// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { stepLegend, withEdges } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
// Relative, because render-svg does not (and should not) depend on the linter.
import { lint, renderMarksFor } from "../../lint/src/index.js";
import { renderSvg, wrapHtml } from "../src/index.js";
import { checkSvg } from "./svg-structure.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);
const numbersIn = (svg: string) => [...svg.matchAll(/data-step="([^"]+)" data-step-of="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
const sizeOf = (svg: string) => {
  const m = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg)!;
  return { width: Number(m[1]), height: Number(m[2]) };
};

describe("step numbers on the picture", () => {
  it("are off by default", () => {
    const svg = renderSvg(layoutGraph(fixture("diamond")));
    expect(svg).not.toContain("data-step");
    expect(svg).not.toContain("data-legend");
  });

  it("number every box once, in the order stepLegend gives", () => {
    const graph = fixture("diamond");
    const svg = renderSvg(layoutGraph(graph), { steps: "numbers" });
    expect(numbersIn(svg)).toEqual(stepLegend(graph).map((s) => `${s.number} ${s.id}`));
    expect(svg).not.toContain("data-legend");
  });

  it("number release-session repaired in its five waves", () => {
    const original = fixture("release-session");
    const repaired = withEdges(original, lint(original).repairedEdges);
    expect(numbersIn(renderSvg(layoutGraph(repaired), { steps: "numbers" }))).toEqual([
      "1 scope",
      "2a pr_hotfix",
      "2b pr_landing",
      "2c pr_new_site",
      "2d pr_pricing",
      "2e pr_byok",
      "2f pr_compare",
      "3a pr_credits",
      "3b pr_copy",
      "3c pr_links",
      "4 ci",
      "5 release",
    ]);
  });

  it("draw a fan-out's number once", () => {
    const svg = renderSvg(layoutGraph(fixture("wide-fanin")), { steps: "legend" });
    expect(numbersIn(svg).filter((n) => n.endsWith(" read"))).toEqual(["2 read"]);
    expect(svg.match(/one per page, up to 200/g)).toHaveLength(1);
  });

  it("leave every box, edge and mark where it was", () => {
    // The numbers are added on top; nothing they sit beside moves for them.
    const layout = layoutGraph(fixture("release-session"));
    const marks = renderMarksFor(lint(fixture("release-session")).findings.filter((f) => f.phase === "raw"));
    const plain = renderSvg(layout, { ...marks, grain: false });
    const numbered = renderSvg(layout, { ...marks, grain: false, steps: "numbers" });
    const withoutSteps = numbered.replace(/\n {4}<g data-step="[^"]+"[^\n]*<\/g>/g, "");
    expect(withoutSteps).toBe(plain);
  });
});

describe("the legend under the picture", () => {
  const graph = fixture("diamond");
  const layout = layoutGraph(graph);

  it("lists every step: number, label, and what it takes and gives", () => {
    const svg = renderSvg(layout, { steps: "legend" });
    const legend = svg.slice(svg.indexOf('<g data-legend="steps">'));
    expect(legend).toContain(">one run, step by step<");
    for (const step of stepLegend(graph)) {
      expect(legend).toContain(`>${step.number}<`);
      expect(legend).toContain(`>${step.label}<`);
      expect(legend).toContain(`>${step.line}<`);
    }
  });

  it("grows the canvas to hold it, by a computed amount", () => {
    const without = sizeOf(renderSvg(layout, { steps: "numbers" }));
    const withLegend = sizeOf(renderSvg(layout, { steps: "legend" }));
    expect(withLegend.height).toBeGreaterThan(without.height);
    expect(withLegend.width).toBeGreaterThanOrEqual(without.width);
  });

  it("is byte-identical across renders", () => {
    for (const name of ["diamond", "release-session", "research-desk", "wide-fanin"]) {
      const a = renderSvg(layoutGraph(fixture(name)), { steps: "legend" });
      const b = renderSvg(layoutGraph(fixture(name)), { steps: "legend" });
      expect(a).toBe(b);
    }
  });

  it("changes where the waves change, as a before and an after", () => {
    const original = fixture("release-session");
    const before = renderSvg(layoutGraph(original), { steps: "legend" });
    const after = renderSvg(layoutGraph(withEdges(original, lint(original).repairedEdges)), { steps: "legend" });
    expect(numbersIn(before)).toContain("12 release");
    expect(numbersIn(after)).toContain("5 release");
    expect(numbersIn(after)).toContain("2f pr_compare");
  });
});

describe("the checker sees the numbers", () => {
  const layout = layoutGraph(fixture("diamond"));
  const svg = renderSvg(layout, { steps: "legend" });

  it("passes them as drawn", () => {
    expect(checkSvg(svg, layout).filter((v) => v.rule !== "contrast")).toEqual([]);
  });

  it("flags a number moved onto a box", () => {
    const worker = layout.nodes.find((n) => n.id === "worker_3")!;
    const moved = svg.replace(
      /(<g data-step="2c" data-step-of="worker_3"><rect x=")[^"]+(" y=")[^"]+"/,
      `$1${worker.x + 20}$2${worker.y + 10}"`,
    );
    expect(moved).not.toBe(svg);
    expect(checkSvg(moved, layout).map((v) => v.rule)).toContain("step-collision");
  });

  it("flags a number nearer another box than its own", () => {
    const other = layout.nodes.find((n) => n.id === "worker_4")!;
    const moved = svg.replace(
      /(<g data-step="2c" data-step-of="worker_3"><rect x=")[^"]+(" y=")[^"]+"/,
      `$1${other.x + 30}$2${other.y - 34}"`,
    );
    expect(checkSvg(moved, layout).map((v) => v.subject)).toContain("2c of worker_3 against nearer worker_4");
  });

  it("flags a legend drawn over the graph", () => {
    const over = svg.replace('<g data-legend="steps">', '<g data-legend="steps" transform="translate(0 -400)">');
    expect(checkSvg(over, layout).map((v) => v.rule)).toContain("legend-overlap");
  });
});

describe("the html legend", () => {
  const graph = fixture("diamond");
  const steps = stepLegend(graph);
  const page = wrapHtml(renderSvg(layoutGraph(graph), { steps: "numbers" }), { title: "diamond", steps });

  it("is a semantic list with a heading, one item a step", () => {
    expect(page).toContain('<aside id="legend" aria-labelledby="legend-heading">');
    expect(page).toContain('<h2 id="legend-heading">One run, step by step</h2>');
    expect(page.match(/<li>/g)).toHaveLength(steps.length);
    expect(page).toContain(
      '<li><span class="number">2a</span><span class="label">worker 1</span><span class="line">takes angle; gives claim, source, date</span></li>',
    );
  });

  it("sizes in rem and moves under the picture on a narrow screen", () => {
    expect(page).toContain("width: 24rem");
    expect(page).toContain("@media (max-width: 48rem)");
  });

  it("is absent by default, leaving the page as it was", () => {
    const svg = renderSvg(layoutGraph(graph));
    expect(wrapHtml(svg, { title: "diamond", steps: [] })).toBe(wrapHtml(svg, { title: "diamond" }));
    expect(wrapHtml(svg)).not.toContain("legend");
  });
});
