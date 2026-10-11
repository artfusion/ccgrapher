// SPDX-License-Identifier: Apache-2.0
/**
 * Checks, in a real browser, that the hopper never covers the drawing.
 *
 * jsdom has no layout, so a test of boxes has to run where there is some. This
 * serves the static export of the web canvas (`pnpm --filter @ccgrapher/web
 * build`), opens it in headless Chrome over the DevTools protocol, and for
 * several viewports, themes and densities, with the hopper folded, open, and
 * open with a parse shown, asserts:
 *
 *   - the hopper's box never intersects the canvas element's box
 *   - every step of the drawing lies inside the canvas box, and the point at
 *     the middle of the fit button is the fit button (nothing sits over it)
 *   - opening the drawer after the reader has zoomed does not move the drawing
 *     relative to the canvas (pan and zoom are theirs once they have used them)
 *
 *   node tools/web-layout-check.mjs                # check only
 *   SHOTS=/some/dir node tools/web-layout-check.mjs  # also write screenshots
 *
 * Chrome is found from $CHROME or the usual install paths. Without one the
 * script says so and exits 0 locally, but exits 1 when $CI is set, so a runner
 * without a browser cannot pass this check by silently skipping it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const OUT = resolve("apps/web/out");
const BASE = "/app";
const SHOTS = process.env.SHOTS;

const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));

if (!CHROME) {
  const message = "web-layout-check: no Chrome found (set CHROME to its path).";
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipped.`);
  process.exit(0);
}
if (!existsSync(join(OUT, "index.html"))) {
  console.error("web-layout-check: apps/web/out is missing. Run `pnpm --filter @ccgrapher/web build` first.");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain" };

const server = createServer((req, res) => {
  let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (!path.startsWith(BASE)) path = BASE + path;
  path = normalize(path.slice(BASE.length) || "/");
  let file = join(OUT, path);
  if (!file.startsWith(OUT)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}${BASE}/`;

const profile = mkdtempSync(join(tmpdir(), "ccg-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
let socket;

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("Chrome did not start");
}

let nextId = 1;
const waiting = new Map();
async function open() {
  socket = new WebSocket(await connect());
  await new Promise((r) => socket.addEventListener("open", r, { once: true }));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve: ok, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else ok(msg.result);
    }
  });
}
const send = (method, params = {}) =>
  new Promise((ok, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve: ok, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result.value;
};

/** What the server would answer: nothing to watch, and one parse to look at. */
const PAGE_SETUP = `(() => {
  const parse = {
    model: "a model",
    candidates: [{
      id: "tidy_notes", label: "Tidy the release notes", kind: "worker", tier: "cheap",
      in: {}, out: { notes: "string" }, writes: [], rationale: "A small job that stands alone.",
      source: "tidy the release notes", review: { agrees: true, note: "Honest as drafted.", changed: [] },
      placement: { wave: 1, sentence: "Placed in wave 1, beside the first step." }, findings: [],
    }],
    duplicates: [], waitingOnYou: [{ text: "Should it ship on Friday?", kind: "question", recommendation: "Yes." }],
    setAside: [{ text: "Honestly I am tired.", reason: "A feeling, not work." }],
  };
  window.fetch = async (u) => new Response(JSON.stringify(String(u).endsWith("/draft") ? parse : { runs: [] }), { status: 200 });
})()`;

async function measure() {
  // On a narrow page the drawing is below the fold; the point test needs it on screen.
  await evaluate(`document.querySelector(".stage").scrollIntoView({ block: "start" })`);
  await sleep(100);
  return evaluate(`(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const canvas = document.querySelector(".pane.canvas");
    const hopper = document.querySelector(".hopper");
    const fit = document.querySelector(".canvas-fit");
    const f = fit.getBoundingClientRect();
    const at = document.elementFromPoint((f.left + f.right) / 2, (f.top + f.bottom) / 2);
    return {
      canvas: box(canvas), hopper: box(hopper),
      steps: [...document.querySelectorAll(".spec-node")].map(box),
      fitReachable: fit.contains(at),
    };
  })()`);
}

const intersects = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;

