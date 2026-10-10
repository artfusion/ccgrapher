// SPDX-License-Identifier: Apache-2.0
import type { Step } from "@ccgrapher/core";
import { CAVEAT_NOTICE, caveatFontFace } from "./font.js";
import { escapeHtml } from "./html.js";
import { DEFAULT_THEME } from "./theme.js";

/** One file the code generator writes, as `describeFiles` in `@ccgrapher/codegen` gives it. */
export interface ExplainFile {
  readonly path: string;
  readonly lines: number;
  readonly note: string;
}

/** The linter's findings on one rule, in the order it reported them. */
export interface ExplainRule {
  readonly rule: string;
  readonly severity: "error" | "warn";
  readonly messages: readonly string[];
}

export interface ExplainLint {
  /** Grouped by rule, in the order the linter reports them. Empty when clean. */
  readonly rules: readonly ExplainRule[];
  readonly layersBefore: number;
  readonly layersAfter: number;
  /** The repairs the linter proposes: what it does, and why. */
  readonly repairs: ReadonlyArray<{ readonly text: string; readonly why: string }>;
}

export interface ExplainPage {
  readonly name: string;
  readonly goal?: string;
  /**
   * The picture, as `renderSvg` draws it with `steps: "numbers"` and the header
   * off (the page carries the name and goal). Its numbers match `steps`.
   */
  readonly svg: string;
  /** `stepLegend` of the graph the picture shows. */
  readonly steps: readonly Step[];
  /** True when the page describes the graph as repaired, not as written. */
  readonly repaired?: boolean;
  /** The codegen target the files are for. */
  readonly target: string;
  /** The target writes a directory, so the files are drawn as a tree. */
  readonly directory: boolean;
  readonly files: readonly ExplainFile[];
  readonly lint: ExplainLint;
  /**
   * The spec as written and as repaired, side by side, when the repair was
   * asked for and changes something. Drawn without numbers, grain or header.
   */
  readonly pair?: { readonly before: string; readonly after: string };
  /** Inline the handwriting face for the headings and the pictures. On by default. */
  readonly embedFont?: boolean;
}

/**
 * Text colours against the panel and the page, in each scheme. Every one reads
 * as body text (4.5:1 or better) on both backgrounds; a test holds them to it.
 */
export const EXPLAIN_COLOURS = {
  light: {
    page: "#F3EEE5",
    panel: "#FFFDF8",
    rule: "#D9D2C5",
    ink: DEFAULT_THEME.ink,
    quiet: "#5F5750",
    accent: "#A4461A",
    error: "#B03A26",
    warn: "#855400",
    ok: "#2F6A3B",
  },
  dark: {
    page: "#171513",
    panel: "#221F1C",
    rule: "#3D3732",
    ink: "#EFE9E1",
    quiet: "#B8AEA3",
    accent: "#F2A777",
    error: "#FF8F7A",
    warn: "#E6B85C",
    ok: "#8CCB98",
  },
} as const;

/** The colours a test checks for contrast: everything but the backgrounds and rules. */
export const EXPLAIN_TEXT = ["ink", "quiet", "accent", "error", "warn", "ok"] as const;

/**
 * One self-contained page that explains a spec in three panels: the full loop
 * (the picture, with pan and zoom), one run step by step (the numbered legend),
 * and what it is made of (the generated files and the lint status). Everything
 * on it is handed in, derived from the spec and the tools' own output, so the
 * same input gives the same bytes. No CDN and no requests: the font is inline,
 * and the page reads without script (the picture scrolls instead of panning).
 */
export function explainHtml(page: ExplainPage): string {
  const font = (page.embedFont ?? true) ? caveatFontFace() : null;
  const waves = page.steps.reduce((max, s) => Math.max(max, s.wave), 0);
  const findings = page.lint.rules.reduce((n, r) => n + r.messages.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.name)}, explained</title>
