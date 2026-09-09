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
  it("puts the errors first, the way RULE_ORDER does", () => {
    expect(AUDIT_RULE_ORDER.map(auditRuleSeverity)).toEqual([
      "error", // CAPABILITY_GAP
      "error", // ORDER_VIOLATION
      "warn", // UNUSED_CAPABILITY
      "warn", // UNDECLARED_CAPABILITY
      "warn", // NODE_NEVER_RAN
      "warn", // UNDECLARED_NODE
      "warn", // OBSERVED_SERIALISATION
    ]);
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
    // write_up declares skill:summarise and never ran, so no UNUSED/GAP finding
    // is reported for it. write_up itself now correctly picks up NODE_NEVER_RAN,
    // which is a different rule's business, not this test's.
    expect(audit(lines, graph).findings.filter((f) => f.rule !== "NODE_NEVER_RAN")).toEqual([]);
  });

  it("a node-less invocation does not satisfy a node's declaration", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_invoked", capability: "skill:summarise" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    // fetch_docs never appears at all here, so NODE_NEVER_RAN correctly fires
    // for it — this test is only about the capability finding.
    const findings = audit(lines, graph).findings.filter((f) => f.rule !== "NODE_NEVER_RAN");
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

  // fetch_docs never appears in any of the three traces below — only
  // write_up's capability timeline is under test — so each filters out the
  // NODE_NEVER_RAN it correctly and separately picks up for fetch_docs.
  it("a capability lost after the node closed is not that node's gap", () => {
    const graph = fixture("capability-audit");
    const lines = [
      line(0, { type: "node_started", node: "write_up" }),
      line(1, { type: "capability_invoked", capability: "skill:summarise", node: "write_up" }),
      line(2, { type: "node_finished", node: "write_up", durationMs: 10 }),
      line(3, { type: "capability_lost", capability: "skill:summarise" }),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule !== "NODE_NEVER_RAN")).toEqual([]);
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
    expect(audit(lines, graph).findings.filter((f) => f.rule !== "NODE_NEVER_RAN")).toEqual([]);
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
    expect(audit(lines, graph).findings.filter((f) => f.rule !== "NODE_NEVER_RAN")).toEqual([]);
  });
});

