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
 *
 * The script also narrates itself. It runs in a sandbox with no filesystem, so
 * it cannot write a trace; instead it logs `ccg:` marker lines that a watcher
 * tailing Claude Code's journal turns into `@ccgrapher/trace` events.
 */
export const claudeCodeEmitter: Emitter = {
  target: "claude-code",
  extension: ".workflow.mjs",

  /**
   * A gate wants a human and this target has no way to ask for one. Compiling it
   * to a plain `agent()` call and saying nothing would be the exact failure this
   * project exists to catch, sitting in our own emitter.
   */
  warnings(graph: Graph): string[] {
    return graph.spec.nodes
      .filter((node) => node.kind === "gate")
      .map(
        (node) =>
          `'${node.id}' is a gate — the claude-code target cannot pause for a human, so the generated step will not wait for approval.`,
      );
  },

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

    lines.push(...markers());

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
      const title = phaseTitle(stage.nodes);
      lines.push(`phase(${quote(title)})`);
      // A phase has no event of its own in the trace contract, so it goes out as
      // the run's own log line — the shape `node_log` already has for exactly this.
      lines.push(`mark({ type: "node_log", line: ${quote(`phase: ${title}`)} })`);
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
      ...gateNote(node),
      `// one agent per ${node.fanOut.over}${cap ? `, capped at ${cap}` : ""}`,
      `const ${name}Items = toList(${prelude.expr})${cap ? `.slice(0, ${cap})` : ""}`,
      `const ${name} = (await parallel(${name}Items.map((item, i) => () =>`,
      // `of` is what tells the watcher how many instances to wait for.
      `  step({ node: ${quote(node.id)}, instance: i, of: ${name}Items.length }, () =>`,
      `    agent(${prompt(node, "item")}, ${opts(node, `\`${node.id}:\${i}\``)}),`,
      `  ),`,
      `))).filter(Boolean)`,
    ];
  }

  return [
    ...prelude.lines,
    ...freshContextNote(node),
    ...gateNote(node),
    `const ${name} = await step({ node: ${quote(node.id)} }, () =>`,
    `  agent(${prompt(node, prelude.expr)}, ${opts(node, quote(node.id))}),`,
    ")",
  ];
}

function concurrent(graph: Graph, nodes: readonly NodeSpec[]): string[] {
  const preludes = nodes.map((node) => inputPrelude(graph, node));
  return [
    ...preludes.flatMap((p) => p.lines),
    ...nodes.flatMap(freshContextNote),
    ...nodes.flatMap(gateNote),
    `const [${nodes.map((n) => identifier(n.id)).join(", ")}] = await parallel([`,
    // The marker goes inside the thunk, not around the wave: these finish at
    // different moments and a marker outside would report one time for all of them.
    ...nodes.flatMap((node, i) => [
      `  () => step({ node: ${quote(node.id)} }, () =>`,
      `    agent(${prompt(node, preludes[i]!.expr)}, ${opts(node, quote(node.id))}),`,
      "  ),",
    ]),
    "])",
  ];
}

/**
 * The expression holding what actually reached this node, plus any lines needed
 * to build it — and the fan-in count guard, which has to test the results that
 * *arrived*, not the node's own output. Without it one dead upstream node slips
 * through and the synthesis step reports on partial data as though it were whole.
 *
 * The guard is a floor, `< expects`, matching the runner and the `plain-ts`
 * target: a surplus means the count is stale, not that anything is missing, and
 * the linter is the one that complains about that. See `NodeSpec.expects` in
 * `@ccgrapher/core` for why the two times compare differently.
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
      `if (${expr}.length < ${node.expects}) {`,
      `  const note = \`expected at least ${node.expects} results, got \${${expr}.length}\``,
      `  log(\`${node.id}: \${note}\`)`,
      `  mark({ type: "node_log", node: ${quote(node.id)}, line: note })`,
      "}",
    );
  }

  return { lines, expr };
}

/**
 * The two helpers every marker goes through. Kept to two so the rest of the file
 * stays a workflow rather than a logging harness.
 */
function markers(): string[] {
  return [
    "/**",
    " * A Workflow script has no filesystem, so it cannot write a trace. It says what",
    " * happened on stdout instead, and a watcher tailing Claude Code's journal turns",
    " * these lines into @ccgrapher/trace events. The payloads are deliberately",
    " * partial: `runId`, `seq` and `ts` belong to the watcher, which is the side with",
    " * a run identity and a clock. Field names are the contract's own, so completing",
    " * one is mechanical rather than a translation between two dialects.",
    " */",
    'const mark = (event) => log("ccg:" + JSON.stringify(event))',
    "",
    "/** Brackets one agent call with its start and finish markers. */",
    "const step = async (node, run) => {",
    '  mark({ type: "node_started", ...node })',
    "  const out = await run()",
    '  mark({ type: "node_finished", ...node })',
    "  return out",
    "}",
    "",
  ];
}

/** The rule the article is emphatic about: a worker never checks its own work. */
function freshContextNote(node: NodeSpec): string[] {
  return node.freshContext
    ? [`// ${node.id} runs in a fresh context — it must not share one with the work it grades`]
    : [];
}

/**
 * Said in the file as well as on stderr, because the file is what outlives the
 * run. No `gate_waiting` marker is emitted with it: nothing here waits, and a
 * marker claiming otherwise would put the lie into the trace itself.
 */
function gateNote(node: NodeSpec): string[] {
  return node.kind === "gate"
    ? [`// ${node.id} is a gate, and this target cannot pause for a human — it runs straight through`]
    : [];
}

function opts(node: NodeSpec, label: string): string {
  // `label` is exactly the node id — `id:i` for a fanOut instance — and that is a
  // contract, not a coincidence: it is the only thing tying a journal record back
  // to a graph node. A test holds it.
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