<style>${font ? `\n/* ${CAVEAT_NOTICE.replace(/\n\s*/g, " ")} */\n${font}` : ""}
${css()}
</style>
</head>
<body>
<a class="skip" href="#steps">Skip to the steps</a>
<header class="masthead">
  <p class="kicker">How it runs</p>
  <h1>${escapeHtml(page.name)}</h1>${page.goal ? `\n  <p class="goal">${escapeHtml(page.goal)}</p>` : ""}
  <dl class="facts">
    <div><dt>Steps</dt><dd>${page.steps.length}</dd></div>
    <div><dt>Waves</dt><dd>${waves}</dd></div>
    <div><dt>Lint</dt><dd>${findings === 0 ? `<span class="ok">clean</span>` : lintCount(page.lint.rules)}</dd></div>
    <div><dt>Target</dt><dd>${escapeHtml(page.target)}</dd></div>
  </dl>${page.repaired ? `\n  <p class="note">Drawn as repaired: the linter's repairs are applied to the spec before it is drawn, numbered and generated.</p>` : ""}
</header>
<main>
<section class="panel loop" aria-labelledby="loop-heading">
  <h2 id="loop-heading"><span class="n" aria-hidden="true">1</span> The full loop</h2>
  <p class="hint">Every step and what passes between them. Drag to pan; pinch, or hold Ctrl and scroll, to zoom.</p>
  <div class="controls" role="toolbar" aria-label="Zoom the picture">
    <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
    <button type="button" data-zoom="out" aria-label="Zoom out">&minus;</button>
    <button type="button" data-zoom="fit">Fit</button>
    <button type="button" data-zoom="reset">100%</button>
  </div>
  <div class="viewport" id="loop-viewport" role="img" aria-label="${escapeHtml(pictureLabel(page, waves))}">
    <div class="stage" id="loop-stage">
${page.svg}
    </div>
  </div>
</section>
<section class="panel steps" id="steps" tabindex="-1" aria-labelledby="steps-heading">
  <h2 id="steps-heading"><span class="n" aria-hidden="true">2</span> One run, step by step</h2>
  <p class="hint">Numbered by wave, as on the picture: steps that share a number run at once.</p>
  <ol class="legend">
${page.steps.map(stepItem).join("\n")}
  </ol>
</section>
<section class="panel made-of" aria-labelledby="made-heading">
  <h2 id="made-heading"><span class="n" aria-hidden="true">3</span> What it is made of</h2>
  <div class="columns">
    <div class="files">
      <h3>Files, for the ${escapeHtml(page.target)} target</h3>
      <p class="hint">What <code>ccg codegen -t ${escapeHtml(page.target)}${page.repaired ? " --fix" : ""}</code> writes${page.directory ? ", as a directory" : ""}.</p>
${filesHtml(page.files, page.directory)}
    </div>
    <div class="lint">
      <h3>Lint</h3>
${lintHtml(page)}
    </div>
  </div>${page.pair ? pairHtml(page.pair, page.lint) : ""}
</section>
</main>
<footer>
  <p>Made by <code>ccg explain</code> from the spec and the linter's and code generator's own output. Nothing on this page was written by a model.</p>
</footer>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

function pictureLabel(page: ExplainPage, waves: number): string {
  return `Diagram of ${page.name}${page.repaired ? ", as repaired" : ""}: ${plural(page.steps.length, "step")} in ${plural(waves, "wave")}, numbered as in the list of steps.`;
}

function stepItem(step: Step): string {
  return `    <li data-step="${escapeHtml(step.number)}"><span class="number">${escapeHtml(step.number)}</span><span class="label">${escapeHtml(step.label)}</span><span class="line">${escapeHtml(step.line)}</span></li>`;
}

function lintCount(rules: readonly ExplainRule[]): string {
  const errors = rules.filter((r) => r.severity === "error").reduce((n, r) => n + r.messages.length, 0);
  const warnings = rules.filter((r) => r.severity === "warn").reduce((n, r) => n + r.messages.length, 0);
  const parts = [
    ...(errors > 0 ? [`<span class="error">${plural(errors, "error")}</span>`] : []),
    ...(warnings > 0 ? [`<span class="warn">${plural(warnings, "warning")}</span>`] : []),
  ];
  return parts.join(", ");
}

