// SPDX-License-Identifier: Apache-2.0
//
// A structural lint over the SVG that `renderSvg` produces. It reads the markup
// back and asks whether the picture is well formed: boxes apart, routes clear of
// boxes, labels and text inside what holds them, colours readable. Core computes
// ranks and layout computes pixels, so most of these faults should be impossible;
// this exists to prove it, and to say so loudly the day a change breaks it.
//
// Test-side only. It ships in no package and depends on nothing but the layout
// metrics the renderer itself uses.
import { DEFAULT_METRICS, type PositionedGraph } from "@ccgrapher/layout";

export type Rule =
  | "node-overlap"
  | "edge-through-node"
  | "label-clipped"
  | "text-overflow"
  | "step-collision"
  | "legend-overlap"
  | "contrast";

export interface Violation {
  readonly rule: Rule;
  /** Stable identity of the fault, so an allow-list can name it. */
  readonly subject: string;
  readonly detail: string;
}

/** `rule|subject`: the string an allow-list entry is matched against. */
export const keyOf = (v: Violation): string => `${v.rule}|${v.subject}`;

/** Pixels of give for stroke width and the few px rough.js wobbles outside a nominal box. */
const TOLERANCE = 3;
/** Advance width per character, as a fraction of font size: what `measureNode` plans with. */
const BODY_CHAR_RATIO = DEFAULT_METRICS.charRatio;
/** The header's own heuristic in render.ts (`HEADER_CHAR_RATIO`), which is not exported. */
const HEADER_CHAR_RATIO = 0.47;
/** WCAG 2.x AA: body text, large text (24px and up), and graphical objects. */
const AA_TEXT = 4.5;
const AA_LARGE_TEXT = 3;
const AA_GRAPHIC = 3;

// ---------------------------------------------------------------------------
// A very small XML reader. renderSvg's output is regular (escaped attributes, no
// CDATA), so a tokeniser is enough and no parser dependency is needed.

interface El {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: El[];
  text: string;
}

const TOKEN = /<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function parse(svg: string): El {
  const source = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  const root: El = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: El[] = [root];
  for (const m of source.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.text += unescapeXml(m[5]);
    } else if (m[1]) {
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = unescapeXml(a[2]!);
      const el: El = { name: m[2]!, attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  const svgEl = root.children[0];
  if (!svgEl || svgEl.name !== "svg") throw new Error("not an svg document");
  return svgEl;
}

// ---------------------------------------------------------------------------
// Geometry.

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const union = (boxes: readonly Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1)),
});

const inset = (b: Box, d: number): Box => ({ x0: b.x0 + d, y0: b.y0 + d, x1: b.x1 - d, y1: b.y1 - d });
const shift = (b: Box, dx: number, dy: number): Box => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });

/** How far two boxes interpenetrate on each axis; both positive means they overlap. */
function depth(a: Box, b: Box): { x: number; y: number } {
  return {
    x: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
    y: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
  };
}

/** The gap between two boxes; zero when they touch or overlap. */
const separation = (a: Box, b: Box): number =>
  Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

const overlaps = (a: Box, b: Box, tolerance: number): boolean => {
  const d = depth(a, b);
  return d.x > tolerance && d.y > tolerance;
};

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Liang-Barsky: does the segment touch the box? */
function segmentHits(p: Point, q: Point, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const clip = (pk: number, qk: number): boolean => {
    if (pk === 0) return qk >= 0;
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 <= t1;
  };
  return clip(-dx, p.x - b.x0) && clip(dx, b.x1 - p.x) && clip(-dy, p.y - b.y0) && clip(dy, b.y1 - p.y);
}

const numbersIn = (d: string): number[] => [...d.matchAll(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)].map((m) => Number(m[0]));

function pointsOf(d: string): Point[] {
  const n = numbersIn(d);
  const out: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! });
  return out;
}

const boundsOf = (points: readonly Point[]): Box => ({
  x0: Math.min(...points.map((p) => p.x)),
  y0: Math.min(...points.map((p) => p.y)),
  x1: Math.max(...points.map((p) => p.x)),
  y1: Math.max(...points.map((p) => p.y)),
});

