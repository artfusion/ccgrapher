// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGraph } from "@ccgrapher/core/node";
import { parseTraceLine, type TraceLine } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { audit, AUDIT_RULE_ORDER, auditRuleSeverity } from "../src/index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const fixture = (name: string) => loadGraph(`${examples}${name}.yaml`);

function trace(name: string): TraceLine[] {
  return readFileSync(`${examples}traces/${name}.jsonl`, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseTraceLine);
}

/** Same shape as the fixtures write, so a hand-built timeline stays readable. */
function line(seq: number, event: Record<string, unknown>): TraceLine {
  return parseTraceLine(
    JSON.stringify({ v: 1, runId: "hand", seq, ts: "2026-08-05T10:00:00.000Z", ...event }),
  );
}

describe("the rule set", () => {
  it("puts the error first, the way RULE_ORDER does", () => {
    expect(AUDIT_RULE_ORDER.map(auditRuleSeverity)).toEqual(["error", "warn", "warn"]);
  });
});

describe("UNUSED_CAPABILITY", () => {
  const result = audit(trace("capability-unused"), fixture("capability-audit"));

  it("reports the one capability the node declared and never called", () => {
    expect(result.findings).toEqual([
      {
        rule: "UNUSED_CAPABILITY",
        severity: "warn",
        capability: "skill:summarise",
        nodes: ["fetch_docs"],
        message: "fetch_docs ran but never invoked 'skill:summarise', which it declares in uses",
      },
    ]);
    expect(result.runIds).toEqual(["cap-unused"]);
  });

  it("says nothing about a capability the node did call", () => {
    expect(result.findings.some((f) => f.capability === "mcp:docs/search")).toBe(false);
  });

  it("a node that never started produces no finding — there is no evidence either way", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "run_started", spec: { name: "capability-audit" }, source: "ccg-run" }),
      line(1, { type: "node_started", node: "fetch_docs" }),
      line(2, { type: "capability_invoked", capability: "mcp:docs/search", node: "fetch_docs" }),
      line(3, { type: "capability_invoked", capability: "skill:summarise", node: "fetch_docs" }),
      line(4, { type: "node_finished", node: "fetch_docs", durationMs: 10 }),
    ];
    // write_up declares skill:summarise and never ran, so it is not reported.
    expect(audit(lines, graph).findings).toEqual([]);
  });

  it("a node-less invocation does not satisfy a node's declaration", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_invoked", capability: "skill:summarise" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    const findings = audit(lines, graph).findings;
    expect(findings.map((f) => f.rule)).toEqual(["UNUSED_CAPABILITY"]);
    expect(findings[0]!.nodes).toEqual(["write_up"]);
  });
});

describe("UNDECLARED_CAPABILITY", () => {
  const result = audit(trace("capability-undeclared"), fixture("capability-audit"));

  it("reports the capability the node used without declaring it", () => {
    expect(result.findings).toEqual([
      {
        rule: "UNDECLARED_CAPABILITY",
        severity: "warn",
        capability: "mcp:web/fetch",
        nodes: ["fetch_docs"],
        message: "fetch_docs invoked 'mcp:web/fetch' but does not declare it in uses",
      },
    ]);
    expect(result.runIds).toEqual(["cap-undeclared"]);
  });

  it("a node-less invocation is run-scoped: no node to blame, so no node named", () => {
    const graph = fixture("capability-audit");
    const lines = [line(0, { type: "capability_invoked", capability: "mcp:web/fetch" })];
    expect(audit(lines, graph).findings).toEqual([
      {
        rule: "UNDECLARED_CAPABILITY",
        severity: "warn",
        capability: "mcp:web/fetch",
        nodes: [],
        message: "the run invoked 'mcp:web/fetch' and no node declares it",
      },
    ]);
  });

  it("a node-less invocation of something some node declares is not a finding", () => {
    const graph = fixture("capability-audit");
    const lines = [line(0, { type: "capability_invoked", capability: "skill:summarise" })];
    expect(audit(lines, graph).findings).toEqual([]);
  });
});