// --- files ------------------------------------------------------------------

interface Dir {
  readonly children: Map<string, Dir | ExplainFile>;
}

function filesHtml(files: readonly ExplainFile[], directory: boolean): string {
  if (!directory) {
    return `      <ul class="tree">\n${files.map((f) => fileItem(f.path, f, 4)).join("\n")}\n      </ul>`;
  }
  // The generator's order (sorted paths), folded into folders as they first appear.
  const root: Dir = { children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.children.get(`${part}/`);
      if (!next || !("children" in next)) {
        next = { children: new Map() };
        dir.children.set(`${part}/`, next);
      }
      dir = next;
    }
    dir.children.set(parts[parts.length - 1]!, file);
  }
  return `      <ul class="tree" aria-label="The generated directory">\n${treeItems(root, 4)}\n      </ul>`;
}

function treeItems(dir: Dir, depth: number): string {
  const pad = "  ".repeat(depth);
  return [...dir.children]
    .map(([name, entry]) =>
      "children" in entry
        ? `${pad}<li class="dir"><span class="path">${escapeHtml(name)}</span>\n${pad}  <ul>\n${treeItems(entry, depth + 2)}\n${pad}  </ul>\n${pad}</li>`
        : fileItem(name, entry, depth),
    )
    .join("\n");
}

function fileItem(name: string, file: ExplainFile, depth: number): string {
  const pad = "  ".repeat(depth);
  return `${pad}<li class="file"><span class="path">${escapeHtml(name)}</span> <span class="size">${plural(file.lines, "line")}</span><span class="note">${escapeHtml(file.note)}</span></li>`;
}

// --- lint -------------------------------------------------------------------

function lintHtml(page: ExplainPage): string {
  const { rules, layersBefore, layersAfter, repairs } = page.lint;
  const out: string[] = [];
  out.push(
    rules.length === 0
      ? `      <p class="status"><span class="ok">Clean.</span> No findings.</p>`
      : `      <p class="status">${lintCount(rules)}.</p>`,
  );
  for (const rule of rules) {
    out.push(
      `      <div class="rule">`,
      `        <h4><code>${escapeHtml(rule.rule)}</code> <span class="${rule.severity === "error" ? "error" : "warn"}">${rule.severity === "error" ? "error" : "warning"}</span> <span class="count">${rule.messages.length}</span></h4>`,
      `        <ul>`,
      ...rule.messages.map((m) => `          <li>${escapeHtml(m)}</li>`),
      `        </ul>`,
      `      </div>`,
    );
  }
  out.push(
    layersAfter < layersBefore
      ? `      <p class="critical">Critical path: ${plural(layersBefore, "layer")} as written, ${layersAfter} once repaired.</p>`
      : `      <p class="critical">Critical path: ${plural(layersBefore, "layer")}.</p>`,
  );
  if (repairs.length > 0) {
    out.push(
      `      <h4>Proposed repairs</h4>`,
      `      <ul class="repairs">`,
      ...repairs.map(
        (r) => `        <li><code>${escapeHtml(r.text)}</code><span class="why">${escapeHtml(r.why)}</span></li>`,
      ),
      `      </ul>`,
    );
    if (!page.pair) {
      out.push(`      <p class="hint"><code>ccg explain --fix</code> draws the repair beside the spec as written.</p>`);
    }
  } else if (page.repaired) {
    out.push(`      <p class="hint">The linter has nothing to repair here, so the spec is drawn as written.</p>`);
  }
  return out.join("\n");
}

