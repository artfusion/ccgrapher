// SPDX-License-Identifier: Apache-2.0
import { agentTag, renderStyle, type NodeSpec } from "@ccgrapher/core";
import { routeLinks, type PositionedGraph, type PositionedNode, type PositionedRegion } from "@ccgrapher/layout";

export interface ExcalidrawOptions {
  /** Mark these edges dashed and red. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * Fan-ins the linter flagged for their count guard, with the number of results
   * that actually arrive. Drawn as a red box inside a solid red halo; the renderer
   * does not compare `expects` with the edges itself.
   */
  readonly guardFindings?: ReadonlyArray<{ readonly id: string; readonly arriving: number }>;
  /**
   * Every other rule's findings, as `renderMarksFor` in `@ccgrapher/lint` builds
   * them. A node finding is the same red box and halo with a note in the label;
   * two writers of one file are joined by a thin red line, routed as the SVG
   * routes it and labelled with the file. The line is bound to nothing, so it
   * stays put when a box is dragged; it is a note, not an arrow.
   */
  readonly findingMarks?: ReadonlyArray<FindingMark>;
  readonly backgroundColor?: string;
}

/** The same shape `render-svg` and `render-mermaid` take; declared here so this package needs neither. */
export type FindingMark =
  | { readonly rule: "MISSING_INPUT"; readonly id: string; readonly field: string }
  | { readonly rule: "SELF_GRADING"; readonly id: string }
  | { readonly rule: "CONTEXT_COLLAPSE"; readonly id: string; readonly arriving: number }
  | { readonly rule: "HIDDEN_EDGE"; readonly between: readonly [string, string]; readonly file: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly store: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly boundary: string }
  | { readonly rule: "DUPLICATE_EFFECT"; readonly id: string; readonly effect: string }
  | { readonly rule: "EARLY_COMMIT"; readonly id: string; readonly store: string };

export interface ExcalidrawScene {
  readonly type: "excalidraw";
  readonly version: 2;
  readonly source: string;
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Record<string, unknown>;
  readonly files: Record<string, never>;
}

type ExcalidrawElement = Record<string, unknown>;

const INK = "#2b2724";
const ACCENT = "#e8763a";
const DANGER = "#c4442e";
const PAPER = "#fbf7f0";
const BOUNDARY = "#736a63";

const KIND_FILL: Record<string, string> = {
  agent: "transparent",
  code: "#f1eee9",
  human: "#f6f0dc",
};

/**
 * Excalidraw scene JSON — an array of element objects. Arrows are bound to the
 * boxes they connect, and labels live inside their container, so the file is a
 * genuine escape hatch: open it, drag a node, and everything follows.
 *
 * Font family 1 is Virgil, Excalidraw's own hand-drawn face, so the aesthetic
 * survives the round trip without embedding anything.
 */
export function renderExcalidraw(
  positioned: PositionedGraph,
  options: ExcalidrawOptions = {},
): ExcalidrawScene {
  const fake = new Set((options.fakeEdges ?? []).map((e) => `${e.from}->${e.to}`));
  const arriving = new Map((options.guardFindings ?? []).map((g) => [g.id, g.arriving]));
  const findingMarks = options.findingMarks ?? [];
  const writers = new Set(findingMarks.flatMap((m) => (m.rule === "HIDDEN_EDGE" ? m.between : [])));
  const elements: ExcalidrawElement[] = [];

  // Arrows are collected per node so each box can declare what it is bound to.
  const bindings = new Map<string, Array<{ id: string; type: string }>>();
  const bind = (nodeId: string, entry: { id: string; type: string }) => {
    bindings.set(nodeId, [...(bindings.get(nodeId) ?? []), entry]);
  };

  positioned.edges.forEach((edge, i) => {
    const id = `arrow-${i}`;
    bind(edge.from, { id, type: "arrow" });
    bind(edge.to, { id, type: "arrow" });
  });

  for (const node of positioned.nodes) {
    const textId = `text-${node.id}`;
    bind(node.id, { id: textId, type: "text" });
  }

  // A boundary is one Excalidraw group: its regions, their captions and every
  // member box and label, so dragging the group takes the whole lot. Regions go
  // first, which puts them behind everything else.
  const groupOf = new Map<string, string>();
  for (const boundary of positioned.graph.spec.boundaries ?? []) {
    for (const member of boundary.members) groupOf.set(member, boundaryGroup(boundary.id));
  }
  for (const region of positioned.regions) {
    elements.push(...regionElements(region));
  }

  for (const node of positioned.nodes) {
    const found = arriving.get(node.id);
    const notes = findingNotes(node.id, findingMarks);
    const flagged = found !== undefined || notes.length > 0 || writers.has(node.id);
    const group = groupOf.get(node.id);
    const groupIds = group ? [group] : [];
    // The halo goes in first so it sits behind the box. It is not bound to anything.
    if (flagged) elements.push({ ...halo(node), groupIds });
    elements.push({ ...box(node, bindings.get(node.id) ?? [], flagged), groupIds });
    elements.push({ ...text(node, found, notes), groupIds });
  }

  positioned.edges.forEach((edge, i) => {
    const isFake = fake.has(`${edge.from}->${edge.to}`);
    elements.push(arrow(`arrow-${i}`, positioned, edge, isFake));
  });

  elements.push(...sharedWrites(positioned, findingMarks));

  return {
    type: "excalidraw",
    version: 2,
    source: "ccgrapher",
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: options.backgroundColor ?? PAPER,
    },
    files: {},
  };
}

