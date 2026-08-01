// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyRunState,
  isTraceEvent,
  parseTraceLine,
  reduceRun,
  serializeEvent,
  TAIL_CAP,
  type RunState,
  type TraceEvent,
} from "../src/index.js";
import { readTrace } from "../src/node.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Fold a committed fixture, optionally stopping part way to inspect a run mid-flight. */
function fold(file: string, runId: string, upTo = Number.POSITIVE_INFINITY): RunState {
  return readTrace(`${fixtures}${file}`)
    .slice(0, upTo)
    .reduce(reduceRun, emptyRunState(runId));
}

const EVENTS: TraceEvent[] = [
  {
    v: 1,
    type: "run_started",
    runId: "r",
    seq: 0,
    ts: "2026-08-01T09:00:00.000Z",
    spec: { name: "diamond", hash: "abc123" },
    source: "ccg-run",
    args: { repo: "artfusion/ccgrapher", depth: 2 },
  },
  {
    v: 1,
    type: "node_started",
    runId: "r",
    seq: 1,
    ts: "2026-08-01T09:00:00.001Z",
    node: "worker",
    instance: 2,
    of: 5,
  },
  {
    v: 1,
    type: "node_log",
    runId: "r",
    seq: 2,
    ts: "2026-08-01T09:00:00.002Z",
    node: "worker",
    line: "checking the third claim",
  },
  {
    v: 1,
    type: "node_finished",
    runId: "r",
    seq: 3,
    ts: "2026-08-01T09:00:00.003Z",
    node: "worker",
    instance: 2,
    durationMs: 1400,
    output: { claim: "verified", sources: ["https://example.test"] },
    usage: { model: "claude-haiku-4", inputTokens: 600, outputTokens: 90, costUsd: 0.0009 },
  },
  {
    v: 1,
    type: "node_failed",
    runId: "r",
    seq: 4,
    ts: "2026-08-01T09:00:00.004Z",
    node: "worker",
    instance: 3,
    durationMs: 300,
    error: "source returned 404",
  },
  {
    v: 1,
    type: "gate_waiting",
    runId: "r",
    seq: 5,
    ts: "2026-08-01T09:00:00.005Z",
    node: "approval",
    payload: { diff: "+ 42 lines" },
  },
  {
    v: 1,
    type: "gate_resolved",
    runId: "r",
    seq: 6,
    ts: "2026-08-01T09:00:00.006Z",
    node: "approval",
    decision: "approve",
    note: "reads fine",
  },
  {
    v: 1,
    type: "run_finished",
    runId: "r",
    seq: 7,
    ts: "2026-08-01T09:00:00.007Z",
    ok: true,
    durationMs: 5410,
  },
];

describe("round trip — event -> JSONL line -> event", () => {
  it.each(EVENTS.map((event) => [event.type, event] as const))("%s survives", (_type, event) => {
    const back = parseTraceLine(serializeEvent(event));
    expect(back).toEqual(event);
  });

  it("covers every type in the union", () => {
    expect(new Set(EVENTS.map((e) => e.type)).size).toBe(EVENTS.length);
  });

  it("is one line, with no trailing newline", () => {
    for (const event of EVENTS) expect(serializeEvent(event)).not.toContain("\n");
  });
});

describe("parseTraceLine tolerance", () => {
  const junk = [
    "",
    "   ",
    "{not json",
    "{",
    "42",
    "null",
    "[]",
    '"a string"',
    '{"v":1}',
    // A recognised type with a required field missing.
    '{"v":1,"type":"node_started","runId":"r","seq":0}',
    // Right shape, wrong contract version.
    '{"v":2,"type":"run_finished","runId":"r","seq":0,"ts":"t","ok":true,"durationMs":1}',
    // Wrong type for a field.
    '{"v":1,"type":"node_finished","runId":"r","seq":0,"ts":"t","node":"a","durationMs":"soon"}',
  ];

  it.each(junk)("returns the unknown shape for %j, never throws", (line) => {
    const parsed = parseTraceLine(line);
    expect(parsed).toEqual({ type: "unknown", raw: line });
    expect(isTraceEvent(parsed)).toBe(false);
  });

  it("keeps going when a newer writer emits a type it has never heard of", () => {
    const line = '{"v":1,"type":"node_retried","runId":"r","seq":9,"ts":"t","node":"w","attempt":2}';
    const parsed = parseTraceLine(line);

    expect(parsed.type).toBe("unknown");
    // The line is kept verbatim, so a reader can forward what it cannot read.
    expect(isTraceEvent(parsed) ? "" : parsed.raw).toBe(line);
  });

  it("keeps the run when a newer writer names a source it has never heard of", () => {
    // `run_started` is the only event carrying the spec, so rejecting it over an
    // unfamiliar source would lose the identity of the whole run. Adding a source
    // is an additive change, and additive changes are what `v: 1` promises to survive.
    const line =
      '{"v":1,"type":"run_started","runId":"r","seq":0,"ts":"t","spec":{"name":"w"},"source":"github-action"}';
    const parsed = parseTraceLine(line);

    expect(parsed.type).toBe("run_started");
    expect(isTraceEvent(parsed) && parsed.type === "run_started" ? parsed.source : "").toBe(
      "github-action",
    );
  });
});

