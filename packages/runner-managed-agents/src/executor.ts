// SPDX-License-Identifier: Apache-2.0
import { modelIdOf } from "@ccgrapher/codegen";
import type { Graph } from "@ccgrapher/core";
import { messageOf, type NodeContext, type NodeExecutor, type NodeOutput } from "@ccgrapher/runner";
import type { ManagedAgentsClient, SendEvent, SessionCreateParams, SessionEvent, SessionSnapshot } from "./client.js";
import type { ResolvedIds } from "./lock.js";
import { inputMessage, nodeInput, readOutput } from "./protocol.js";

export interface ManagedAgentsOptions {
  readonly graph: Graph;
  /** Agent and environment ids, from `resolveIds` over the lock file. */
  readonly ids: ResolvedIds;
  readonly client: ManagedAgentsClient;
  /**
   * A hard cap on each session's list-price spend, in US cents, passed to
   * `sessions.create` as `budget`. One cap per session, not per run: a fanned
   * step of five copies may spend five times this.
   */
  readonly sessionBudgetCents?: number;
  /** Archive each session once its node is settled. Default true. Sessions are never deleted. */
  readonly archive?: boolean;
  /** After an interrupt, how long to wait for the session to go idle before giving up on it. Default 30 s. */
  readonly interruptGraceMs?: number;
  /** How many times a dropped event stream is reopened, with the history read to cover the gap. Default 3. */
  readonly reconnects?: number;
  /**
   * Where a line goes once the runner has stopped listening to a node: after a
   * timeout, the node's own `log` would write to a trace that has already
   * recorded the failure, and may have ended.
   */
  readonly detachedLog?: (line: string) => void;
  /** The pause between status polls after idle. Injectable so a test waits for nothing real. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ManagedAgents {
  /** One implementation per model node, keyed by node id: the shape a `ccg run --impl` module exports. */
  readonly impls: ReadonlyMap<string, NodeExecutor>;
  /**
   * Resolves once every session's clean-up has finished, including sessions
   * whose node the runner already gave up on after a timeout. Await it before
   * the process exits, or an interrupt or an archive can be cut off.
   */
  settled(): Promise<void>;
}

/** The documented post-idle race: poll up to ten times, 200 ms apart, before archiving. */
const STATUS_POLLS = 10;
const STATUS_POLL_MS = 200;

/** Documented as at most 8 keys on a session, values up to 512 characters. */
const METADATA_VALUE_MAX = 512;

const DENY_MESSAGE =
  "This session is driven unattended by ccg run, so a tool call that asks for confirmation is denied. " +
  "If this step needs the tool, allow it in the agent's permission policy.";

/** How a session's turn ended, before anyone has decided whether that is a success. */
interface Ending {
  /** `end_turn`, another idle `stop_reason`, or `terminated`. */
  readonly stop: string;
  /** The text of the last `agent.message`, which is where the output is read from. */
  readonly reply?: string;
  readonly interrupted: boolean;
  /** The last `session.error` seen, for the failure message. */
  readonly lastError?: string;
}

/**
 * Turns every model node of a spec into a node implementation that runs it as
 * one Claude Managed Agents session.
 *
 * Plain-code nodes and gates get nothing here: they keep the caller's own
 * implementations, and the runner still enforces order and `expects` for all of
 * them. Each call, for a step or for one copy of a fanned step:
 *
 * 1. creates a session for the node's agent and the workflow's environment,
 *    with the run id, spec and node in its metadata;
 * 2. opens the event stream, and only then sends the input envelope as the one
 *    `user.message`, so no early event is missed;
 * 3. reads events until the session is idle with a stop reason other than
 *    `requires_action`, or terminated, reopening a dropped stream with the
 *    history read and deduplicated by event id. A tool call that asks for
 *    confirmation is denied, since nobody is watching, and a custom tool call
 *    is answered with a note that there is no handler;
 * 4. polls the session until it no longer reports `running` (the documented
 *    post-idle race), reads its usage, and archives it, never deletes it;
 * 5. reads the output from the last reply, or fails the node saying why.
 *
 * On the runner's timeout the session gets a `user.interrupt`, is drained to
 * idle and archived, and the node fails. The runner does not wait for that
 * clean-up; `settled()` does.
 */