// ---------------------------------------------------------------------------
// The scene: what the SVG says is where.

interface TextBox {
  readonly text: string;
  readonly box: Box;
}

interface SceneNode {
  readonly id: string;
  /** Offset of the group that holds it, to bring layout coordinates into svg space. */
  readonly dx: number;
  readonly dy: number;
  /** The painted outline, as drawn. */
  readonly frame: Box;
  /** The fan-out copies and worktree halo drawn around the box. */
  readonly extras: readonly Box[];
  /** Everything the node occupies: its box plus the extras. */
  readonly footprint: Box;
  /** Round marks drawn on the box's edge, such as a finding halo's flag. */
  readonly flags: readonly Box[];
  readonly texts: readonly TextBox[];
}

/** A step's number beside its box (`data-step`). */
interface SceneBadge {
  readonly number: string;
  readonly of: string;
  readonly box: Box;
}

interface SceneEdge {
  readonly from: string;
  readonly to: string;
  readonly dx: number;
  readonly dy: number;
  readonly routes: readonly (readonly Point[])[];
  readonly labels: readonly TextBox[];
}

interface Scene {
  readonly width: number;
  readonly height: number;
  readonly nodes: SceneNode[];
  readonly edges: SceneEdge[];
  /** Text outside any node or edge: the header and the boundary captions. */
  readonly loose: TextBox[];
  readonly badges: SceneBadge[];
  /** The outline of each boundary region. */
  readonly regions: Box[];
  /** The step legend's text under the graph (`data-legend`). */
  readonly legend: TextBox[];
}

