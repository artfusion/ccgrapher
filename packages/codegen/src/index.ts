// SPDX-License-Identifier: Apache-2.0
import type { Graph } from "@ccgrapher/core";
import { claudeCodeEmitter } from "./targets/claude-code.js";
import { langgraphEmitter } from "./targets/langgraph.js";
import { plainTsEmitter } from "./targets/plain-ts.js";
import { TARGETS, type Emitter, type EmitOptions, type Target } from "./types.js";

export const EMITTERS: Readonly<Record<Target, Emitter>> = {
  "claude-code": claudeCodeEmitter,
  "plain-ts": plainTsEmitter,
  langgraph: langgraphEmitter,
};

export function codegen(graph: Graph, target: Target, options: EmitOptions = {}): string {
  const emitter = EMITTERS[target];
  if (!emitter) throw new Error(`unknown codegen target: ${target}`);
  return emitter.emit(graph, options);
}

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

export { TARGETS, type Target, type Emitter, type EmitOptions, type Stage } from "./types.js";
export { stages, inputsOf } from "./stages.js";
export { jsonSchemaFor, objectSchema, tsType, type JsonSchema } from "./fields.js";
export { claudeCodeEmitter, plainTsEmitter, langgraphEmitter };