describe("CAPABILITY_GAP", () => {
  const result = audit(trace("capability-gap"), fixture("capability-audit"));

  it("reports the node that ran while a capability it declares was known lost", () => {
    const gaps = result.findings.filter((f) => f.rule === "CAPABILITY_GAP");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe("error");
    expect(gaps[0]!.capability).toBe("skill:summarise");
    expect(gaps[0]!.nodes).toEqual(["write_up"]);
    expect(gaps[0]!.message).toContain("lost before the node started");
    // The runtime's own words, kept.
    expect(gaps[0]!.message).toContain("the session reloaded without it");
  });

  it("also reports that the node could not have used what was missing", () => {
    expect(result.findings.map((f) => f.rule)).toEqual(["CAPABILITY_GAP", "UNUSED_CAPABILITY"]);
  });

  it("catches a capability lost while a declaring node is already open", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_lost", capability: "skill:summarise" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    const gaps = audit(lines, graph).findings.filter((f) => f.rule === "CAPABILITY_GAP");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.message).toContain("while the node was running");
  });

  it("a capability lost after the node closed is not that node's gap", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_invoked", capability: "skill:summarise", node: "write_up" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
      line(3, { type: "capability_lost", capability: "skill:summarise" }),
    ];
    expect(audit(lines, graph).findings).toEqual([]);
  });

  it("a capability lost and then reported back is available again", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "capability_lost", capability: "skill:summarise" }),
      line(1, { type: "capability_available", capability: "skill:summarise" }),
      line(2, { type: "node_started", node: "write_up" }),
      line(3, { type: "capability_invoked", capability: "skill:summarise", node: "write_up" }),
      line(4, { type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings).toEqual([]);
  });

  /**
   * The rule that matters most. Nothing reported on skill:summarise, so its
   * state is unknown — and unknown is never a gap, however loudly an empty map
   * looks like "nothing was there".
   */
  it("no availability events at all means unknown, never a gap", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_invoked", capability: "skill:summarise", node: "write_up" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings).toEqual([]);
  });
});

describe("clean control", () => {
  // research-desk rather than diamond, and the assertion below is why: diamond
  // gained a `uses:` declaration the day this test was written, in a change that
  // touched no file this test touches. The guard is kept precisely so the next
  // fixture to gain one fails here loudly instead of leaving a control that
  // silently controls for nothing.
  it("a uses-free spec and a trace with no capability events reports nothing", () => {
    const graph = fixture("research-desk");
    expect(graph.spec.nodes.every((n) => n.uses === undefined)).toBe(true);
    const lines = [
      line(0, { type: "run_started", spec: { name: "research-desk" }, source: "ccg-run" }),
      line(1, { type: "node_started", node: "plan" }),
      line(2, { type: "node_finished", node: "plan", durationMs: 10 }),
      line(3, { type: "run_finished", ok: true, durationMs: 20 }),
    ];
    const result = audit(lines, graph);
    expect(result.findings).toEqual([]);
    expect(result.runIds).toEqual(["hand"]);
  });

  it("lines this reader cannot parse are skipped, not counted", () => {
    const graph = fixture("capability-audit");
    const lines: TraceLine[] = [
      parseTraceLine("{ not json"),
      parseTraceLine(JSON.stringify({ v: 1, runId: "hand", seq: 0, ts: "t", type: "from_the_future" })),
    ];
    expect(audit(lines, graph)).toEqual({ findings: [], runIds: [] });
  });
});

