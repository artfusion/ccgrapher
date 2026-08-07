// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyRunState, isTraceEvent, reduceRun, type TraceLine } from "../src/index.js";
import {
  followTrace,
  MAX_LOG_LINE,
  MAX_OUTPUT_CHARS,
  OUTPUT_PREVIEW_CHARS,
  readTrace,
  resumeSeq,
  TraceWriter,
  type TruncatedOutput,
} from "../src/node.js";

let dir: string;
let next = 0;
const tracePath = () => join(dir, `run-${(next += 1)}.jsonl`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccg-trace-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TraceWriter", () => {
  it("round-trips a whole run through readTrace", () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "run-w1");

    const written = [
      writer.write({ type: "run_started", spec: { name: "diamond" }, source: "ccg-run" }),
      writer.write({ type: "node_started", node: "split" }),
      writer.write({ type: "node_log", node: "split", line: "three claims" }),
      writer.write({ type: "node_finished", node: "split", durationMs: 500, output: { n: 3 } }),
      writer.write({ type: "run_finished", ok: true, durationMs: 510 }),
    ];

    expect(readTrace(path)).toEqual(written);
  });

  it("assigns seq monotonically from zero and stamps the envelope", () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "run-w2");

    expect(writer.seq).toBe(0);
    writer.write({ type: "node_started", node: "a" });
    writer.write({ type: "node_started", node: "b" });
    writer.write({ type: "node_started", node: "c" });
    expect(writer.seq).toBe(3);

    const events = readTrace(path).filter(isTraceEvent);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.every((e) => e.v === 1 && e.runId === "run-w2" && e.ts.length > 0)).toBe(true);
  });

  it("resumes numbering when handed a starting seq", () => {
    const path = tracePath();
    new TraceWriter(path, "run-w3", 41).write({ type: "node_started", node: "a" });

    expect(readTrace(path).filter(isTraceEvent)[0]?.seq).toBe(41);
  });

  it("writes a file the reducer can fold without any further help", () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "run-w4");
    writer.write({ type: "run_started", spec: { name: "diamond" }, source: "ccg-run" });
    writer.write({ type: "node_started", node: "worker", instance: 0, of: 2 });
    writer.write({ type: "node_started", node: "worker", instance: 1, of: 2 });
    writer.write({ type: "node_finished", node: "worker", instance: 0, durationMs: 10 });
    writer.write({ type: "node_failed", node: "worker", instance: 1, error: "nope" });
    writer.write({ type: "run_finished", ok: false, durationMs: 30 });

    const state = readTrace(path).reduce(reduceRun, emptyRunState("run-w4"));

    expect(state.status).toBe("failed");
    expect(state.nodes.get("worker")?.instances).toEqual({ done: 1, failed: 1, of: 2 });
  });
});

describe("TraceWriter size caps", () => {
  it("truncates an oversized log line and says how much it dropped", () => {
    const path = tracePath();
    const line = "x".repeat(MAX_LOG_LINE + 100);
    const event = new TraceWriter(path, "run-c1").write({ type: "node_log", node: "a", line });

    expect(event.type === "node_log" && event.line).toContain("(100 more chars)");
    expect(event.type === "node_log" && event.line.startsWith("x".repeat(MAX_LOG_LINE))).toBe(true);
    expect(event.type === "node_log" && event.line.length).toBeLessThan(line.length);
  });

  it("leaves a log line under the cap exactly as it was", () => {
    const path = tracePath();
    const line = "y".repeat(MAX_LOG_LINE);
    const event = new TraceWriter(path, "run-c2").write({ type: "node_log", node: "a", line });

    expect(event.type === "node_log" && event.line).toBe(line);
  });

  it("replaces an oversized output with a marked preview", () => {
    const path = tracePath();
    const output = { blob: "z".repeat(MAX_OUTPUT_CHARS + 1_000) };
    const event = new TraceWriter(path, "run-c3").write({
      type: "node_finished",
      node: "a",
      durationMs: 1,
      output,
    });

    const written = (event.type === "node_finished" ? event.output : undefined) as TruncatedOutput;
    expect(written.truncated).toBe(true);
    expect(written.chars).toBe(JSON.stringify(output).length);
    expect(written.preview).toHaveLength(OUTPUT_PREVIEW_CHARS);

    // And it survives the file, so a reader sees the marker rather than a lie.
    expect(readTrace(path)[0]).toEqual(event);
  });

  it("leaves an output under the cap untouched", () => {
    const path = tracePath();
    const output = { claim: "verified", sources: ["https://example.test"] };
    const event = new TraceWriter(path, "run-c4").write({
      type: "node_finished",
      node: "a",
      durationMs: 1,
      output,
    });

    expect(event.type === "node_finished" && event.output).toEqual(output);
  });

  it("marks an output that cannot be serialised at all, without calling it big", () => {
    const path = tracePath();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const event = new TraceWriter(path, "run-c5").write({
      type: "node_finished",
      node: "a",
      durationMs: 1,
      output: circular,
    });

    const written = (event.type === "node_finished" ? event.output : undefined) as TruncatedOutput;
    expect(written.chars).toBeNull();
    expect(readTrace(path)).toHaveLength(1);
  });
});

