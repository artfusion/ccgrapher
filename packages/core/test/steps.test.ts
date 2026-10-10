// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph, parseSpec, rankGraph, stepLegend } from "../src/index.js";
import { loadGraph } from "../src/node.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);
const numbers = (name: string) => stepLegend(fixture(name)).map((s) => `${s.number} ${s.id}`);

describe("stepLegend", () => {
  it("numbers the diamond by wave, and letters the five workers that run together", () => {
    expect(numbers("diamond")).toEqual([
      "1 split",
      "2a worker_1",
      "2b worker_2",
      "2c worker_3",
      "2d worker_4",
      "2e worker_5",
      "3 checker",
      "4 merge",
    ]);
  });

  it("numbers release-session as written one to twelve, a chain with no letters", () => {
    const steps = stepLegend(fixture("release-session"));
    expect(steps.map((s) => s.number)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  });

  it("agrees with the ranking on every example: the number is the wave", () => {
    for (const name of ["diamond", "release-session", "linear-chain", "research-desk", "route-auth-audit", "wide-fanin"]) {
      const graph = fixture(name);
      const { rank, layers } = rankGraph(graph);
      const steps = stepLegend(graph);
      expect(steps).toHaveLength(graph.nodes.size);
      for (const step of steps) {
        expect(step.wave).toBe(rank.get(step.id)! + 1);
        expect(step.number.startsWith(`${step.wave}`)).toBe(true);
        expect(/[a-z]$/.test(step.number)).toBe(layers[step.wave - 1]!.length > 1);
      }
    }
  });

  it("reads a fan-out once, with what it fans over and its cap", () => {
    const steps = stepLegend(fixture("wide-fanin"));
    const read = steps.filter((s) => s.id === "read");
    expect(read).toHaveLength(1);
    expect(read[0]!.line).toBe("one per page, up to 200; takes page; gives text");
  });

  it("says what each step takes and gives from its declarations, shortened past three names", () => {
    const steps = stepLegend(fixture("diamond"));
    expect(steps[0]!.line).toBe("takes question; gives angle");
    const ci = stepLegend(fixture("release-session")).find((s) => s.id === "ci")!;
    expect(ci.line).toBe("takes hotfix, landing, credits +5; gives verdict");
  });

  it("says so when a step declares nothing, and when a fan-out has no cap", () => {
    const graph = buildGraph(
      parseSpec(`
version: 1
name: bare
nodes:
  - { id: a, label: start, kind: split }
  - { id: b, label: each, kind: worker, fanOut: { over: items }, in: { items: string } }
edges:
  - { from: a, to: b, carries: [] }
`),
    );
    expect(stepLegend(graph).map((s) => s.line)).toEqual(["takes and gives nothing", "one per items; takes items"]);
  });

  it("keeps letters distinct past z", () => {
    const workers = Array.from({ length: 28 }, (_, i) => `  - { id: w${i}, label: w${i}, kind: worker }`).join("\n");
    const graph = buildGraph(parseSpec(`version: 1\nname: wide\nnodes:\n${workers}\nedges: []\n`));
    const steps = stepLegend(graph).map((s) => s.number);
    expect(steps.slice(24)).toEqual(["1y", "1z", "1aa", "1ab"]);
    expect(new Set(steps).size).toBe(28);
  });

  it("is deterministic", () => {
    expect(stepLegend(fixture("research-desk"))).toEqual(stepLegend(fixture("research-desk")));
  });
});
