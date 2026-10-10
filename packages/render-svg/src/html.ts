// SPDX-License-Identifier: Apache-2.0
import type { Step } from "@ccgrapher/core";

export interface WrapHtmlOptions {
  /** Used for the page's <title>. Falls back to a generic title. */
  readonly title?: string;
  /**
   * The steps, as `stepLegend` in `@ccgrapher/core` gives them, listed beside
   * the picture (under it on a narrow screen) as an HTML list, so the legend
   * reflows and reads at any zoom. Pair it with an SVG rendered with
   * `steps: "numbers"`, so the numbers on the boxes match. None by default.
   */
  readonly steps?: readonly Step[];
}

/**
 * Wraps an SVG string produced by `renderSvg` in a single, self-contained HTML
 * page with pan and zoom — no CDN, no external requests, so it renders inline
 * wherever script is allowed to run alongside an attachment (a chat side
 * panel, a browser tab) without a CSP fight.
 *
 * The SVG itself is untouched: this only adds a viewport, a small amount of
 * inline CSS, and a wheel/drag/reset handler. `prefers-reduced-motion` turns
 * off the one transition (the snap back to a fitted view).
 */
export function wrapHtml(svg: string, options: WrapHtmlOptions = {}): string {
  const title = escapeHtml(options.title ?? "ccgrapher");
  const steps = options.steps ?? [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #f5f2ea; }
  #viewport { position: fixed; inset: 0; cursor: grab; touch-action: none; }
  #viewport.dragging { cursor: grabbing; }
  #stage { transform-origin: 0 0; will-change: transform; }
  #stage.settling { transition: transform 150ms ease-out; }
  @media (prefers-reduced-motion: reduce) {
    #stage.settling { transition: none; }
  }
  #stage svg { display: block; }
  #controls { position: fixed; right: 12px; bottom: 12px; display: flex; gap: 6px; font: 13px system-ui, sans-serif; }
  #controls button {
    padding: 6px 10px; border: 1px solid #999; border-radius: 6px; background: #fff;
    cursor: pointer; color: #333;
  }
  #controls button:hover { background: #eee; }${steps.length > 0 ? LEGEND_CSS : ""}
</style>
</head>
<body>
<div id="viewport">
  <div id="stage">
    ${svg}
  </div>
</div>
<div id="controls">
  <button id="fit" type="button">Fit</button>
  <button id="reset" type="button">100%</button>
</div>${steps.length > 0 ? legendHtml(steps) : ""}
<script>
(function () {
  var viewport = document.getElementById("viewport");
  var stage = document.getElementById("stage");
  var svgEl = stage.querySelector("svg");
  var scale = 1, x = 0, y = 0;
  var MIN_SCALE = 0.1, MAX_SCALE = 8;

  function apply(settle) {
    stage.classList.toggle("settling", !!settle);
    stage.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
  }

  function svgSize() {
    var box = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (box && box.width && box.height) return { w: box.width, h: box.height };
    return { w: svgEl.width.baseVal.value, h: svgEl.height.baseVal.value };
  }

  function fit() {
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    // The viewport can still be zero-sized on the very first frame (its
    // layout box lands one paint after the script runs) — skip rather than
    // compute a bogus near-zero scale from it.
    if (vw <= 0 || vh <= 0) return;
    var size = svgSize();
    var padding = 24;
    scale = Math.min((vw - padding * 2) / size.w, (vh - padding * 2) / size.h, 1);
    scale = Math.max(scale, MIN_SCALE);
    x = (vw - size.w * scale) / 2;
    y = (vh - size.h * scale) / 2;
    apply(true);
  }

  viewport.addEventListener("wheel", function (evt) {
    evt.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var cx = evt.clientX - rect.left, cy = evt.clientY - rect.top;
    var factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    // Anchor the point under the cursor: it lands in the same place after
    // the scale changes, so zoom feels like it comes from the pointer.
    x = cx - ((cx - x) / scale) * next;
    y = cy - ((cy - y) / scale) * next;
    scale = next;
    apply(false);
  }, { passive: false });

  var dragging = false, lastX = 0, lastY = 0;
  viewport.addEventListener("pointerdown", function (evt) {
    dragging = true;
    lastX = evt.clientX;
    lastY = evt.clientY;
    viewport.classList.add("dragging");
    viewport.setPointerCapture(evt.pointerId);
  });
  viewport.addEventListener("pointermove", function (evt) {
    if (!dragging) return;
    x += evt.clientX - lastX;
    y += evt.clientY - lastY;
    lastX = evt.clientX;
    lastY = evt.clientY;
    apply(false);
  });
  function endDrag() {
    dragging = false;
    viewport.classList.remove("dragging");
  }
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  viewport.addEventListener("dblclick", fit);
  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("reset").addEventListener("click", function () {
    scale = 1;
    x = 0;
    y = 0;
    apply(true);
  });

  // Two frames, not one: the first guarantees the browser has painted once
  // (so #viewport, a position:fixed box, definitely has its final size);
  // one alone was still occasionally racing layout on the initial load.
  requestAnimationFrame(function () {
    requestAnimationFrame(fit);
  });
})();
</script>
</body>
</html>
`;
}

/**
 * The legend takes a column on the right, the picture the rest; under 48rem
 * the column moves below the picture. In rem, so it grows with the reader's
 * text size, and it scrolls on its own when there are more steps than fit.
 */
const LEGEND_CSS = `
  #viewport { right: 24rem; }
  #controls { right: calc(24rem + 12px); }
  #legend {
    position: fixed; top: 0; right: 0; bottom: 0; width: 24rem; box-sizing: border-box;
    overflow-y: auto; padding: 1.25rem 1.5rem; background: #fffdf8; border-left: 1px solid #d9d2c5;
    font: 1rem/1.4 system-ui, sans-serif; color: #2b2724;
  }
  #legend h2 { margin: 0 0 0.75rem; font-size: 1.05rem; font-weight: 600; }
  #legend ol { list-style: none; margin: 0; padding: 0; }
  #legend li { display: grid; grid-template-columns: 2.75rem 1fr; gap: 0 0.5rem; padding: 0.4rem 0; border-top: 1px solid #ece6db; }
  #legend .number { grid-row: span 2; font-weight: 600; font-variant-numeric: tabular-nums; }
  #legend .label { font-weight: 500; }
  #legend .line { color: #5f5750; font-size: 0.9rem; }
  @media (max-width: 48rem) {
    #viewport { right: 0; bottom: 45vh; }
    #controls { right: 12px; bottom: calc(45vh + 12px); }
    #legend { top: auto; left: 0; width: auto; height: 45vh; border-left: 0; border-top: 1px solid #d9d2c5; }
  }`;

function legendHtml(steps: readonly Step[]): string {
  const items = steps
    .map(
      (s) =>
        `    <li><span class="number">${escapeHtml(s.number)}</span><span class="label">${escapeHtml(s.label)}</span><span class="line">${escapeHtml(s.line)}</span></li>`,
    )
    .join("\n");
  return `
