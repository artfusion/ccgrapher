// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, parseSpec, withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
// Relative, because render-svg does not (and should not) depend on the linter.
import { RULE_ORDER, lint, renderMarksFor } from "../../lint/src/index.js";
import { renderSvg } from "../src/index.js";
import { checkSvg, contrastRatio, keyOf, type Violation } from "./svg-structure.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const specs = readdirSync(examples)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  .sort();

/** daily-brief broken three ways, for the marks no example draws: the rules about what one run hands the next. */
const variants = fileURLToPath(new URL("../../lint/test/fixtures/daily-brief/", import.meta.url));
const variantSpecs = readdirSync(variants)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  .sort();

/** research-desk with the tiers moved, for the marks about who does the work. */
const desks = fileURLToPath(new URL("../../lint/test/fixtures/research-desk/", import.meta.url));
const deskSpecs = readdirSync(desks)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  .sort();

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Every other spec in the repository: test fixtures anywhere, and the plugin's template. */
const fixtureDirs = (["packages", "apps"] as const).flatMap((top) =>
  readdirSync(`${root}${top}`)
    .map((pkg) => `${root}${top}/${pkg}/test/fixtures/`)
    .filter((dir) => existsSync(dir)),
);
const others = [
  ...fixtureDirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => `${dir}${f}`),
  ),
  ...readdirSync(`${root}plugin/skills`, { recursive: true, encoding: "utf8" }).map((f) => `${root}plugin/skills/${f}`),
]
  .filter((f) => f.endsWith(".yaml"))
  .filter((f) => !f.startsWith(variants) && !f.startsWith(desks))
  .map((f) => f.slice(root.length).replace(/\.yaml$/, ""))
  .sort();

interface Render {
  label: string;
  svg: string;
  violations: Violation[];
}

/** Render a graph as `ccg render` does: every finding lint makes of it, marked. */
function render(
  label: string,
  graph: Graph,
  options: { plain?: boolean; title?: string; steps?: "legend" } = {},
): Render {
  const raw = lint(graph).findings.filter((f) => f.phase === "raw");
  const marks = options.plain ? {} : renderMarksFor(raw);
  const layout = layoutGraph(graph);
  const svg = renderSvg(layout, { ...marks, ...(options.title && { title: options.title }), ...(options.steps && { steps: options.steps }) });
  return { label, svg, violations: checkSvg(svg, layout) };
}

/**
 * Every render a user can ask for: the graph as written with its findings marked
 * (rings, captions, dead edges, shared-write lines, as `ccg render` does by
 * default), the same with `--plain`, and, where there is anything to repair, the
 * repaired graph with its own findings (`--fix`), and both again with the
 * steps numbered and the legend written under them (`--legend`).
 */
function renders(name: string, dir = examples): Render[] {
  const original: Graph = loadGraph(`${dir}${name}.yaml`);
  const result = lint(original);

  const out = [
    render(name, original),
    render(`${name} (plain)`, original, { plain: true }),
    render(`${name} (steps)`, original, { steps: "legend" }),
  ];
  if (result.repairs.length > 0) {
    const title = `${name} (repaired)`;
    const repaired = withEdges(original, result.repairedEdges);
    out.push(render(title, repaired, { title }));
    out.push(render(`${name} (repaired, steps)`, repaired, { title, steps: "legend" }));
  }
  return out;
}

/**
 * Pictures the examples do not draw: several findings on one box, a fitted
 * caption beside a wrong guard, writers that share a row with a stranger between
 * them, and writers a row apart, whose line has to go round by the margin.
 */