describe("reduceRun — happy path", () => {
  const state = fold("happy-path.jsonl", "run-happy");

  it("ends done, with the spec it started from", () => {
    expect(state.status).toBe("done");
    expect(state.spec).toEqual({ name: "research-desk", hash: "9f2c1a" });
  });

  it("keeps the started time, duration and log tail of a node", () => {
    expect(state.nodes.get("plan")).toEqual({
      status: "done",
      startedAt: "2026-08-01T09:00:00.010Z",
      durationMs: 1200,
      tail: ["reading the brief", "three questions worth asking"],
      usage: {
        model: "claude-haiku-4",
        inputTokens: 900,
        outputTokens: 120,
        costUsd: 0.0021,
      },
    });
  });

  it("leaves usage absent when the run never reported any", () => {
    const research = state.nodes.get("research");
    expect(research?.status).toBe("done");
    expect(research?.durationMs).toBe(2880);
    // Absent, not zeroed. A consumer renders "n/a" here.
    expect(research?.usage).toBeUndefined();
  });

  it("keeps a partial usage report partial", () => {
    expect(state.nodes.get("write")?.usage).toEqual({
      model: "claude-sonnet-4",
      inputTokens: 4100,
      outputTokens: 800,
    });
    expect(state.nodes.get("write")?.usage?.costUsd).toBeUndefined();
  });

  it("does not invent a node for a run-scoped log line", () => {
    expect([...state.nodes.keys()]).toEqual(["plan", "research", "write"]);
  });
});

describe("reduceRun — a run with a failed node", () => {
  const state = fold("failed-node.jsonl", "run-failed");

  it("ends failed", () => {
    expect(state.status).toBe("failed");
  });

  it("records the error and what the node had said before it", () => {
    expect(state.nodes.get("audit")).toEqual({
      status: "failed",
      startedAt: "2026-08-01T10:00:12.510Z",
      durationMs: 1690,
      error: "1 unguarded route",
      tail: ["scanning 41 routes", "routes/admin.ts: no auth guard"],
    });
  });

  it("leaves a node that never reported an end still running", () => {
    // `report` started and the run ended around it. Marking it done or failed
    // would be the fold guessing at something the trace never said.
    expect(state.nodes.get("report")?.status).toBe("running");
  });
});

