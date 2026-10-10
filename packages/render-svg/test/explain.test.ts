// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { stepLegend } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { EXPLAIN_COLOURS, EXPLAIN_TEXT } from "../src/explain.js";
import { explainHtml, renderSvg, type ExplainPage } from "../src/index.js";
import { contrastRatio } from "./svg-structure.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

function page(overrides: Partial<ExplainPage> = {}): ExplainPage {
  const graph = loadGraph(`${examples}diamond.yaml`);
  return {
    name: graph.spec.name,
    goal: graph.spec.goal ?? "",
    svg: renderSvg(layoutGraph(graph), { header: false, embedFont: false, steps: "numbers" }),
    steps: stepLegend(graph),
    target: "claude-code",
    directory: false,
    files: [{ path: "diamond.workflow.mjs", lines: 10, note: "the script" }],
    lint: { rules: [], layersBefore: 4, layersAfter: 4, repairs: [] },
    ...overrides,
  };
}

describe("explainHtml", () => {
  it("has the three panels under one h1, and a skip link to the steps", () => {
    const html = explainHtml(page());
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('id="loop-heading"');
    expect(html).toContain('id="steps-heading"');
    expect(html).toContain('id="made-heading"');
    expect(html).toContain('<a class="skip" href="#steps">');
    expect(html).toContain('id="steps" tabindex="-1"');
  });

  it("gives the picture a text alternative", () => {
    expect(explainHtml(page())).toMatch(/role="img" aria-label="Diagram of diamond: 8 steps in 4 waves/);
  });

  it("escapes what it is handed", () => {
    const html = explainHtml(page({ name: "<b>x</b>", goal: 'a "goal" & more' }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a &quot;goal&quot; &amp; more");
    expect(html).not.toContain("<b>x</b>");
  });

  it("draws a directory as a tree of folders", () => {
    const html = explainHtml(
      page({
        target: "managed-agents",
        directory: true,
        files: [
          { path: "README.md", lines: 3, note: "readme" },
          { path: "agents/a/agent.md", lines: 4, note: "agent a" },
          { path: "agents/b/agent.md", lines: 5, note: "agent b" },
        ],
      }),
    );
    expect(html.match(/<li class="dir"><span class="path">agents\/<\/span>/g)).toHaveLength(1);
    expect(html).toContain('<span class="path">a/</span>');
    expect(html.match(/<span class="path">agent\.md<\/span>/g)).toHaveLength(2);
  });

  it("only says the spec is clean when it is", () => {
    expect(explainHtml(page())).toContain("No findings.");
    const html = explainHtml(
      page({
        lint: {
          rules: [{ rule: "SELF_GRADING", severity: "warn", messages: ["grades itself"] }],
          layersBefore: 4,
          layersAfter: 4,
          repairs: [],
        },
      }),
    );
    expect(html).not.toContain("No findings.");
    expect(html).toContain("<code>SELF_GRADING</code>");
    expect(html).toContain("<li>grades itself</li>");
  });

  it("carries the font once, with its licence notice", () => {
    const html = explainHtml(page());
    expect(html.match(/@font-face/g)).toHaveLength(1);
    expect(html).toContain("SIL Open Font");
    expect(explainHtml(page({ embedFont: false }))).not.toContain("@font-face");
  });

  it("is the same bytes for the same input", () => {
    expect(explainHtml(page())).toBe(explainHtml(page()));
  });
});

describe("explain page colours", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`every text colour reads as body text in ${scheme}`, () => {
      const colours = EXPLAIN_COLOURS[scheme];
      for (const name of EXPLAIN_TEXT) {
        for (const bg of [colours.page, colours.panel]) {
          expect(contrastRatio(colours[name], bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
