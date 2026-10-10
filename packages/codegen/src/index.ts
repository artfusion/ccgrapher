// SPDX-License-Identifier: Apache-2.0
import type { Graph } from "@ccgrapher/core";
import { claudeCodeEmitter } from "./targets/claude-code.js";
import { langgraphEmitter } from "./targets/langgraph.js";
import { managedAgentsEmitter } from "./targets/managed-agents.js";
import { plainTsEmitter } from "./targets/plain-ts.js";
import {
  ALL_TARGETS,
  DIRECTORY_TARGETS,
  TARGETS,
  type AnyTarget,
  type DirectoryEmitter,
  type DirectoryTarget,
  type Emitter,
  type EmitOptions,
  type Files,
  type Target,
} from "./types.js";

export const EMITTERS: Readonly<Record<Target, Emitter>> = {
  "claude-code": claudeCodeEmitter,
  "plain-ts": plainTsEmitter,
  langgraph: langgraphEmitter,
};

export const DIRECTORY_EMITTERS: Readonly<Record<DirectoryTarget, DirectoryEmitter>> = {
  "managed-agents": managedAgentsEmitter,
};

export function codegen(graph: Graph, target: Target, options: EmitOptions = {}): string {
  const emitter = EMITTERS[target];
  if (!emitter) {
    throw new Error(
      isDirectoryTarget(target)
        ? `codegen target ${target} emits a directory: call codegenFiles() instead`
        : `unknown codegen target: ${target}`,
    );
  }
  return emitter.emit(graph, options);
}

/** A directory target's output: relative path to content, paths sorted. */
export function codegenFiles(graph: Graph, target: DirectoryTarget, options: EmitOptions = {}): Files {
  const emitter = DIRECTORY_EMITTERS[target];
  if (!emitter) throw new Error(`unknown directory codegen target: ${target}`);
  return emitter.emitFiles(graph, options);
}

/**
 * What the chosen target will quietly fail to do with this graph. Generating is
 * still the right answer — the caller asked for code — so these are warnings on
 * the side, alongside the fake-edge one.
 */
export function codegenWarnings(graph: Graph, target: AnyTarget): string[] {
  const emitter = isDirectoryTarget(target) ? DIRECTORY_EMITTERS[target] : EMITTERS[target];
  return emitter.warnings?.(graph) ?? [];
}

/** A target that emits one file. */
export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/** A target that emits a directory. */
export function isDirectoryTarget(value: string): value is DirectoryTarget {
  return (DIRECTORY_TARGETS as readonly string[]).includes(value);
}

export function isAnyTarget(value: string): value is AnyTarget {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

export {
  ALL_TARGETS,
  DIRECTORY_TARGETS,
  TARGETS,
  type AnyTarget,
  type DirectoryEmitter,
  type DirectoryTarget,
  type Target,
  type Emitter,
  type EmitOptions,
  type Files,
  type Stage,
} from "./types.js";
export { stages, inputsOf } from "./stages.js";
export { jsonSchemaFor, objectSchema, tsType, type JsonSchema } from "./fields.js";
export { MODEL_ID, TIER_FAMILY, familyOf, modelIdOf, type ModelFamily, type Tier } from "./tiers.js";
export { managedAgentsLayout } from "./targets/managed-agents.js";
export { claudeCodeEmitter, plainTsEmitter, langgraphEmitter, managedAgentsEmitter };
