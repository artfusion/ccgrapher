// SPDX-License-Identifier: Apache-2.0
import { buildGraph, rankGraph, WorkflowSpec, type Graph } from "@ccgrapher/core";
import { audit } from "@ccgrapher/lint";
import type { TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { ExpectsError, execute } from "../src/index.js";
import type { GateDecision, NodeContext, NodeExecutor } from "../src/index.js";

/**
 * Readiness scheduling, tested without a single real delay.
 *
 * Every slow step here waits on a promise the test resolves by hand, and every
 * "meanwhile" is `flush`, which lets all pending microtasks run and nothing
 * else. So each assertion about what started before what is a fact about the
 * scheduler, never about how busy the machine running the test happened to be.
 */

function graphOf(
  nodes: ReadonlyArray<Record<string, unknown>>,
  edges: ReadonlyArray<Record<string, unknown>> = [],
): Graph {
  return buildGraph(WorkflowSpec.parse({ version: 1, name: "fixture", nodes, edges }));
}

const worker = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: "worker",
  ...extra,
});

const edge = (from: string, to: string) => ({ from, to, carries: ["x"] });

const frozen = () => 1_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets every pending microtask run. No timer is involved, so nothing here can be early or late. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function lines(events: readonly TraceEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case "run_finished":
        return [`run_finished ${event.ok ? "ok" : "not-ok"}`];
      case "node_started":
        return [`started ${event.node}${event.instance === undefined ? "" : ` ${event.instance}`}`];
      case "node_finished":
        return [`finished ${event.node}${event.instance === undefined ? "" : ` ${event.instance}`}`];
      case "node_failed":
        return [`failed ${event.node}: ${event.error}`];
      case "gate_waiting":
        return [`waiting ${event.node}`];
      case "gate_resolved":
        return [`resolved ${event.node} ${event.decision}`];
      default:
        return [];
    }
  });
}

/** Steps listed in `held` wait until the test releases them; everything else succeeds at once. */
function heldExecutor(held: Record<string, Deferred<void>>, behaviours: Record<string, () => void> = {}): NodeExecutor {
  return async (context: NodeContext) => {
    behaviours[context.node.id]?.();
    await held[context.node.id]?.promise;
    return { output: `${context.node.id}-ok` };
  };
}

describe("a step starts when its inputs exist, not when its rank has finished", () => {
  // root fans out to one slow step and to a chain of three quick ones. As waves,
  // a2 and a3 would sit behind `slow`, because `slow` shares a rank with a1.
  const graph = graphOf(
    [worker("root"), worker("slow"), worker("a1"), worker("a2"), worker("a3")],
    [edge("root", "slow"), edge("root", "a1"), edge("a1", "a2"), edge("a2", "a3")],
  );

  it("runs the quick branch to its end while the slow one is still going", async () => {
    // The premise: the ranks would have made a2 wait for slow.
    const { rank } = rankGraph(graph);
    expect(rank.get("slow")).toBe(1);
    expect(rank.get("a2")).toBe(2);

    const slow = deferred();
    const reachedEnd = deferred();
    const events: TraceEvent[] = [];
    const run = execute(graph, heldExecutor({ slow }, { a3: () => reachedEnd.resolve() }), {
      runId: "r1",
      emit: (event) => events.push(event),
      now: frozen,
    });

    await reachedEnd.promise;
    // a3 is under way and slow has not finished: no barrier held the chain back.
    expect(lines(events)).toContain("started a3");
    expect(lines(events)).not.toContain("finished slow");

    slow.resolve();
    const result = await run;
    expect(lines(events)).toEqual([
      "started root",
      "finished root",
      "started slow",
      "started a1",
      "finished a1",
      "started a2",
      "finished a2",
      "started a3",
      "finished a3",
      "finished slow",
      "run_finished ok",
    ]);
    expect(result.ok).toBe(true);
  });

  it("writes a trace that `ccg trace audit` finds nothing wrong with", async () => {
    const slow = deferred();
    const events: TraceEvent[] = [];
    const run = execute(graph, heldExecutor({ slow }), {
      runId: "r1",
      emit: (event) => events.push(event),
      now: frozen,
    });
    await flush();
    slow.resolve();
    await run;

    // ORDER_VIOLATION in particular: starting early is only allowed for a step
    // whose declared predecessors have all finished.
    expect(audit(events, graph).findings).toEqual([]);
  });

  it("is reproducible: the same run twice gives the same trace", async () => {
    const twice = await Promise.all(
      [0, 1].map(async () => {
        const events: TraceEvent[] = [];
        await execute(graph, heldExecutor({}), { runId: "r1", emit: (e) => events.push(e), now: frozen });
        return events;
      }),
    );
    expect(twice[0]).toEqual(twice[1]);
  });
});

