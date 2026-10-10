// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
// Relative, because render-svg does not (and should not) depend on the linter.
import { lint } from "../../lint/src/index.js";
import { renderSvg } from "../src/index.js";
import { checkSvg, contrastRatio, keyOf, type Violation } from "./svg-structure.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const specs = readdirSync(examples)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  .sort();

/**
 * Every render a user can ask for: the graph as written (dead edges drawn red,
 * as `ccg render` does by default) and, where there is anything to repair, the
 * repaired graph (`--fix`).
 */
function renders(name: string): Array<{ label: string; svg: string; violations: Violation[] }> {
  const original: Graph = loadGraph(`${examples}${name}.yaml`);
  const result = lint(original);
  const fakeEdges = result.findings.filter((f) => f.rule === "FAKE_EDGE" && f.edge).map((f) => f.edge!);

  const variants = [{ label: name, graph: original, fakeEdges, title: undefined as string | undefined }];
  if (fakeEdges.length > 0) {
    variants.push({
      label: `${name} (repaired)`,
      graph: withEdges(original, result.repairedEdges),
      fakeEdges: [],
      title: `${name} (repaired)`,
    });
  }
  return variants.map((v) => {
    const layout = layoutGraph(v.graph);
    const svg = renderSvg(layout, { fakeEdges: v.fakeEdges, ...(v.title && { title: v.title }) });
    return { label: v.label, svg, violations: checkSvg(svg, layout) };
  });
}

/**
 * Known faults, each named and given a reason. A render may break a rule only if
 * it is listed here; and a listed fault that no longer occurs fails the suite,
 * so this list can only shrink. `render` is a label from `renders()`, or `*` for
 * a fault that belongs to the theme and so appears in every picture.
 */
const KNOWN: ReadonlyArray<{ render: string; key: string; reason: string }> = [
  {
    render: "*",
    key: "contrast|graphic #E8763A on #FBF7F0",
    reason: "the accent orange draws every edge, arrow head and the title underline at 2.78:1 on the paper; it needs a darker accent",
  },
  {
    render: "*",
    key: "contrast|graphic #E8763A on #FFFFFF",
    reason: "the accent orange icon on a white agent node is 2.97:1; it is the same accent colour as the edges",
  },
  {
    render: "*",
    key: "contrast|graphic #E8763A on #FDEFE6",
    reason: "the accent orange icon on a verifier node is 2.64:1; it is the same accent colour as the edges",
  },
  {
    render: "*",
    key: "contrast|graphic #E8763A on #FBE3D3",
    reason: "the accent orange icon on a synthesize node is 2.40:1; it is the same accent colour as the edges",
  },
  {
    render: "*",
    key: "contrast|text #8A817A on #FBF7F0",
    reason: "the muted goal caption under the title is 3.57:1 on the paper, short of 4.5:1 for body text",
  },
  {
    render: "*",
    key: "contrast|text #E8763A on #FFFFFF",
    reason: "the fan-out badge (x5, x20) is accent orange text on a white node, 2.96:1",
  },
  {
    render: "*",
    key: "contrast|graphic #2B2724 at 0.225 opacity on #FBF7F0",
    reason: "the back copy of a fan-out stack fades by design; the xN badge also says the node fans out",
  },
  {
    render: "*",
    key: "contrast|graphic #2B2724 at 0.45 opacity on #FBF7F0",
    reason: "the front copy of a fan-out stack fades by design; the xN badge also says the node fans out",
  },
  {
    render: "*",
    key: "contrast|graphic #8A817A at 0.8 opacity on #FBF7F0",
    reason: "the dashed worktree halo is thin and faded, 2.63:1; nothing else in the picture says the node is isolated",
  },
];

const matches = (entry: { render: string; key: string }, label: string, v: Violation) =>
  (entry.render === "*" || entry.render === label) && entry.key === keyOf(v);