describe("reduceRun — a run with a gate", () => {
  it("waits, rather than pretending work is happening", () => {
    const waiting = fold("gate.jsonl", "run-gate", 4);

    expect(waiting.status).toBe("running");
    expect(waiting.nodes.get("approval")).toEqual({
      status: "waiting",
      startedAt: "2026-08-01T11:00:09.010Z",
      tail: [],
      gatePayload: { diff: "+ 42 lines" },
    });
  });

  it("keeps what the human is being asked to approve", () => {
    // A prompt that cannot show the thing being approved is asking for a rubber
    // stamp, so the payload has to survive the fold, not just the file.
    const waiting = fold("gate.jsonl", "run-gate", 4);

    expect(waiting.nodes.get("approval")?.gatePayload).toEqual({ diff: "+ 42 lines" });
  });

  it("closes the gate on approval and lets the rest of the run proceed", () => {
    const state = fold("gate.jsonl", "run-gate");

    expect(state.status).toBe("done");
    expect(state.nodes.get("approval")?.status).toBe("done");
    expect(state.nodes.get("publish")?.status).toBe("done");
  });

  it("fails the gate on rejection, using the reviewer's own note", () => {
    const events = readTrace(`${fixtures}gate.jsonl`).slice(0, 4);
    const rejected = reduceRun(events.reduce(reduceRun, emptyRunState("run-gate")), {
      v: 1,
      type: "gate_resolved",
      runId: "run-gate",
      seq: 4,
      ts: "2026-08-01T11:04:31.000Z",
      node: "approval",
      decision: "reject",
      note: "the second claim is not sourced",
    });

    expect(rejected.nodes.get("approval")?.status).toBe("failed");
    expect(rejected.nodes.get("approval")?.error).toBe("the second claim is not sourced");
  });

  it("invents no error text for a rejection with no note", () => {
    const rejected = reduceRun(emptyRunState("run-gate"), {
      v: 1,
      type: "gate_resolved",
      runId: "run-gate",
      seq: 0,
      ts: "2026-08-01T11:04:31.000Z",
      node: "approval",
      decision: "reject",
    });

    expect(rejected.nodes.get("approval")?.status).toBe("failed");
    expect(rejected.nodes.get("approval")?.error).toBeUndefined();
  });
});

describe("reduceRun — fanOut instances", () => {
  it("is running while every instance is still out", () => {
    const state = fold("fan-out.jsonl", "run-fanout", 6);

    expect(state.nodes.get("worker")).toEqual({
      status: "running",
      startedAt: "2026-08-01T12:00:00.520Z",
      instances: { done: 0, failed: 0, of: 3 },
      tail: [],
    });
  });

  it("is partial once some instances have landed", () => {
    const state = fold("fan-out.jsonl", "run-fanout", 8);

    expect(state.nodes.get("worker")?.status).toBe("partial");
    expect(state.nodes.get("worker")?.instances).toEqual({ done: 1, failed: 0, of: 3 });
  });

  it("counts every instance and sums the usage that was reported", () => {
    const state = fold("fan-out.jsonl", "run-fanout");
    const worker = state.nodes.get("worker");

    expect(worker?.status).toBe("failed");
    expect(worker?.instances).toEqual({ done: 2, failed: 1, of: 3 });
    expect(worker?.error).toBe("source returned 404");
    // The slowest instance, not the sum: they ran at the same time.
    expect(worker?.durationMs).toBe(3500);
    expect(worker?.usage).toEqual({
      model: "claude-haiku-4",
      inputTokens: 1300,
      outputTokens: 200,
      costUsd: expect.closeTo(0.002, 6),
    });
  });

  it("folds straight past an event a newer writer added", () => {
    const lines = readTrace(`${fixtures}fan-out.jsonl`);
    expect(lines.filter((line) => !isTraceEvent(line))).toHaveLength(1);

    // The unknown line neither throws nor disturbs the state around it.
    expect(fold("fan-out.jsonl", "run-fanout").status).toBe("failed");
  });
});

describe("reduceRun is a fold, not a mutation", () => {
  it("leaves the state it was given alone", () => {
    const before = emptyRunState("run-happy");
    const after = readTrace(`${fixtures}happy-path.jsonl`).reduce(reduceRun, before);

    expect(before.nodes.size).toBe(0);
    expect(before.status).toBe("running");
    expect(after.nodes.size).toBe(3);
  });

  it("ignores events belonging to another run", () => {
    const state = readTrace(`${fixtures}happy-path.jsonl`).reduce(
      reduceRun,
      emptyRunState("some-other-run"),
    );

    expect(state).toEqual(emptyRunState("some-other-run"));
  });

  it("caps the log tail at TAIL_CAP lines, keeping the most recent", () => {
    const overflow = TAIL_CAP + 50;
    let state = emptyRunState("r");
    for (let i = 0; i < overflow; i += 1) {
      state = reduceRun(state, {
        v: 1,
        type: "node_log",
        runId: "r",
        seq: i,
        ts: "2026-08-01T09:00:00.000Z",
        node: "chatty",
        line: `line ${i}`,
      });
    }

    const tail = state.nodes.get("chatty")?.tail ?? [];
    expect(tail).toHaveLength(TAIL_CAP);
    expect(tail[0]).toBe(`line ${overflow - TAIL_CAP}`);
    expect(tail.at(-1)).toBe(`line ${overflow - 1}`);
  });
});
