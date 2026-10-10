// SPDX-License-Identifier: Apache-2.0
import { renderStyle, type Graph, type NodeKind, type NodeSpec } from "@ccgrapher/core";

export interface MermaidOptions {
  /** Mermaid v11's sketch renderer. On by default — it is the cheap way to the look. */
  readonly handDrawn?: boolean;
  /** Mark these edges dotted and red. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * Fan-ins the linter flagged for their count guard, with the number of results
   * that actually arrive. Drawn with a red outline and a note in the label; the
   * renderer does not compare `expects` with the edges itself.
   */
  readonly guardFindings?: ReadonlyArray<{ readonly id: string; readonly arriving: number }>;
  /** Label each edge with the fields it carries. On by default. */
  readonly showCarries?: boolean;
  /** Wrap the output in a ```mermaid fence for pasting into Markdown. */
  readonly fenced?: boolean;
}

/** Mermaid's shape vocabulary, mapped so a kind is legible without a legend. */
const SHAPE: Record<NodeKind, readonly [string, string]> = {
  goal: ["([", "])"],
  split: ["[/", "\\]"],
  worker: ["[", "]"],
  verifier: ["{{", "}}"],
  reduce: ["[[", "]]"],
  synthesize: ["([", "])"],
  gate: ["{", "}"],
};

/**
 * Emits `flowchart TD`. Unlike the SVG path this needs no layout pass — Mermaid
 * ranks the graph itself, and because the ranking is the same longest-path
 * algorithm, parallel nodes land on the same row there too.
 */
export function renderMermaid(graph: Graph, options: MermaidOptions = {}): string {
  const handDrawn = options.handDrawn ?? true;
  const showCarries = options.showCarries ?? true;
  const fake = new Set((options.fakeEdges ?? []).map((e) => `${e.from}->${e.to}`));
  const arriving = new Map((options.guardFindings ?? []).map((g) => [g.id, g.arriving]));

  const lines: string[] = [];

  if (handDrawn) {
    lines.push(
      "---",
      "config:",
      "  look: handDrawn",
      "  theme: base",
      "  themeVariables:",
      "    primaryColor: '#FFFFFF'",
      "    primaryTextColor: '#2B2724'",
      "    primaryBorderColor: '#2B2724'",
      "    lineColor: '#E8763A'",
      "    fontFamily: 'Caveat, Patrick Hand, cursive'",
      "---",
    );
  }

  lines.push("flowchart TD");

  if (graph.spec.goal) lines.push(`  %% ${graph.spec.goal}`);

  for (const node of graph.spec.nodes) {
    const [open, close] = SHAPE[node.kind];
    lines.push(`  ${node.id}${open}"${label(node, arriving.get(node.id))}"${close}`);
  }

  const fakeIndices: number[] = [];
  graph.edges.forEach((edge, i) => {
    const isFake = fake.has(`${edge.from}->${edge.to}`);
    if (isFake) fakeIndices.push(i);

    const arrow = isFake ? "-.->" : "-->";
    const text = isFake ? "no data" : showCarries ? edge.carries.join(", ") : "";
    const mid = text ? `|"${escape(text)}"|` : "";
    lines.push(`  ${edge.from} ${arrow}${mid} ${edge.to}`);
  });

  // Kind styling. Code-only and human nodes get a flat fill to match the SVG's
  // "this costs nothing" signal.
  const byStyle = new Map<string, string[]>();
  for (const node of graph.spec.nodes) {
    const key = renderStyle(node);
    byStyle.set(key, [...(byStyle.get(key) ?? []), node.id]);
  }
  lines.push("");
  lines.push("  classDef agent fill:#FFFFFF,stroke:#2B2724,stroke-width:2px;");
  lines.push("  classDef code fill:#F1EEE9,stroke:#2B2724,stroke-width:1.5px;");
  lines.push("  classDef human fill:#F6F0DC,stroke:#2B2724,stroke-width:1.5px,stroke-dasharray:5 3;");
  for (const [style, ids] of byStyle) {
    if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${style};`);
  }

  // A style line beats the class, so the red outline lands whatever the kind.
  // Solid on purpose: dashes already mean a human gate.
  for (const node of graph.spec.nodes) {
    if (arriving.has(node.id)) lines.push(`  style ${node.id} stroke:#C4442E,stroke-width:2.5px;`);
  }

  for (const i of fakeIndices) {
    lines.push(`  linkStyle ${i} stroke:#C4442E,stroke-width:1.5px,stroke-dasharray:6 4;`);
  }

  const body = lines.join("\n");
  return options.fenced ? `\`\`\`mermaid\n${body}\n\`\`\`` : body;
}

function label(node: NodeSpec, arriving: number | undefined): string {
  const badge = node.fanOut ? ` ×${node.fanOut.cap ?? "n"}` : "";
  return `${escape(node.label)}${badge}${guardNote(node, arriving)}`;
}

/** The guard is always shown, since it is a declaration; a finding changes only its wording. */
function guardNote(node: NodeSpec, arriving: number | undefined): string {
  if (node.expects === undefined) return arriving === undefined ? "" : " · no count guard";
  return arriving === undefined ? ` · expects ${node.expects}` : ` · ${node.expects} ≠ ${arriving}`;
}

/** Mermaid needs HTML entities for quotes and angle brackets inside labels. */
const escape = (text: string) =>
  text.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
