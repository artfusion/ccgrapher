// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { buildGraph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, renderSvg } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => layoutGraph(loadGraph(`${examples}${name}.yaml`));

const ALL = [
  "diamond",
  "research-desk",
  "route-auth-audit",
  "linear-chain",
  "self-grading",
  "wide-fanin",
] as const;

describe("output shape", () => {
  it.each(ALL)("%s produces a self-contained svg", (name) => {
    const svg = renderSvg(fixture(name));
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // No external references: everything needed is inline.
    expect(svg).not.toMatch(/href=|<image/);
  });

  it.each(ALL)("%s declares a canvas that contains every drawn coordinate", (name) => {
    const svg = renderSvg(fixture(name));
    const declared = Number(/<svg[^>]*width="(\d+)"/.exec(svg)![1]);

    const xs: number[] = [];
    for (const [, d] of svg.matchAll(/ d="([^"]*)"/g)) {
      const nums = [...d.matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g)].map((m) => Number(m[0]));
      xs.push(...nums.filter((_, i) => i % 2 === 0));
    }
    // rough.js wobbles a few px outside the nominal box; allow for the stroke.
    expect(Math.max(...xs)).toBeLessThanOrEqual(declared);
  });

  it("emits one group per node, tagged with its rank", () => {
    const svg = renderSvg(fixture("diamond"));
    expect([...svg.matchAll(/data-node="/g)]).toHaveLength(8);
    expect([...svg.matchAll(/data-rank="1"/g)]).toHaveLength(5);
  });

  it("embeds the handwriting face so the file travels", () => {
    expect(renderSvg(fixture("diamond"))).toContain("@font-face");
    expect(renderSvg(fixture("diamond"), { embedFont: false })).not.toContain("@font-face");
  });

  // Embedding the woff2 makes every SVG a redistribution of the font, and
  // OFL-1.1 requires the notice to accompany it — so it has to be in the file.
  it("carries the OFL attribution wherever the font goes", () => {
    const svg = renderSvg(fixture("diamond"));
    expect(svg).toContain("SIL Open Font");
    expect(svg).toContain("Copyright 2014 The Caveat Project Authors");
    // Inside a comment, before anything is drawn.
    expect(svg.indexOf("<!--")).toBeLessThan(svg.indexOf("<defs>"));
  });

  it("omits the notice when there is no font to attribute", () => {
    const svg = renderSvg(fixture("diamond"), { embedFont: false });
    expect(svg).not.toContain("SIL Open Font");
    expect(svg).not.toContain("Caveat Project Authors");
  });

  it("is deterministic — same spec in, byte-identical svg out", () => {
    const positioned = fixture("research-desk");
    expect(renderSvg(positioned)).toBe(renderSvg(positioned));
  });
});

describe("node styling carries meaning", () => {
  // A no-model node draws sharp and crisp to signal "this is plain code, it
  // costs nothing"; an agent node draws sketchy.
  it("draws code-only nodes as sharp rects and agent nodes as rough paths", () => {
    const svg = renderSvg(fixture("linear-chain"));

    const collate = groupFor(svg, "collate");
    expect(collate).toMatch(/<rect /);
    expect(collate).not.toMatch(/<path d="M[^"]*C/);

    const writeReport = groupFor(svg, "write_report");
    expect(writeReport).toMatch(/<path /);
  });

  it("dashes the human gate", () => {
    expect(groupFor(renderSvg(fixture("research-desk")), "gate")).toContain("stroke-dasharray");
  });

  it("badges a fanOut node and haloes an isolated worktree", () => {
    const svg = renderSvg(fixture("route-auth-audit"));
    const audit = groupFor(svg, "audit");
    expect(audit).toContain(">x20<");
    expect(audit).toContain("stroke-dasharray=\"3 4\"");
  });

  it("gives every kind its own icon", () => {
    const svg = renderSvg(fixture("research-desk"));
    const kinds = new Set([...svg.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]));
    expect(kinds).toEqual(new Set(["split", "worker", "reduce", "verifier", "synthesize", "gate"]));
  });
});

describe("fake edges", () => {
  const fakes = [
    { from: "review_a", to: "review_b" },
    { from: "review_b", to: "lint_docs" },
  ];

  it("marks them red, dashed and labelled", () => {
    const svg = renderSvg(fixture("linear-chain"), { fakeEdges: fakes });
    expect([...svg.matchAll(/data-fake="true"/g)]).toHaveLength(2);
    expect(svg).toContain("carries no data");
    expect(svg).toContain(DEFAULT_THEME.danger);
  });

  it("leaves them alone when not asked", () => {
    const svg = renderSvg(fixture("linear-chain"));
    expect(svg).not.toContain("data-fake");
    expect(svg).not.toContain("carries no data");
  });

  it("records what a real edge carries", () => {
    expect(renderSvg(fixture("diamond"))).toContain('data-carries="claim, source, date"');
  });
});