function translateOf(el: El): { x: number; y: number } | null {
  const t = el.attrs["transform"];
  if (t === undefined) return { x: 0, y: 0 };
  const m = /^translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/.exec(t.trim());
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** Lines of a `<text>`, each with the box its glyphs are estimated to cover. */
function textBoxes(el: El, dx: number, dy: number, ratio: number): TextBox[] {
  const size = Number(el.attrs["font-size"] ?? 16);
  const anchor = el.attrs["text-anchor"] ?? "start";
  const spans = el.children.filter((c) => c.name === "tspan");
  const lines = spans.length > 0 ? spans : [el];
  return lines.map((line) => {
    const x = Number(line.attrs["x"] ?? el.attrs["x"] ?? 0) + dx;
    const y = Number(line.attrs["y"] ?? el.attrs["y"] ?? 0) + dy;
    const width = line.text.length * size * ratio;
    const x0 = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    return { text: line.text, box: { x0, y0: y - size * 0.8, x1: x0 + width, y1: y + size * 0.25 } };
  });
}

function readNode(g: El, dx: number, dy: number): SceneNode {
  const rects = g.children.filter((c) => c.name === "rect");
  const paths = g.children.filter((c) => c.name === "path");
  const rectBox = (r: El): Box => {
    const x = Number(r.attrs["x"]);
    const y = Number(r.attrs["y"]);
    return { x0: x, y0: y, x1: x + Number(r.attrs["width"]), y1: y + Number(r.attrs["height"]) };
  };

  // The box is the rect drawn without opacity and with a fill; fan-out copies
  // fade and the worktree halo has no fill. Agent boxes are rough paths instead.
  const main = rects.filter((r) => r.attrs["opacity"] === undefined && r.attrs["fill"] !== "none");
  const painted = [...main.map(rectBox), ...paths.map((p) => boundsOf(pointsOf(p.attrs["d"] ?? "")))];
  const extras = rects.filter((r) => !main.includes(r)).map((r) => shift(rectBox(r), dx, dy));
  const frame = shift(union(painted.length > 0 ? painted : [{ x0: 0, y0: 0, x1: 0, y1: 0 }]), dx, dy);

  return {
    id: g.attrs["data-node"]!,
    dx,
    dy,
    frame,
    extras,
    footprint: union([frame, ...extras]),
    // The finding flag, and the urgency disc in its own group.
    flags: [...g.children, ...g.children.filter((c) => c.attrs["data-mark"] !== undefined).flatMap((c) => c.children)]
      .filter((c) => c.name === "circle")
      .map((c) => {
        const cx = Number(c.attrs["cx"]) + dx;
        const cy = Number(c.attrs["cy"]) + dy;
        const rad = Number(c.attrs["r"]);
        return { x0: cx - rad, y0: cy - rad, x1: cx + rad, y1: cy + rad };
      }),
    texts: g.children.filter((c) => c.name === "text").flatMap((t) => textBoxes(t, dx, dy, BODY_CHAR_RATIO)),
  };
}

/**
 * An edge, or a finding's line between two nodes (`data-link="a~b"`). Both are
 * held to the same rules: clear of every box but their own two ends.
 */
function readEdge(g: El, dx: number, dy: number): SceneEdge {
  const [from = "", to = ""] =
    g.attrs["data-edge"] !== undefined ? g.attrs["data-edge"].split("->") : g.attrs["data-link"]!.split("~");
  // A rough path is several strokes; each `M` starts one, so keep them apart.
  const routes = g.children
    .filter((c) => c.name === "path")
    .flatMap((p) => (p.attrs["d"] ?? "").split(/(?=M)/).map((sub) => pointsOf(sub).map((pt) => ({ x: pt.x + dx, y: pt.y + dy }))))
    .filter((r) => r.length >= 2);
  return {
    from,
    to,
    dx,
    dy,
    routes,
    labels: g.children.filter((c) => c.name === "text").flatMap((t) => textBoxes(t, dx, dy, BODY_CHAR_RATIO)),
  };
}

function readScene(svg: El): Scene {
  const scene: Scene = {
    width: Number(svg.attrs["width"]),
    height: Number(svg.attrs["height"]),
    nodes: [],
    edges: [],
    loose: [],
    badges: [],
    regions: [],
    legend: [],
  };
  const walk = (el: El, dx: number, dy: number): void => {
    for (const child of el.children) {
      if (child.attrs["data-node"] !== undefined) scene.nodes.push(readNode(child, dx, dy));
      else if (child.attrs["data-edge"] !== undefined || child.attrs["data-link"] !== undefined)
        scene.edges.push(readEdge(child, dx, dy));
      else if (child.attrs["data-step"] !== undefined) {
        const pill = child.children.find((c) => c.name === "rect");
        const x = Number(pill?.attrs["x"]) + dx;
        const y = Number(pill?.attrs["y"]) + dy;
        scene.badges.push({
          number: child.attrs["data-step"],
          of: child.attrs["data-step-of"] ?? "",
          box: { x0: x, y0: y, x1: x + Number(pill?.attrs["width"]), y1: y + Number(pill?.attrs["height"]) },
        });
      } else if (child.attrs["data-legend"] !== undefined) {
        const t = translateOf(child) ?? { x: 0, y: 0 };
        scene.legend.push(
          ...child.children.filter((c) => c.name === "text").flatMap((c) => textBoxes(c, dx + t.x, dy + t.y, BODY_CHAR_RATIO)),
        );
      } else if (child.name === "text") scene.loose.push(...textBoxes(child, dx, dy, HEADER_CHAR_RATIO));
      else if (child.name === "g") {
        const t = translateOf(child);
        if (child.attrs["data-boundary"] !== undefined) {
          const outline = child.children.find((c) => c.name === "rect");
          if (outline) {
            const x = Number(outline.attrs["x"]) + dx;
            const y = Number(outline.attrs["y"]) + dy;
            scene.regions.push({ x0: x, y0: y, x1: x + Number(outline.attrs["width"]), y1: y + Number(outline.attrs["height"]) });
          }
        }
        if (t) walk(child, dx + t.x, dy + t.y);
      }
    }
  };
  walk(svg, 0, 0);
  return scene;
}

/**
 * When the layout is to hand, prefer its nominal numbers to the drawn ones: the
 * node boxes and edge routes it computed, not rough.js's wobble around them.
 */
function refine(scene: Scene, layout: PositionedGraph): Scene {
  const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodes = scene.nodes.map((n) => {
    const l = boxes.get(n.id);
    if (!l) return n;
    const nominal = shift({ x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height }, n.dx, n.dy);
    return { ...n, footprint: union([nominal, ...n.extras]) };
  });
  const edges = scene.edges.map((e, i) => {
    const l = layout.edges[i];
    if (!l || l.from !== e.from || l.to !== e.to) return e;
    return { ...e, routes: [l.points.map((p) => ({ x: p.x + e.dx, y: p.y + e.dy }))] };
  });
  return { ...scene, nodes, edges };
}

// ---------------------------------------------------------------------------
// Geometry checks.

const fmt = (b: Box) => `${Math.round(b.x0)},${Math.round(b.y0)}..${Math.round(b.x1)},${Math.round(b.y1)}`;

function checkGeometry(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const canvas: Box = { x0: 0, y0: 0, x1: scene.width, y1: scene.height };

  // 1. Node boxes overlapping.
  for (let i = 0; i < scene.nodes.length; i++) {
    for (let j = i + 1; j < scene.nodes.length; j++) {
      const a = scene.nodes[i]!;
      const b = scene.nodes[j]!;
      if (overlaps(a.footprint, b.footprint, TOLERANCE)) {
        const [first, second] = [a.id, b.id].sort();
        out.push({
          rule: "node-overlap",
          subject: `${first} / ${second}`,
          detail: `${a.id} (${fmt(a.footprint)}) and ${b.id} (${fmt(b.footprint)}) overlap`,
        });
      }
    }
  }

  // 2. An edge route passing through a node it neither leaves nor enters.
  for (const edge of scene.edges) {
    for (const node of scene.nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      const solid = inset(node.footprint, TOLERANCE);
      const hit = edge.routes.some((route) => route.some((p, k) => k > 0 && segmentHits(route[k - 1]!, p, solid)));
      if (hit) {
        out.push({
          rule: "edge-through-node",
          subject: `${edge.from}->${edge.to} through ${node.id}`,
          detail: `the route ${edge.from} to ${edge.to} crosses the box of ${node.id} (${fmt(node.footprint)})`,
        });
      }
    }
  }

  // 3. An edge label overlapped by a node box, or cut off by the canvas.
  for (const edge of scene.edges) {
    for (const label of edge.labels) {
      for (const node of scene.nodes) {
        if (overlaps(label.box, node.footprint, 1)) {
          out.push({
            rule: "label-clipped",
            subject: `"${label.text}" on ${edge.from}->${edge.to} against ${node.id}`,
            detail: `label "${label.text}" (${fmt(label.box)}) runs into ${node.id} (${fmt(node.footprint)})`,
          });
        }
      }
    }
  }
  const everyText = [
    ...scene.loose.map((t) => ({ owner: "header", t })),
    ...scene.legend.map((t) => ({ owner: "the legend", t })),
    ...scene.badges.map((b) => ({ owner: `the step of ${b.of}`, t: { text: b.number, box: b.box } })),
    ...scene.edges.flatMap((e) => e.labels.map((t) => ({ owner: `${e.from}->${e.to}`, t }))),
    ...scene.nodes.flatMap((n) => n.texts.map((t) => ({ owner: n.id, t }))),
  ];
  for (const { owner, t } of everyText) {
    const b = t.box;
    if (b.x0 < -1 || b.y0 < -1 || b.x1 > canvas.x1 + 1 || b.y1 > canvas.y1 + 1) {
      out.push({
        rule: "label-clipped",
        subject: `"${t.text}" of ${owner} off the canvas`,
        detail: `text "${t.text}" (${fmt(b)}) leaves the ${scene.width}x${scene.height} canvas`,
      });
    }
  }

  // 4. Text spilling out of its own node, or colliding with other text in it.
  for (const node of scene.nodes) {
    const room = inset(node.frame, -TOLERANCE);
    for (const t of node.texts) {
      if (t.box.x0 < room.x0 || t.box.x1 > room.x1 || t.box.y0 < room.y0 || t.box.y1 > room.y1) {
        out.push({
          rule: "text-overflow",
          subject: `"${t.text}" in ${node.id}`,
          detail: `text "${t.text}" (${fmt(t.box)}) overflows the box of ${node.id} (${fmt(node.frame)})`,
        });
      }
    }
    for (let i = 0; i < node.texts.length; i++) {
      for (let j = i + 1; j < node.texts.length; j++) {
        const a = node.texts[i]!;
        const b = node.texts[j]!;
        if (overlaps(a.box, b.box, 1)) {
          out.push({
            rule: "text-overflow",
            subject: `"${a.text}" collides with "${b.text}" in ${node.id}`,
            detail: `text "${a.text}" (${fmt(a.box)}) and "${b.text}" (${fmt(b.box)}) overlap inside ${node.id}`,
          });
        }
      }
    }
  }
  out.push(...checkSteps(scene));
  return out;
}

/**
 * Step numbers sit outside their box, so they are held to what an edge label is
 * and more: clear of every box and its flag, every route, every other piece of
 * text, every other number and every boundary outline. The legend sits wholly
 * under the drawing, and no two of its texts meet.
 */
function checkSteps(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const hit = (b: SceneBadge, against: string, detail: string) =>
    out.push({ rule: "step-collision", subject: `${b.number} of ${b.of} against ${against}`, detail: `step ${b.number} (${fmt(b.box)}) ${detail}` });

  const texts = [...scene.loose, ...scene.edges.flatMap((e) => e.labels)];
  scene.badges.forEach((b, i) => {
    for (const node of scene.nodes) {
      if (overlaps(b.box, node.footprint, 0)) hit(b, node.id, `runs into ${node.id} (${fmt(node.footprint)})`);
      for (const flag of node.flags) {
        if (overlaps(b.box, flag, 0)) hit(b, `the flag of ${node.id}`, `covers the finding flag of ${node.id}`);
      }
    }
    // A number nearer another box than its own reads as that box's.
    const own = scene.nodes.find((n) => n.id === b.of);
    if (own) {
      const gap = (n: SceneNode) => separation(b.box, n.frame);
      for (const other of scene.nodes) {
        if (other !== own && gap(other) <= gap(own)) hit(b, `nearer ${other.id}`, `is nearer ${other.id} than its own box, ${b.of}`);
      }
    }
    for (const edge of scene.edges) {
      if (edge.routes.some((route) => route.some((p, k) => k > 0 && segmentHits(route[k - 1]!, p, b.box)))) {
        hit(b, `${edge.from}->${edge.to}`, `sits on the route ${edge.from} to ${edge.to}`);
      }
    }
    for (const t of texts) {
      if (overlaps(b.box, t.box, 0)) hit(b, `"${t.text}"`, `covers the text "${t.text}" (${fmt(t.box)})`);
    }
    for (const other of scene.badges.slice(i + 1)) {
      if (overlaps(b.box, other.box, 0)) hit(b, `${other.number} of ${other.of}`, `meets step ${other.number} (${fmt(other.box)})`);
    }
    for (const region of scene.regions) {
      const crosses = overlaps(b.box, region, 0) && !(b.box.x0 > region.x0 && b.box.y0 > region.y0 && b.box.x1 < region.x1 && b.box.y1 < region.y1);
      if (crosses) hit(b, `the boundary at ${fmt(region)}`, `crosses a boundary outline (${fmt(region)})`);
    }
  });

  if (scene.legend.length > 0) {
    const legend = union(scene.legend.map((t) => t.box));
    const drawing = [
      ...scene.nodes.map((n) => n.footprint.y1),
      ...scene.edges.flatMap((e) => e.routes.flatMap((route) => route.map((p) => p.y))),
      ...scene.badges.map((b) => b.box.y1),
      ...scene.regions.map((r) => r.y1),
    ];
    const bottom = Math.max(...drawing);
    if (legend.y0 < bottom) {
      out.push({ rule: "legend-overlap", subject: "legend over the drawing", detail: `the legend starts at y ${Math.round(legend.y0)}, above the drawing's bottom at ${Math.round(bottom)}` });
    }
    for (let i = 0; i < scene.legend.length; i++) {
      for (let j = i + 1; j < scene.legend.length; j++) {
        const a = scene.legend[i]!;
        const b = scene.legend[j]!;
        if (overlaps(a.box, b.box, 0)) {
          out.push({ rule: "legend-overlap", subject: `"${a.text}" and "${b.text}"`, detail: `legend text "${a.text}" (${fmt(a.box)}) meets "${b.text}" (${fmt(b.box)})` });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contrast.

function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two hex colours. */
export function contrastRatio(fg: string, bg: string): number {
  const a = rgbOf(fg);
  const b = rgbOf(bg);
  if (!a || !b) throw new Error(`not a hex colour: ${!a ? fg : bg}`);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A mark drawn at partial opacity looks like its colour mixed into what is behind it. */
function blend(fg: string, bg: string, opacity: number): string {
  const a = rgbOf(fg);
  const b = rgbOf(bg);
  if (!a || !b || opacity >= 1) return fg;
  const mix = a.map((c, i) => Math.round(c * opacity + b[i]! * (1 - opacity)));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function checkContrast(svg: El): Violation[] {
  const found = new Map<string, Violation>();
  const paper = svg.children.find((c) => c.name === "rect" && rgbOf(c.attrs["fill"] ?? ""))?.attrs["fill"] ?? "#FFFFFF";

  const judge = (role: "text" | "graphic", what: string, fg: string | undefined, bg: string, opacity: number, size = 16) => {
    if (!fg || !rgbOf(fg)) return;
    const shown = blend(fg, bg, opacity);
    const need = role === "graphic" ? AA_GRAPHIC : size >= 24 ? AA_LARGE_TEXT : AA_TEXT;
    const ratio = contrastRatio(shown, bg);
    if (ratio >= need) return;
    const subject = `${role} ${fg.toUpperCase()}${opacity < 1 ? ` at ${opacity} opacity` : ""} on ${bg.toUpperCase()}`;
    if (!found.has(subject)) {
      found.set(subject, {
        rule: "contrast",
        subject,
        detail: `${what}: ${ratio.toFixed(2)}:1, AA needs ${need}:1`,
      });
    }
  };

  const mark = (el: El, bg: string, owner: string) => {
    const opacity = Number(el.attrs["opacity"] ?? 1);
    if (el.name === "text") {
      judge("text", `text "${el.children[0]?.text ?? el.text}" of ${owner}`, el.attrs["fill"], bg, opacity, Number(el.attrs["font-size"] ?? 16));
    } else if (el.name === "polygon") {
      judge("graphic", `arrow head of ${owner}`, el.attrs["fill"], bg, opacity);
    } else if (el.attrs["stroke"] !== undefined && el.attrs["stroke"] !== "none") {
      judge("graphic", `${el.name} stroke of ${owner}`, el.attrs["stroke"], bg, opacity);
    }
  };

  const walk = (el: El, bg: string, owner: string): void => {
    for (const child of el.children) {
      if (child.name === "defs") continue;
      const node = child.attrs["data-node"];
      if (node !== undefined) {
        // The outline sits on paper; the label and icon sit on the node's fill.
        const fill =
          child.children.find((c) => (c.name === "rect" || c.name === "path") && c.attrs["opacity"] === undefined && rgbOf(c.attrs["fill"] ?? ""))
            ?.attrs["fill"] ?? bg;
        for (const part of child.children) {
          if (part.name === "text") mark(part, fill, node);
          else if (part.name === "g") {
            mark(part, fill, node);
            walk(part, fill, node);
          } else {
            mark(part, bg, node);
          }
        }
      } else if (child.name === "g") {
        mark(child, bg, owner);
        walk(child, bg, child.attrs["data-edge"] ?? owner);
      } else {
        mark(child, bg, owner);
      }
    }
  };
  walk(svg, paper, "the page");
  return [...found.values()];
}

// ---------------------------------------------------------------------------

/**
 * Check one rendered SVG. Pass the layout it was rendered from to test against
 * its nominal node boxes and edge routes rather than the hand-drawn ones.
 */
export function checkSvg(markup: string, layout?: PositionedGraph): Violation[] {
  const svg = parse(markup);
  const scene = layout ? refine(readScene(svg), layout) : readScene(svg);
  return [...checkGeometry(scene), ...checkContrast(svg)].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}
