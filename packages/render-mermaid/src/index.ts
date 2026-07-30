// SPDX-License-Identifier: Apache-2.0
import { renderStyle, type Graph, type NodeKind, type NodeSpec } from "@ccgrapher/core";

export interface MermaidOptions {
  /** Mermaid v11's sketch renderer. On by default — it is the cheap way to the look. */
  readonly handDrawn?: boolean;
  /** Mark these edges dotted and red. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
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
    lines.push(`  ${node.id}${open}"${label(node)}"${close}`);
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

  for (const i of fakeIndices) {
    lines.push(`  linkStyle ${i} stroke:#C4442E,stroke-width:1.5px,stroke-dasharray:6 4;`);
  }

  const body = lines.join("\n");
  return options.fenced ? `\`\`\`mermaid\n${body}\n\`\`\`` : body;
}

function label(node: NodeSpec): string {
  const badge = node.fanOut ? ` ×${node.fanOut.cap ?? "n"}` : "";
  return `${escape(node.label)}${badge}`;
}

/** Mermaid needs HTML entities for quotes and angle brackets inside labels. */
const escape = (text: string) =>
  text.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
