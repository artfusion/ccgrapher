// SPDX-License-Identifier: Apache-2.0
import { buildGraph, parseSpec, type WorkflowSpec } from "@ccgrapher/core";
import { describe, expect, it } from "vitest";
import { candidateId, checkCandidate, deriveEdges, describePlacement, placeCandidate } from "../src/index.js";

const SITE: WorkflowSpec = parseSpec(`
version: 1
name: site
nodes:
  - { id: palette, label: Pick the palette, kind: worker, out: { palette: string } }
  - { id: stylesheet, label: Write the stylesheet, kind: worker, in: { palette: string }, out: { css: string }, writes: [site.css] }
  - { id: publish, label: Publish, kind: worker, in: { css: string, banner: string }, out: { url: string } }
edges:
  - { from: palette, to: stylesheet, carries: [palette] }
  - { from: stylesheet, to: publish, carries: [css] }
`);

const font = {
  id: "deeper_blue",
  label: "Make the homepage font a deeper blue",
  kind: "worker",
  model: "cheap",
  in: { css: "string" },
  out: { css_tweak: "string" },
  writes: ["site.css"],
};

describe("deriveEdges", () => {
  it("reads inbound edges off the fields a candidate takes", () => {
    expect(deriveEdges(SITE, parseNode(font))).toEqual([
      { from: "stylesheet", to: "deeper_blue", carries: ["css"] },
    ]);
  });

  it("hands a field only to a step that has nothing supplying it", () => {
    const banner = parseNode({ id: "banner", label: "Draw a banner", kind: "worker", out: { banner: "png", css: "string" } });
    // publish already gets css from the stylesheet; banner is the gap.
    expect(deriveEdges(SITE, banner)).toEqual([{ from: "banner", to: "publish", carries: ["banner"] }]);
  });
});

describe("checkCandidate", () => {
  it("places a step after what it reads, and says so in one sentence", () => {
    const check = checkCandidate(SITE, font);
    expect(check.refusal).toBeUndefined();
    expect(check.placement).toEqual({
      wave: 3,
      sentence: "Placed in wave 3, after “Write the stylesheet”, which it reads css from.",
    });
    expect(check.spec?.nodes.map((n) => n.id)).toContain("deeper_blue");
  });

  it("reports the linter's findings that name the candidate", () => {
    // Reading the palette puts it in the stylesheet's own wave, and both write
    // site.css: the collision the linter calls a hidden edge.
    const rival = { ...font, id: "rival", in: { palette: "string" } };
    const check = checkCandidate(SITE, rival);
    expect(check.findings.map((f) => f.rule)).toContain("HIDDEN_EDGE");
  });

  it("refuses a step that is not a valid step, with the reason", () => {
    const check = checkCandidate(SITE, { ...font, kind: "wizard" });
    expect(check.refusal).toMatch(/not a valid step.*kind/);
    expect(check.spec).toBeUndefined();
  });

  it("refuses to give a started step a new input", () => {
    const banner = { id: "banner", label: "Draw a banner", kind: "worker", out: { banner: "png" } };
    const check = checkCandidate(SITE, banner, new Set(["palette", "stylesheet", "publish"]));
    expect(check.refusal).toMatch(/“Publish” \(banner\).*already started/);
    expect(check.spec).toBeUndefined();
  });

  it("lets a candidate read from a step that has started", () => {
    const check = checkCandidate(SITE, font, new Set(["palette", "stylesheet"]));
    expect(check.refusal).toBeUndefined();
  });

  it("refuses a candidate that would close a loop", () => {
    const loop = { id: "loop", label: "Loop", kind: "worker", in: { url: "string" }, out: { banner: "png" } };
    expect(checkCandidate(SITE, loop).refusal).toMatch(/cycle/);
  });
});

describe("describePlacement", () => {
  it("says a step with no inputs can start at once, and what it hands on", () => {
    const banner = parseNode({ id: "banner", label: "Draw a banner", kind: "worker", out: { banner: "png" } });
    const graph = buildGraph(placeCandidate(SITE, banner).spec);
    expect(describePlacement(graph, "banner").sentence).toBe(
      "Placed in wave 1: it reads nothing another step makes, so it can start at once; it hands banner to “Publish”.",
    );
  });
});

describe("candidateId", () => {
  it("slugs the label and keeps it unique", () => {
    expect(candidateId("Make the font blue!", [])).toBe("make_the_font_blue");
    expect(candidateId("Publish", ["publish"])).toBe("publish_2");
    expect(candidateId("???", [])).toBe("step");
  });
});

function parseNode(raw: unknown) {
  return parseSpec(JSON.stringify({ version: 1, name: "x", nodes: [raw] })).nodes[0]!;
}
