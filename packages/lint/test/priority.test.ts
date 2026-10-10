// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, type Priority } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { formatReport, lint } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const names = readdirSync(examples)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  .sort();

const LEVELS: readonly Priority[] = ["urgent", "high", "normal"];

describe("priority is a scheduling hint, so no lint rule reads it", () => {
  it.each(names)("%s lints the same with every node given a priority", (name) => {
    const plain = loadGraph(`${examples}${name}.yaml`);
    const marked = buildGraph({
      ...plain.spec,
      nodes: plain.spec.nodes.map((node, i) => ({
        ...node,
        priority: LEVELS[i % LEVELS.length],
        prioritySetBy: "on-call",
      })),
    });
    // Everything but the repaired graph itself, which carries the priorities it was given.
    const verdict = (result: ReturnType<typeof lint>) => {
      const { repairedGraph, ...rest } = result;
      void repairedGraph;
      return rest;
    };
    const before = lint(plain);
    const after = lint(marked);
    expect(verdict(after)).toEqual(verdict(before));
    expect(formatReport(marked, after)).toBe(formatReport(plain, before));
  });
});
