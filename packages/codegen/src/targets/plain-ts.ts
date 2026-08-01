// SPDX-License-Identifier: Apache-2.0
import type { Graph, NodeSpec } from "@ccgrapher/core";
import { tsInterfaceBody } from "../fields.js";
import { inputsOf, stages } from "../stages.js";
import { banner, identifier, type Emitter, type EmitOptions } from "../types.js";

/**
 * Runtime-agnostic skeleton: one typed async function per node, and a runner
 * that awaits each rank with Promise.all. Node bodies are left to throw — this
 * target generates the orchestration, not the work.
 */
export const plainTsEmitter: Emitter = {
  target: "plain-ts",
  extension: ".ts",

  emit(graph: Graph, options: EmitOptions): string {
    const all = stages(graph);
    const lines: string[] = [...banner(graph, options, "plain-ts")];

    for (const node of graph.spec.nodes) {
      lines.push(
        `export interface ${typeName(node, "In")} {`,
        tsInterfaceBody(node.in),
        "}",
        "",
        `export interface ${typeName(node, "Out")} {`,
        tsInterfaceBody(node.out),
        "}",
        "",
      );
    }

    for (const node of graph.spec.nodes) {
      lines.push(
        docComment(node),
        `export async function ${identifier(node.id)}(`,
        `  input: ${typeName(node, "In")},`,
        `): Promise<${typeName(node, "Out")}> {`,
        `  void input;`,
        `  throw new Error(${JSON.stringify(`${node.id}: not implemented`)});`,
        "}",
        "",
      );
    }

    if (graph.spec.nodes.some((n) => n.fanOut)) {
      lines.push(
        "/** A fanOut source may hand back one item or many; normalise before mapping. */",
        "function toList<T>(value: T | T[]): T[] {",
        "  return Array.isArray(value) ? value : [value];",
        "}",
        "",
      );
    }

    const root = all[0]?.nodes[0];
    lines.push(
      `export async function run${pascal(graph.spec.name)}(`,
      `  args: ${root ? typeName(root, "In") : "Record<string, unknown>"},`,
      "): Promise<unknown> {",
    );

    for (const stage of all) {
      lines.push(`  // rank ${stage.rank}${stage.nodes.length > 1 ? " — runs concurrently" : ""}`);
      lines.push(
        ...(stage.nodes.length === 1
          ? single(graph, stage.nodes[0]!)
          : concurrent(graph, stage.nodes)),
      );
      lines.push("");
    }

    const last = all[all.length - 1]?.nodes ?? [];
    lines.push(
      `  return { ${last.map((n) => `${identifier(n.id)}: ${resultVar(n)}`).join(", ")} };`,
      "}",
      "",
    );

    return lines.join("\n");
  },
};

/**
 * Everything about a node that TypeScript's own syntax cannot express, written
 * as ordinary documentation. Reads naturally, and `ingest` parses it back.
 */
function docComment(node: NodeSpec): string {
  const traits = [node.kind as string];
  if (node.model === null) traits.push("plain code");
  else if (node.model) traits.push(`model: ${node.model}`);
  if (node.freshContext) traits.push("fresh context");
  if (node.worktree) traits.push("isolated worktree");
  if (node.expects !== undefined) traits.push(`expects ${node.expects}`);
  if (node.writes?.length) traits.push(`writes ${node.writes.join(" ")}`);

  const fan = node.fanOut
    ? ` Runs once per ${node.fanOut.over}${node.fanOut.cap ? `, capped at ${node.fanOut.cap}` : ""}.`
    : "";

  return `/** ${node.label} — ${traits.join(", ")}.${fan} */`;
}

function single(graph: Graph, node: NodeSpec): string[] {
  const name = identifier(node.id);
  const result = resultVar(node);

  if (node.fanOut) {
    const cap = node.fanOut.cap;
    const source = inputsOf(graph, node)[0]?.from;
    const items = source ? `toList(${resultVarFor(graph, source)})` : "toList(args)";
    return [
      `  const ${name}Items = ${items}${cap ? `.slice(0, ${cap})` : ""};`,
      `  const ${result} = await Promise.all(`,
      `    ${name}Items.map((item) => ${name}(item as ${typeName(node, "In")})),`,
      `  );`,
      ...fanOutGuard(node, result),
    ];
  }

  return [
    ...staticGuardNote(graph, node),
    `  const ${result} = await ${name}(${inputExpr(graph, node)});`,
  ];
}

function concurrent(graph: Graph, nodes: readonly NodeSpec[]): string[] {
  return [
    `  const [${nodes.map(resultVar).join(", ")}] = await Promise.all([`,
    ...nodes.map((n) => `    ${identifier(n.id)}(${inputExpr(graph, n)}),`),
    "  ]);",
  ];
}

/**
 * Only a fanOut produces a count that can vary at runtime, so that is the only
 * place a real guard belongs. A static fan-in either resolves all its inputs or
 * Promise.all rejects, so the count is noted rather than tested.
 *
 * A floor, `< expects`, matching the runner and the `claude-code` target: an
 * uncapped fanOut, or one capped above the declared count, can legitimately
 * hand back more than `expects`, and throwing on data that is all present would
 * be worse than the stale count the linter already reports. See
 * `NodeSpec.expects` in `@ccgrapher/core`.
 */
function fanOutGuard(node: NodeSpec, result: string): string[] {
  if (node.expects === undefined) return [];
  return [
    `  if (${result}.length < ${node.expects}) {`,
    `    throw new Error(\`${node.id}: expected at least ${node.expects}, got \${${result}.length}\`);`,
    "  }",
  ];
}

function staticGuardNote(graph: Graph, node: NodeSpec): string[] {
  if (node.expects === undefined) return [];
  const sources = inputsOf(graph, node).length;
  return [`  // fan-in guard: expects ${node.expects} results from ${sources} upstream node(s)`];
}

function inputExpr(graph: Graph, node: NodeSpec): string {
  const sources = inputsOf(graph, node);
  const cast = ` as unknown as ${typeName(node, "In")}`;
  if (sources.length === 0) return "args";
  if (sources.length === 1) return `${resultVarFor(graph, sources[0]!.from)}${cast}`;
  const merged = sources.map((s) => resultVarFor(graph, s.from)).join(", ");
  return `Object.assign({}, ${merged})${cast}`;
}

/** Distinct from the function name, or the const would shadow its own initialiser. */
const resultVar = (node: NodeSpec) => `${identifier(node.id)}Result`;
const resultVarFor = (graph: Graph, id: string) => resultVar(graph.nodes.get(id)!);

const typeName = (node: NodeSpec, suffix: string) => `${pascal(node.id)}${suffix}`;

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
