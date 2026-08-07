// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { heatFromRunStats, parseTraceLine, statsFromLines, type RunStats } from "../src/index.js";
import { readTrace } from "../src/node.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const load = (file: string) => readTrace(`${fixtures}${file}`);

describe("statsFromLines", () => {
  it("rolls up a single-shot node from its one recorded sample", () => {
    const stats = statsFromLines(load("happy-path.jsonl"));
    expect(stats.runIds).toEqual(["run-happy"]);
    expect(stats.nodes.plan).toEqual({ count: 1, meanMs: 1200, medianMs: 1200, costUsd: 0.0021 });
    // research reported a duration but no usage at all.
    expect(stats.nodes.research).toEqual({ count: 1, meanMs: 2880, medianMs: 2880 });
    // write reported usage, but no cost within it — costUsd stays absent, not 0.
    expect(stats.nodes.write).toEqual({
      count: 1,
      meanMs: 1290,
      medianMs: 1290,
    });
    expect(stats.nodes.write).not.toHaveProperty("costUsd");
  });

  it("sorts models by their reported usage, leaving cost absent where none was reported", () => {
    const stats = statsFromLines(load("happy-path.jsonl"));
    expect(stats.models["claude-haiku-4"]).toEqual({
      count: 1,
      meanMs: 1200,
      medianMs: 1200,
      costUsd: 0.0021,
    });
    expect(stats.models["claude-sonnet-4"]).toEqual({ count: 1, meanMs: 1290, medianMs: 1290 });
  });

  it("pools a fanned node's instances, summing only the costs that were reported", () => {
    const stats = statsFromLines(load("fan-out.jsonl"));
    // instance 0: 3000ms/$0.0011, instance 1: 2000ms/$0.0009, instance 2: failed at 3500ms, no usage.
    expect(stats.nodes.worker).toEqual({
      count: 3,
      meanMs: (3000 + 2000 + 3500) / 3,
      medianMs: 3000,
      costUsd: 0.002,
    });
    // The failed instance never reported a model, so only 2 of the 3 durations land here.
    expect(stats.nodes.split).toEqual({ count: 1, meanMs: 500, medianMs: 500 });
    expect(stats.models["claude-haiku-4"]).toEqual({
      count: 2,
      meanMs: 2500,
      medianMs: 2500,
      costUsd: 0.002,
    });
    // An event type this reader has never heard of (node_retried) is silently skipped, not a throw.
  });

  it("keeps a failed node's duration but never invents its cost", () => {
    const stats = statsFromLines(load("failed-node.jsonl"));
    expect(stats.nodes.audit).toEqual({ count: 1, meanMs: 1690, medianMs: 1690 });
    expect(stats.nodes.build).toEqual({ count: 1, meanMs: 12490, medianMs: 12490 });
  });

  it("leaves a node with no recorded duration out of the aggregate entirely", () => {
    // "report" only ever gets a node_started before the run ends; "approval" is
    // a gate, never a node_finished/node_failed. Neither belongs in `nodes`.
    const failed = statsFromLines(load("failed-node.jsonl"));
    expect(failed.nodes).not.toHaveProperty("report");
    const gate = statsFromLines(load("gate.jsonl"));
    expect(gate.nodes).not.toHaveProperty("approval");
  });

  it("pools several runs by concatenation, rather than averaging their medians", () => {
    const pooled = statsFromLines([...load("happy-path.jsonl"), ...load("gate.jsonl")]);
    expect([...pooled.runIds].sort()).toEqual(["run-gate", "run-happy"]);
    // Nodes from both runs are present side by side.
    expect(pooled.nodes.plan).toBeDefined();
    expect(pooled.nodes.draft).toBeDefined();
    expect(pooled.nodes.approval).toBeUndefined();
  });

  it("returns an empty roll-up for no lines, never a zeroed one", () => {
    const stats = statsFromLines([]);
    expect(stats).toEqual<RunStats>({ runIds: [], nodes: {}, models: {} });
  });
});

describe("heatFromRunStats", () => {
  it("tints every node with a duration under duration-ms", () => {
    const stats = statsFromLines(load("happy-path.jsonl"));
    const heat = heatFromRunStats(stats, "duration-ms", "ccg trace stats happy-path.jsonl");
    expect(heat).toEqual({
      v: 1,
      metric: "duration-ms",
      unit: "ms",
      source: "ccg trace stats happy-path.jsonl",
      values: { plan: 1200, research: 2880, write: 1290 },
    });
  });

  it("under cost-usd, only tints the nodes that actually reported a cost", () => {
    const stats = statsFromLines(load("happy-path.jsonl"));
    const heat = heatFromRunStats(stats, "cost-usd", "ccg trace stats happy-path.jsonl");
    expect(heat.metric).toBe("cost-usd");
    expect(heat.unit).toBe("usd");
    // research and write never reported a cost; a heatmap must never draw them
    // as if they cost $0.
    expect(heat.values).toEqual({ plan: 0.0021 });
  });
});

/**
 * Capability events carry a `node`, so a structural reader picks them up — but
 * they carry no duration and no usage, and a run that reports which tools it
 * touched must not thereby change what the run is said to have cost or taken.
 */
describe("capability events do not disturb the numbers", () => {
  it("produces byte-identical stats with and without them", () => {
    const plain = load("happy-path.jsonl");
    const withCapabilities = [
      ...plain,
      parseTraceLine(
        '{"v":1,"runId":"run-happy","seq":900,"ts":"2026-08-01T09:00:00.900Z","type":"capability_available","capability":"mcp:search/query"}',
      ),
      parseTraceLine(
        '{"v":1,"runId":"run-happy","seq":901,"ts":"2026-08-01T09:00:00.901Z","type":"capability_invoked","capability":"mcp:search/query","node":"plan"}',
      ),
    ];

    expect(JSON.stringify(statsFromLines(withCapabilities))).toBe(
      JSON.stringify(statsFromLines(plain)),
    );
  });
});
