// SPDX-License-Identifier: Apache-2.0
import { rankGraph, type EdgeSpec, type Graph, type NodeSpec, type Ranking } from "@ccgrapher/core";
import dagre from "@dagrejs/dagre";
import { DEFAULT_METRICS, measureNode, type Metrics } from "./measure.js";
import { boundaryRegions, type PositionedRegion } from "./regions.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PositionedNode {
  readonly id: string;
  readonly node: NodeSpec;
  /** Top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rank: number;
  /** Pre-wrapped label lines, so the renderer measures nothing itself. */
  readonly lines: readonly string[];
}

export interface PositionedEdge {
  readonly from: string;
  readonly to: string;
  readonly edge: EdgeSpec;
  readonly points: readonly Point[];
}

export interface PositionedGraph {
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly PositionedEdge[];
  /** Regions drawn behind the members of each boundary. Empty when the spec has none. */
  readonly regions: readonly PositionedRegion[];
  readonly width: number;
  readonly height: number;
  readonly ranking: Ranking;
  readonly graph: Graph;
}

export interface LayoutOptions {
  /** Vertical gap between rows. Generous, per the reference images. */
  readonly rankSep?: number;
  /** Horizontal gap within a row. Small, so parallel work reads as one band. */
  readonly nodeSep?: number;
  readonly margin?: number;
  readonly metrics?: Metrics;
}

export const DEFAULT_LAYOUT = {
  rankSep: 96,
  nodeSep: 30,
  margin: 40,
} as const;

/**
 * dagre places the boxes, but it does not choose their rows: core's ranking is
 * handed to it, so a step is drawn on the row of the wave it runs in and the
 * picture can never disagree with the number the linter prints. dagre's own
 * `longest-path` ranker measures from the sinks, so it pushes a step that
 * nothing waits on long down to sit just above its consumer, a row or more below
 * its wave. A test asserts the rows and the ranks agree on every spec in the
 * repository rather than trusting that they do.
 *
 * No coordinate in this file is authored; they all come out of dagre or out of
 * the measured text.
 */
export function layoutGraph(graph: Graph, options: LayoutOptions = {}): PositionedGraph {
  const rankSep = options.rankSep ?? DEFAULT_LAYOUT.rankSep;
  const nodeSep = options.nodeSep ?? DEFAULT_LAYOUT.nodeSep;
  const margin = options.margin ?? DEFAULT_LAYOUT.margin;
  const metrics = options.metrics ?? DEFAULT_METRICS;

  const ranking = rankGraph(graph);

  const d = new dagre.graphlib.Graph({ multigraph: true });
  d.setGraph({ rankdir: "TB", ranksep: rankSep, nodesep: nodeSep, ranker: coreRanker(ranking) });
  d.setDefaultEdgeLabel(() => ({}));

  const measured = new Map<string, ReturnType<typeof measureNode>>();
  for (const node of graph.spec.nodes) {
    const size = measureNode(node, metrics);
    measured.set(node.id, size);
    d.setNode(node.id, { width: size.width, height: size.height });
  }

  // Multigraph with an explicit name per edge, so two edges between the same
  // pair of nodes keep separate routes instead of collapsing into one.
  graph.edges.forEach((edge, i) => {
    d.setEdge(edge.from, edge.to, {}, `e${i}`);
  });

  dagre.layout(d);

  const nodes: PositionedNode[] = graph.spec.nodes.map((node) => {
    const laid = d.node(node.id);
    const size = measured.get(node.id)!;
    return {
      id: node.id,
      node,
      x: laid.x - size.width / 2,
      y: laid.y - size.height / 2,
      width: size.width,
      height: size.height,
      rank: ranking.rank.get(node.id) ?? 0,
      lines: size.lines,
    };
  });

  const edges: PositionedEdge[] = graph.edges.map((edge, i) => {
    const laid = d.edge({ v: edge.from, w: edge.to, name: `e${i}` });
    return {
      from: edge.from,
      to: edge.to,
      edge,
      points: laid?.points ?? [],
    };
  });

  const oriented = orientToSpecOrder(nodes, edges, ranking);
  return normalise({ ...oriented, margin, ranking, graph });
}

