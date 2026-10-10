// SPDX-License-Identifier: Apache-2.0
import type {
  ManagedAgentsClient,
  SendEvent,
  SessionCreateParams,
  SessionEvent,
  SessionSnapshot,
} from "../src/index.js";

/**
 * A Managed Agents client that never leaves the process.
 *
 * Each session is a little state machine driven by a `Behaviour`: when the
 * runner sends an event, the behaviour decides what the session emits. Events
 * are delivered on a later macrotask, the way a real stream delivers them after
 * the request that caused them, and every one is kept as history so a
 * reconnecting reader can list it.
 */

export type Behaviour = (session: MockSession, sent: SendEvent) => void;

export class Feed implements AsyncIterable<SessionEvent> {
  private readonly buffer: SessionEvent[] = [];
  private readonly waiting: Array<{ resolve: (r: IteratorResult<SessionEvent>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;
  private failure: Error | undefined;
  closedByReader = false;

  push(event: SessionEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.buffer.push(event);
  }

  /** The connection drops: the reader's next read rejects. */
  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
      },
      return: () => {
        this.closedByReader = true;
        this.ended = true;
        for (const waiter of this.waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class MockSession {
  readonly sent: SendEvent[] = [];
  readonly history: SessionEvent[] = [];
  readonly feeds: Feed[] = [];
  status = "idle";
  archived = false;
  /** How many `retrieve` calls still report `running` after the turn ended: the post-idle race. */
  runningPolls = 0;
  retrieves = 0;
  usage: SessionSnapshot["usage"] = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5,
    list_cost: { amount: "12", currency: "USD" },
  };
  private counter = 0;

  constructor(
    readonly id: string,
    readonly params: SessionCreateParams,
    readonly behaviour: Behaviour,
  ) {}

  /** Emits an event to every open stream and to the history, with a fresh id unless it has one. */
  emit(event: Record<string, unknown> & { type: string }): void {
    const full = { id: `sevt_${this.id}_${++this.counter}`, processed_at: "2026-10-10T00:00:00Z", ...event };
    if (full.type === "session.status_running") this.status = "running";
    if (full.type === "session.status_idle") {
      this.status = "idle";
    }
    if (full.type === "session.status_terminated") this.status = "terminated";
    this.history.push(full);
    for (const feed of this.feeds) feed.push(full);
  }

  /** Emits on a later macrotask, as a real stream would. */
  later(...events: Array<Record<string, unknown> & { type: string }>): void {
    setImmediate(() => {
      for (const event of events) this.emit(event);
    });
  }

  /** The envelope the runner sent as the first message. */
  input(): Record<string, unknown> & { node: string; inputs: Array<{ from: string; output: unknown }> } {
    const message = this.sent.find((e) => e.type === "user.message");
    if (!message || message.type !== "user.message") throw new Error("no user.message was sent");
    const text = message.content[0]!.text;
    const json = /```json\n([\s\S]*?)```/.exec(text)?.[1];
    return JSON.parse(json!) as ReturnType<MockSession["input"]>;
  }
}

export class MockClient implements ManagedAgentsClient {
  readonly sessions: MockSession[] = [];
  /** Every call, in order, so a test can assert stream-first. */
  readonly calls: string[] = [];
  private created = 0;

  constructor(private readonly behaviourFor: (params: SessionCreateParams) => Behaviour) {}

  readonly beta = {
    sessions: {
      create: async (params: SessionCreateParams) => {
        const session = new MockSession(`sesn_${++this.created}`, params, this.behaviourFor(params));
        this.sessions.push(session);
        this.calls.push(`create ${session.id}`);
        return { id: session.id };
      },
      retrieve: async (id: string): Promise<SessionSnapshot> => {
        const session = this.find(id);
        session.retrieves += 1;
        this.calls.push(`retrieve ${id}`);
        if (session.runningPolls > 0) {
          session.runningPolls -= 1;
          return { status: "running" };
        }
        return { status: session.status, usage: session.usage };
      },
      archive: async (id: string) => {
        const session = this.find(id);
        this.calls.push(`archive ${id}`);
        if (session.status === "running") throw new Error("cannot archive while running");
        session.archived = true;
        return {};
      },
      events: {
        send: async (id: string, params: { events: SendEvent[] }) => {
          const session = this.find(id);
          for (const event of params.events) {
            this.calls.push(`send ${id} ${event.type}`);
            session.sent.push(event);
            session.behaviour(session, event);
          }
          return {};
        },
        stream: async (id: string) => {
          const feed = new Feed();
          this.find(id).feeds.push(feed);
          this.calls.push(`stream ${id}`);
          return feed;
        },
        list: (id: string): AsyncIterable<SessionEvent> => {
          const session = this.find(id);
          this.calls.push(`list ${id}`);
          const snapshot = [...session.history];
          return (async function* () {
            yield* snapshot;
          })();
        },
      },
    },
  };

  private find(id: string): MockSession {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`no such session ${id}`);
    return session;
  }
}

/**
 * The ordinary turn: running, the echoed message, one model request, the
 * reply, then idle with `end_turn`.
 */
export function replies(answer: (session: MockSession) => string): Behaviour {
  return (session, sent) => {
    if (sent.type !== "user.message") return;
    session.later(
      { type: "session.status_running" },
      { type: "user.message", content: sent.content },
      { type: "span.model_request_start" },
      { type: "agent.message", content: [{ type: "text", text: answer(session) }] },
      {
        type: "span.model_request_end",
        model_usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
      },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    );
  };
}

/** Starts work and never finishes it, until interrupted. */
export const hangsUntilInterrupted: Behaviour = (session, sent) => {
  if (sent.type === "user.message") session.later({ type: "session.status_running" });
  if (sent.type === "user.interrupt") {
    session.later({ type: "user.interrupt" }, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
  }
};
