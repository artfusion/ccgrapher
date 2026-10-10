// SPDX-License-Identifier: Apache-2.0
import { renderStyle, type NodeSpec } from "@ccgrapher/core";
import type { PositionedGraph, PositionedNode } from "@ccgrapher/layout";

export interface ExcalidrawOptions {
  /** Mark these edges dashed and red. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * Fan-ins the linter flagged for their count guard, with the number of results
   * that actually arrive. Drawn as a red box inside a solid red halo; the renderer
   * does not compare `expects` with the edges itself.
   */
  readonly guardFindings?: ReadonlyArray<{ readonly id: string; readonly arriving: number }>;
  readonly backgroundColor?: string;
}

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

  for (const node of positioned.nodes) {
    const found = arriving.get(node.id);
    // The halo goes in first so it sits behind the box. It is not bound to anything.
    if (found !== undefined) elements.push(halo(node));
    elements.push(box(node, bindings.get(node.id) ?? [], found !== undefined));
    elements.push(text(node, found));
  }

  positioned.edges.forEach((edge, i) => {
    const isFake = fake.has(`${edge.from}->${edge.to}`);
    elements.push(arrow(`arrow-${i}`, positioned, edge, isFake));
  });

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

function text(node: PositionedNode, arriving: number | undefined): ExcalidrawElement {
  const label = labelOf(node.node, arriving);
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

function labelOf(node: NodeSpec, arriving: number | undefined): string {
  const fan = node.fanOut ? ` ×${node.fanOut.cap ?? "n"}` : "";
  return `${node.label}${fan}${guardNote(node, arriving)}`;
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