describe("pooling runs", () => {
  const graph = fixture("capability-audit");

  it("the same disagreement in two runs is reported once", () => {
    const both = [...trace("capability-gap"), ...renumber(trace("capability-gap"), "cap-gap-2")];
    const result = audit(both, graph);
    expect(result.runIds).toEqual(["cap-gap", "cap-gap-2"]);
    expect(result.findings.map((f) => f.rule)).toEqual(["CAPABILITY_GAP", "UNUSED_CAPABILITY"]);
  });

  it("different runs' different disagreements both survive", () => {
    const result = audit([...trace("capability-unused"), ...trace("capability-undeclared")], graph);
    expect(result.runIds).toEqual(["cap-undeclared", "cap-unused"]);
    expect(result.findings.map((f) => [f.rule, f.capability])).toEqual([
      ["UNUSED_CAPABILITY", "skill:summarise"],
      ["UNDECLARED_CAPABILITY", "mcp:web/fetch"],
    ]);
  });

  it("interleaved runs are each walked on their own timeline", () => {
    // b's loss must not make a's node_started a gap, even though it comes first
    // in the file. Two runs are two timelines, not one.
    const lines = [
      parseTraceLine(
        JSON.stringify({
          v: 1,
          runId: "b",
          seq: 0,
          ts: "t",
          type: "capability_lost",
          capability: "skill:summarise",
        }),
      ),
      parseTraceLine(
        JSON.stringify({ v: 1, runId: "a", seq: 0, ts: "t", type: "node_started", node: "write_up" }),
      ),
      parseTraceLine(
        JSON.stringify({
          v: 1,
          runId: "a",
          seq: 1,
          ts: "t",
          type: "capability_invoked",
          capability: "skill:summarise",
          node: "write_up",
        }),
      ),
    ];
    const result = audit(lines, graph);
    expect(result.runIds).toEqual(["a", "b"]);
    expect(result.findings).toEqual([]);
  });
});

/** Re-labels a parsed trace as a second run, so one fixture can stand in for two. */
function renumber(lines: readonly TraceLine[], runId: string): TraceLine[] {
  return lines.map((l) =>
    l.type === "unknown" ? l : (parseTraceLine(JSON.stringify({ ...l, runId })) as TraceLine),
  );
}

/**
 * The same discipline CAPABILITY_GAP applies to availability, applied to
 * invocation. A producer that never reports an invocation has not told us a
 * declaration went unused; it has told us nothing, and the two must not read
 * the same.
 */
describe("UNUSED_CAPABILITY needs a producer that reports invocations", () => {
  const graph = fixture("capability-audit");

  const ran = (extra: readonly TraceLine[] = []) => [
    line(0, { type: "run_started", spec: { name: "capability-audit" }, source: "ccg-run" }),
    line(1, { type: "node_started", node: "fetch_docs" }),
    ...extra,
    line(5, { type: "node_finished", node: "fetch_docs", durationMs: 10 }),
    line(6, { type: "run_finished", ok: true, durationMs: 20 }),
  ];

  it("stays silent when the run reported no invocation at all", () => {
    // fetch_docs declares two capabilities and ran. Under the old rule that was
    // two warnings; it is really a run that cannot answer the question.
    const result = audit(ran(), graph);
    expect(result.findings.filter((f) => f.rule === "UNUSED_CAPABILITY")).toEqual([]);
  });

  it("fires as soon as the run proves it reports invocations", () => {
    // One invocation anywhere is the evidence. It is for a different capability
    // than the ones left unused, which is the point: the flag is about the
    // producer's behaviour, not about this node or this capability.
    const result = audit(
      ran([line(2, { type: "capability_invoked", capability: "mcp:docs/search", node: "fetch_docs" })]),
      graph,
    );
    const unused = result.findings.filter((f) => f.rule === "UNUSED_CAPABILITY");
    expect(unused.map((f) => f.capability)).toEqual(["skill:summarise"]);
  });

  it("counts a node-less invocation as evidence too", () => {
    // A session adapter reports the tool without a spec node to pin it to. That
    // still proves the producer speaks this part of the contract.
    const result = audit(
      ran([line(2, { type: "capability_invoked", capability: "mcp:elsewhere/thing" })]),
      graph,
    );
    expect(result.findings.some((f) => f.rule === "UNUSED_CAPABILITY")).toBe(true);
  });
});
