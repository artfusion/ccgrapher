// SPDX-License-Identifier: Apache-2.0
import { agentTag, renderStyle, type Graph, type NodeKind, type NodeSpec } from "@ccgrapher/core";

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
  /**
   * Every other rule's findings, as `renderMarksFor` in `@ccgrapher/lint` builds
   * them. Each is a red outline and a note in the label. Two writers of one file
   * are noted on both nodes rather than joined: any link in Mermaid is an edge,
   * and an edge between them would move one of them down a row.
   */
  readonly findingMarks?: ReadonlyArray<FindingMark>;
  /** Label each edge with the fields it carries. On by default. */
  readonly showCarries?: boolean;
  /** Wrap the output in a ```mermaid fence for pasting into Markdown. */
  readonly fenced?: boolean;
}

/** The same shape `render-svg` and `render-excalidraw` take; declared here so this package needs neither. */
export type FindingMark =
  | { readonly rule: "MISSING_INPUT"; readonly id: string; readonly field: string }
  | { readonly rule: "SELF_GRADING"; readonly id: string }
  | { readonly rule: "CONTEXT_COLLAPSE"; readonly id: string; readonly arriving: number }
  | { readonly rule: "HIDDEN_EDGE"; readonly between: readonly [string, string]; readonly file: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly store: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly boundary: string }
  | { readonly rule: "DUPLICATE_EFFECT"; readonly id: string; readonly effect: string }
  | { readonly rule: "EARLY_COMMIT"; readonly id: string; readonly store: string };

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
  const findingMarks = options.findingMarks ?? [];

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
    lines.push(`  ${node.id}${open}"${label(node, arriving.get(node.id), findingNotes(node.id, findingMarks))}"${close}`);
  }

  lines.push(...boundaries(graph));

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
  if (graph.spec.boundaries?.length) lines.push(BOUNDARY_CLASS);
  for (const [style, ids] of byStyle) {
    if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${style};`);
  }

  // A style line beats the class, so the red outline lands whatever the kind.
  // Solid on purpose: dashes already mean a human gate.
  for (const node of graph.spec.nodes) {
    if (arriving.has(node.id) || findingNotes(node.id, findingMarks).length > 0) lines.push(`  style ${node.id} stroke:#C4442E,stroke-width:2.5px;`);
  }

  for (const i of fakeIndices) {
    lines.push(`  linkStyle ${i} stroke:#C4442E,stroke-width:1.5px,stroke-dasharray:6 4;`);
  }

  const body = lines.join("\n");
  return options.fenced ? `\`\`\`mermaid\n${body}\n\`\`\`` : body;
}

/**
 * One subgraph per boundary, listing nodes already declared above, styled as a
 * dashed muted region to match the SVG. Mermaid keeps a subgraph's members
 * together, so it may reorder a row to do so, but it ranks them by their edges
 * as before; a boundary changes no row in the Mermaid picture either. A
 * subgraph cannot be split the way the SVG splits a region around a non-member,
 * which is the one place the two renderers differ: Mermaid moves the
 * non-member aside instead.
 *
 * The subgraph id is suffixed so it can never collide with a node id.
 */
function boundaries(graph: Graph): string[] {
  return (graph.spec.boundaries ?? []).flatMap((boundary) => {
    const id = `${boundary.id.replace(/[^A-Za-z0-9_]/g, "_")}__boundary`;
    const caption = boundary.access === "read-only"
      ? `${boundary.label ?? boundary.id} · read-only`
      : (boundary.label ?? boundary.id);
    return [
      `  subgraph ${id}["${escape(caption)}"]`,
      ...boundary.members.map((member) => `    ${member}`),
      "  end",
      `  class ${id} boundary;`,
    ];
  });
}

/** A class rather than a `style` line: in this output `style` is kept for findings. */
const BOUNDARY_CLASS =
  "  classDef boundary fill:none,stroke:#736A63,stroke-width:1.4px,stroke-dasharray:12 6,color:#736A63;";

function label(node: NodeSpec, arriving: number | undefined, notes: readonly string[]): string {
  const badge = node.fanOut ? ` ×${node.fanOut.cap ?? "n"}` : "";
  const found = notes.map((n) => ` · ${escape(n)}`).join("");
  return `${escape(node.label)}${badge}${escape(whoNote(node))}${found}${guardNote(node, arriving)}`;
}

/** Rule order, as the linter reports it; the count guard's note always comes last. */
const NOTE_ORDER = [
  "MISSING_INPUT",
  "AUTHORITY_BREACH",
  "HIDDEN_EDGE",
  "SELF_GRADING",
  "CONTEXT_COLLAPSE",
  "DUPLICATE_EFFECT",
  "EARLY_COMMIT",
] as const;

function findingNotes(id: string, marks: readonly FindingMark[]): string[] {
  const notes: Array<{ rule: FindingMark["rule"]; text: string }> = [];
  for (const m of marks) {
    if (m.rule === "MISSING_INPUT" && m.id === id) notes.push({ rule: m.rule, text: `no ${m.field}` });
    if (m.rule === "SELF_GRADING" && m.id === id) notes.push({ rule: m.rule, text: "grades own work" });
    if (m.rule === "CONTEXT_COLLAPSE" && m.id === id) notes.push({ rule: m.rule, text: `${m.arriving} in, no reduce` });
    if (m.rule === "HIDDEN_EDGE" && m.between.includes(id)) {
      const other = m.between[0] === id ? m.between[1] : m.between[0];
      notes.push({ rule: m.rule, text: `shares ${m.file} with ${other}` });
    }
    if (m.rule === "AUTHORITY_BREACH" && m.id === id) notes.push({ rule: m.rule, text: authorityNote(m) });
    if (m.rule === "DUPLICATE_EFFECT" && m.id === id) notes.push({ rule: m.rule, text: `unguarded ${m.effect}` });
  }
  const early = marks.flatMap((m) => (m.rule === "EARLY_COMMIT" && m.id === id ? [m.store] : []));
  if (early.length > 0) notes.push({ rule: "EARLY_COMMIT", text: `writes ${early.join(", ")} too early` });
  return notes
    .sort((a, b) => NOTE_ORDER.indexOf(a.rule) - NOTE_ORDER.indexOf(b.rule))
    .map((n) => n.text);
}

const authorityNote = (m: Extract<FindingMark, { rule: "AUTHORITY_BREACH" }>) =>
  "boundary" in m ? `writes in read-only ${m.boundary}` : `writes ${m.store}, a person's`;

/** The tier and the agent, as the SVG draws them: plain code and an unspecified tier say nothing. */
function whoNote(node: NodeSpec): string {
  const tag = agentTag(node);
  return `${node.model ? ` · ${node.model}` : ""}${tag ? ` · ${tag}` : ""}`;
}

/** The guard is always shown, since it is a declaration; a finding changes only its wording. */
function guardNote(node: NodeSpec, arriving: number | undefined): string {
  if (node.expects === undefined) return arriving === undefined ? "" : " · no count guard";
  return arriving === undefined ? ` · expects ${node.expects}` : ` · ${node.expects} ≠ ${arriving}`;
}

/** Mermaid needs HTML entities for quotes and angle brackets inside labels. */
const escape = (text: string) =>
  text.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
