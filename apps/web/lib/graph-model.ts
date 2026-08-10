// SPDX-License-Identifier: Apache-2.0
import { buildGraph, parseSpec, renderStyle, withEdges, type Graph } from "@ccgrapher/core";
import { layoutGraph } from "@ccgrapher/layout";
import { lint, type LintResult } from "@ccgrapher/lint";
import type { CCEdge as Edge, CCNode as Node } from "./view-model.js";

export interface Model {
  readonly ok: true;
  readonly graph: Graph;
  readonly result: LintResult;
  readonly nodes: Node[];
  readonly edges: Edge[];
}

export interface ModelError {
  readonly ok: false;
  readonly error: string;
}

export type ModelState = Model | ModelError;

export const KIND_TINT: Record<string, string> = {
  goal: "#FFFFFF",
  split: "#FFFFFF",
  worker: "#FFFFFF",
  verifier: "#FDEFE6",
  reduce: "#F1EEE9",
  synthesize: "#FBE3D3",
  gate: "#F6F0DC",
};

export const INK = "#2B2724";
export const ACCENT = "#E8763A";
export const DANGER = "#C4442E";
export const PAPER = "#FBF7F0";

/**
 * Parse, lint and lay out in one pass. The canvas runs the exact same core,
 * lint and layout packages the CLI does, so what you see here and what
 * `ccg lint` prints can never disagree.
 */
export function buildModel(yaml: string, repaired: boolean): ModelState {
  let base: Graph;
  try {
    base = buildGraph(parseSpec(yaml));
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  const result = lint(base);
  const graph = repaired ? withEdges(base, result.repairedEdges) : base;
  const positioned = layoutGraph(graph, { margin: 24 });

  const fake = new Set(
    result.findings
      .filter((f) => f.rule === "FAKE_EDGE" && f.edge)
      .map((f) => `${f.edge!.from}->${f.edge!.to}`),
  );

  const flagged = new Map<string, string[]>();
  for (const finding of result.findings) {
    if (finding.rule === "FAKE_EDGE") continue;
    for (const id of finding.nodes) {
      flagged.set(id, [...(flagged.get(id) ?? []), `${finding.rule}: ${finding.message}`]);
    }
  }

  const nodes: Node[] = positioned.nodes.map((p) => ({
    id: p.id,
    position: { x: p.x, y: p.y },
    data: {
      label: p.node.label,
      lines: p.lines,
      kind: p.node.kind,
      style: renderStyle(p.node),
      badge: p.node.fanOut ? `×${p.node.fanOut.cap ?? "n"}` : null,
      worktree: p.node.worktree === true,
      // The spec side of a capability, kept separate from anything a run says.
      // An empty list here means "this node declares nothing", which is not the
      // same fact as "no run reported any use" — see lib/capability.ts.
      uses: p.node.uses ?? [],
      rank: p.rank,
      problems: flagged.get(p.id) ?? [],
    },
    type: "spec",
    width: p.width,
    height: p.height,
    draggable: true,
  }));

  const edges: Edge[] = positioned.edges.map((e, i) => {
    const isFake = !repaired && fake.has(`${e.from}->${e.to}`);
    return {
      id: `${e.from}->${e.to}#${i}`,
      source: e.from,
      target: e.to,
      label: isFake ? "carries no data" : e.edge.carries.join(", "),
      animated: isFake,
      style: {
        stroke: isFake ? DANGER : ACCENT,
        strokeWidth: isFake ? 1.6 : 2,
        ...(isFake ? { strokeDasharray: "6 4" } : {}),
      },
      labelStyle: {
        fill: isFake ? DANGER : "#6F6660",
        fontSize: 12,
        fontFamily: "var(--hand)",
      },
      labelBgStyle: { fill: PAPER, fillOpacity: 0.9 },
      markerEnd: { type: "arrowclosed", color: isFake ? DANGER : ACCENT } as Edge["markerEnd"],
      data: { fake: isFake, carries: e.edge.carries },
    };
  });

  return { ok: true, graph, result, nodes, edges };
}
