// SPDX-License-Identifier: Apache-2.0
import type { Graph, NodeSpec } from "@ccgrapher/core";
import { objectSchema } from "../fields.js";
import { inputsOf, stages } from "../stages.js";
import { banner, identifier, quote, type Emitter, type EmitOptions } from "../types.js";

/**
 * Emits a Workflow script: `agent()` for one job, `parallel()` for a rank with
 * more than one node. Because the stages come straight from the graph's ranks,
 * the concurrency in the generated script is exactly the concurrency the
 * diagram shows — the two cannot drift.
 */
export const claudeCodeEmitter: Emitter = {
  target: "claude-code",
  extension: ".workflow.mjs",

  emit(graph: Graph, options: EmitOptions): string {
    const all = stages(graph);
    const lines: string[] = [...banner(graph, options, "claude-code")];

    lines.push(
      "export const meta = {",
      `  name: ${quote(graph.spec.name)},`,
      `  description: ${quote(graph.spec.goal ?? graph.spec.name)},`,
      "  phases: [",
      ...all.map((stage) => `    { title: ${quote(phaseTitle(stage.nodes))} },`),
      "  ],",
      "}",
      "",
    );

    if (graph.spec.nodes.some((n) => n.fanOut)) {
      lines.push(
        "/** A fanOut source may hand back one item or many; normalise before mapping. */",
        "const toList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])",
        "",
      );
    }

    for (const node of graph.spec.nodes) {
      if (Object.keys(node.out).length === 0) continue;
      lines.push(`const ${schemaName(node)} = ${JSON.stringify(objectSchema(node.out), null, 2)}`, "");
    }

    for (const stage of all) {
      lines.push(`phase(${quote(phaseTitle(stage.nodes))})`);
      lines.push(
        ...(stage.nodes.length === 1
          ? single(graph, stage.nodes[0]!)
          : concurrent(graph, stage.nodes)),
      );
      lines.push("");
    }

    const last = all[all.length - 1]?.nodes ?? [];
    lines.push(`return { ${last.map((n) => identifier(n.id)).join(", ")} }`, "");

    return lines.join("\n");
  },
};

function single(graph: Graph, node: NodeSpec): string[] {
  const name = identifier(node.id);
  const prelude = inputPrelude(graph, node);

  if (node.fanOut) {
    const cap = node.fanOut.cap;
    return [
      ...prelude.lines,
      `// one agent per ${node.fanOut.over}${cap ? `, capped at ${cap}` : ""}`,
      `const ${name}Items = toList(${prelude.expr})${cap ? `.slice(0, ${cap})` : ""}`,
      `const ${name} = (await parallel(${name}Items.map((item, i) => () =>`,
      `  agent(${prompt(node, "item")}, ${opts(node, `\`${node.id}:\${i}\``)}),`,
      `))).filter(Boolean)`,
    ];
  }

  return [
    ...prelude.lines,
    ...freshContextNote(node),
    `const ${name} = await agent(${prompt(node, prelude.expr)}, ${opts(node, quote(node.id))})`,
  ];
}

function concurrent(graph: Graph, nodes: readonly NodeSpec[]): string[] {
  const preludes = nodes.map((node) => inputPrelude(graph, node));
  return [
    ...preludes.flatMap((p) => p.lines),
    ...nodes.flatMap(freshContextNote),
    `const [${nodes.map((n) => identifier(n.id)).join(", ")}] = await parallel([`,
    ...nodes.map(
      (node, i) => `  () => agent(${prompt(node, preludes[i]!.expr)}, ${opts(node, quote(node.id))}),`,
    ),
    "])",
  ];
}

/**
 * The expression holding what actually reached this node, plus any lines needed
 * to build it — and the fan-in count guard, which has to test the results that
 * *arrived*, not the node's own output. Without it one dead upstream node slips
 * through and the synthesis step reports on partial data as though it were whole.
 */
function inputPrelude(graph: Graph, node: NodeSpec): { lines: string[]; expr: string } {
  const name = identifier(node.id);
  const sources = inputsOf(graph, node);
  const lines: string[] = [];

  let expr: string;
  if (sources.length === 0) {
    expr = "args";
  } else if (sources.length === 1) {
    expr = identifier(sources[0]!.from);
  } else {
    // parallel() yields null for an agent that died, so drop those before counting.
    expr = `${name}Inputs`;
    lines.push(
      `const ${expr} = [${sources.map((s) => identifier(s.from)).join(", ")}].filter(Boolean)`,
    );
  }

  if (node.expects !== undefined) {
    lines.push(
      `if (${expr}.length !== ${node.expects}) {`,
      `  log(\`${node.id}: expected ${node.expects} results, got \${${expr}.length}\`)`,
      "}",
    );
  }

  return { lines, expr };
}

/** The rule the article is emphatic about: a worker never checks its own work. */
function freshContextNote(node: NodeSpec): string[] {
  return node.freshContext
    ? [`// ${node.id} runs in a fresh context — it must not share one with the work it grades`]
    : [];
}

function opts(node: NodeSpec, label: string): string {
  const parts = [`label: ${label}`];
  if (Object.keys(node.out).length > 0) parts.push(`schema: ${schemaName(node)}`);
  if (node.model) parts.push(`model: ${quote(node.model === "cheap" ? "haiku" : "opus")}`);
  // An isolated worktree is what stops two "independent" workers colliding on disk.
  if (node.worktree) parts.push(`isolation: ${quote("worktree")}`);
  return `{ ${parts.join(", ")} }`;
}

function prompt(node: NodeSpec, input: string): string {
  const wants = Object.entries(node.out)
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  return [
    "`",
    node.label,
    ".",
    wants ? ` Return ${wants}.` : "",
    `\n\nInput: \${JSON.stringify(${input})}`,
    "`",
  ].join("");
}

const schemaName = (node: NodeSpec) => `${identifier(node.id).toUpperCase()}_SCHEMA`;

function phaseTitle(nodes: readonly NodeSpec[]): string {
  if (nodes.length === 1) return titleCase(nodes[0]!.label);
  const kinds = new Set(nodes.map((n) => n.kind));
  return kinds.size === 1 ? `${titleCase([...kinds][0]!)}s` : "Parallel";
}

const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