export function managedAgents(options: ManagedAgentsOptions): ManagedAgents {
  const { graph, ids, client } = options;
  const archive = options.archive ?? true;
  const grace = options.interruptGraceMs ?? 30_000;
  const reconnects = options.reconnects ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const detached = options.detachedLog ?? (() => undefined);
  const budget = options.sessionBudgetCents;
  if (budget !== undefined && !(Number.isInteger(budget) && budget >= 1)) {
    throw new RangeError(`sessionBudgetCents must be a whole number of cents, at least 1, not ${budget}`);
  }

  const pending = new Set<Promise<unknown>>();

  const run = async (context: NodeContext): Promise<NodeOutput> => {
    const { node } = context;
    const agent = ids.agents.get(node.id);
    if (agent === undefined) throw new Error(`${node.id}: claude-lock.json has no agent for this node`);
    if (context.signal.aborted) throw new Error(`${node.id}: ${messageOf(context.signal.reason)}; no session was created`);

    // Once the runner has given up on the node, its trace has recorded the
    // failure and may have ended, so later lines go out of band instead.
    const say = (line: string): void => {
      if (context.signal.aborted) detached(`${node.id}${copy(context)}: ${line}`);
      else context.log(line);
    };

    const params: SessionCreateParams = {
      agent,
      environment_id: ids.environment,
      title: `${graph.spec.name}/${node.id}${copy(context)}`,
      metadata: clip({
        ccg_run: context.runId,
        ccg_spec: graph.spec.name,
        ccg_node: node.id,
        ...(context.instance === undefined ? {} : { ccg_instance: `${context.instance}/${context.of}` }),
      }),
    };
    if (budget !== undefined) {
      params.budget = { type: "limit", max_list_cost: { amount: String(budget), currency: "USD" } };
    }

    const session = await client.beta.sessions.create(params);
    say(`managed-agents session ${session.id} (agent ${agent})`);

    let ending: Ending | undefined;
    let failure: unknown;
    try {
      ending = await drive(client, session.id, context, inputMessage(nodeInput(context, graph.spec.name)), {
        grace,
        reconnects,
        say,
      });
    } catch (error) {
      failure = error;
    }

    const snapshot = await cleanUp(client, session.id, { archive, sleep, say });

    if (failure !== undefined) throw new Error(`${node.id}: ${messageOf(failure)}`);
    if (ending!.interrupted) {
      throw new Error(`${node.id}: ${messageOf(context.signal.reason)}; the session was interrupted`);
    }
    if (ending!.stop !== "end_turn") throw new Error(`${node.id}: ${stopMessage(ending!, budget)}`);

    return { output: readOutput(node, ending!.reply), usage: usageOf(node.model, snapshot) };
  };

  const impls = new Map<string, NodeExecutor>();
  for (const id of ids.agents.keys()) {
    impls.set(id, (context) => {
      const work = run(context);
      pending.add(work);
      // Tracked, and kept from ever being an unhandled rejection: the runner
      // stops listening to a node that timed out, but its clean-up goes on.
      void work.catch(() => undefined).finally(() => pending.delete(work));
      return work;
    });
  }

  return {
    impls,
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/**
 * Stream-first: the stream is open before the message is sent, so the session's
 * first events cannot happen before anyone is listening.
 */
async function drive(
  client: ManagedAgentsClient,
  sessionId: string,
  context: NodeContext,
  message: string,
  how: { grace: number; reconnects: number; say: (line: string) => void },
): Promise<Ending> {
  const events = client.beta.sessions.events;
  const send = (event: SendEvent) => events.send(sessionId, { events: [event] });
  const seen = new Set<string>();
  let reply: string | undefined;
  let lastError: string | undefined;
  let interrupted = false;
  // Work only counts once it has started: an idle from before the message was
  // taken up is the session's state at creation, not the end of this turn.
  let started = false;

  // Rejects only if an interrupted session has not gone idle within the grace.
  let abandon!: (error: Error) => void;
  const abandoned = new Promise<never>((_, reject) => {
    abandon = reject;
  });
  abandoned.catch(() => undefined);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    if (interrupted) return;
    interrupted = true;
    how.say("timed out, so the session is being interrupted");
    void Promise.resolve(send({ type: "user.interrupt" })).catch((error: unknown) =>
      how.say(`the interrupt could not be sent: ${messageOf(error)}`),
    );
    graceTimer = setTimeout(() => abandon(new Abandoned(how.grace)), how.grace);
  };

  const handle = async (event: SessionEvent): Promise<Ending | undefined> => {
    const fresh = event.id === undefined || !seen.has(event.id);
    if (event.id !== undefined) seen.add(event.id);

    if (fresh) {
      const e = event as AnyEvent;
      switch (e.type) {
        case "session.status_running":
          started = true;
          break;
        case "user.message":
          if (e.processed_at) started = true;
          break;
        case "agent.message":
          reply = (e.content ?? [])
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("");
          break;
        case "agent.tool_use":
        case "agent.mcp_tool_use":
          if (e.evaluated_permission === "ask" && e.id) {
            how.say(`denied ${toolName(e)}: it asks for confirmation, and this run is unattended`);
            await send({ type: "user.tool_confirmation", tool_use_id: e.id, result: "deny", deny_message: DENY_MESSAGE });
          } else if (e.type === "agent.mcp_tool_use" && e.evaluated_permission === "allow" && !context.signal.aborted) {
            context.capability(`mcp:${e.mcp_server_name}/${e.name}`);
          }
          break;
        case "agent.custom_tool_use":
          if (e.id) {
            how.say(`custom tool ${e.name ?? "(unnamed)"} called, and ccg run has no handler for it`);
            await send({
              type: "user.custom_tool_result",
              custom_tool_use_id: e.id,
              content: [{ type: "text", text: `ccg run has no handler for the custom tool '${e.name ?? ""}'.` }],
            });
          }
          break;
        case "session.error":
          lastError = e.error?.message ?? e.error?.type ?? "unknown error";
          how.say(`session error: ${lastError}`);
          break;
      }
    }

    // Checked for every event, seen or not: a terminal event first met in the
    // history must still end the loop.
    if (event.type === "session.status_terminated") return { stop: "terminated", reply, interrupted, lastError };
    if (event.type === "session.status_idle" && (started || interrupted)) {
      const stop = (event as AnyEvent).stop_reason?.type ?? "unknown";
      if (stop !== "requires_action") return { stop, reply, interrupted, lastError };
    }
    return undefined;
  };

  /** Reads one connection until an ending, or `undefined` if it closed without one. */
  const consume = async (stream: AsyncIterable<SessionEvent>): Promise<Ending | undefined> => {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), abandoned]);
        if (next.done) return undefined;
        const ending = await handle(next.value);
        if (ending) return ending;
      }
    } finally {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  };

  try {
    let stream = await events.stream(sessionId);
    if (context.signal.aborted) {
      // Timed out before any work was asked for: nothing to interrupt.
      void Promise.resolve(stream[Symbol.asyncIterator]().return?.()).catch(() => undefined);
      return { stop: "not_started", interrupted: true };
    }
    await send({ type: "user.message", content: [{ type: "text", text: message }] });
    // Listened for only once the message is sent, so an interrupt can never
    // reach the session ahead of the work it is meant to stop.
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();

    for (let attempt = 0; ; attempt++) {
      let dropped: unknown;
      try {
        const ending = await consume(stream);
        if (ending) return ending;
        dropped = new Error("the event stream closed before the session finished its turn");
      } catch (error) {
        if (error instanceof Abandoned) throw error;
        dropped = error;
      }
      if (attempt >= how.reconnects) {
        throw new Error(`lost the event stream ${attempt + 1} time(s), last: ${messageOf(dropped)}`);
      }
      how.say(`event stream dropped (${messageOf(dropped)}); reconnecting and reading the history`);

      // The documented consolidation: open the new stream first, then read the
      // history to cover the gap, deduplicating by event id.
      stream = await events.stream(sessionId);
      for await (const event of events.list(sessionId)) {
        const ending = await handle(event);
        if (ending) return ending;
      }
    }
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

/**
 * The documented post-idle race: the stream reports idle slightly before the
 * session's status does, and archiving a session still marked running is
 * refused. So poll first, and leave a session that never settles unarchived
 * rather than fight it. Clean-up never fails a node; it only says what it did.
 */
async function cleanUp(
  client: ManagedAgentsClient,
  sessionId: string,
  how: { archive: boolean; sleep: (ms: number) => Promise<void>; say: (line: string) => void },
): Promise<SessionSnapshot | undefined> {
  let snapshot: SessionSnapshot | undefined;
  try {
    for (let poll = 0; poll < STATUS_POLLS; poll++) {
      snapshot = await client.beta.sessions.retrieve(sessionId);
      if (snapshot.status !== "running") break;
      await how.sleep(STATUS_POLL_MS);
    }
  } catch (error) {
    how.say(`could not read the session's status: ${messageOf(error)}`);
    return undefined;
  }
  if (!how.archive) return snapshot;
  if (snapshot?.status === "running") {
    how.say(`session ${sessionId} still reports running, so it was left unarchived`);
    return snapshot;
  }
  try {
    await client.beta.sessions.archive(sessionId);
    how.say(`session ${sessionId} archived`);
  } catch (error) {
    how.say(`session ${sessionId} could not be archived: ${messageOf(error)}`);
  }
  return snapshot;
}

/** An interrupted session that never went idle. Not a dropped stream, so never reconnected. */
class Abandoned extends Error {
  constructor(grace: number) {
    super(`the interrupted session did not go idle within ${grace}ms`);
  }
}

function stopMessage(ending: Ending, budget: number | undefined): string {
  const detail = ending.lastError ? ` (last error: ${ending.lastError})` : "";
  switch (ending.stop) {
    case "terminated":
      return `the session terminated before it finished its turn${detail}`;
    case "retries_exhausted":
      return `the session gave up after exhausting its retries${detail}`;
    case "budget_reached":
      return `the session reached its budget${budget === undefined ? "" : ` of ${budget} cents`} and paused before finishing`;
    default:
      return `the session stopped with '${ending.stop}' rather than finishing its turn${detail}`;
  }
}

/**
 * Usage as the session reports it once settled. Cost is the documented list
 * cost, which is the public price and can be more than a discounted bill.
 * Anything the session did not report stays absent rather than becoming zero.
 */
function usageOf(tier: string | null | undefined, snapshot: SessionSnapshot | undefined): NodeOutput["usage"] {
  const usage: NonNullable<NodeOutput["usage"]> = { model: modelIdOf(tier === "cheap" ? "cheap" : "strong") };
  const u = snapshot?.usage;
  if (!u) return usage;
  if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined) {
    usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  if (u.list_cost?.currency === "USD" && /^\d+$/.test(u.list_cost.amount)) {
    usage.costUsd = Number(u.list_cost.amount) / 100;
  }
  return usage;
}

const copy = (context: NodeContext) => (context.instance === undefined ? "" : `[${context.instance}]`);

function clip(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      value.length <= METADATA_VALUE_MAX ? value : value.slice(0, METADATA_VALUE_MAX),
    ]),
  );
}

const toolName = (e: AnyEvent) =>
  e.type === "agent.mcp_tool_use" ? `mcp:${e.mcp_server_name}/${e.name}` : (e.name ?? "a tool");

/** The fields of the events acted on, all optional so a surprise is never a crash. */
interface AnyEvent {
  readonly type: string;
  readonly id?: string;
  readonly processed_at?: string | null;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly name?: string;
  readonly mcp_server_name?: string;
  readonly evaluated_permission?: string;
  readonly error?: { readonly type?: string; readonly message?: string };
  readonly stop_reason?: { readonly type: string };
}