<aside id="legend" aria-labelledby="legend-heading">
  <h2 id="legend-heading">One run, step by step</h2>
  <ol>
${items}
  </ol>
</aside>`;
}

/** One heading and its lines, as `ledgerSections` in `@ccgrapher/lint` gives them. */
export interface LedgerBlockSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface WrapLedgerHtmlOptions {
  /** The page's heading and <title>. */
  readonly title: string;
  /** The picture before the change, as `renderSvg` returns it. */
  readonly before: string;
  /** The picture after it. */
  readonly after: string;
  /** What changed, in words. The first section holds the totals and goes under the heading. */
  readonly sections: readonly LedgerBlockSection[];
}

/**
 * A before, the changes, and an after, side by side on one static page: the
 * pair and its ledger read together. The ledger is HTML between the two
 * pictures, never drawn into either, so it reflows and reads at any zoom.
 * Under 60rem the three stack in reading order. No script and no external
 * requests, like `wrapHtml`.
 *
 * Both pictures are inlined. The only id a picture defines is its paper
 * filter, which is the same in both, so the second definition is harmless.
 */
export function wrapLedgerHtml(options: WrapLedgerHtmlOptions): string {
  const title = escapeHtml(options.title);
  const [totals, ...changes] = options.sections;
  const summary = totals ? `\n  <p>${totals.lines.map(escapeHtml).join("; ")}</p>` : "";
  const block = (section: LedgerBlockSection) => {
    const items = section.lines.map((line) => `        <li>${escapeHtml(line)}</li>`).join("\n");
    const list = section.lines.length > 0 ? `\n      <ul>\n${items}\n      </ul>` : "";
    return `      <h3>${escapeHtml(section.heading)}</h3>${list}`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}: before and after</title>
<style>
  body { margin: 0; background: #f5f2ea; color: #2b2724; font: 1rem/1.45 system-ui, sans-serif; }
  header { padding: 1.25rem 1.5rem 0; }
  header h1 { margin: 0; font-size: 1.2rem; font-weight: 600; }
  header p { margin: 0.25rem 0 0; color: #5f5750; }
  main {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(16rem, 24rem) minmax(0, 1fr);
    gap: 1.5rem; padding: 1.25rem 1.5rem 2rem; align-items: start;
  }
  figure { margin: 0; }
  figure h2, #ledger h2 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; }
  figure svg { display: block; width: 100%; height: auto; }
  #ledger { background: #fffdf8; border: 1px solid #d9d2c5; border-radius: 6px; padding: 1rem 1.25rem; }
  #ledger h3 { margin: 0.9rem 0 0.25rem; font-size: 0.95rem; font-weight: 600; }
  #ledger h2 + h3 { margin-top: 0; }
  #ledger ul { margin: 0; padding: 0; list-style: none; }
  #ledger li { padding: 0.2rem 0; border-top: 1px solid #ece6db; font-size: 0.9rem; color: #5f5750; overflow-wrap: anywhere; }
  @media (max-width: 60rem) {
    main { grid-template-columns: minmax(0, 1fr); }
  }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>${summary}
</header>
<main>
  <figure aria-labelledby="before-heading">
    <h2 id="before-heading">Before</h2>
    ${options.before}
  </figure>
  <section id="ledger" aria-labelledby="ledger-heading">
    <h2 id="ledger-heading">Changes</h2>
${changes.map(block).join("\n")}
  </section>
  <figure aria-labelledby="after-heading">
    <h2 id="after-heading">After</h2>
    ${options.after}
  </figure>
</main>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