describe("clean control", () => {
  // research-desk rather than diamond, and the assertion below is why: diamond
  // gained a `uses:` declaration the day this test was written, in a change that
  // touched no file this test touches. The guard is kept precisely so the next
  // fixture to gain one fails here loudly instead of leaving a control that
  // silently controls for nothing.
  it("a uses-free spec and a trace with no capability events reports no capability finding", () => {
    const graph = fixture("research-desk");
    expect(graph.spec.nodes.every((n) => n.uses === undefined)).toBe(true);
    const lines = [
      line(0, { type: "run_started", spec: { name: "research-desk" }, source: "ccg-run" }),
      line(1, { type: "node_started", node: "plan" }),
      line(2, { type: "node_finished", node: "plan", durationMs: 10 }),
      line(3, { type: "run_finished", ok: true, durationMs: 20 }),
    ];
    const result = audit(lines, graph);
    // Only "plan" ran here, so NODE_NEVER_RAN correctly flags the rest — that
    // is the node-level rules' job, not this test's concern. This test is
    // only about a spec with no `uses:` anywhere producing no capability finding.
    expect(result.findings.filter((f) => f.rule.includes("CAPABILITY"))).toEqual([]);
    expect(result.runIds).toEqual(["hand"]);
  });

  it("lines this reader cannot parse are skipped, not counted", () => {
    const graph = fixture("capability-audit");
    const lines: TraceLine[] = [
      parseTraceLine("{ not json"),
      parseTraceLine(JSON.stringify({ v: 1, runId: "hand", seq: 0, ts: "t", type: "from_the_future" })),
    ];
    expect(audit(lines, graph)).toEqual({
      findings: [],
      runIds: [],
      skipped: [],
      changedSince: [],
      reportedCapabilities: false,
      reportedNodeEvents: false,
    });
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
    // fetch_docs correctly picks up NODE_NEVER_RAN here — neither run starts
    // it. What this test actually checks is that b's loss does not leak into
    // a's timeline as a false CAPABILITY_GAP.
    expect(result.findings.filter((f) => f.rule === "CAPABILITY_GAP")).toEqual([]);
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

/**
 * A run says which spec it came from. Until this was checked, nothing compared
 * that claim to the spec being audited against, so pointing the audit at the
 * wrong pair produced findings that were confident, specific and fiction — two
 * unrelated workflows need only share a node name to appear to disagree.
 */
describe("a run is only audited against the spec it came from", () => {
  const graph = fixture("capability-audit");

  const fromSpec = (runId: string, name: string, hash?: string) =>
    parseTraceLine(
      JSON.stringify({
        v: 1,
        runId,
        seq: 0,
        ts: "2026-08-05T10:00:00.000Z",
        type: "run_started",
        spec: hash === undefined ? { name } : { name, hash },
        source: "ccg-run",
      }),
    );

  const body = (runId: string) => [
    parseTraceLine(
      JSON.stringify({
        v: 1,
        runId,
        seq: 1,
        ts: "2026-08-05T10:00:01.000Z",
        type: "node_started",
        node: "fetch_docs",
      }),
    ),
    parseTraceLine(
      JSON.stringify({
        v: 1,
        runId,
        seq: 2,
        ts: "2026-08-05T10:00:02.000Z",
        type: "capability_invoked",
        capability: "mcp:docs/search",
        node: "fetch_docs",
      }),
    ),
  ];

  it("skips a run that names a different spec, and says which", () => {
    const result = audit([fromSpec("other", "live-demo"), ...body("other")], graph);
    expect(result.findings).toEqual([]);
    expect(result.runIds).toEqual([]);
    expect(result.skipped).toEqual([{ runId: "other", specName: "live-demo" }]);
  });

  it("audits the matching runs in a pool and skips the rest", () => {
    const result = audit(
      [
        fromSpec("mine", "capability-audit"),
        ...body("mine"),
        fromSpec("theirs", "live-demo"),
        ...body("theirs"),
      ],
      graph,
    );
    expect(result.runIds).toEqual(["mine"]);
    expect(result.skipped.map((r) => r.runId)).toEqual(["theirs"]);
    // The finding belongs to the run that matched, and mentions nothing from the other.
    expect(result.findings.every((f) => f.capability !== "mcp:web/fetch")).toBe(true);
  });

  // Absence is not mismatch. A hand-written trace, or one from an adapter that
  // never saw a session start, has made no claim to contradict.
  it("audits a run that never said which spec it came from", () => {
    const result = audit(body("anonymous"), graph);
    expect(result.runIds).toEqual(["anonymous"]);
    expect(result.skipped).toEqual([]);
  });

  it("reports a hash that moved, and audits anyway", () => {
    const result = audit(
      [fromSpec("mine", "capability-audit", "aaaaaaaaaaaaaaaa"), ...body("mine")],
      graph,
      { specHash: "bbbbbbbbbbbbbbbb" },
    );
    expect(result.changedSince).toEqual(["mine"]);
    expect(result.runIds).toEqual(["mine"]);
  });

  it("says nothing about a hash when the caller supplied none", () => {
    const result = audit([fromSpec("mine", "capability-audit", "aaaaaaaaaaaaaaaa"), ...body("mine")], graph);
    expect(result.changedSince).toEqual([]);
  });

  it("reports whether anything was actually checked", () => {
    const silent = audit([fromSpec("q", "capability-audit")], graph);
    expect(silent.reportedCapabilities).toBe(false);
    const spoke = audit([fromSpec("r", "capability-audit"), ...body("r")], graph);
    expect(spoke.reportedCapabilities).toBe(true);
  });
});

describe("NODE_NEVER_RAN", () => {
  const graph = fixture("capability-audit"); // fetch_docs -> write_up

  it("flags a declared node that never started in any matched run", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(1, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings).toEqual([
      {
        rule: "NODE_NEVER_RAN",
        severity: "warn",
        nodes: ["write_up"],
        message: "write_up is declared in the spec but no audited run shows any evidence it ran",
      },
    ]);
  });

  it("says nothing when no run reports a node_started at all — absence is not evidence", () => {
    const lines = [line(0, { runId: "r1", type: "run_started", spec: { name: "capability-audit" } })];
    expect(audit(lines, graph).findings).toEqual([]);
  });

  it("says nothing once every declared node has started somewhere across the pool", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(1, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
      line(2, { runId: "r2", type: "node_started", node: "write_up" }),
      line(3, { runId: "r2", type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "NODE_NEVER_RAN")).toEqual([]);
  });

  // Regression: examples/traces/live-demo.jsonl has both shapes in one real
  // run — a gate node ("review": gate_waiting/gate_resolved, never
  // node_started) and a node the runner skipped because its own dependency
  // failed ("count_lines": node_failed with no node_started ever preceding
  // it). Neither is "never ran" — the trace has direct evidence for both.
  it("a gate node is accounted for by gate_waiting/gate_resolved, not node_started", () => {
    const gateGraph = fixture("live-demo");
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "plan" }),
      line(1, { runId: "r1", type: "node_finished", node: "plan", durationMs: 10 }),
      line(2, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(3, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
      line(4, { runId: "r1", type: "node_started", node: "fetch_code" }),
      line(5, { runId: "r1", type: "node_finished", node: "fetch_code", durationMs: 10 }),
      line(6, { runId: "r1", type: "node_started", node: "count_lines" }),
      line(7, { runId: "r1", type: "node_finished", node: "count_lines", durationMs: 10 }),
      line(8, { runId: "r1", type: "node_started", node: "summarise" }),
      line(9, { runId: "r1", type: "node_finished", node: "summarise", durationMs: 10 }),
      line(10, { runId: "r1", type: "gate_waiting", node: "review" }),
      line(11, { runId: "r1", type: "gate_resolved", node: "review", decision: "approve" }),
      line(12, { runId: "r1", type: "node_started", node: "publish" }),
      line(13, { runId: "r1", type: "node_finished", node: "publish", durationMs: 10 }),
    ];
    expect(audit(lines, gateGraph).findings.filter((f) => f.rule === "NODE_NEVER_RAN")).toEqual([]);
  });

  it("a node skipped after its dependency failed is accounted for by node_failed alone", () => {
    const gateGraph = fixture("live-demo");
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "plan" }),
      line(1, { runId: "r1", type: "node_finished", node: "plan", durationMs: 10 }),
      line(2, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(3, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
      line(4, { runId: "r1", type: "node_started", node: "fetch_code" }),
      line(5, { runId: "r1", type: "node_failed", node: "fetch_code", error: "boom" }),
      // count_lines never started — its only dependency failed — but the
      // runner still reports it, as a failure rather than a silence.
      line(6, { runId: "r1", type: "node_failed", node: "count_lines", error: "skipped: no result from fetch_code" }),
    ];
    const result = audit(lines, gateGraph);
    expect(result.findings.filter((f) => f.rule === "NODE_NEVER_RAN" && f.nodes.includes("count_lines"))).toEqual(
      [],
    );
  });
});

describe("ORDER_VIOLATION", () => {
  const graph = fixture("capability-audit"); // a declared edge: fetch_docs -> write_up

  it("flags a node that started before its declared predecessor finished", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      // write_up starts while fetch_docs is still open — the dependency was not honoured.
      line(1, { runId: "r1", type: "node_started", node: "write_up" }),
      line(2, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
      line(3, { runId: "r1", type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings).toEqual([
      {
        rule: "ORDER_VIOLATION",
        severity: "error",
        nodes: ["fetch_docs", "write_up"],
        message:
          "write_up started before fetch_docs finished, though the spec declares fetch_docs -> write_up",
      },
    ]);
  });

  it("says nothing when the predecessor finished first, as declared", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(1, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
      line(2, { runId: "r1", type: "node_started", node: "write_up" }),
      line(3, { runId: "r1", type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings).toEqual([]);
  });

  it("says nothing when the predecessor never appears at all — absence is not evidence", () => {
    // A thin trace that only tracks write_up says nothing about whether
    // fetch_docs ran first; only a predecessor known to have started (and not
    // yet finished) counts as evidence.
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "write_up" }),
      line(1, { runId: "r1", type: "node_finished", node: "write_up", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "ORDER_VIOLATION")).toEqual([]);
  });
});

describe("UNDECLARED_NODE", () => {
  const graph = fixture("diamond");

  it("flags a node_started for an id the spec does not know", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "ghost_worker" }),
      line(1, { runId: "r1", type: "node_finished", node: "ghost_worker", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "UNDECLARED_NODE")).toEqual([
      {
        rule: "UNDECLARED_NODE",
        severity: "warn",
        nodes: ["ghost_worker"],
        message: "ghost_worker started but is not declared in the spec",
      },
    ]);
  });

  it("says nothing about a node the spec does declare", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "split" }),
      line(1, { runId: "r1", type: "node_finished", node: "split", durationMs: 10 }),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "UNDECLARED_NODE")).toEqual([]);
  });
});