/**
 * A ranker for dagre that assigns core's ranks instead of computing its own.
 * dagre leaves a spare rank between every pair of rows for edge labels, by
 * stretching each edge's `minlen` before it ranks; the stride is read off those
 * edges rather than assumed, and core's layer `r` becomes dagre rank `r * stride`.
 * Anything that is not a step (dagre's own scaffolding node) goes above row 0.
 *
 * dagre accepts a function here at runtime; its typings only list the names of
 * the built-in rankers, hence the cast.
 */
function coreRanker(ranking: Ranking): string {
  const ranker = (g: dagre.graphlib.Graph): void => {
    let stride = 1;
    for (const e of g.edges()) {
      if (ranking.rank.has(e.v) && ranking.rank.has(e.w)) {
        stride = Math.max(stride, (g.edge(e) as { minlen?: number }).minlen ?? 1);
      }
    }
    for (const id of g.nodes()) {
      const r = ranking.rank.get(id);
      (g.node(id) as { rank?: number }).rank = r === undefined ? -1 : r * stride;
    }
  };
  return ranker as unknown as string;
}

/**
 * dagre's ordering pass is free to lay a rank out end-to-end backwards, so a
 * spec authored worker_1..worker_5 can come out 5..1. Mirroring the whole
 * drawing is a rigid transform — gaps, crossings and edge routes all survive
 * it — so we flip when that reads closer to the order the spec was written in.
 */
function orientToSpecOrder(
  nodes: PositionedNode[],
  edges: PositionedEdge[],
  ranking: Ranking,
): { nodes: PositionedNode[]; edges: PositionedEdge[] } {
  const centre = new Map(nodes.map((n) => [n.id, n.x + n.width / 2]));

  let concordant = 0;
  let discordant = 0;
  for (const layer of ranking.layers) {
    for (let i = 0; i < layer.length; i++) {
      for (let j = i + 1; j < layer.length; j++) {
        const left = centre.get(layer[i]!)!;
        const right = centre.get(layer[j]!)!;
        if (left < right) concordant++;
        else if (left > right) discordant++;
      }
    }
  }
  if (discordant <= concordant) return { nodes, edges };

  const axis = Math.max(...nodes.map((n) => n.x + n.width)) + Math.min(...nodes.map((n) => n.x));
  return {
    nodes: nodes.map((n) => ({ ...n, x: axis - (n.x + n.width) })),
    edges: edges.map((e) => ({ ...e, points: e.points.map((p) => ({ ...p, x: axis - p.x })) })),
  };
}

/** Shift everything so the drawing starts at (margin, margin) and report the extent. */
function normalise(input: {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  margin: number;
  ranking: Ranking;
  graph: Graph;
}): PositionedGraph {
  const { nodes, edges, margin, ranking, graph } = input;

  const xs = [
    ...nodes.flatMap((n) => [n.x, n.x + n.width]),
    ...edges.flatMap((e) => e.points.map((p) => p.x)),
  ];
  const ys = [
    ...nodes.flatMap((n) => [n.y, n.y + n.height]),
    ...edges.flatMap((e) => e.points.map((p) => p.y)),
  ];

  const dx = margin - Math.min(...xs);
  const dy = margin - Math.min(...ys);

  const placed = nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));

  // Regions sit inside the margin (the region padding is far smaller), so they leave
  // the extent alone: a boundary never changes the size of the drawing.
  return {
    nodes: placed,
    regions: boundaryRegions(graph.spec.boundaries ?? [], placed),
    edges: edges.map((e) => ({
      ...e,
      points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    })),
    width: Math.ceil(Math.max(...xs) + dx + margin),
    height: Math.ceil(Math.max(...ys) + dy + margin),
    ranking,
    graph,
  };
}
