// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, parseSpec, withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import { changeLedger, formatLedger, ledgerSections, lint } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/ledger/", import.meta.url));
const example = (name: string) => loadGraph(`${examples}${name}.yaml`);
const source = (name: string) => readFileSync(`${examples}${name}.yaml`, "utf8");
const fromText = (text: string) => buildGraph(parseSpec(text));
const repaired = (graph: Graph) => withEdges(graph, lint(graph).repairedEdges);

describe("a guard added by hand", () => {
  const before = loadGraph(`${fixtures}plan-unguarded.yaml`);
  const after = loadGraph(`${fixtures}plan-guarded.yaml`);

  it("records the three guards, and the three findings they resolve", () => {
    const ledger = changeLedger(before, after);
    expect(ledger.guards).toEqual([
      { id: "merge_api", change: "added", after: 2, arriving: 2 },
      { id: "merge_ui", change: "added", after: 2, arriving: 2 },
      { id: "release", change: "added", after: 3, arriving: 3 },
    ]);
    expect(ledger.findings.resolved.map((f) => `${f.rule} ${f.nodes.join(",")}`)).toEqual([
      "SILENT_FAILURE merge_api",
      "SILENT_FAILURE merge_ui",
      "SILENT_FAILURE release",
    ]);
    expect(ledger.findings.introduced).toEqual([]);
    // A guard moves nothing.
    expect(ledger.edges).toEqual([]);
    expect(ledger.waves.moved).toEqual([]);
    expect(ledger.changes).toBe(6);
    expect(formatLedger(ledger)).toContain("3 count guards added on the fan-ins\n  merge_api expects 2 (2 arrive)");
  });

  it("which the spec's own repair could not have given", () => {
    const ledger = changeLedger(before, repaired(before));
    expect(ledger.guards).toEqual([]);
    expect(ledger.changes).toBe(0);
  });
});

describe("release-session, as written and repaired", () => {
  const before = example("release-session");
  const ledger = changeLedger(before, repaired(before));

  it("goes from twelve waves to five, and from one step wide to six", () => {
    expect(ledger.before).toEqual({ name: "release-session", steps: 12, edges: 18, waves: 12, widest: 1 });
    expect(ledger.after).toEqual({ name: "release-session", steps: 12, edges: 18, waves: 5, widest: 6 });
  });

  it("says which steps moved, and how far", () => {
    expect(ledger.waves.moved.map((m) => `${m.id} ${m.before}>${m.after}`)).toEqual([
      "pr_landing 3>2",
      "pr_credits 4>3",
      "pr_new_site 5>2",
      "pr_copy 6>3",
      "pr_pricing 7>2",
      "pr_links 8>3",
      "pr_byok 9>2",
      "pr_compare 10>2",
      "ci 11>4",
      "release 12>5",
    ]);
    expect(ledger.waves.moved.find((m) => m.id === "ci")?.moved).toBe(-7);
    expect(ledger.waves.unchanged).toEqual(["scope", "pr_hotfix"]);
  });

  it("calls each fake edge's fix a repoint", () => {
    expect(ledger.edges.every((e) => e.change === "repointed")).toBe(true);
    expect(ledger.edges).toHaveLength(6);
    expect(ledger.edges[3]).toEqual({
      change: "repointed",
      from: "pr_pricing",
      to: "pr_links",
      carries: [],
      newFrom: "pr_new_site",
      newCarries: ["site"],
    });
  });

  it("resolves the fake edges and missing inputs, and leaves the wrong guard alone", () => {
    const rules = ledger.findings.resolved.map((f) => f.rule);
    expect(rules.filter((r) => r === "FAKE_EDGE")).toHaveLength(6);
    expect(rules.filter((r) => r === "MISSING_INPUT")).toHaveLength(6);
    expect(rules).not.toContain("SILENT_FAILURE");
    expect(ledger.findings.introduced).toEqual([]);
    expect(ledger.guards).toEqual([]);
  });

  it("reads as one line per change", () => {
    const text = formatLedger(ledger);
    expect(text).toContain("12 to 5 waves, widest wave 1 to 6 steps");
    expect(text).toContain("ci from wave 11 to wave 4 (7 waves earlier)");
    expect(text).toContain("pr_pricing -> pr_links becomes pr_new_site -> pr_links, carrying site");
  });
});

