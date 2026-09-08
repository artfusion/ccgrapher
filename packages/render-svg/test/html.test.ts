// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { loadGraph } from "@ccgrapher/core/node";
import { layoutGraph } from "@ccgrapher/layout";
import { describe, expect, it } from "vitest";
import { renderSvg, wrapHtml } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => layoutGraph(loadGraph(`${examples}${name}.yaml`));

describe("wrapHtml", () => {
  it("carries the exact svg renderSvg produced", () => {
    const svg = renderSvg(fixture("diamond"));
    expect(wrapHtml(svg)).toContain(svg);
  });

  it("is a self-contained document — no script or stylesheet from a network host", () => {
    const html = wrapHtml(renderSvg(fixture("diamond")));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // xmlns and the font's OFL notice legitimately contain "http://" as text,
    // not as something the page fetches — only a src/href attribute matters.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/\bsrc="https?:/);
    expect(html).not.toMatch(/\bhref="https?:/);
  });

  it("respects prefers-reduced-motion for the one transition it uses", () => {
    const html = wrapHtml(renderSvg(fixture("diamond")));
    expect(html).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it("titles the page from the title option, escaped", () => {
    const html = wrapHtml(renderSvg(fixture("diamond")), { title: "<script>" });
    expect(html).toContain("<title>&lt;script&gt;</title>");
    expect(html).not.toContain("<title><script>");
  });

  it("falls back to a generic title when none is given", () => {
    expect(wrapHtml(renderSvg(fixture("diamond")))).toContain("<title>ccgrapher</title>");
  });

  // Regression: fit() ran synchronously at script end, before the browser had
  // given #viewport (a position:fixed box) its layout size on the very first
  // paint, so clientWidth/clientHeight read 0 and the page opened clamped to
  // the minimum zoom instead of fitted.
  it("defers the initial fit past the first paint, and skips a zero-sized viewport", () => {
    const html = wrapHtml(renderSvg(fixture("diamond")));
    expect(html).toMatch(/requestAnimationFrame\(function \(\) \{\s*requestAnimationFrame\(fit\);/);
    expect(html).toMatch(/if \(vw <= 0 \|\| vh <= 0\) return;/);
  });

  it("is deterministic — identical input produces identical output", () => {
    const svg = renderSvg(fixture("research-desk"));
    expect(wrapHtml(svg, { title: "research desk" })).toBe(
      wrapHtml(svg, { title: "research desk" }),
    );
  });
});