function base(id: string, seedSource: string): ExcalidrawElement {
  const seed = hash(seedSource);
  return {
    id,
    seed,
    versionNonce: seed,
    version: 1,
    // Fixed so the same spec always produces the same file — no spurious diffs.
    updated: 0,
    isDeleted: false,
    angle: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    link: null,
    locked: false,
  };
}

/** A solid ring, not a dashed one: dashes already mean a human gate here. */
function halo(node: PositionedNode): ExcalidrawElement {
  const gap = 7;
  return {
    ...base(`halo-${node.id}`, `halo-${node.id}`),
    type: "rectangle",
    x: node.x - gap,
    y: node.y - gap,
    width: node.width + gap * 2,
    height: node.height + gap * 2,
    strokeColor: DANGER,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    boundElements: [],
  };
}

const boundaryGroup = (id: string) => `boundary-${id}`;

/** A dashed, rounded rectangle and its caption above the top-left corner. */
function regionElements(region: PositionedRegion): ExcalidrawElement[] {
  const { id, label, access } = region.boundary;
  const caption = access === "read-only" ? `${label ?? id} · read-only` : (label ?? id);
  const rectId = `boundary-${id}-${region.part}`;
  const groupIds = [boundaryGroup(id)];
  const fontSize = 16;
  return [
    {
      ...base(rectId, rectId),
      type: "rectangle",
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      strokeColor: BOUNDARY,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "dashed",
      roughness: 0,
      roundness: { type: 3 },
      boundElements: [],
      groupIds,
    },
    {
      ...base(`${rectId}-label`, `${rectId}-label`),
      type: "text",
      x: region.x + 14,
      y: region.y - fontSize * 1.25,
      width: Math.ceil(caption.length * fontSize * 0.5),
      height: fontSize * 1.25,
      strokeColor: BOUNDARY,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      roundness: null,
      boundElements: [],
      groupIds,
      text: caption,
      originalText: caption,
      fontSize,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      autoResize: true,
    },
  ];
}

function box(
  node: PositionedNode,
  bound: Array<{ id: string; type: string }>,
  flagged: boolean,
): ExcalidrawElement {
  const style = renderStyle(node.node);
  return {
    ...base(node.id, node.id),
    type: "rectangle",
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    strokeColor: flagged ? DANGER : INK,
    backgroundColor: KIND_FILL[style] ?? "transparent",
    fillStyle: "solid",
    strokeWidth: style === "agent" ? 2 : 1,
    strokeStyle: style === "human" ? "dashed" : "solid",
    // Sketchy for agents, clean for plain code — same signal as the SVG.
    roughness: style === "agent" ? 1 : 0,
    roundness: null,
    boundElements: bound,
  };
}

function text(node: PositionedNode, arriving: number | undefined, notes: readonly string[]): ExcalidrawElement {
  const label = labelOf(node.node, arriving, notes);
  const fontSize = 20;
  const lineHeight = 1.25;
  return {
    ...base(`text-${node.id}`, `text-${node.id}`),
    type: "text",
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    roundness: null,
    boundElements: [],
    text: label,
    originalText: label,
    fontSize,
    // 1 = Virgil, Excalidraw's hand-drawn face.
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: node.id,
    lineHeight,
    autoResize: true,
  };
}

function arrow(
  id: string,
  positioned: PositionedGraph,
  edge: PositionedGraph["edges"][number],
  isFake: boolean,
): ExcalidrawElement {
  const points = edge.points.length >= 2 ? edge.points : fallbackPoints(positioned, edge);
  const origin = points[0]!;

  return {
    ...base(id, id),
    type: "arrow",
    x: origin.x,
    y: origin.y,
    width: Math.abs(points[points.length - 1]!.x - origin.x),
    height: Math.abs(points[points.length - 1]!.y - origin.y),
    strokeColor: isFake ? DANGER : ACCENT,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: isFake ? "dashed" : "solid",
    roughness: 1,
    roundness: { type: 2 },
    boundElements: [],
    points: points.map((p) => [p.x - origin.x, p.y - origin.y]),
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    startBinding: { elementId: edge.from, focus: 0, gap: 4 },
    endBinding: { elementId: edge.to, focus: 0, gap: 4 },
    elbowed: false,
  };
}

/** Straight centre-to-centre, only if the layout produced no route. */
function fallbackPoints(positioned: PositionedGraph, edge: PositionedGraph["edges"][number]) {
  const at = (id: string) => positioned.nodes.find((n) => n.id === id)!;
  const a = at(edge.from);
  const b = at(edge.to);
  return [
    { x: a.x + a.width / 2, y: a.y + a.height },
    { x: b.x + b.width / 2, y: b.y },
  ];
}