describe("followTrace", () => {
  it("yields what is already there, then what is appended", async () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "run-f1");
    writer.write({ type: "run_started", spec: { name: "diamond" }, source: "ccg-run" });
    writer.write({ type: "node_started", node: "split" });

    const seen: TraceLine[] = [];
    const stop = new AbortController();
    const consume = (async () => {
      for await (const line of followTrace(path, { signal: stop.signal, pollMs: 5 })) {
        seen.push(line);
        if (seen.length === 3) stop.abort();
      }
    })();

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    writer.write({ type: "run_finished", ok: true, durationMs: 20 });
    await consume;

    expect(seen).toHaveLength(3);
    expect(seen.map((line) => line.type)).toEqual([
      "run_started",
      "node_started",
      "run_finished",
    ]);
  });

  it("holds back a partial line until its newline arrives", async () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "run-f2");
    writer.write({ type: "node_started", node: "a" });

    const seen: TraceLine[] = [];
    const stop = new AbortController();
    const consume = (async () => {
      for await (const line of followTrace(path, { signal: stop.signal, pollMs: 5 })) {
        seen.push(line);
        if (seen.length === 2) stop.abort();
      }
    })();

    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // Half an event, then the rest of it.
    appendFileSync(path, '{"v":1,"type":"node_finished","runId":"run-f2","seq":1,');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);

    appendFileSync(path, '"ts":"2026-08-01T09:00:00.000Z","node":"a","durationMs":5}\n');
    await consume;

    expect(seen).toHaveLength(2);
    expect(seen[1]?.type).toBe("node_finished");
  });
});

describe("resumeSeq", () => {
  it("starts at 0 for a file that does not exist", () => {
    expect(resumeSeq(join(dir, "never-written.jsonl"))).toBe(0);
  });

  it("starts at 0 for an empty file", () => {
    const path = tracePath();
    appendFileSync(path, "");
    expect(resumeSeq(path)).toBe(0);
  });

  it("continues after the highest seq already written", () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "r");
    writer.write({ type: "capability_available", capability: "mcp:a/b" });
    writer.write({ type: "capability_available", capability: "skill:house-style" });
    expect(resumeSeq(path)).toBe(2);
  });

  it("ignores a line it cannot parse rather than trusting it", () => {
    const path = tracePath();
    new TraceWriter(path, "r").write({ type: "capability_available", capability: "mcp:a/b" });
    appendFileSync(path, "{ half a line\n");
    expect(resumeSeq(path)).toBe(1);
  });

  // The point of the helper: a process that appends one event and exits still
  // produces a file whose order can be recovered.
  it("lets a second short-lived writer continue the sequence gaplessly", () => {
    const path = tracePath();
    new TraceWriter(path, "r").write({ type: "capability_available", capability: "mcp:a/b" });
    new TraceWriter(path, "r", resumeSeq(path)).write({
      type: "capability_invoked",
      capability: "mcp:a/b",
    });
    new TraceWriter(path, "r", resumeSeq(path)).write({
      type: "capability_lost",
      capability: "mcp:a/b",
      reason: "gone",
    });

    const seqs = readTrace(path).map((line) => (isTraceEvent(line) ? line.seq : -1));
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("takes the highest seq, not the last line", () => {
    const path = tracePath();
    const writer = new TraceWriter(path, "r");
    writer.write({ type: "capability_available", capability: "mcp:a/b" });
    writer.write({ type: "capability_available", capability: "mcp:c/d" });
    // A file appended to out of order should not talk the next writer into
    // repeating a number it has already used.
    appendFileSync(
      path,
      '{"v":1,"runId":"r","seq":0,"ts":"2026-08-01T09:00:00.000Z","type":"capability_lost","capability":"mcp:a/b"}\n',
    );
    expect(resumeSeq(path)).toBe(2);
  });
});

describe("TraceWriter caps a capability_lost reason", () => {
  it("keeps the head and says how much was cut", () => {
    const path = tracePath();
    const reason = "x".repeat(MAX_LOG_LINE + 250);
    const written = new TraceWriter(path, "r").write({
      type: "capability_lost",
      capability: "mcp:a/b",
      reason,
    });

    const capped = written.type === "capability_lost" ? (written.reason ?? "") : "";
    expect(capped.startsWith("x".repeat(MAX_LOG_LINE))).toBe(true);
    expect(capped).toContain("(250 more chars)");
  });

  it("leaves a reason that fits exactly as it was", () => {
    const path = tracePath();
    const written = new TraceWriter(path, "r").write({
      type: "capability_lost",
      capability: "mcp:a/b",
      reason: "socket closed",
    });
    expect(written.type === "capability_lost" ? written.reason : "").toBe("socket closed");
  });
});
