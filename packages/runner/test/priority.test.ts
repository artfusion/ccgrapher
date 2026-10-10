// SPDX-License-Identifier: Apache-2.0
import { buildGraph, WorkflowSpec, type Graph } from "@ccgrapher/core";
import { audit } from "@ccgrapher/lint";
import type { TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { execute } from "../src/index.js";
import type { ExecuteOptions, NodeContext, NodeExecutor } from "../src/index.js";

/**
 * Urgency, tested the way readiness is: no real delay anywhere. A slow step
 * waits on a promise the test releases by hand, so what started before what is
 * a fact about the scheduler and not about the machine.
 */

function graphOf(
  nodes: ReadonlyArray<Record<string, unknown>>,
  edges: ReadonlyArray<Record<string, unknown>> = [],
): Graph {
  return buildGraph(WorkflowSpec.parse({ version: 1, name: "fixture", nodes, edges }));
}

const worker = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, kind: "worker", ...extra });
const edge = (from: string, to: string) => ({ from, to, carries: ["x"] });
const frozen = () => 1_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const starts = (events: readonly TraceEvent[]) =>
  events.flatMap((e) => (e.type === "node_started" ? [e.node] : []));

const quick: NodeExecutor = async (context: NodeContext) => ({ output: `${context.node.id}-ok` });

async function run(graph: Graph, options: Partial<ExecuteOptions> = {}, executor = quick): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  await execute(graph, executor, { runId: "r1", emit: (e) => events.push(e), now: frozen, ...options });
  return events;
}

/**
 * One slot. After `root`, three steps are ready at once: `docs` and `tests`,
 * which come first in the spec, and `prep`, which the urgent `fix` waits on.
 */
const queue = (fix: Record<string, unknown> = {}) =>
  graphOf(
    [worker("root"), worker("docs"), worker("tests"), worker("prep"), worker("fix", fix)],
    [edge("root", "docs"), edge("root", "tests"), edge("root", "prep"), edge("prep", "fix")],
  );

describe("an urgent step and what it waits on go ahead of the queue", () => {
  it("starts the urgent step's unstarted ancestor before earlier-queued unrelated work", async () => {
    // The premise: without urgency the spec order decides, and fix comes last.
    expect(starts(await run(queue(), { concurrency: 1 }))).toEqual(["root", "docs", "tests", "prep", "fix"]);

    const events = await run(queue({ priority: "urgent", prioritySetBy: "on-call" }), { concurrency: 1 });
    expect(starts(events)).toEqual(["root", "prep", "fix", "docs", "tests"]);
    // Still in dependency order: urgency moved fix up the queue, not past prep.
    expect(audit(events, queue({ priority: "urgent" })).findings).toEqual([]);
  });

  it("records why a step moved on the start it moved", async () => {
    const events = await run(queue({ priority: "urgent", prioritySetBy: "on-call" }), { concurrency: 1 });
    const started = (id: string) => events.find((e) => e.type === "node_started" && e.node === id);
    expect(started("fix")).toMatchObject({ priority: "urgent", prioritySetBy: "on-call" });
    expect(started("fix")).not.toHaveProperty("inheritedFrom");
    expect(started("prep")).toMatchObject({ priority: "urgent", inheritedFrom: "fix", prioritySetBy: "on-call" });
    // root is upstream of fix too, so it carries the priority, though it was first anyway.
    expect(started("root")).toMatchObject({ priority: "urgent", inheritedFrom: "fix" });
    expect(started("docs")).not.toHaveProperty("priority");
  });

  it("puts urgent ahead of high, and high ahead of normal", async () => {
    const graph = graphOf(
      [worker("a"), worker("b", { priority: "high" }), worker("c", { priority: "urgent" }), worker("d")],
    );
    expect(starts(await run(graph, { concurrency: 1 }))).toEqual(["c", "b", "a", "d"]);
  });

  it("holds nothing back without a limit: everything ready still starts at once", async () => {
    // Every step after root is held, so each start below happened before any of them finished.
    const held = { docs: deferred(), tests: deferred(), prep: deferred() };
    const events: TraceEvent[] = [];
    const running = execute(
      queue({ priority: "urgent" }),
      async (context) => {
        await held[context.node.id as keyof typeof held]?.promise;
        return { output: "ok" };
      },
      { runId: "r1", emit: (e) => events.push(e), now: frozen },
    );
    await flush();
    // All three are running together. Urgency only decides the order they are written in.
    expect(starts(events)).toEqual(["root", "prep", "docs", "tests"]);
    for (const each of Object.values(held)) each.resolve();
    await running;
    expect(starts(events)).toEqual(["root", "prep", "docs", "tests", "fix"]);
  });

  it("never interrupts a running step to make room", async () => {
    // One slot, held by `long`. The gate takes no slot; once it is approved the
    // urgent `fix` is ready, and must wait for `long` to finish of its own accord.
    const graph = graphOf(
      [worker("long"), { id: "approve", label: "approve", kind: "gate" }, worker("fix", { priority: "urgent" })],
      [edge("approve", "fix")],
    );
    const long = deferred();
    const answer = deferred();
    let signal: AbortSignal | undefined;
    const events: TraceEvent[] = [];
    const running = execute(
      graph,
      async (context) => {
        if (context.node.id === "long") {
          signal = context.signal;
          await long.promise;
        }
        return { output: "ok" };
      },
      {
        runId: "r1",
        emit: (e) => events.push(e),
        now: frozen,
        concurrency: 1,
        gate: async () => {
          await answer.promise;
          return { decision: "approve" };
        },
      },
    );

    await flush();
    answer.resolve();
    await flush();
    // fix is ready and urgent, and still waiting: long was not stopped for it.
    expect(events.some((e) => e.type === "gate_resolved")).toBe(true);
    expect(starts(events)).toEqual(["long"]);
    expect(signal?.aborted).toBe(false);

    long.resolve();
    const result = await running;
    expect(result.ok).toBe(true);
    expect(starts(events)).toEqual(["long", "fix"]);
    expect(result.nodes.get("long")?.outcome).toBe("done");
  });
});

describe("no priority is the run it always was", () => {
  it("writes a trace with no trace of priority in it", async () => {
    const events = await run(queue(), { concurrency: 1 });
    expect(events.map((e) => JSON.stringify(e)).join("\n")).not.toMatch(/priority|inheritedFrom/i);
  });

  it("treats `normal`, and a setter with nothing raised, exactly as absent, byte for byte", async () => {
    const absent = await run(queue(), { concurrency: 2 });
    const normal = await run(
      graphOf(
        [
          worker("root", { priority: "normal" }),
          worker("docs"),
          worker("tests", { prioritySetBy: "release manager" }),
          worker("prep"),
          worker("fix", { priority: "normal", prioritySetBy: "on-call" }),
        ],
        [edge("root", "docs"), edge("root", "tests"), edge("root", "prep"), edge("prep", "fix")],
      ),
      { concurrency: 2 },
    );
    expect(normal.map((e) => JSON.stringify(e))).toEqual(absent.map((e) => JSON.stringify(e)));
  });
});