describe("structural lint over every example", () => {
  const all = specs.flatMap(renders);

  it("covers every example spec, as written and repaired", () => {
    expect(specs.length).toBeGreaterThanOrEqual(6);
    expect(all.some((r) => r.label.endsWith("(repaired)"))).toBe(true);
  });

  it.each(all.map((r) => [r.label, r] as const))("%s has no unlisted violations", (label, r) => {
    const unlisted = r.violations.filter((v) => !KNOWN.some((k) => matches(k, label, v)));
    expect(unlisted.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it("lists no fault that has since been fixed", () => {
    const stale = KNOWN.filter((k) => !all.some((r) => r.violations.some((v) => matches(k, r.label, v))));
    expect(stale.map((k) => `${k.render} ${k.key}`)).toEqual([]);
  });

  it("is deterministic", () => {
    const again = specs.flatMap(renders);
    expect(again.map((r) => r.violations)).toEqual(all.map((r) => r.violations));
  });

  it("agrees with and without the layout to hand", () => {
    // The layout only sharpens the numbers; it must not change the verdict on
    // a well-formed picture.
    const layout = layoutGraph(loadGraph(`${examples}diamond.yaml`));
    const svg = renderSvg(layout);
    expect(checkSvg(svg).map(keyOf)).toEqual(checkSvg(svg, layout).map(keyOf));
  });
});

describe("the checker catches what it is for", () => {
  // A hand-made picture with one fault of every kind, in the markup renderSvg uses.
  const BROKEN = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#FFFFFF"/>
  <g data-edge="a->c"><path d="M60 50 L60 250" fill="none" stroke="#2B2724" stroke-width="2"/><text x="70" y="140" font-size="14" fill="#E8E8E8">carries no data</text></g>
  <g data-node="a" data-kind="worker" data-rank="0"><rect x="10" y="10" width="100" height="40" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/><text font-size="17" fill="#2B2724" text-anchor="middle"><tspan x="60" y="35">a</tspan></text></g>
  <g data-node="b" data-kind="worker" data-rank="1"><rect x="40" y="110" width="100" height="60" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/><text font-size="17" fill="#2B2724" text-anchor="middle"><tspan x="90" y="145">a label far too long for this box</tspan></text></g>
  <g data-node="c" data-kind="worker" data-rank="2"><rect x="30" y="230" width="100" height="40" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/></g>
  <g data-node="d" data-kind="worker" data-rank="1"><rect x="100" y="150" width="100" height="40" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/></g>
</svg>`;

  const found = checkSvg(BROKEN);

  it("flags nodes drawn on top of each other", () => {
    expect(found.map(keyOf)).toContain("node-overlap|b / d");
  });

  it("flags an edge routed through a node it does not touch", () => {
    expect(found.map(keyOf)).toContain("edge-through-node|a->c through b");
  });

  it("flags a label that runs into a node", () => {
    expect(found.map(keyOf)).toContain('label-clipped|"carries no data" on a->c against b');
  });

  it("flags text that overflows its box", () => {
    expect(found.map(keyOf)).toContain('text-overflow|"a label far too long for this box" in b');
  });

  it("flags text too pale for the page", () => {
    expect(found.map(keyOf)).toContain("contrast|text #E8E8E8 on #FFFFFF");
  });

  it("flags text cut off by the edge of the canvas", () => {
    const cut = BROKEN.replace('x="70" y="140"', 'x="350" y="140"');
    expect(checkSvg(cut).some((v) => v.rule === "label-clipped" && v.subject.endsWith("off the canvas"))).toBe(true);
  });

  it("passes a tidy picture", () => {
    const tidy = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
  <rect width="300" height="200" fill="#FFFFFF"/>
  <g data-edge="a->b"><path d="M60 50 L60 130" fill="none" stroke="#2B2724" stroke-width="2"/></g>
  <g data-node="a"><rect x="10" y="10" width="100" height="40" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/><text font-size="17" fill="#2B2724" text-anchor="middle"><tspan x="60" y="35">a</tspan></text></g>
  <g data-node="b"><rect x="10" y="130" width="100" height="40" fill="#FFFFFF" stroke="#2B2724" stroke-width="1.6"/><text font-size="17" fill="#2B2724" text-anchor="middle"><tspan x="60" y="155">b</tspan></text></g>
</svg>`;
    expect(checkSvg(tidy)).toEqual([]);
  });
});

describe("the checker sees the real markup", () => {
  const layout = layoutGraph(loadGraph(`${examples}route-auth-audit.yaml`));
  const svg = renderSvg(layout);
  const geometry = (markup: string, l = layout) => checkSvg(markup, l).filter((v) => v.rule !== "contrast");

  it("finds nothing wrong with a well-formed render", () => {
    expect(geometry(svg)).toEqual([]);
  });

  it("flags a node copied on top of another", () => {
    const start = svg.indexOf('<g data-node="discover"');
    const end = svg.indexOf('<g data-node="audit"');
    const ghost = svg.slice(start, end).replace('data-node="discover"', 'data-node="ghost"');
    expect(geometry(svg.slice(0, end) + ghost + svg.slice(end)).map(keyOf)).toContain("node-overlap|discover / ghost");
  });

  it("flags a label longer than its box", () => {
    const long = svg.replace(">list route files<", ">list every route file in the whole repository<");
    expect(geometry(long).map((v) => v.rule)).toContain("text-overflow");
  });

  it("flags a route drawn straight through a node, using the layout's own numbers", () => {
    const root = layout.nodes[0]!;
    const sink = layout.nodes[layout.nodes.length - 1]!;
    const through = {
      ...layout,
      edges: layout.edges.map((e, i) =>
        i === 0
          ? { ...e, points: [{ x: root.x + root.width / 2, y: root.y }, { x: sink.x + sink.width / 2, y: sink.y }] }
          : e,
      ),
    };
    expect(geometry(svg, through).map((v) => v.rule)).toContain("edge-through-node");
  });
});

describe("boundary regions pass the checker", () => {
  // No example splits a boundary, so build one that must: the odd workers of the
  // diamond, with an even worker between each pair.
  const graph = buildGraph({
    ...loadGraph(`${examples}diamond.yaml`).spec,
    boundaries: [{ id: "odd", label: "odd workers", members: ["worker_1", "worker_3", "worker_5"], access: "read-only" }],
  });
  const layout = layoutGraph(graph);
  const svg = renderSvg(layout);

  it("splits into one region per member and adds no violation of its own", () => {
    expect(layout.regions).toHaveLength(3);
    const plain = renderSvg(layoutGraph(loadGraph(`${examples}diamond.yaml`)));
    expect(checkSvg(svg, layout).map(keyOf)).toEqual(checkSvg(plain).map(keyOf));
  });
});

describe("contrast arithmetic", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });
});