async function check(name, { requireFramed }) {
  const m = await measure();
  if (intersects(m.hopper, m.canvas)) failures.push(`${name}: the hopper box intersects the canvas box`);
  if (m.steps.length === 0) failures.push(`${name}: no steps were drawn`);
  if (requireFramed) {
    const out = m.steps.filter((s) => !inside(s, m.canvas)).length;
    if (out > 0) failures.push(`${name}: ${out} of ${m.steps.length} steps lie outside the canvas box ${JSON.stringify({ canvas: m.canvas, steps: m.steps })}`);
  }
  if (!m.fitReachable) failures.push(`${name}: something sits over the fit button`);
  return m;
}

const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

async function parseSomething() {
  await evaluate(`(() => {
    const t = document.querySelector(".hopper textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "tidy the release notes");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(100);
  await evaluate(`[...document.querySelectorAll(".hopper button")].find((b) => b.textContent === "parse").click()`);
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`!!document.querySelector(".hopper-parse")`)) return;
    await sleep(100);
  }
  throw new Error("the parse never appeared");
}

async function shot(file) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, file), Buffer.from(data, "base64"));
}

// `framed`: the page leaves the canvas room enough for the whole graph at the
// smallest scale the canvas will draw it (0.2), so every step must be in view.
// On the laptop the page's own header and report take most of the height, and
// only the non-overlap and reachability checks apply.
const SIZES = [
  ["desktop", 1440, 1000, true],
  ["laptop", 1100, 760, false],
  ["narrow", 600, 900, true],
  ["phone", 390, 800, true],
];
const LOOKS = [
  ["light", "light", "comfortable"],
  ["ink", "dark", "compact"],
];

async function load(width, height, theme, density) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evaluate(`document.querySelectorAll(".spec-node").length > 0 && !!document.querySelector(".hopper")`).catch(() => false)) break;
  }
  await evaluate(`(() => { const r = document.documentElement; r.setAttribute("data-theme", ${JSON.stringify(theme)}); r.setAttribute("data-density", ${JSON.stringify(density)}); })()`);
  await sleep(700);
}

try {
  await open();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SETUP });

  for (const [look, theme, density] of LOOKS) {
    for (const [size, width, height, framed] of SIZES) {
      const name = `${size} ${width}x${height}, ${look}`;
      await load(width, height, theme, density);
      const tag = `${size}-${look}`;

      await check(`${name}, folded`, { requireFramed: framed });
      await shot(`${tag}-1-folded.png`);

      await click(".hopper-toggle");
      await sleep(800);
      await check(`${name}, open`, { requireFramed: framed });
      await shot(`${tag}-2-open.png`);

      await parseSomething();
      await sleep(800);
      await check(`${name}, open with a parse`, { requireFramed: framed });
      await shot(`${tag}-3-parse.png`);
    }
  }

  // The reader has zoomed: folding and opening the drawer must not move the drawing.
  await load(1440, 1000, "light", "comfortable");
  const offset = () =>
    evaluate(`(() => { const s = document.querySelector(".spec-node").getBoundingClientRect(); const c = document.querySelector(".pane.canvas").getBoundingClientRect(); return { x: s.left - c.left, y: s.top - c.top, w: s.width }; })()`);
  await evaluate(`(() => { const p = document.querySelector(".jointjs-paper"); const r = p.getBoundingClientRect(); p.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true })); })()`);
  await sleep(300);
  const before = await offset();
  await click(".hopper-toggle");
  await sleep(800);
  const after = await offset();
  if (Math.abs(before.x - after.x) > 1 || Math.abs(before.y - after.y) > 1 || Math.abs(before.w - after.w) > 0.5) {
    failures.push(`opening the drawer after a zoom moved the drawing: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  // And the reverse: not yet used, so the drawer refits it into the room that is left.
  await load(1440, 1000, "light", "comfortable");
  const room = (await measure()).canvas;
  await click(".hopper-toggle");
  await sleep(800);
  const smaller = await check("refit on open", { requireFramed: true });
  if (!(smaller.canvas.bottom - smaller.canvas.top < room.bottom - room.top)) {
    failures.push("opening the drawer did not make the canvas shorter");
  }
} catch (error) {
  failures.push(`the check could not run: ${error.stack ?? error}`);
} finally {
  socket?.close();
  chrome.kill();
  server.close();
}

if (failures.length > 0) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  console.error(`web-layout-check: ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("web-layout-check: the hopper never covers the drawing, at every size, look and state.");
process.exit(0);
