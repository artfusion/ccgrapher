// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { stepLegend } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { codegen, codegenFiles, describeFiles, TARGETS } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const load = (name: string) => loadGraph(`${examples}${name}.yaml`);

describe("describeFiles", () => {
  it("a one-file target lists one file, named after the spec, with the generator's line count", () => {
    const graph = load("research-desk");
    for (const target of TARGETS) {
      const [file, ...rest] = describeFiles(graph, target);
      expect(rest).toEqual([]);
      expect(file!.path.startsWith("research-desk.")).toBe(true);
      expect(file!.lines).toBe(codegen(graph, target).trimEnd().split("\n").length);
      expect(file!.note.length).toBeGreaterThan(0);
    }
    expect(describeFiles(graph, "claude-code")[0]!.note).toContain("9 steps in 7 waves");
  });

  it("managed-agents lists exactly the files codegenFiles writes, in its order", () => {
    const graph = load("research-desk");
    const files = codegenFiles(graph, "managed-agents");
    const notes = describeFiles(graph, "managed-agents");
    expect(notes.map((n) => n.path)).toEqual(Object.keys(files));
    for (const note of notes) {
      expect(note.lines).toBe(files[note.path]!.trimEnd().split("\n").length);
      expect(note.note).not.toContain("written by the");
    }
  });

  it("names each agent by its step number, as the legend numbers it", () => {
    const graph = load("research-desk");
    const numbers = new Map(stepLegend(graph).map((s) => [s.id, s.number]));
    const plan = describeFiles(graph, "managed-agents").find((n) => n.path === "agents/plan/agent.md")!;
    expect(plan.note).toBe(`the agent for step ${numbers.get("plan")}, ${graph.nodes.get("plan")!.label}, on claude-opus-5-5`);
  });

  it("is deterministic", () => {
    const graph = load("release-session");
    expect(describeFiles(graph, "managed-agents")).toEqual(describeFiles(load("release-session"), "managed-agents"));
  });
});