const CROWDED = {
  /** judge: an input nobody supplies, its own grader, and no count guard. Three findings, one caption. */
  "several findings on one node": `
version: 1
name: several findings
nodes:
  - { id: start, label: split the work, kind: split, in: { q: string }, out: { a: string, b: string } }
  - { id: left, label: left half, kind: worker, in: { a: string }, out: { x: string } }
  - { id: right, label: right half, kind: worker, in: { b: string }, out: { y: string } }
  - { id: judge, label: judge, kind: verifier, in: { x: string, y: string, rubric: string }, out: { verdict: string } }
edges:
  - { from: start, to: left, carries: [a] }
  - { from: start, to: right, carries: [b] }
  - { from: left, to: judge, carries: [x] }
  - { from: right, to: judge, carries: [y] }
`,
  /** The same judge declaring a wrong guard, so the caption has to fit beside `3 ≠ 2`. */
  "a caption beside a wrong guard": `
version: 1
name: caption and guard
nodes:
  - { id: start, label: split the work, kind: split, in: { q: string }, out: { a: string, b: string } }
  - { id: left, label: left half, kind: worker, in: { a: string }, out: { x: string } }
  - { id: right, label: right half, kind: worker, in: { b: string }, out: { y: string } }
  - { id: judge, label: judge, kind: verifier, freshContext: true, expects: 3, in: { x: string, y: string, acceptance_criteria: string }, out: { verdict: string } }
edges:
  - { from: start, to: left, carries: [a] }
  - { from: start, to: right, carries: [b] }
  - { from: left, to: judge, carries: [x] }
  - { from: right, to: judge, carries: [y] }
`,
  /** Three writers of one log on a row, one fanning out, and a clean node in among them. */
  "three writers on one row": `
version: 1
name: three writers
nodes:
  - { id: plan, label: plan the sweep, kind: split, in: { q: string }, out: { scope: string } }
  - { id: w1, label: sweep the api, kind: worker, in: { scope: string }, out: { r1: string }, writes: [logs/sweep.log] }
  - { id: clean, label: sweep the docs, kind: worker, in: { scope: string }, out: { r2: string } }
  - { id: w3, label: sweep the cli, kind: worker, fanOut: { over: scope, cap: 4 }, in: { scope: string }, out: { r3: string }, writes: [logs/sweep.log] }
  - { id: w4, label: sweep the web app, kind: worker, in: { scope: string }, out: { r4: string }, writes: [logs/sweep.log, build/cache.json] }
  - { id: merge, label: merge, kind: reduce, model: null, expects: 4, in: { r1: string, r2: string, r3: string, r4: string }, out: { all: string } }
edges:
  - { from: plan, to: w1, carries: [scope] }
  - { from: plan, to: clean, carries: [scope] }
  - { from: plan, to: w3, carries: [scope] }
  - { from: plan, to: w4, carries: [scope] }
  - { from: w1, to: merge, carries: [r1] }
  - { from: clean, to: merge, carries: [r2] }
  - { from: w3, to: merge, carries: [r3] }
  - { from: w4, to: merge, carries: [r4] }
`,
  /** stamp on the top row and report below it, with no path between: one file, two rows. */
  "writers a row apart": `
version: 1
name: writers a row apart
nodes:
  - { id: a, label: gather the notes, kind: split, in: { q: string }, out: { notes: string } }
  - { id: stamp, label: stamp the version, kind: worker, in: { q: string }, out: { v: string }, writes: [dist/CHANGES.md] }
  - { id: tag, label: tag the release, kind: worker, in: { v: string }, out: { t: string } }
  - { id: report, label: write the changes, kind: synthesize, in: { notes: string }, out: { doc: string }, writes: [dist/CHANGES.md] }
edges:
  - { from: a, to: report, carries: [notes] }
  - { from: stamp, to: tag, carries: [v] }
`,
  /**
   * An urgent step at the end of a chain, so the chain is washed and the step is
   * marked: a fanned ancestor, a ring on the urgent step itself, and a high step
   * on its own beside them.
   */
  "an urgent step and the chain it pulls": `
version: 1
name: urgent chain
nodes:
  - { id: plan, label: plan the fix, kind: split, in: { q: string }, out: { file: string } }
  - { id: scan, label: scan each file, kind: worker, fanOut: { over: file, cap: 4 }, in: { file: string }, out: { hit: string } }
  - { id: docs, label: update the docs, kind: worker, priority: high, in: { file: string }, out: { page: string } }
  - { id: fix, label: patch the hole, kind: verifier, priority: urgent, prioritySetBy: on-call, in: { hit: string }, out: { patch: string } }
edges:
  - { from: plan, to: scan, carries: [file] }
  - { from: plan, to: docs, carries: [file] }
  - { from: scan, to: fix, carries: [hit] }
`,
} as const;

