// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, SpecError } from "@ccgrapher/core";
import { lint } from "@ccgrapher/lint";
import { describe, expect, it } from "vitest";
import { buildRetroSpec, type RetroPr } from "../src/commands/retro.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/flowsequencer-prs.json", import.meta.url)), "utf8"),
) as RetroPr[];

const { spec, warnings } = buildRetroSpec(fixture, "artfusion/flowsequencer");
const edge = (from: string, to: string) =>
  spec.edges.filter((e) => e.from === from && e.to === to);

/** A minimal PR for the cases the fixture does not need to carry. */
const pr = (over: Partial<RetroPr> & { number: number; mergedAt: string }): RetroPr => ({
  title: "",
  headRefName: "",
  body: "",
  files: [],
  ...over,
});

describe("the as-merged graph", () => {
  it("one worker per PR, in merge order, writes from the changed files", () => {
    expect(spec.name).toBe("artfusion/flowsequencer");
    expect(spec.nodes.map((n) => n.id)).toEqual([
      "pr_25",
      "pr_26",
      "pr_27",
      "pr_28",
      "pr_29",
      "pr_30",
    ]);
    expect(spec.nodes.every((n) => n.kind === "worker")).toBe(true);
    expect(spec.nodes.find((n) => n.id === "pr_27")!.writes).toEqual([
      "app/src/components/Footer.tsx",
    ]);
  });

  it("chains consecutive merges, carrying nothing without evidence", () => {
    expect(edge("pr_26", "pr_27")[0]!.carries).toEqual([]);
    expect(edge("pr_27", "pr_28")[0]!.carries).toEqual([]);
  });

  it("upgrades the chain edge in place when adjacent PRs share files", () => {
    // Never a second parallel edge — that would lint as a spurious FAKE_EDGE.
    const funnel = edge("pr_28", "pr_29");
    expect(funnel).toHaveLength(1);
    expect([...funnel[0]!.carries].sort()).toEqual(["prerender_mjs", "welcomepage_tsx"]);
    expect(edge("pr_29", "pr_30")[0]!.carries).toEqual(["practicegate_tsx"]);
    expect(edge("pr_25", "pr_26")[0]!.carries).toEqual(["analytics_ts"]);
  });

  it("adds a non-adjacent evidence edge from the nearest earlier toucher", () => {
    // analytics.ts: touched by 25, 26 and 30 — 30's evidence is 26, not 25.
    expect(edge("pr_26", "pr_30")[0]!.carries).toEqual(["analytics_ts"]);
    expect(edge("pr_25", "pr_30")).toHaveLength(0);
    const node = (id: string) => spec.nodes.find((n) => n.id === id)!;
    expect(node("pr_26").out).toHaveProperty("analytics_ts", "file");
    expect(node("pr_30").in).toHaveProperty("analytics_ts", "file");
  });

  it("leads labels with the ticket IDs and strips them from the title", () => {
    const label = (id: string) => spec.nodes.find((n) => n.id === id)!.label;
    expect(label("pr_30")).toMatch(/^YOG-192 Deep-return/);
    // The body cites other PRs' tickets; only the title and branch count here.
    expect(label("pr_30")).not.toContain("YOG-190");
    expect(label("pr_26")).toMatch(/^YOG-61 YOG-62 embed growth loop/);
  });

  it("warns about a PR with no ticket reference", () => {
    expect(warnings.join(" ")).toContain("PR #27");
  });

  it("survives its own engine: builds, and repair collapses the chain", () => {
    const result = lint(buildGraph(spec));
    expect(result.layersBefore).toBe(6);
    expect(result.layersAfter).toBe(3);
    // The evidence-free chain edges were not waiting on anything.
    expect(result.repairs.every((r) => r.kind === "drop")).toBe(true);
    expect(result.repairs).toHaveLength(2);
  });
});

describe("edges of the builder", () => {
  it("throws on a repo with no merged PRs", () => {
    expect(() => buildRetroSpec([], "artfusion/ccgrapher")).toThrow(SpecError);
  });

  it("falls back to the first ticket in the body, and only the first", () => {
    const { spec: s } = buildRetroSpec(
      [pr({ number: 1, mergedAt: "2026-01-01", title: "Fix", body: "See ART-9 and ART-10." })],
      "x/y",
    );
    expect(s.nodes[0]!.label).toBe("ART-9 Fix");
  });

  it("warns about a PR with no changed files", () => {
    const { warnings: w } = buildRetroSpec(
      [pr({ number: 1, mergedAt: "2026-01-01", title: "Docs only" })],
      "x/y",
    );
    expect(w.join(" ")).toContain("no changed files");
  });

  it("disambiguates colliding field tokens with the full path", () => {
    const files = [{ path: "a/util.ts" }, { path: "b/util.ts" }];
    const { spec: s } = buildRetroSpec(
      [
        pr({ number: 1, mergedAt: "2026-01-01", files }),
        pr({ number: 2, mergedAt: "2026-01-02", files }),
      ],
      "x/y",
    );
    expect([...edgeOf(s, "pr_1", "pr_2").carries].sort()).toEqual(["b_util_ts", "util_ts"]);
  });

  it("prefixes a field token that would start with a digit", () => {
    const files = [{ path: "app/2fa.ts" }];
    const { spec: s } = buildRetroSpec(
      [
        pr({ number: 1, mergedAt: "2026-01-01", files }),
        pr({ number: 2, mergedAt: "2026-01-02", files }),
      ],
      "x/y",
    );
    expect(edgeOf(s, "pr_1", "pr_2").carries).toEqual(["f_2fa_ts"]);
  });
});

function edgeOf(s: { edges: readonly { from: string; to: string; carries: string[] }[] }, from: string, to: string) {
  return s.edges.find((e) => e.from === from && e.to === to)!;
}
