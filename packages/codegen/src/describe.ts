// SPDX-License-Identifier: Apache-2.0
import { stepLegend, type Graph } from "@ccgrapher/core";
import { codegen, codegenFiles, EMITTERS, isDirectoryTarget } from "./index.js";
import { stages } from "./stages.js";
import { managedAgentsLayout } from "./targets/managed-agents.js";
import { modelIdOf } from "./tiers.js";
import type { AnyTarget, EmitOptions } from "./types.js";

/** One file the chosen target writes, and what it is for. */
export interface FileNote {
  /** Relative POSIX path. A one-file target is named after the spec, as `ccg codegen -o` would suggest. */
  readonly path: string;
  /** How many lines the generated file has. */
  readonly lines: number;
  /** One line on what the file is, from the target and the graph. Never written by a model. */
  readonly note: string;
}

/**
 * The files `codegen` or `codegenFiles` would write for this graph, each with a
 * line saying what it is. The paths and line counts are the generator's own
 * output, so this cannot list a file the target does not write; the lines are
 * fixed sentences per target, filled in from the graph. Directory targets come
 * back in the generator's order (sorted paths). Deterministic.
 */
export function describeFiles(graph: Graph, target: AnyTarget, options: EmitOptions = {}): FileNote[] {
  if (isDirectoryTarget(target)) {
    const files = codegenFiles(graph, target, options);
    const notes = managedAgentsNotes(graph);
    return Object.entries(files).map(([path, content]) => ({
      path,
      lines: lineCount(content),
      note: notes.get(path) ?? `written by the ${target} target`,
    }));
  }

  const code = codegen(graph, target, options);
  const waves = stages(graph).length;
  const steps = graph.nodes.size;
  const counted = `${plural(steps, "step")} in ${plural(waves, "wave")}`;
  const note = {
    "claude-code": `the workflow script Claude Code runs: ${counted}, one phase per wave, and parallel() where a wave holds more than one step`,
    "plain-ts": `a typed async function for each of the ${plural(steps, "step")}, and a runner that awaits the ${plural(waves, "wave")} in order with Promise.all`,
    langgraph: `a LangGraph StateGraph with ${plural(steps, "node")} and ${plural(graph.spec.edges.length, "edge")}; the runtime works out what runs at once from the edges`,
  }[target];
  return [{ path: `${graph.spec.name}${EMITTERS[target].extension}`, lines: lineCount(code), note }];
}

function managedAgentsNotes(graph: Graph): Map<string, string> {
  const layout = managedAgentsLayout(graph);
  const numbers = new Map(stepLegend(graph).map((step) => [step.id, step.number]));
  const notes = new Map<string, string>();
  for (const [id, path] of layout.agents) {
    const node = graph.nodes.get(id)!;
    notes.set(path, `the agent for step ${numbers.get(id)}, ${node.label}, on ${modelIdOf(node.model ?? "strong")}`);
  }
  notes.set(layout.environment, "the one environment every agent runs in");
  const local = graph.spec.nodes.length - layout.agents.size;
  notes.set(
    "README.md",
    `lists the ${plural(layout.agents.size, "agent")}${local > 0 ? ` and the ${plural(local, "step")} the runner keeps for itself` : ""}`,
  );
  return notes;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
