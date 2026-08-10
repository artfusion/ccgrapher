// SPDX-License-Identifier: Apache-2.0
import { emptyRunState, reduceRun, type NodeRunState, type TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDuration,
  formatStartedAt,
  formatTokens,
  instanceRows,
  NOT_RECORDED,
  timingRows,
  usageIsEmpty,
  usageRows,
} from "../lib/run-detail";
import { placement, Position } from "../app/spec-node";

/**
 * The rule under test is one sentence: **absent is not zero**.
 *
 * Everything below is that sentence from a different angle, because it is the
 * rule most likely to be regressed by someone tidying a table — an unmeasured
 * cost rendered as `0` and a free node rendered as `0` are the same pixels and
 * opposite facts.
 *
 * There is no component-test infrastructure in this app and this change did not
 * invent one: what is worth pinning down is the formatting and the placement
 * arithmetic, and both are plain functions.
 */

describe("absent is not zero", () => {
  it("never prints an absent number as 0", () => {
    expect(formatDuration(undefined)).toBe(NOT_RECORDED);
    expect(formatTokens(undefined)).toBe(NOT_RECORDED);
    expect(formatCost(undefined)).toBe(NOT_RECORDED);
    expect(formatStartedAt(undefined)).toBe(NOT_RECORDED);
  });

  it("does print a measured zero as 0, which is a different fact", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatTokens(0)).toBe("0");
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("keeps every usage row even when the trace said nothing at all", () => {
    const rows = usageRows(undefined);
    expect(rows.map((r) => r.label)).toEqual(["model", "input tokens", "output tokens", "cost"]);
    expect(rows.every((r) => r.value === NOT_RECORDED)).toBe(true);
    expect(rows.every((r) => !r.recorded)).toBe(true);
    expect(usageIsEmpty(undefined)).toBe(true);
  });

  it("keeps the rows the trace left out alongside the ones it filled in", () => {
    // A writer that reports tokens but not cost is ordinary. The cost row has to
    // survive it, saying it was not measured, rather than vanish or read $0.00.
    const rows = usageRows({ model: "demo-cheap", inputTokens: 90, outputTokens: 30 });
    expect(rows.map((r) => [r.label, r.value, r.recorded])).toEqual([
      ["model", "demo-cheap", true],
      ["input tokens", "90", true],
      ["output tokens", "30", true],
      ["cost", NOT_RECORDED, false],
    ]);
    expect(usageIsEmpty({ model: "demo-cheap" })).toBe(false);
  });

  it("reports a cost too small to print as a bound, never as zero", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(0.0091)).toBe("$0.0091");
    expect(formatCost(1.25)).toBe("$1.25");
    // Two places would round this to $0.00 and call a real cost free.
    expect(formatCost(0.00002)).toBe("$0.000020");
    expect(formatCost(0.0000001)).toBe("< $0.000001");
  });
});

describe("timings", () => {
  it("scales the unit without inventing precision", () => {
    expect(formatDuration(21)).toBe("21 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(65_000)).toBe("1 m 5 s");
  });

  it("shows an unparseable timestamp verbatim rather than dropping it", () => {
    // `ts` is a plain string in the contract on purpose. A writer that sends
    // something this reader cannot parse is still telling us something.
    expect(formatStartedAt("whenever")).toBe("whenever");
    expect(formatStartedAt("2026-08-01T16:37:10.254Z")).not.toBe(NOT_RECORDED);
  });

  it("says so when a node failed before anything timed it", () => {
    // `node_failed` carries `durationMs` as optional, and live-demo has a node
    // that exercises it: count_lines is skipped, so it is never clocked.
    const run = fold({
      v: 1,
      runId: "r",
      seq: 0,
      ts: "2026-08-01T16:37:10.321Z",
      type: "node_failed",
      node: "count_lines",
      error: "skipped: no result from fetch_code",
    }).nodes.get("count_lines") as NodeRunState;

    const rows = timingRows(run);
    expect(rows.map((r) => r.label)).toEqual(["status", "started", "took"]);
    expect(rows[2]).toEqual({ label: "took", value: NOT_RECORDED, recorded: false });
    // It never started either, and that row stays too.
    expect(rows[1]!.recorded).toBe(false);
  });
});

describe("a fanned node", () => {
  it("accounts for every instance, including the ones still out", () => {
    const rows = instanceRows({ done: 2, failed: 1, of: 5 });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["done", "2"],
      ["failed", "1"],
      ["still out", "2"],
      ["fanned to", "5"],
    ]);
  });
});

describe("where the note goes", () => {
  // `box` is already in client (viewport) pixels here — paper.localToClientPoint
  // has folded in whatever pan/zoom was live, so placement() itself no longer
  // takes a separate tx/ty/zoom. Each case below is the same scenario the
  // React Flow version tested, expressed as a client box instead of a
  // model-space one pre-multiplied by a transform.
  const box = { x: 0, y: 0, w: 200, h: 60 };
  const view = { paneW: 1000, paneH: 800 };

  it("sits beside the node when there is room", () => {
    expect(placement(box, view).position).toBe(Position.Right);
  });

  it("flips to the other side rather than hang off the canvas edge", () => {
    // The node's right edge is 100px from the pane's; a 320px note does not fit.
    const nearRight = placement({ ...box, x: 700 }, view);
    expect(nearRight.position).toBe(Position.Left);
  });

  it("goes below when neither side fits", () => {
    const narrow = placement({ ...box, x: 100 }, { ...view, paneW: 420 });
    expect(narrow.position).toBe(Position.Bottom);
    expect(narrow.align).toBe("center");
  });

  it("hangs from the node's bottom edge when it would overflow downwards", () => {
    const low = placement({ ...box, y: 700 }, view);
    expect(low.align).toBe("end");
  });
});

function fold(...events: TraceEvent[]) {
  return events.reduce(reduceRun, emptyRunState("r"));
}