describe("a failure fails what depends on it, and nothing else", () => {
  const graph = graphOf(
    [worker("a"), worker("slow"), worker("after-a"), worker("after-after-a"), worker("after-slow")],
    [edge("a", "after-a"), edge("after-a", "after-after-a"), edge("slow", "after-slow")],
  );

  it("skips the descendants at once, while an unrelated branch carries on", async () => {
    const slow = deferred();
    const events: TraceEvent[] = [];
    const executor: NodeExecutor = async (context) => {
      if (context.node.id === "a") throw new Error("a broke");
      if (context.node.id === "slow") await slow.promise;
      return { output: context.node.id };
    };
    const run = execute(graph, executor, { runId: "r1", emit: (e) => events.push(e), now: frozen });

    await flush();
    // As waves, these skips would have waited for slow, which has nothing to do with them.
    expect(lines(events)).toEqual([
      "started a",
      "started slow",
      "failed a: a broke",
      "failed after-a: skipped: no result from a",
      "failed after-after-a: skipped: no result from after-a",
    ]);

    slow.resolve();
    const result = await run;
    expect(lines(events).slice(5)).toEqual([
      "finished slow",
      "started after-slow",
      "finished after-slow",
      "run_finished not-ok",
    ]);
    expect(result.nodes.get("after-slow")?.outcome).toBe("done");
    expect(result.nodes.get("after-after-a")?.outcome).toBe("skipped");
    expect(audit(events, graph).findings).toEqual([]);
  });

  it("starts nothing new once a guard stops the run, and lets running work finish", async () => {
    const guarded = graphOf(
      [
        worker("a"),
        worker("b"),
        worker("slow"),
        worker("join", { kind: "reduce", expects: 2 }),
        worker("after-slow"),
      ],
      [edge("a", "join"), edge("b", "join"), edge("slow", "after-slow")],
    );
    const slow = deferred();
    const events: TraceEvent[] = [];
    const executor: NodeExecutor = async (context) => {
      if (context.node.id === "a") throw new Error("a broke");
      if (context.node.id === "slow") await slow.promise;
      return { output: context.node.id };
    };
    const run = execute(guarded, executor, { runId: "r1", emit: (e) => events.push(e), now: frozen });
    const outcome = run.catch((error: unknown) => error);

    await flush();
    slow.resolve();
    expect(await outcome).toBeInstanceOf(ExpectsError);

    const emitted = lines(events);
    // slow was already running, so it is seen through and closed in the trace...
    expect(emitted.indexOf("finished slow")).toBeLessThan(emitted.indexOf("run_finished not-ok"));
    // ...but what would have followed it never starts.
    expect(emitted).not.toContain("started after-slow");
    expect(emitted).not.toContain("started join");
  });
});

describe("gates", () => {
  it("pause their own descendants and nothing else", async () => {
    const graph = graphOf(
      [
        worker("draft"),
        worker("review", { kind: "gate" }),
        worker("ship"),
        worker("other"),
        worker("other2"),
        worker("other3"),
      ],
      [edge("draft", "review"), edge("review", "ship"), edge("other", "other2"), edge("other2", "other3")],
    );
    const answer = deferred<GateDecision>();
    const events: TraceEvent[] = [];
    const run = execute(graph, heldExecutor({}), {
      runId: "r1",
      emit: (e) => events.push(e),
      now: frozen,
      gate: () => answer.promise,
    });

    await flush();
    expect(lines(events)).toContain("waiting review");
    // other3 shares a rank with ship. As waves it would have waited on the human too.
    expect(lines(events)).toContain("finished other3");
    expect(lines(events)).not.toContain("started ship");

    answer.resolve({ decision: "approve" });
    const result = await run;
    expect(lines(events).slice(-3)).toEqual(["started ship", "finished ship", "run_finished ok"]);
    expect(result.ok).toBe(true);
    expect(audit(events, graph).findings).toEqual([]);
  });
});

describe("the concurrency limit", () => {
  /** An executor that holds every step until the test lets it go, and keeps count of how many are in at once. */
  function counted() {
    const order: string[] = [];
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const executor: NodeExecutor = async (context) => {
      order.push(context.instance === undefined ? context.node.id : `${context.node.id} ${context.instance}`);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return { output: context.node.id };
    };
    /** Lets the oldest held step finish, then lets the scheduler react. */
    const next = async () => {
      waiting.shift()?.();
      await flush();
    };
    return { executor, order, next, most: () => most, held: () => waiting.length };
  }

  it("gives the next slot to the lower rank, then to spec order", async () => {
    // p and q are both roots; p2 needs p. With one slot, q (rank 0) goes before
    // p2 (rank 1) even though p2 became ready the moment p finished.
    const graph = graphOf([worker("p"), worker("q"), worker("p2")], [edge("p", "p2")]);
    const work = counted();
    const run = execute(graph, work.executor, { runId: "r1", emit: () => {}, now: frozen, concurrency: 1 });

    await flush();
    while (work.held() > 0) await work.next();
    await run;

    expect(work.order).toEqual(["p", "q", "p2"]);
    expect(work.most()).toBe(1);
  });

  it("counts each fanned instance as one step", async () => {
    const graph = graphOf([worker("fan", { fanOut: { over: "items", cap: 3 } }), worker("join")], [
      edge("fan", "join"),
    ]);
    const work = counted();
    const events: TraceEvent[] = [];
    const run = execute(graph, work.executor, {
      runId: "r1",
      emit: (e) => events.push(e),
      now: frozen,
      concurrency: 2,
    });

    await flush();
    expect(work.order).toEqual(["fan 0", "fan 1"]);
    while (work.held() > 0) await work.next();
    const result = await run;

    expect(work.order).toEqual(["fan 0", "fan 1", "fan 2", "join"]);
    expect(work.most()).toBe(2);
    expect(result.nodes.get("fan")?.results).toHaveLength(3);
    expect(audit(events, graph).findings).toEqual([]);
  });

  it("is refused when it could never start anything", async () => {
    const graph = graphOf([worker("only")]);
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      const events: TraceEvent[] = [];
      await expect(
        execute(graph, heldExecutor({}), { runId: "r1", emit: (e) => events.push(e), concurrency }),
      ).rejects.toBeInstanceOf(RangeError);
      // Refused before the run began, so there is no trace to leave unfinished.
      expect(events).toEqual([]);
    }
  });
});
