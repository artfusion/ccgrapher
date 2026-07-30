// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { buildGraph, type Graph } from "./graph.js";
import { parseSpec } from "./load.js";
import type { WorkflowSpec } from "./schema.js";

/** Filesystem entry points, kept out of `index.ts` so that stays bundler-safe. */

export function loadSpec(path: string): WorkflowSpec {
  return parseSpec(readFileSync(path, "utf8"), path);
}

/** Load, validate and index in one step. The usual entry point for the CLI. */
export function loadGraph(path: string): Graph {
  return buildGraph(loadSpec(path));
}
