// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, parseSpec, WorkflowSpec, type Graph } from "@ccgrapher/core";
import { audit } from "@ccgrapher/lint";
import { ExpectsError, execute, type NodeContext, type NodeExecutor, type NodeOutput } from "@ccgrapher/runner";
import type { TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { managedAgents, PROTOCOL, resolveIds, type ManagedAgentsOptions, type ResolvedIds } from "../src/index.js";
import { hangsUntilInterrupted, MockClient, replies, type Behaviour, type MockSession } from "./mock-client.js";

/**
 * The executor against a client that never leaves the process. Nothing here
 * creates a real session: the SDK itself is unloadable in tests (see
 * tools/vitest-no-anthropic.ts), and every client is a `MockClient`.
 */

const example = fileURLToPath(new URL("../../../examples/research-desk.yaml", import.meta.url));
const researchDesk = (): Graph => buildGraph(parseSpec(readFileSync(example, "utf8"), example));

/** What `ant apply` would have written for the generated research-desk directory. */
const LOCK = {
  resources: {
    "./agents/plan/agent.md": { id: "agent_plan" },
    "./agents/research/agent.md": { id: "agent_research" },
    "./agents/skeptic-correct/agent.md": { id: "agent_skeptic_correct" },
    "./agents/skeptic-current/agent.md": { id: "agent_skeptic_current" },
    "./agents/skeptic-source/agent.md": { id: "agent_skeptic_source" },
    "./agents/report/agent.md": { id: "agent_report" },
    "./agents/research-desk/environment.yaml": { id: "env_desk" },
  },
};

const instant = () => Promise.resolve();

/** The two plain-code steps and nothing else: the parts a user's --impl module supplies. */
const local: Record<string, NodeExecutor> = {
  dedupe: async (context) => ({
    output: { finding: context.inputs.map((input) => input.output) },
  }),
  vote: async (context) => ({
    output: {
      survivor: { keep: context.inputs.filter((input) => (input.output as { vote: string }).vote === "keep").length },
    },
  }),
};

/** Each agent's ordinary answer, by agent id. */
function deskBehaviour(overrides: Record<string, Behaviour> = {}): (agent: string) => Behaviour {
  const json = (value: unknown) => () => JSON.stringify(value);
  const standard: Record<string, Behaviour> = {
    agent_plan: replies(json({ angle: ["cost", "speed", "risk", "law", "market"] })),
    agent_research: replies((session) => {
      const instance = session.input().instance as number;
      return "Here is what I found.\n\n```json\n" +
        JSON.stringify({ claim: `claim ${instance}`, source: `https://example.org/${instance}`, date: "2026-10-01" }) +
        "\n```";
    }),
    agent_skeptic_correct: replies(json({ vote: "keep", why: "checks out" })),
    agent_skeptic_current: replies(json({ vote: "keep", why: "recent" })),
    agent_skeptic_source: replies(json({ vote: "drop", why: "no such page" })),
    agent_report: replies(json({ report: "# Findings\n\nOne survivor." })),
  };
  return (agent) => overrides[agent] ?? standard[agent] ?? (() => undefined);
}

interface Run {
  readonly client: MockClient;
  readonly events: TraceEvent[];
  readonly result?: Awaited<ReturnType<typeof execute>>;
  readonly error?: unknown;
  readonly graph: Graph;
  readonly settled: () => Promise<void>;
}

async function runDesk(
  behaviour: (agent: string) => Behaviour,
  extra: Partial<ManagedAgentsOptions> & { timeoutMs?: number } = {},
): Promise<Run> {
  const graph = researchDesk();
  const client = new MockClient((params) => behaviour(params.agent));
  const managed = managedAgents({ graph, ids: resolveIds(graph, LOCK), client, sleep: instant, ...extra });
  const impls = new Map<string, NodeExecutor>([...managed.impls, ...Object.entries(local)]);
  const events: TraceEvent[] = [];
  try {
    const result = await execute(
      graph,
      (context) => impls.get(context.node.id)!(context),
      {
        runId: "desk-run",
        emit: (event) => events.push(event),
        gate: async () => ({ decision: "approve" }),
        timeoutMs: extra.timeoutMs,
      },
    );
    return { client, events, result, graph, settled: () => managed.settled() };
  } catch (error) {
    return { client, events, error, graph, settled: () => managed.settled() };
  }
}

/** Nodes the runner skipped for want of an input, in the order it said so. */
const skipped = (events: readonly TraceEvent[]) =>
  events
    .filter((event) => event.type === "node_failed" && event.error.startsWith("skipped:"))
    .map((event) => (event as { node: string }).node);

const byNode = (client: MockClient, node: string) =>
  client.sessions.filter((session) => session.params.metadata?.ccg_node === node);

describe("research-desk, one session per model node", () => {
  it("creates ten sessions, each for its node's agent and the workflow's environment", async () => {
    const { client, result } = await runDesk(deskBehaviour());
    expect(result?.ok).toBe(true);

    expect(client.sessions).toHaveLength(10);
    const agents = client.sessions.map((session) => session.params.agent).sort();
    expect(agents).toEqual(
      [
        "agent_plan",
        ...Array(5).fill("agent_research"),
        "agent_report",
        "agent_skeptic_correct",
        "agent_skeptic_current",
        "agent_skeptic_source",
      ].sort(),
    );
    for (const session of client.sessions) expect(session.params.environment_id).toBe("env_desk");
    // Plain code and the gate open no session.
    expect(byNode(client, "dedupe")).toEqual([]);
    expect(byNode(client, "vote")).toEqual([]);
    expect(byNode(client, "gate")).toEqual([]);
  });

  it("puts the run, the spec and the node in each session's metadata", async () => {
    const { client } = await runDesk(deskBehaviour());
    const [plan] = byNode(client, "plan");
    expect(plan!.params.metadata).toEqual({ ccg_run: "desk-run", ccg_spec: "research-desk", ccg_node: "plan" });
    expect(plan!.params.title).toBe("research-desk/plan");
    const copies = byNode(client, "research").map((session) => session.params.metadata?.ccg_instance).sort();
    expect(copies).toEqual(["0/5", "1/5", "2/5", "3/5", "4/5"]);
    for (const session of client.sessions) {
      expect(Object.keys(session.params.metadata ?? {}).length).toBeLessThanOrEqual(8);
    }
  });

  it("opens the stream before it sends the inputs, and sends them once", async () => {
    const { client } = await runDesk(deskBehaviour());
    for (const session of client.sessions) {
      const mine = client.calls.filter((call) => call.split(" ")[1] === session.id);
      expect(mine.slice(0, 3)).toEqual([`create ${session.id}`, `stream ${session.id}`, `send ${session.id} user.message`]);
      expect(session.sent.filter((event) => event.type === "user.message")).toHaveLength(1);
    }
  });

  it("sends each node its inputs in the documented envelope", async () => {
    const { client } = await runDesk(deskBehaviour());
    const [plan] = byNode(client, "plan");
    expect(plan!.input()).toEqual({ protocol: PROTOCOL, run: "desk-run", spec: "research-desk", node: "plan", args: {}, inputs: [] });

    const second = byNode(client, "research").find((session) => session.params.metadata?.ccg_instance === "2/5")!;
    const input = second.input();
    expect(input).toMatchObject({ node: "research", instance: 2, of: 5 });
    expect(input.inputs).toEqual([
      { from: "plan", fields: ["angle"], output: { angle: ["cost", "speed", "risk", "law", "market"] } },
    ]);

    const [report] = byNode(client, "report");
    expect(report!.input().inputs).toEqual([{ from: "vote", fields: ["survivor"], output: { survivor: { keep: 2 } } }]);
  });

  it("reads each node's output from its last reply, fenced or bare", async () => {
    const { events } = await runDesk(deskBehaviour());
    const finished = (node: string) =>
      events.filter((event) => event.type === "node_finished" && event.node === node) as Array<
        Extract<TraceEvent, { type: "node_finished" }>
      >;
    expect(finished("plan")[0]!.output).toEqual({ angle: ["cost", "speed", "risk", "law", "market"] });
    expect(finished("research").map((event) => (event.output as { claim: string }).claim).sort()).toEqual([
      "claim 0",
      "claim 1",
      "claim 2",
      "claim 3",
      "claim 4",
    ]);
    expect(finished("report")[0]!.output).toEqual({ report: "# Findings\n\nOne survivor." });
  });

  it("records each session's usage, at list price, and names the session in the trace", async () => {
    const { events } = await runDesk(deskBehaviour());
    const report = events.find((event) => event.type === "node_finished" && event.node === "report") as Extract<
      TraceEvent,
      { type: "node_finished" }
    >;
    expect(report.usage).toEqual({ model: "claude-opus-5-5", inputTokens: 105, outputTokens: 20, costUsd: 0.12 });
    const research = events.find((event) => event.type === "node_finished" && event.node === "research") as Extract<
      TraceEvent,
      { type: "node_finished" }
    >;
    expect(research.usage?.model).toBe("claude-haiku-5-5");
    const logs = events.filter((event) => event.type === "node_log").map((event) => (event as { line: string }).line);
    expect(logs.filter((line) => /^managed-agents session sesn_\d+ \(agent agent_/.test(line))).toHaveLength(10);
  });

  it("archives every session and deletes none", async () => {
    const { client } = await runDesk(deskBehaviour());
    expect(client.sessions.every((session) => session.archived)).toBe(true);
    expect(client.calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("writes a trace `ccg trace audit` finds nothing wrong with", async () => {
    const { events, graph } = await runDesk(deskBehaviour());
    expect(audit(events, graph).findings).toEqual([]);
  });
});

describe("a reply the runner cannot read", () => {
  it("fails the node with a message saying why, and skips everything after it", async () => {
    const { client, events, error } = await runDesk(
      deskBehaviour({ agent_plan: replies(() => "Sure, the angles are cost and speed.") }),
    );
    const failed = events.find((event) => event.type === "node_failed" && event.node === "plan") as { error: string };
    expect(failed.error).toMatch(/^plan: the reply is not a JSON object/);
    expect(failed.error).toContain("'angle'");
    expect(skipped(events)).toEqual(["research"]);
    // dedupe's `expects: 5` then meets nothing at all, which stops the run.
    expect(error).toBeInstanceOf(ExpectsError);
    // The only session ever opened: nothing downstream asked for one.
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]!.archived).toBe(true);
  });

  it("names a declared field the object is missing", async () => {
    const { events } = await runDesk(deskBehaviour({ agent_plan: replies(() => JSON.stringify({ angles: [] })) }));
    const failed = events.find((event) => event.type === "node_failed" && event.node === "plan") as { error: string };
    expect(failed.error).toBe("plan: the reply's JSON object is missing the declared output field(s) 'angle'");
  });

  it("fails a turn that ends with no reply at all", async () => {
    const silent: Behaviour = (session, sent) => {
      if (sent.type === "user.message") {
        session.later({ type: "session.status_running" }, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
      }
    };
    const { events } = await runDesk(deskBehaviour({ agent_plan: silent }));
    const failed = events.find((event) => event.type === "node_failed" && event.node === "plan") as { error: string };
    expect(failed.error).toMatch(/finished its turn without a reply/);
  });
});

describe("a failed node, under the readiness scheduler", () => {
  it("lets independent branches finish, and a short fan-in guard stops the run", async () => {
    const { client, events, error } = await runDesk(
      deskBehaviour({ agent_skeptic_current: replies(() => "I could not decide.") }),
    );
    // vote expects 3 votes and got 2: the runner's guard, not this package, stops the run.
    expect(error).toBeInstanceOf(ExpectsError);
    const finished = events
      .filter((event) => event.type === "node_finished")
      .map((event) => (event as { node: string }).node);
    expect(finished).toContain("skeptic_correct");
    expect(finished).toContain("skeptic_source");
    expect(byNode(client, "report")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", ok: false });
  });
});

describe("the runner's timeout", () => {
  it("interrupts the session, fails the node, and archives the session once it is idle", async () => {
    const { client, events, settled } = await runDesk(deskBehaviour({ agent_plan: hangsUntilInterrupted }), {
      timeoutMs: 30,
    });
    const failed = events.find((event) => event.type === "node_failed" && event.node === "plan") as { error: string };
    expect(failed.error).toBe("plan: timed out after 30ms");
    expect(skipped(events)).toEqual(["research"]);

    await settled();
    const [plan] = client.sessions;
    expect(plan!.sent.map((event) => event.type)).toEqual(["user.message", "user.interrupt"]);
    expect(plan!.archived).toBe(true);
    // Nothing is written against the node once the runner has recorded its failure.
    const after = events.slice(events.indexOf(failed as TraceEvent) + 1);
    expect(after.filter((event) => event.type === "node_log" && event.node === "plan")).toEqual([]);
  });

  it("gives up on a session that never goes idle, and leaves it unarchived rather than fight it", async () => {
    const deaf: Behaviour = (session, sent) => {
      if (sent.type === "user.message") session.later({ type: "session.status_running" });
    };
    const lines: string[] = [];
    const { client, settled } = await runDesk(deskBehaviour({ agent_plan: deaf }), {
      timeoutMs: 20,
      interruptGraceMs: 20,
      detachedLog: (line) => lines.push(line),
    });
    await settled();
    const [plan] = client.sessions;
    expect(plan!.archived).toBe(false);
    expect(lines).toContain("plan: session sesn_1 still reports running, so it was left unarchived");
  });
});

/** One model node and nothing else, for the session-level details. */
function single(behaviour: Behaviour, extra: Partial<ManagedAgentsOptions> = {}) {
  const graph = buildGraph(
    WorkflowSpec.parse({
      version: 1,
      name: "solo",
      nodes: [{ id: "write", label: "write", kind: "worker", model: "cheap", out: { text: "string" } }],
      edges: [],
    }),
  );
  const ids: ResolvedIds = { agents: new Map([["write", "agent_write"]]), environment: "env_solo" };
  const client = new MockClient(() => behaviour);
  const managed = managedAgents({ graph, ids, client, sleep: instant, ...extra });
  const logs: string[] = [];
  const capabilities: string[] = [];
  const controller = new AbortController();
  const context: NodeContext = {
    runId: "solo-run",
    node: graph.nodes.get("write")!,
    inputs: [],
    args: { topic: "tides" },
    worktree: false,
    signal: controller.signal,
    log: (line) => logs.push(line),
    capability: (id) => capabilities.push(id),
  };
  const call = (): Promise<NodeOutput> => managed.impls.get("write")!(context) as Promise<NodeOutput>;
  return { client, call, logs, capabilities, controller };
}

describe("a session's turn", () => {
  it("polls past the post-idle race before archiving", async () => {
    const solo = single(replies(() => JSON.stringify({ text: "ok" })));
    const done = solo.call();
    // Two polls still say running after idle; archiving then would be refused.
    await new Promise((resolve) => setImmediate(resolve));
    solo.client.sessions[0]!.runningPolls = 2;
    await done;
    const session = solo.client.sessions[0]!;
    expect(session.retrieves).toBe(3);
    expect(session.archived).toBe(true);
  });

  it("can leave sessions unarchived when asked", async () => {
    const solo = single(replies(() => JSON.stringify({ text: "ok" })), { archive: false });
    await solo.call();
    expect(solo.client.sessions[0]!.archived).toBe(false);
  });

  it("passes a per-session budget through, in cents", async () => {
    const solo = single(replies(() => JSON.stringify({ text: "ok" })), { sessionBudgetCents: 250 });
    await solo.call();
    expect(solo.client.sessions[0]!.params.budget).toEqual({
      type: "limit",
      max_list_cost: { amount: "250", currency: "USD" },
    });
  });

  it("refuses a budget that is not a whole number of cents", () => {
    expect(() => single(replies(() => "{}"), { sessionBudgetCents: 0.5 })).toThrow(RangeError);
  });

  it("fails the node when the budget is reached", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later({ type: "session.status_running" }, { type: "session.status_idle", stop_reason: { type: "budget_reached" } });
      }
    }, { sessionBudgetCents: 100 });
    await expect(solo.call()).rejects.toThrow("write: the session reached its budget of 100 cents and paused before finishing");
    expect(solo.client.sessions[0]!.archived).toBe(true);
  });

  it("denies a tool call that asks for confirmation, and keeps going", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later(
          { type: "session.status_running" },
          { type: "agent.mcp_tool_use", id: "sevt_ask", name: "search", mcp_server_name: "docs", evaluated_permission: "ask" },
          { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["sevt_ask"] } },
        );
      }
      if (sent.type === "user.tool_confirmation") {
        session.later(
          { type: "session.status_running" },
          { type: "agent.message", content: [{ type: "text", text: JSON.stringify({ text: "without the tool" }) }] },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        );
      }
    });
    const out = await solo.call();
    expect(out.output).toEqual({ text: "without the tool" });
    const confirmation = solo.client.sessions[0]!.sent.find((event) => event.type === "user.tool_confirmation");
    expect(confirmation).toMatchObject({ tool_use_id: "sevt_ask", result: "deny" });
    expect(solo.logs).toContain("denied mcp:docs/search: it asks for confirmation, and this run is unattended");
  });

  it("records an MCP tool the platform allowed as a capability the node invoked", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later(
          { type: "session.status_running" },
          { type: "agent.mcp_tool_use", name: "fetch", mcp_server_name: "docs", evaluated_permission: "allow" },
          { type: "agent.message", content: [{ type: "text", text: JSON.stringify({ text: "fetched" }) }] },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        );
      }
    });
    await solo.call();
    expect(solo.capabilities).toEqual(["mcp:docs/fetch"]);
  });

  it("answers a custom tool call it has no handler for", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later(
          { type: "session.status_running" },
          { type: "agent.custom_tool_use", id: "sevt_tool", name: "dedupe", input: {} },
          { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["sevt_tool"] } },
        );
      }
      if (sent.type === "user.custom_tool_result") {
        session.later(
          { type: "agent.message", content: [{ type: "text", text: JSON.stringify({ text: "done by hand" }) }] },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        );
      }
    });
    await expect(solo.call()).resolves.toMatchObject({ output: { text: "done by hand" } });
    expect(solo.client.sessions[0]!.sent.map((event) => event.type)).toEqual(["user.message", "user.custom_tool_result"]);
  });

  it("ignores an idle from before the turn started", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later(
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
          { type: "session.status_running" },
          { type: "agent.message", content: [{ type: "text", text: JSON.stringify({ text: "the real answer" }) }] },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        );
      }
    });
    await expect(solo.call()).resolves.toMatchObject({ output: { text: "the real answer" } });
  });

  it("fails on a terminated session, with the last error it reported", async () => {
    const solo = single((session, sent) => {
      if (sent.type === "user.message") {
        session.later(
          { type: "session.status_running" },
          { type: "session.error", error: { type: "billing_error", message: "credit balance too low" } },
          { type: "session.status_terminated" },
        );
      }
    });
    await expect(solo.call()).rejects.toThrow(
      "write: the session terminated before it finished its turn (last error: credit balance too low)",
    );
  });

  it("reconnects a dropped stream, reads the history, and handles nothing twice", async () => {
    let session!: MockSession;
    const solo = single((s, sent) => {
      session = s;
      if (sent.type !== "user.message") return;
      setImmediate(() => {
        s.emit({ type: "session.status_running" });
        s.emit({ type: "agent.mcp_tool_use", id: "sevt_once", name: "fetch", mcp_server_name: "docs", evaluated_permission: "allow" });
        // The connection drops; the rest happens while nobody is listening.
        s.feeds[0]!.fail(new Error("socket hang up"));
        s.emit({ type: "agent.message", content: [{ type: "text", text: JSON.stringify({ text: "while away" }) }] });
        s.emit({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
      });
    });
    await expect(solo.call()).resolves.toMatchObject({ output: { text: "while away" } });
    expect(solo.client.calls.filter((call) => call.startsWith("stream"))).toHaveLength(2);
    expect(solo.client.calls).toContain(`list ${session.id}`);
    expect(solo.capabilities).toEqual(["mcp:docs/fetch"]);
    expect(solo.logs.some((line) => line.startsWith("event stream dropped (socket hang up)"))).toBe(true);
  });

  it("creates no session for a node whose time is already up", async () => {
    const solo = single(replies(() => "{}"));
    solo.controller.abort(new Error("write: timed out after 1ms"));
    await expect(solo.call()).rejects.toThrow("no session was created");
    expect(solo.client.sessions).toEqual([]);
  });
});