function pairHtml(pair: { before: string; after: string }, lint: ExplainLint): string {
  return `
  <section class="pair" aria-labelledby="pair-heading">
    <h3 id="pair-heading">The repair, before and after</h3>
    <div class="figures">
      <figure>
        <div class="sheet" role="img" aria-label="The spec as written: ${plural(lint.layersBefore, "layer")}.">
${pair.before}
        </div>
        <figcaption>As written: ${plural(lint.layersBefore, "layer")}</figcaption>
      </figure>
      <figure>
        <div class="sheet" role="img" aria-label="The spec repaired: ${plural(lint.layersAfter, "layer")}.">
${pair.after}
        </div>
        <figcaption>Repaired: ${plural(lint.layersAfter, "layer")}</figcaption>
      </figure>
    </div>
  </section>`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- style and script -------------------------------------------------------

function tokens(scheme: keyof typeof EXPLAIN_COLOURS): string {
  return Object.entries(EXPLAIN_COLOURS[scheme])
    .map(([name, value]) => `--${name}: ${value};`)
    .join(" ");
}

/**
 * Wide: the picture and the steps side by side, so a number on one is found on
 * the other at a glance, and the files and lint across the foot. Narrow (under
 * 64rem): every panel stacks. In rem, so it follows the reader's text size.
 */
function css(): string {
  return `:root { ${tokens("light")} --paper: ${DEFAULT_THEME.paper}; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { ${tokens("dark")} } }
* { box-sizing: border-box; }
html { background: var(--page); color: var(--ink); }
body { margin: 0 auto; max-width: 96rem; padding: 0 1rem 2rem; font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
code { font: 0.9em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a, button { color: inherit; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.skip { position: absolute; left: 1rem; top: -4rem; padding: 0.5rem 0.75rem; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
.skip:focus { top: 1rem; }
.masthead { padding: 2.5rem 0 1.5rem; }
.kicker { margin: 0; color: var(--accent); font-size: 0.85rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 0.1rem 0 0.25rem; font: 400 3.25rem/1.05 'Caveat', 'Segoe Print', cursive; overflow-wrap: anywhere; }
.goal { margin: 0; font-size: 1.15rem; color: var(--quiet); max-width: 48rem; }
.facts { display: flex; flex-wrap: wrap; gap: 0.5rem 2rem; margin: 1.25rem 0 0; }
.facts div { display: flex; flex-direction: column; }
.facts dt { font-size: 0.8rem; color: var(--quiet); text-transform: uppercase; letter-spacing: 0.06em; }
.facts dd { margin: 0; font-weight: 600; }
.note { margin: 1rem 0 0; color: var(--quiet); }
main { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr) 24rem; grid-template-areas: "loop steps" "made made"; }
.panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 1.25rem 1.5rem 1.5rem; min-width: 0; }
.loop { grid-area: loop; }
.steps { grid-area: steps; }
.made-of { grid-area: made; }
h2 { margin: 0 0 0.25rem; font-size: 1.25rem; font-weight: 600; display: flex; align-items: baseline; gap: 0.6rem; }
h2 .n { font: 400 2rem/1 'Caveat', 'Segoe Print', cursive; color: var(--accent); }
h3 { margin: 0 0 0.25rem; font-size: 1.05rem; }
h4 { margin: 1rem 0 0.35rem; font-size: 0.95rem; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; }
.hint { margin: 0 0 0.75rem; color: var(--quiet); font-size: 0.9rem; }
.ok { color: var(--ok); font-weight: 600; }
.error { color: var(--error); font-weight: 600; }
.warn { color: var(--warn); font-weight: 600; }
.controls { display: none; gap: 0.4rem; margin-bottom: 0.5rem; }
.js .controls { display: flex; }
.controls button { min-width: 2.5rem; padding: 0.3rem 0.7rem; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); font: inherit; font-size: 0.9rem; cursor: pointer; }
.controls button:hover { border-color: var(--quiet); }
.viewport { position: relative; min-height: 28rem; height: min(78vh, 52rem); overflow: auto; border-radius: 8px; background: var(--paper); border: 1px solid var(--rule); }
.js .viewport { overflow: hidden; cursor: grab; touch-action: none; }
.js .viewport.dragging { cursor: grabbing; }
.stage { transform-origin: 0 0; width: max-content; }
.js .stage { will-change: transform; }
.stage.settling { transition: transform 150ms ease-out; }
@media (prefers-reduced-motion: reduce) { .stage.settling { transition: none; } }
.stage svg { display: block; }
.legend { list-style: none; margin: 0; padding: 0; }
.legend li { display: grid; grid-template-columns: 2.75rem 1fr; gap: 0 0.5rem; padding: 0.45rem 0; border-top: 1px solid var(--rule); }
.legend .number { grid-row: span 2; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); }
.legend .label { font-weight: 600; }
.legend .line { color: var(--quiet); font-size: 0.9rem; }
.columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem 2.5rem; margin-top: 1rem; }
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { margin-left: 0.4rem; padding-left: 1rem; border-left: 1px solid var(--rule); }
.tree li { padding: 0.3rem 0; }
.tree .path { font: 600 0.9rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.tree .size { color: var(--quiet); font-size: 0.85rem; }
.tree .note { display: block; color: var(--quiet); font-size: 0.9rem; }
.status { margin: 0.25rem 0 0; font-weight: 600; }
.rule ul, .repairs { margin: 0; padding-left: 1.1rem; }
.rule li, .repairs li { padding: 0.15rem 0; overflow-wrap: anywhere; }
.count { color: var(--quiet); font-weight: 400; }
.critical { margin: 1rem 0 0; }
.repairs .why { display: block; color: var(--quiet); font-size: 0.9rem; }
.pair { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
.figures { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; }
figure { margin: 0; }
.sheet { display: flex; align-items: center; justify-content: center; height: min(36rem, 70vh); padding: 0.5rem; background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.sheet svg { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; }
figcaption { margin-top: 0.4rem; color: var(--quiet); font-size: 0.9rem; }
footer { margin-top: 1.5rem; color: var(--quiet); font-size: 0.9rem; }
@media (max-width: 64rem) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-areas: "loop" "steps" "made"; }
  .viewport { height: 62vh; min-height: 20rem; }
  .columns, .figures { grid-template-columns: minmax(0, 1fr); }
  .sheet { height: auto; }
  .sheet svg { max-height: 70vh; }
  h1 { font-size: 2.6rem; }
}`;
}

/**
 * Pan and zoom, as `wrapHtml` does them, scoped to the picture's panel. On a
 * page that scrolls, a bare wheel scrolls the page: zoom is a pinch, or the
 * wheel with Ctrl or Cmd held, or the buttons.
 */
const SCRIPT = `(function () {
  var viewport = document.getElementById("loop-viewport");
  var stage = document.getElementById("loop-stage");
  var svgEl = stage.querySelector("svg");
  if (!svgEl) return;
  document.documentElement.classList.add("js");
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

  // Animated when asked for; the first fit, on load, lands at once.
  function fit(settle) {
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    var size = svgSize();
    var padding = 16;
    scale = Math.min((vw - padding * 2) / size.w, (vh - padding * 2) / size.h, 1);
    scale = Math.max(scale, MIN_SCALE);
    x = (vw - size.w * scale) / 2;
    y = (vh - size.h * scale) / 2;
    apply(settle !== false);
  }

  function zoomAt(cx, cy, factor, settle) {
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    x = cx - ((cx - x) / scale) * next;
    y = cy - ((cy - y) / scale) * next;
    scale = next;
    apply(settle);
  }

  viewport.addEventListener("wheel", function (evt) {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    var rect = viewport.getBoundingClientRect();
    zoomAt(evt.clientX - rect.left, evt.clientY - rect.top, evt.deltaY < 0 ? 1.12 : 1 / 1.12, false);
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

  var buttons = document.querySelectorAll("[data-zoom]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (evt) {
      var what = evt.currentTarget.getAttribute("data-zoom");
      if (what === "fit") return fit();
      if (what === "reset") {
        scale = 1;
        x = 0;
        y = 0;
        return apply(true);
      }
      zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, what === "in" ? 1.25 : 1 / 1.25, true);
    });
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      fit(false);
    });
  });
})();`;