describe("OBSERVED_SERIALISATION", () => {
  const graph = fixture("diamond"); // worker_2 and worker_3 share no declared path

  const nonOverlapping = (runId: string, order: readonly [string, string]) => [
    line(0, { runId, type: "node_started", node: order[0] }),
    line(1, { runId, type: "node_finished", node: order[0], durationMs: 10 }),
    line(2, { runId, type: "node_started", node: order[1] }),
    line(3, { runId, type: "node_finished", node: order[1], durationMs: 10 }),
  ];

  it("needs more than one non-overlapping run before calling it a pattern", () => {
    const result = audit(nonOverlapping("r1", ["worker_2", "worker_3"]), graph);
    expect(result.findings.filter((f) => f.rule === "OBSERVED_SERIALISATION")).toEqual([]);
  });

  it("flags a pair with no declared path that never overlaps across several runs", () => {
    const lines = [
      ...nonOverlapping("r1", ["worker_2", "worker_3"]),
      ...nonOverlapping("r2", ["worker_3", "worker_2"]),
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "OBSERVED_SERIALISATION")).toEqual([
      {
        rule: "OBSERVED_SERIALISATION",
        severity: "warn",
        nodes: ["worker_2", "worker_3"],
        message:
          "worker_2 and worker_3 share no declared path and never overlapped in 2 audited runs — a candidate hidden edge",
      },
    ]);
  });

  it("one overlapping run disproves the candidate outright", () => {
    const overlapping = [
      line(0, { runId: "r3", type: "node_started", node: "worker_2" }),
      line(1, { runId: "r3", type: "node_started", node: "worker_3" }),
      line(2, { runId: "r3", type: "node_finished", node: "worker_2", durationMs: 10 }),
      line(3, { runId: "r3", type: "node_finished", node: "worker_3", durationMs: 10 }),
    ];
    const lines = [
      ...nonOverlapping("r1", ["worker_2", "worker_3"]),
      ...nonOverlapping("r2", ["worker_3", "worker_2"]),
      ...overlapping,
    ];
    expect(audit(lines, graph).findings.filter((f) => f.rule === "OBSERVED_SERIALISATION")).toEqual([]);
  });

  it("says nothing about a pair the spec already connects, however indirectly", () => {
    // split -> worker_2 is a declared path, so there is no edge to propose.
    const lines = [
      ...nonOverlapping("r1", ["split", "worker_2"]),
      ...nonOverlapping("r2", ["worker_2", "split"]),
    ];
    const result = audit(lines, graph);
    expect(
      result.findings.some((f) => f.nodes.includes("split") && f.nodes.includes("worker_2")),
    ).toBe(false);
  });
});

describe("reportedNodeEvents", () => {
  const graph = fixture("capability-audit");

  it("is false for a trace that never mentions a node_started", () => {
    const lines = [line(0, { runId: "r1", type: "run_started", spec: { name: "capability-audit" } })];
    expect(audit(lines, graph).reportedNodeEvents).toBe(false);
  });

  it("is true once any matched run reports one", () => {
    const lines = [
      line(0, { runId: "r1", type: "node_started", node: "fetch_docs" }),
      line(1, { runId: "r1", type: "node_finished", node: "fetch_docs", durationMs: 10 }),
    ];
    expect(audit(lines, graph).reportedNodeEvents).toBe(true);
  });
});
