// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, parseSpec, rankGraph, type Graph, type WorkflowSpec } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { describe, expect, it } from "vitest";
import {
  authorityBreaches,
  duplicateEffects,
  earlyCommits,
  formatReport,
  lint,
  monocultures,
  tierMismatches,
  writeDenial,
} from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

/** The three fixtures whose every edge carries real data. */
const CLEAN = ["diamond", "research-desk", "route-auth-audit"] as const;

describe("clean fixtures are clean", () => {
  it.each(CLEAN)("%s reports nothing", (name) => {
    const result = lint(fixture(name));
    expect(result.findings).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(result.layersAfter).toBe(result.layersBefore);
  });

  it("diamond's single-inbound merge does not trip the fan-in guard", () => {
    const graph = fixture("diamond");
    expect(graph.inbound.get("merge")).toHaveLength(1);
    expect(graph.nodes.get("merge")!.expects).toBeUndefined();
    expect(lint(graph).findings).toEqual([]);
  });
});

describe("linear-chain — acceptance criterion #2", () => {
  const result = lint(fixture("linear-chain"));
  const of = (rule: string) => result.findings.filter((f) => f.rule === rule);

  it("finds both fake edges", () => {
    expect(of("FAKE_EDGE").map((f) => f.edge)).toEqual([
      { from: "review_a", to: "review_b" },
      { from: "review_b", to: "lint_docs" },
    ]);
  });

  it("finds both missing inputs and exempts the root", () => {
    expect(of("MISSING_INPUT").map((f) => f.message)).toEqual([
      "review_b requires 'repo' but no inbound edge carries it",
      "lint_docs requires 'repo' but no inbound edge carries it",
    ]);
    // `setup` declares in.url with nothing supplying it, but it is a root.
    expect(of("MISSING_INPUT").some((f) => f.nodes.includes("setup"))).toBe(false);
  });

  it("finds the hidden edge only after repair", () => {
    const hidden = of("HIDDEN_EDGE");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.nodes).toEqual(["review_a", "review_b"]);
    expect(hidden[0]!.message).toContain("notes/findings.md");
    // As written, review_a is rank 1 and review_b rank 2 with a path between
    // them, so this is invisible until the fake edges are repointed.
    expect(hidden[0]!.phase).toBe("repaired");
  });

  it("reports exactly the five findings documented in the fixture header", () => {
    expect(result.findings.map((f) => f.rule)).toEqual([
      "FAKE_EDGE",
      "FAKE_EDGE",
      "MISSING_INPUT",
      "MISSING_INPUT",
      "HIDDEN_EDGE",
    ]);
  });

  it("collapses the critical path from 6 layers to 4", () => {
    expect(result.layersBefore).toBe(6);
    expect(result.layersAfter).toBe(4);
  });

  it("repoints to setup rather than deleting", () => {
    expect(result.repairs).toEqual([
      {
        kind: "repoint",
        from: "review_a",
        to: "review_b",
        newFrom: "setup",
        carries: ["repo"],
        why: "setup is the nearest node that supplies 'repo'",
      },
      {
        kind: "repoint",
        from: "review_b",
        to: "lint_docs",
        newFrom: "setup",
        carries: ["repo"],
        why: "setup is the nearest node that supplies 'repo'",
      },
    ]);
  });

  it("puts the three reviewers on one row after repair", () => {
    const { rank } = rankGraph(result.repairedGraph);
    expect(rank.get("review_a")).toBe(1);
    expect(rank.get("review_b")).toBe(1);
    expect(rank.get("lint_docs")).toBe(1);
  });

  it("leaves no fake edges or missing inputs behind", () => {
    const after = lint(result.repairedGraph);
    expect(after.findings.filter((f) => f.rule === "FAKE_EDGE")).toEqual([]);
    expect(after.findings.filter((f) => f.rule === "MISSING_INPUT")).toEqual([]);
  });
});