function labelOf(node: NodeSpec, arriving: number | undefined, notes: readonly string[]): string {
  const fan = node.fanOut ? ` ×${node.fanOut.cap ?? "n"}` : "";
  return `${node.label}${fan}${whoNote(node)}${notes.map((n) => ` · ${n}`).join("")}${guardNote(node, arriving)}`;
}

/** The tier and the agent, as the SVG draws them: plain code and an unspecified tier say nothing. */
function whoNote(node: NodeSpec): string {
  const tag = agentTag(node);
  return `${node.model ? ` · ${node.model}` : ""}${tag ? ` · ${tag}` : ""}`;
}

/** Rule order, as the linter reports it; the count guard's note always comes last. */
const NOTE_ORDER = [
  "MISSING_INPUT",
  "AUTHORITY_BREACH",
  "SELF_GRADING",
  "CONTEXT_COLLAPSE",
  "DUPLICATE_EFFECT",
  "EARLY_COMMIT",
] as const;

/** Node findings as label notes. Two writers of one file get a line instead (`sharedWrites`). */
function findingNotes(id: string, marks: readonly FindingMark[]): string[] {
  const notes: Array<{ rule: (typeof NOTE_ORDER)[number]; text: string }> = [];
  for (const m of marks) {
    if (m.rule === "MISSING_INPUT" && m.id === id) notes.push({ rule: m.rule, text: `no ${m.field}` });
    if (m.rule === "SELF_GRADING" && m.id === id) notes.push({ rule: m.rule, text: "grades own work" });
    if (m.rule === "CONTEXT_COLLAPSE" && m.id === id) notes.push({ rule: m.rule, text: `${m.arriving} in, no reduce` });
    if (m.rule === "AUTHORITY_BREACH" && m.id === id) {
      notes.push({ rule: m.rule, text: "boundary" in m ? `writes in read-only ${m.boundary}` : `writes ${m.store}, a person's` });
    }
    if (m.rule === "DUPLICATE_EFFECT" && m.id === id) notes.push({ rule: m.rule, text: `unguarded ${m.effect}` });
  }
  const early = marks.flatMap((m) => (m.rule === "EARLY_COMMIT" && m.id === id ? [m.store] : []));
  if (early.length > 0) notes.push({ rule: "EARLY_COMMIT", text: `writes ${early.join(", ")} too early` });
  return notes
    .sort((a, b) => NOTE_ORDER.indexOf(a.rule) - NOTE_ORDER.indexOf(b.rule))
    .map((n) => n.text);
}

/** One thin red line per pair of concurrent writers, and the file it is about. */
function sharedWrites(positioned: PositionedGraph, marks: readonly FindingMark[]): ExcalidrawElement[] {
  const pairs = new Map<string, { between: readonly [string, string]; files: string[] }>();
  for (const m of marks) {
    if (m.rule !== "HIDDEN_EDGE") continue;
    const key = [...m.between].sort().join("~");
    const entry = pairs.get(key) ?? { between: m.between, files: [] };
    if (!entry.files.includes(m.file)) entry.files.push(m.file);
    pairs.set(key, entry);
  }

  return routeLinks(positioned, [...pairs.values()].map((e) => e.between)).flatMap((route) => {
    const key = [...route.between].sort().join("~");
    const files = pairs.get(key)!.files;
    const origin = route.points[0]!;
    const xs = route.points.map((p) => p.x);
    const ys = route.points.map((p) => p.y);
    const label = `${files[0]!.split("/").pop()}${files.length > 1 ? ` +${files.length - 1}` : ""}`;
    const fontSize = 16;
    const width = Math.ceil(label.length * fontSize * 0.55);
    return [
      {
        ...base(`link-${key}`, `link-${key}`),
        type: "line",
        x: origin.x,
        y: origin.y,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        strokeColor: DANGER,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        // Solid: dashes already mean a human gate or a dead edge here.
        strokeStyle: "solid",
        roughness: 0,
        roundness: null,
        boundElements: [],
        points: route.points.map((p) => [p.x - origin.x, p.y - origin.y]),
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      },
      {
        ...base(`link-label-${key}`, `link-label-${key}`),
        type: "text",
        x: route.label.x - width / 2,
        y: route.label.y - fontSize * 1.25 - 2,
        width,
        height: fontSize * 1.25,
        strokeColor: DANGER,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        roundness: null,
        boundElements: [],
        text: label,
        originalText: label,
        fontSize,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "bottom",
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
      },
    ];
  });
}

/** The guard is always shown, since it is a declaration; a finding changes only its wording. */
function guardNote(node: NodeSpec, arriving: number | undefined): string {
  if (node.expects === undefined) return arriving === undefined ? "" : " · no count guard";
  return arriving === undefined ? ` · expects ${node.expects}` : ` · ${node.expects} ≠ ${arriving}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 2147483647;
}