describe("research-desk's vote, before and after it was handed the finding", () => {
  const after = example("research-desk");
  const before = fromText(
    source("research-desk")
      .replace(/^ +expects: 4.*$/m, "    expects: 3")
      .replace("in:  { finding: object, vote: \"keep|drop\" }", "in:  { vote: \"keep|drop\" }")
      .replace(/^ +- \{ from: dedupe, to: vote,.*\n/m, ""),
  );
  const ledger = changeLedger(before, after);

  it("finds one edge added and the guard raised from 3 to 4", () => {
    expect(ledger.edges).toEqual([{ change: "added", from: "dedupe", to: "vote", carries: ["finding"] }]);
    expect(ledger.guards).toEqual([{ id: "vote", change: "changed", before: 3, after: 4, arriving: 4 }]);
    expect(ledger.fields).toEqual([
      { id: "vote", field: "in", before: { vote: "keep|drop" }, after: { finding: "object", vote: "keep|drop" } },
    ]);
  });

  it("moves nothing, and lint is clean on both", () => {
    expect(ledger.waves.moved).toEqual([]);
    expect(ledger.findings).toEqual({ resolved: [], introduced: [] });
    expect(formatLedger(ledger)).toContain("vote expects 3 to 4 (4 arrive)");
    expect(formatLedger(ledger)).toContain("vote: in gains finding");
  });
});

describe("what else it records", () => {
  it("a finding the change brings in: linear-chain's repair puts two writers side by side", () => {
    const before = example("linear-chain");
    const ledger = changeLedger(before, repaired(before));
    expect(ledger.findings.introduced.map((f) => `${f.rule} ${f.nodes.join(",")}`)).toEqual([
      "HIDDEN_EDGE review_a,review_b",
    ]);
  });

  it("an edge removed, and one carrying something else, told apart from a repoint", () => {
    const spec = (edges: string) =>
      fromText(`version: 1
name: three
nodes:
  - { id: a, label: a, kind: worker, out: { x: s, y: s } }
  - { id: b, label: b, kind: worker, in: { x: s }, out: { z: s } }
  - { id: c, label: c, kind: worker, in: { x: s, y: s } }
edges:
${edges}`);
    const before = spec("  - { from: a, to: b, carries: [x] }\n  - { from: b, to: c, carries: [] }\n  - { from: a, to: c, carries: [x] }\n");
    const after = spec("  - { from: a, to: b, carries: [x] }\n  - { from: a, to: c, carries: [x, y] }\n");
    const ledger = changeLedger(before, after);
    expect(ledger.edges).toEqual([
      { change: "removed", from: "b", to: "c", carries: [] },
      { change: "carries", from: "a", to: "c", carries: ["x"], newCarries: ["x", "y"] },
    ]);
    expect(formatLedger(ledger)).toContain("1 edge carrying something else\n  a -> c carries x, y (was x)");
  });

  it("a renamed step as one removed and one added", () => {
    const before = example("diamond");
    const after = fromText(source("diamond").replaceAll("merge", "combine"));
    const ledger = changeLedger(before, after);
    expect(ledger.steps.removed.map((s) => s.id)).toEqual(["merge"]);
    expect(ledger.steps.added.map((s) => s.id)).toEqual(["combine"]);
  });

  it("a declaration changed, and a list reordered as no change", () => {
    const text = source("release-session");
    const after = fromText(
      text
        .replace("    label: fix the P1\n    kind: worker\n", "    label: fix the P1\n    kind: worker\n    model: cheap\n")
        .replace("    out: { tag: string }", "    out: { tag: string }\n    writes: [b.md, a.md]"),
    );
    const before = fromText(text.replace("    out: { tag: string }", "    out: { tag: string }\n    writes: [a.md, b.md]"));
    const ledger = changeLedger(before, after);
    expect(ledger.fields).toEqual([{ id: "pr_hotfix", field: "model", after: "cheap" }]);
    expect(formatLedger(ledger)).toContain("pr_hotfix: model unset to cheap");
  });

  it("boundary membership", () => {
    const text = source("research-desk");
    const after = fromText(text.replace("skeptic_source, vote]", "skeptic_source]"));
    const ledger = changeLedger(fromText(text), after);
    expect(ledger.fields).toEqual([{ id: "vote", field: "boundary", before: "gather" }]);
    expect(formatLedger(ledger)).toContain("vote: leaves boundary gather");
  });
});

describe("the ledger is a function of the two specs", () => {
  it("gives the same output every time", () => {
    const before = example("release-session");
    const runs = [0, 1, 2].map(() => {
      const ledger = changeLedger(before, repaired(example("release-session")));
      return `${JSON.stringify(ledger)}\n${formatLedger(ledger)}`;
    });
    expect(new Set(runs).size).toBe(1);
  });

  it("is empty for two specs that say the same thing", () => {
    for (const name of ["diamond", "release-session", "research-desk", "daily-brief"]) {
      const ledger = changeLedger(example(name), example(name));
      expect(ledger.changes).toBe(0);
      expect(ledger.steps).toEqual({ added: [], removed: [] });
      expect(ledger.edges).toEqual([]);
      expect(ledger.guards).toEqual([]);
      expect(ledger.fields).toEqual([]);
      expect(ledger.waves.moved).toEqual([]);
      expect(ledger.findings).toEqual({ resolved: [], introduced: [] });
      expect(ledgerSections(ledger).at(-1)).toEqual({ heading: "no changes", lines: [] });
    }
  });
});