describe("self-grading fixture", () => {
  const result = lint(fixture("self-grading"));

  it("flags the verifier without a fresh context", () => {
    const found = result.findings.filter((f) => f.rule === "SELF_GRADING");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodes).toEqual(["check_own"]);
  });

  it("flags a cheap verifier checking cheap drafters: a shared model, whatever the context", () => {
    const found = result.findings.filter((f) => f.rule === "MONOCULTURE");
    expect(found.map((f) => [f.nodes, f.tier])).toEqual([[["check_own", "draft_a", "draft_b"], "cheap"]]);
  });

  it("flags two concurrent drafters writing the same file", () => {
    const found = result.findings.filter((f) => f.rule === "HIDDEN_EDGE");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodes).toEqual(["draft_a", "draft_b"]);
    expect(found[0]!.phase).toBe("raw");
  });

  it("has nothing to repair — every edge carries real data", () => {
    expect(result.repairs).toEqual([]);
    expect(result.layersBefore).toBe(result.layersAfter);
  });
});

describe("wide-fanin fixture", () => {
  const result = lint(fixture("wide-fanin"));

  it("flags 200 results arriving with no reduce layer", () => {
    const found = result.findings.filter((f) => f.rule === "CONTEXT_COLLAPSE");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("200 inbound results");
  });

  it("does not double-report as a silent failure — expects is set and correct", () => {
    expect(result.findings.filter((f) => f.rule === "SILENT_FAILURE")).toEqual([]);
  });
});

describe("worktree suppresses the hidden-edge warning", () => {
  it("audit is isolated, so its writes cannot collide", () => {
    const graph = fixture("route-auth-audit");
    expect(graph.nodes.get("audit")!.worktree).toBe(true);
    expect(lint(graph).findings.filter((f) => f.rule === "HIDDEN_EDGE")).toEqual([]);
  });
});

describe("HIDDEN_EDGE catches a collision across layers, not only within one", () => {
  // a -> b -> c is a three-layer chain; d is a second, unrelated root. c and d
  // land on different ranks (2 and 0) and share no path either way — exactly
  // the shape the same-rank-only version of this rule used to miss.
  const graph = buildGraph({
    version: 1,
    name: "cross-layer",
    nodes: [
      { id: "a", label: "a", kind: "split", in: {}, out: { x: "string" } },
      { id: "b", label: "b", kind: "worker", in: { x: "string" }, out: { y: "string" } },
      {
        id: "c",
        label: "c",
        kind: "worker",
        in: { y: "string" },
        out: { z: "string" },
        writes: ["shared.md"],
      },
      { id: "d", label: "d", kind: "worker", in: {}, out: { w: "string" }, writes: ["shared.md"] },
    ],
    edges: [
      { from: "a", to: "b", carries: ["x"] },
      { from: "b", to: "c", carries: ["y"] },
    ],
  } as WorkflowSpec);

  it("flags c and d even though they sit two ranks apart", () => {
    const found = lint(graph).findings.filter((f) => f.rule === "HIDDEN_EDGE");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodes.sort()).toEqual(["c", "d"]);
    expect(found[0]!.message).toContain("shared.md");
  });

  it("says nothing once one side is isolated in its own worktree", () => {
    const isolated = buildGraph({
      ...graph.spec,
      nodes: graph.spec.nodes.map((n) => (n.id === "d" ? { ...n, worktree: true } : n)),
    });
    expect(lint(isolated).findings.filter((f) => f.rule === "HIDDEN_EDGE")).toEqual([]);
  });
});