describe("header", () => {
  it("captions with the name and goal, never as nodes", () => {
    const svg = renderSvg(fixture("diamond"));
    expect(svg).toContain(">diamond<");
    expect(svg).toContain("market scan: how do we compare to the top 3 competitors");
    // The goal is a caption. It must not have become an eighth box.
    expect([...svg.matchAll(/data-node="/g)]).toHaveLength(8);
  });

  it("can be turned off", () => {
    expect(renderSvg(fixture("diamond"), { header: false })).not.toContain(">diamond<");
  });

  it("widens the canvas when the goal line is longer than the graph", () => {
    // route-auth-audit is a narrow four-node column with a long goal.
    const positioned = fixture("route-auth-audit");
    const svg = renderSvg(positioned);
    const declared = Number(/<svg[^>]*width="(\d+)"/.exec(svg)![1]);

    expect(positioned.graph.spec.goal!.length).toBeGreaterThan(50);
    expect(declared).toBeGreaterThan(positioned.width);
    expect(renderSvg(positioned, { header: false })).toContain(`width="${positioned.width}"`);
  });
});

describe("escaping", () => {
  it("escapes markup in labels and goals", () => {
    // research-desk's goal contains "<question>".
    const svg = renderSvg(fixture("research-desk"));
    expect(svg).toContain("&lt;question&gt;");
    expect(svg).not.toContain("<question>");
  });
});

/** Nodes are emitted one group after another, so slice to the next one. */
function groupFor(svg: string, id: string): string {
  const start = svg.indexOf(`<g data-node="${id}"`);
  if (start < 0) throw new Error(`no group for ${id}`);
  const next = svg.indexOf('<g data-node="', start + 1);
  return next < 0 ? svg.slice(start) : svg.slice(start, next);
}

describe("count guards", () => {
  /** diamond with its checker's guard taken away, which is what lint flags as missing. */
  const unguarded = () => {
    const graph = loadGraph(`${examples}diamond.yaml`);
    return layoutGraph(
      buildGraph({
        ...graph.spec,
        nodes: graph.spec.nodes.map((n) => (n.id === "checker" ? { ...n, expects: undefined } : n)),
      }),
    );
  };
  const MISSING = [{ id: "checker", arriving: 5 }];
  const MISMATCH = [{ id: "ci", arriving: 8 }];

  it.each(["diamond", "research-desk"] as const)("%s draws the count it declares", (name) => {
    const positioned = fixture(name);
    const svg = renderSvg(positioned);
    const guarded = positioned.nodes.filter((n) => n.node.expects !== undefined);
    expect(guarded.length).toBeGreaterThan(0);
    for (const { node } of guarded) {
      const group = groupFor(svg, node.id);
      expect(group).toContain(`data-expects="${node.expects}"`);
      expect(group).toContain(`>expects ${node.expects}<`);
    }
    // A badge is a declaration, not a finding: nothing is warned about.
    expect(svg).not.toContain("data-guard");
    expect(svg).not.toContain("data-halo");
  });

  it("draws a guard that disagrees with lint as 'N ≠ M', in danger colour, with a halo", () => {
    const ci = groupFor(renderSvg(fixture("release-session"), { guardFindings: MISMATCH }), "ci");
    expect(ci).toContain('data-guard="mismatch"');
    expect(ci).toContain('data-expects="9"');
    expect(ci).toContain(`fill="${DEFAULT_THEME.dangerInk}" text-anchor="end">9 ≠ 8<`);
    expect(ci).toContain('data-halo="finding"');
    expect(ci).not.toContain("no count guard");
  });

  it("draws an unguarded fan-in with a halo and a caption", () => {
    const checker = groupFor(renderSvg(unguarded(), { guardFindings: MISSING }), "checker");
    expect(checker).toContain('data-guard="missing"');
    expect(checker).not.toContain("data-expects");
    expect(checker).toContain("no count guard");
    expect(checker).toContain('data-halo="finding"');
  });

  it("makes the halo solid: a finding is told apart by colour, never by a new dash", () => {
    const checker = groupFor(renderSvg(unguarded(), { guardFindings: MISSING }), "checker");
    const halo = /<rect data-halo="finding"[^>]*>/.exec(checker)![0];
    expect(halo).toContain(`stroke="${DEFAULT_THEME.danger}"`);
    expect(halo).not.toContain("stroke-dasharray");
  });

  it("draws no warn marks when nothing is passed in, and still draws the badge", () => {
    for (const svg of [renderSvg(unguarded()), renderSvg(fixture("release-session"))]) {
      expect(svg).not.toContain("data-guard");
      expect(svg).not.toContain("data-halo");
      expect(svg).not.toContain("no count guard");
    }
    expect(renderSvg(fixture("release-session"))).toContain('data-expects="9"');
  });

  it("ignores a finding for a node that is not in the graph", () => {
    const svg = renderSvg(fixture("diamond"), { guardFindings: [{ id: "nowhere", arriving: 3 }] });
    expect(svg).not.toContain("data-guard");
  });

  it("keeps the guard clear of the fan-out count", () => {
    // A node that fans out and also declares a count, so both marks are on one box.
    const graph = loadGraph(`${examples}route-auth-audit.yaml`);
    const both = layoutGraph(
      buildGraph({
        ...graph.spec,
        nodes: graph.spec.nodes.map((n) => (n.id === "audit" ? { ...n, expects: 20 } : n)),
      }),
    );
    const audit = groupFor(renderSvg(both), "audit");
    expect(audit).toContain(">x20<");
    expect(audit).toContain(">expects 20<");
    const y = (text: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*>${text}<`).exec(audit)![1]);
    // The fan-out count sits at the top of the box and the guard at the bottom.
    expect(y("expects 20")).toBeGreaterThan(y("x20") + 20);
  });

  it("is byte-identical across renders, findings included", () => {
    const positioned = fixture("release-session");
    expect(renderSvg(positioned, { guardFindings: MISMATCH })).toBe(
      renderSvg(positioned, { guardFindings: MISMATCH }),
    );
  });
});

describe("paper grain", () => {
  // Per-pixel noise is free in an SVG and ruinous in a PNG, so it has to be
  // switchable for anything headed to a rasteriser.
  it("is on by default and can be turned off", () => {
    expect(renderSvg(fixture("diamond"))).toContain("feTurbulence");

    const flat = renderSvg(fixture("diamond"), { grain: false });
    expect(flat).not.toContain("feTurbulence");
    expect(flat).not.toContain('filter="url(#grain)"');
    // The paper colour stays either way.
    expect(flat).toContain(DEFAULT_THEME.paper);
  });
});
