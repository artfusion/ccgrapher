// SPDX-License-Identifier: Apache-2.0

export interface WrapHtmlOptions {
  /** Used for the page's <title>. Falls back to a generic title. */
  readonly title?: string;
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
  #controls button:hover { background: #eee; }
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
</div>
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