const crowded = (): Render[] =>
  Object.entries(CROWDED).flatMap(([label, yaml]) => [
    render(label, buildGraph(parseSpec(yaml))),
    render(`${label} (steps)`, buildGraph(parseSpec(yaml)), { steps: "legend" }),
  ]);

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
  const all = [
    ...specs.flatMap((n) => renders(n)),
    ...variantSpecs.flatMap((n) => renders(n, variants)),
    ...deskSpecs.flatMap((n) => renders(n, desks)),
    ...others.flatMap((n) => renders(n, root)),
    ...crowded(),
  ];

  it("covers every example spec, as written, plain and repaired", () => {
    expect(specs.length).toBeGreaterThanOrEqual(6);
    expect(all.some((r) => r.label.endsWith("(repaired)"))).toBe(true);
    expect(all.some((r) => r.label.endsWith("(plain)"))).toBe(true);
  });

  it("covers every other spec in the repository too: the test fixtures and the plugin's template", () => {
    expect(others).toContain("packages/lint/test/fixtures/ledger/plan-guarded");
    expect(others).toContain("apps/cli/test/fixtures/run-gate");
    expect(others).toContain("plugin/skills/parallel-plan/template");
    for (const name of others) expect(all.some((r) => r.label === name)).toBe(true);
  });

  it("draws a mark for every rule somewhere in the suite, so the marks are checked too", () => {
    const drawn = new Set(all.flatMap((r) => [...r.svg.matchAll(/data-findings?="([^"]+)"/g)].flatMap((m) => m[1]!.split(" "))));
    expect([...drawn].sort()).toEqual([...RULE_ORDER].sort());
    // The two corner cases the inline specs exist for.
    expect(all.some((r) => /data-link="[^"]+"/.test(r.svg) && r.label === "writers a row apart")).toBe(true);
    expect(all.find((r) => r.label === "several findings on one node")!.svg).toContain(">no rubric +2<");
    // And the urgency marks: a mark on the urgent and the high step, a wash on what they pull.
    const urgent = all.find((r) => r.label === "an urgent step and the chain it pulls")!.svg;
    expect(urgent.match(/data-mark="priority"/g)).toHaveLength(2);
    expect(urgent.match(/data-wash="priority"/g)).toHaveLength(4);
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
    const again = [
    ...specs.flatMap((n) => renders(n)),
    ...variantSpecs.flatMap((n) => renders(n, variants)),
    ...deskSpecs.flatMap((n) => renders(n, desks)),
    ...others.flatMap((n) => renders(n, root)),
    ...crowded(),
  ];
    expect(again.map((r) => r.svg)).toEqual(all.map((r) => r.svg));
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

  it("flags a step drawn off the row of its wave", () => {
    const moved = svg.replace(/(<g data-node="discover" [^>]*data-rank=")0"/, '$11"');
    expect(moved).not.toBe(svg);
    expect(geometry(moved).map(keyOf)).toContain("off-row|discover");
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

describe("the checker sees the finding marks", () => {
  const graph = buildGraph(parseSpec(CROWDED["three writers on one row"]));
  const layout = layoutGraph(graph);
  const { svg } = render("three writers", graph);

  it("reads a shared-write line as a route, and passes it as drawn", () => {
    expect(svg).toContain('data-link="w1~w4"');
    expect(checkSvg(svg, layout).filter((v) => v.rule !== "contrast")).toEqual([]);
  });

  it("flags a shared-write line drawn straight through the nodes between", () => {
    const at = (id: string) => layout.nodes.find((n) => n.id === id)!;
    const [w1, w4] = [at("w1"), at("w4")];
    const y = w1.y + w1.height / 2;
    const straight = svg.replace(
      /(<g data-link="w1~w4"[^>]*><path d=")[^"]*"/,
      `$1M${w1.x + w1.width} ${y} L${w4.x} ${y}"`,
    );
    expect(straight).not.toBe(svg);
    expect(checkSvg(straight, layout).map(keyOf)).toContain("edge-through-node|w1->w4 through clean");
  });
});

describe("contrast arithmetic", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });
});