describe("silent failure", () => {
  /** diamond's checker with its fan-in guard altered. */
  const checkerWith = (expects: number | undefined) => {
    const spec: WorkflowSpec = fixture("diamond").spec;
    return buildGraph({
      ...spec,
      nodes: spec.nodes.map((n) => (n.id === "checker" ? { ...n, expects } : n)),
    });
  };

  it("fires when a real fan-in has no guard", () => {
    const found = lint(checkerWith(undefined)).findings.filter(
      (f) => f.rule === "SILENT_FAILURE",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("fans in 5 results with no 'expects' guard");
  });

  it("fires when the guard disagrees with the real count", () => {
    const found = lint(checkerWith(4)).findings.filter((f) => f.rule === "SILENT_FAILURE");
    expect(found[0]!.message).toContain("declares expects: 4 but 5 results actually arrive");
  });

  it("carries the number that actually arrives, so a renderer need not recount", () => {
    for (const expects of [undefined, 4]) {
      const found = lint(checkerWith(expects)).findings.filter((f) => f.rule === "SILENT_FAILURE");
      expect(found[0]!.arriving).toBe(5);
    }
  });

  it("adds `arriving` to SILENT_FAILURE findings only, and changes nothing else in the JSON", () => {
    const findings = lint(fixture("release-session")).findings;
    for (const f of findings) expect("arriving" in f).toBe(f.rule === "SILENT_FAILURE");
    expect(findings.find((f) => f.rule === "SILENT_FAILURE")).toEqual({
      rule: "SILENT_FAILURE",
      severity: "warn",
      phase: "raw",
      message: "ci declares expects: 9 but 8 results actually arrive",
      nodes: ["ci"],
      arriving: 8,
    });
  });
});

describe("formatReport", () => {
  it("shows the before/after path for a broken spec", () => {
    const graph = fixture("linear-chain");
    const text = formatReport(graph, lint(graph));
    expect(text).toContain("Critical path: 6 layers -> 4 layers (2 fewer after repair)");
    expect(text).toContain("5 findings (4 errors, 1 warning)");
    expect(text).toContain("repoint  review_a -> review_b becomes setup -> review_b");
  });

  it("says so plainly when there is nothing wrong", () => {
    const graph = fixture("diamond");
    const text = formatReport(graph, lint(graph));
    expect(text).toContain("no findings");
    expect(text).toContain("Critical path: 4 layers");
  });
});

/**
 * The three ways a scheduled workflow goes wrong across runs, each one a
 * variant of daily-brief that differs from it in one place.
 */
describe("across runs: daily-brief and its broken variants", () => {
  const variants = fileURLToPath(new URL("./fixtures/daily-brief/", import.meta.url));
  const variant = (name: string) => loadGraph(`${variants}${name}.yaml`);
  const rules = (graph: Graph) => [...new Set(lint(graph).findings.map((f) => f.rule))];

  it("daily-brief lints clean, with nothing to repair", () => {
    const result = lint(fixture("daily-brief"));
    expect(result.findings).toEqual([]);
    expect(result.repairs).toEqual([]);
  });

  it("without the destination check, the post is unguarded", () => {
    const { findings, repairs } = lint(variant("unguarded-post"));
    expect(findings).toEqual([
      expect.objectContaining({ rule: "DUPLICATE_EFFECT", severity: "warn", phase: "raw", nodes: ["post"], effect: "post:brief-channel" }),
    ]);
    // Detect-only: --fix moves edges, and there is no edge to move.
    expect(repairs).toEqual([]);
  });

  it("with the commit beside the post, both stores are written too early", () => {
    const { findings, repairs } = lint(variant("early-commit"));
    expect(rules(variant("early-commit"))).toEqual(["EARLY_COMMIT"]);
    expect(findings.map((f) => [f.nodes, f.resource, f.effect, f.severity])).toEqual([
      [["commit_state", "post"], "bookmarks", "post:brief-channel", "warn"],
      [["commit_state", "post"], "ledger", "post:brief-channel", "warn"],
    ]);
    expect(repairs).toEqual([]);
  });

  it("with the agent writing the preferences, it breaches a person's authority", () => {
    const { findings, repairs } = lint(variant("agent-writes-preferences"));
    expect(findings).toEqual([
      expect.objectContaining({ rule: "AUTHORITY_BREACH", severity: "error", nodes: ["decide"], resource: "preferences" }),
    ]);
    expect(findings[0]!.message).toBe("decide writes 'preferences', which a person owns; only a gate may write it");
    expect(repairs).toEqual([]);
  });

  it("an edge that only says 'only then' is dropped by --fix, and the repaired pass says what that costs", () => {
    const { findings, repairs } = lint(variant("ordering-edge"));
    expect(repairs).toEqual([expect.objectContaining({ kind: "drop", from: "post", to: "commit_state" })]);
    expect(findings.filter((f) => f.phase === "raw").map((f) => f.rule)).toEqual(["FAKE_EDGE"]);
    const early = findings.filter((f) => f.rule === "EARLY_COMMIT");
    expect(early.map((f) => [f.phase, f.resource])).toEqual([
      ["repaired", "bookmarks"],
      ["repaired", "ledger"],
    ]);
  });
});

describe("DUPLICATE_EFFECT", () => {
  const graph = (top: string, nodes: string, edges = "") =>
    buildGraph(parseSpec(`version: 1\nname: t\n${top}nodes:\n${nodes}${edges ? `edges:\n${edges}` : ""}`));
  const POST = '  - { id: post, label: P, kind: worker, effects: ["post:x"], in: { a: string } }\n';
  const CHECK = '  - { id: check, label: C, kind: worker, guards: ["post:x"], out: { a: string } }\n';
  const EDGE = "  - { from: check, to: post, carries: [a] }\n";

  it("says nothing without a schedule: a one-off run has a person watching it", () => {
    expect(duplicateEffects(graph("", POST), "raw")).toEqual([]);
  });

  it("fires on a scheduled effect nothing guards", () => {
    expect(duplicateEffects(graph('schedule: daily\n', POST), "raw")).toHaveLength(1);
  });

  it("accepts a guard on the performer itself, such as an idempotency key", () => {
    const keyed = '  - { id: post, label: P, kind: worker, effects: ["post:x"], guards: ["post:x"] }\n';
    expect(duplicateEffects(graph("schedule: daily\n", keyed), "raw")).toEqual([]);
  });

  it("accepts a guard upstream, and not one beside it", () => {
    expect(duplicateEffects(graph("schedule: daily\n", CHECK + POST, EDGE), "raw")).toEqual([]);
    expect(duplicateEffects(graph("schedule: daily\n", CHECK + POST), "raw")).toHaveLength(1);
  });

  it("checks each effect on its own: a guard on one does not cover another", () => {
    const two = '  - { id: post, label: P, kind: worker, effects: ["post:x", "send:y"], guards: ["post:x"] }\n';
    expect(duplicateEffects(graph("schedule: daily\n", two), "raw").map((f) => f.effect)).toEqual(["send:y"]);
  });
});

describe("EARLY_COMMIT", () => {
  const graph = (nodes: string, edges = "", stores = "  ledger: { owner: agent, records: \"post:x\" }\n") =>
    buildGraph(parseSpec(`version: 1\nname: t\nstores:\n${stores}nodes:\n${nodes}${edges ? `edges:\n${edges}` : ""}`));
  const POST = '  - { id: post, label: P, kind: worker, effects: ["post:x"], out: { id: string } }\n';
  const COMMIT = "  - { id: commit, label: C, kind: reduce, writes: [ledger], in: { id: string } }\n";

  it("accepts a writer strictly after the effect", () => {
    expect(earlyCommits(graph(POST + COMMIT, "  - { from: post, to: commit, carries: [id] }\n"), "raw")).toEqual([]);
  });

  it("fires on a writer before the effect", () => {
    const before = earlyCommits(graph(POST + COMMIT, "  - { from: commit, to: post, carries: [] }\n"), "raw");
    expect(before.map((f) => f.nodes)).toEqual([["commit", "post"]]);
  });

  it("fires on a step that writes the store and performs the effect itself", () => {
    const same = '  - { id: post, label: P, kind: worker, effects: ["post:x"], writes: [ledger] }\n';
    const found = earlyCommits(graph(same), "raw");
    expect(found.map((f) => f.nodes)).toEqual([["post"]]);
    expect(found[0]!.message).toContain("in the same step that performs it");
  });

  it("says nothing of a store that records no effect: claiming before acting is allowed", () => {
    expect(earlyCommits(graph(POST + COMMIT, "", "  ledger: { owner: agent }\n"), "raw")).toEqual([]);
  });
});

describe("AUTHORITY_BREACH", () => {
  const base = (body: string) => buildGraph(parseSpec(`version: 1\nname: t\n${body}`));

  it("lets a gate write a store a person owns, and nothing else", () => {
    const graph = base(
      "stores:\n  prefs: { owner: human }\nnodes:\n  - { id: edit, label: E, kind: gate, writes: [prefs] }\n  - { id: agent, label: A, kind: worker, writes: [prefs] }\n",
    );
    expect(authorityBreaches(graph, "raw").map((f) => f.nodes)).toEqual([["agent"]]);
    expect(writeDenial(graph, graph.nodes.get("edit")!, "prefs")).toBeUndefined();
  });

  it("lets anything write an agent's store or a plain file", () => {
    const graph = base("stores:\n  ledger: { owner: agent }\nnodes:\n  - { id: a, label: A, kind: worker, writes: [ledger, notes.md] }\n");
    expect(authorityBreaches(graph, "raw")).toEqual([]);
  });

  it("holds a read-only boundary to no writes and no effects, in one finding per member", () => {
    const graph = base(
      'boundaries:\n  - { id: look, members: [a, b, c], access: read-only }\nnodes:\n  - { id: a, label: A, kind: worker, writes: [notes.md] }\n  - { id: b, label: B, kind: worker, effects: ["post:x"], writes: [log] }\n  - { id: c, label: C, kind: worker }\n',
    );
    const found = authorityBreaches(graph, "raw");
    expect(found.map((f) => [f.nodes, f.boundary, f.severity])).toEqual([
      [["a"], "look", "error"],
      [["b"], "look", "error"],
    ]);
    expect(found[1]!.message).toBe("b is in read-only boundary 'look' but writes 'log' and performs 'post:x'");
  });

  it("says nothing of a read-write boundary, which claims nothing", () => {
    const graph = base(
      "boundaries:\n  - { id: rw, members: [a] }\nnodes:\n  - { id: a, label: A, kind: worker, writes: [notes.md] }\n",
    );
    expect(authorityBreaches(graph, "raw")).toEqual([]);
  });
});

describe("MONOCULTURE", () => {
  const graph = (nodes: string, edges: string) =>
    buildGraph(parseSpec(`version: 1\nname: t\nnodes:\n${nodes}edges:\n${edges}`));
  const node = (id: string, kind: string, extra = "") =>
    `  - { id: ${id}, label: ${id}, kind: ${kind}, in: { a: string }, out: { a: string }${extra} }\n`;
  const edge = (from: string, to: string, carries = "[a]") => `  - { from: ${from}, to: ${to}, carries: ${carries} }\n`;
  const checked = (workerExtra: string, verifierExtra: string) =>
    monocultures(graph(node("w", "worker", workerExtra) + node("v", "verifier", verifierExtra), edge("w", "v")), "raw");

  it("fires on a verifier on the same tier as the work it checks, fresh context or not", () => {
    const found = checked(", model: cheap", ", model: cheap, freshContext: true");
    expect(found.map((f) => [f.nodes, f.tier, f.agent, f.severity])).toEqual([[["v", "w"], "cheap", undefined, "warn"]]);
    expect(found[0]!.message).toBe(
      "verifier v checks w on the same tier, cheap; a shared model shares blind spots, so give the check a different tier or agent",
    );
    expect(checked(", model: strong", ", model: strong")).toHaveLength(1);
  });

  it("says nothing across tiers, of an unspecified tier, or of plain code", () => {
    expect(checked(", model: cheap", ", model: strong")).toEqual([]);
    // Unknown is not equal to anything, itself included.
    expect(checked("", "")).toEqual([]);
    expect(checked(", model: cheap", "")).toEqual([]);
    // A plain-code check, such as a test run, has no model to share.
    expect(checked(", model: null", ", model: null")).toEqual([]);
  });

  it("fires on the same declared agent whatever the tiers, and names it", () => {
    const found = checked(', model: cheap, uses: ["agent:analyst"]', ', model: strong, uses: ["mcp:x/y", "agent:analyst"]');
    expect(found.map((f) => [f.agent, f.tier])).toEqual([["analyst", undefined]]);
    expect(found[0]!.message).toContain("checks w as the same agent, 'analyst'");
    expect(checked(', uses: ["agent:analyst"]', ', uses: ["agent:critic"]')).toEqual([]);
  });

  it("carries both when both hold, and leads with the agent", () => {
    const found = checked(', model: cheap, uses: ["agent:analyst"]', ', model: cheap, uses: ["agent:analyst"]');
    expect(found.map((f) => [f.agent, f.tier])).toEqual([["analyst", "cheap"]]);
    expect(found[0]!.message).toContain("checks w as the same agent, 'analyst', and w on the same tier, cheap");
  });

  it("looks through plain code to the work behind it, and stops at the first model step", () => {
    const through = graph(
      node("w", "worker", ", model: cheap") + node("dedupe", "reduce", ", model: null") + node("v", "verifier", ", model: cheap"),
      edge("w", "dedupe") + edge("dedupe", "v"),
    );
    expect(monocultures(through, "raw").map((f) => f.nodes)).toEqual([["v", "w"]]);

    // The strong summary is what the verifier is handed; the cheap reader behind it is not.
    const summarised = graph(
      node("w", "worker", ", model: cheap") + node("sum", "reduce", ", model: strong") + node("v", "verifier", ", model: cheap"),
      edge("w", "sum") + edge("sum", "v"),
    );
    expect(monocultures(summarised, "raw")).toEqual([]);
  });

  it("checks nothing along a fake edge, which carries nothing", () => {
    const fake = graph(node("w", "worker", ", model: cheap") + node("v", "verifier", ", model: cheap"), edge("w", "v", "[]"));
    expect(monocultures(fake, "raw")).toEqual([]);
  });

  it("names each step on the shared tier once, in one finding per verifier", () => {
    const three = graph(
      node("a", "worker", ", model: cheap") +
        node("b", "worker", ", model: strong") +
        node("c", "worker", ", model: cheap") +
        node("v", "verifier", ", model: cheap"),
      edge("a", "v") + edge("b", "v") + edge("c", "v"),
    );
    expect(monocultures(three, "raw").map((f) => f.nodes)).toEqual([["v", "a", "c"]]);
  });
});

describe("TIER_MISMATCH", () => {
  const graph = (nodes: string, edges = "") =>
    buildGraph(parseSpec(`version: 1\nname: t\nnodes:\n${nodes}${edges ? `edges:\n${edges}` : ""}`));
  const node = (id: string, kind: string, extra = "") =>
    `  - { id: ${id}, label: ${id}, kind: ${kind}, in: { a: string }, out: { a: string }${extra} }\n`;
  const edge = (from: string, to: string) => `  - { from: ${from}, to: ${to}, carries: [a] }\n`;
  const FAN = ", fanOut: { over: doc, cap: 8 }";

  it("fires on a fanned worker on the strong tier, and on nothing else that fans", () => {
    const found = tierMismatches(graph(node("read", "worker", `, model: strong${FAN}`)), "raw");
    expect(found.map((f) => [f.nodes, f.tier, f.severity])).toEqual([[["read"], "strong", "warn"]]);
    expect(tierMismatches(graph(node("read", "worker", `, model: cheap${FAN}`)), "raw")).toEqual([]);
    expect(tierMismatches(graph(node("read", "worker", ", model: strong")), "raw")).toEqual([]);
    // A fanned check is checking, not reading.
    expect(tierMismatches(graph(node("check", "verifier", `, model: strong${FAN}`)), "raw")).toEqual([]);
  });

  it("fires on a cheap synthesis of fanned results, through code and checks in between", () => {
    const direct = graph(node("read", "worker", `, model: cheap${FAN}`) + node("sum", "synthesize", ", model: cheap"), edge("read", "sum"));
    expect(tierMismatches(direct, "raw").map((f) => [f.nodes, f.tier])).toEqual([[["sum"], "cheap"]]);

    const between = graph(
      node("read", "worker", `, model: cheap${FAN}`) +
        node("dedupe", "reduce", ", model: null") +
        node("check", "verifier", ", model: strong") +
        node("sum", "synthesize", ", model: cheap"),
      edge("read", "dedupe") + edge("dedupe", "check") + edge("check", "sum"),
    );
    expect(tierMismatches(between, "raw").map((f) => f.message)).toEqual([
      "sum combines what read fanned out, on the cheap tier; putting many results together is where the strong tier pays",
    ]);
  });

  it("says nothing of a strong synthesis, of one with no fan-out, or of one after the fan-out is already combined", () => {
    const strong = graph(node("read", "worker", `, model: cheap${FAN}`) + node("sum", "synthesize", ", model: strong"), edge("read", "sum"));
    expect(tierMismatches(strong, "raw")).toEqual([]);
    expect(tierMismatches(graph(node("sum", "synthesize", ", model: cheap")), "raw")).toEqual([]);

    // A cheap step that formats a strong report is not the step that combined the fan-out.
    const after = graph(
      node("read", "worker", `, model: cheap${FAN}`) +
        node("report", "synthesize", ", model: strong") +
        node("email", "synthesize", ", model: cheap"),
      edge("read", "report") + edge("report", "email"),
    );
    expect(tierMismatches(after, "raw")).toEqual([]);
  });
});

/**
 * Who does the work, over every example. Only self-grading changes: its cheap
 * verifier checks two cheap drafters. Every other example already puts the
 * strong tier on the steps that combine and check and the cheap one on the
 * steps that read, so neither rule has anything to say about them.
 */
describe("who does the work, across the examples and their variants", () => {
  const ALL = [
    "capability-audit",
    "daily-brief",
    "diamond",
    "linear-chain",
    "live-demo",
    "release-session",
    "research-desk",
    "route-auth-audit",
    "self-grading",
    "wide-fanin",
  ] as const;
  const who = (graph: Graph) =>
    lint(graph)
      .findings.filter((f) => f.rule === "MONOCULTURE" || f.rule === "TIER_MISMATCH")
      .map((f) => `${f.rule} ${f.nodes[0]}`);

  it("covers every example", () => {
    const yaml = readdirSync(examples)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""));
    expect([...ALL].sort()).toEqual(yaml.sort());
  });

  it.each(ALL)("%s", (name) => {
    expect(who(fixture(name))).toEqual(name === "self-grading" ? ["MONOCULTURE check_own"] : []);
  });

  const desk = fileURLToPath(new URL("./fixtures/research-desk/", import.meta.url));
  const variant = (name: string) => loadGraph(`${desk}${name}.yaml`);
  const all = (graph: Graph) => lint(graph).findings.map((f) => `${f.rule} ${f.nodes[0]}`);

  it("research-desk with strong readers: the tier is wrong, and the strong skeptics now share it", () => {
    expect(all(variant("strong-readers"))).toEqual([
      "MONOCULTURE skeptic_correct",
      "MONOCULTURE skeptic_current",
      "MONOCULTURE skeptic_source",
      "TIER_MISMATCH research",
    ]);
  });

  it("research-desk with a cheap report: the first step to put the research together", () => {
    expect(all(variant("cheap-report"))).toEqual(["TIER_MISMATCH report"]);
  });

  it("research-desk with one skeptic run as the readers' own agent", () => {
    expect(lint(variant("same-agent")).findings.map((f) => [f.rule, f.nodes, f.agent, f.tier])).toEqual([
      ["MONOCULTURE", ["skeptic_source", "research"], "analyst", undefined],
    ]);
  });
});
