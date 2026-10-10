// SPDX-License-Identifier: Apache-2.0

/**
 * The part of the Anthropic client this package calls, and nothing more.
 *
 * Every method here is one the Managed Agents documentation shows for the
 * TypeScript SDK: `beta.sessions.create`, `retrieve` and `archive`, and
 * `beta.sessions.events.send`, `stream` and `list`. Typed structurally so a
 * test can hand in a plain object, and so the runner never needs the SDK to be
 * installed in order to be type-checked. `sdk-shape.ts` fails the build if the
 * real client stops fitting this shape.
 *
 * `delete` is deliberately absent. A session is archived or left alone, never
 * deleted, because its event history is the record a trace points back to.
 */
export interface ManagedAgentsClient {
  readonly beta: {
    readonly sessions: {
      create(params: SessionCreateParams): PromiseLike<{ readonly id: string }>;
      retrieve(sessionId: string): PromiseLike<SessionSnapshot>;
      archive(sessionId: string): PromiseLike<unknown>;
      readonly events: {
        send(sessionId: string, params: { events: SendEvent[] }): PromiseLike<unknown>;
        stream(sessionId: string): PromiseLike<AsyncIterable<SessionEvent>>;
        list(sessionId: string): AsyncIterable<SessionEvent>;
      };
    };
  };
}

export interface SessionCreateParams {
  /** The agent id. The bare string form starts the agent's latest version. */
  agent: string;
  environment_id: string;
  title?: string;
  /** Documented as at most 8 keys on the session object. */
  metadata?: { [key: string]: string };
  budget?: SessionBudget;
}

/** A hard cap on one session's list-price spend. `amount` is US cents as an integer string. */
export interface SessionBudget {
  type: "limit";
  max_list_cost: { amount: string; currency: "USD" };
}

/** What `retrieve` is read for: the status, for the post-idle race, and the usage. */
export interface SessionSnapshot {
  readonly status: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly list_cost?: { readonly amount: string; readonly currency: string } | null;
  };
}

export type SendEvent =
  | { type: "user.message"; content: Array<{ type: "text"; text: string }> }
  | { type: "user.interrupt" }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string }
  | { type: "user.custom_tool_result"; custom_tool_use_id: string; content: Array<{ type: "text"; text: string }> };

/**
 * Any event the stream or the history can carry.
 *
 * Only `type` is common to all of them (the stream-only preview events have no
 * `id`), so this is the loosest true statement, and `events.ts` narrows it by
 * `type` to the handful of events the executor acts on.
 */
export interface SessionEvent {
  readonly type: string;
  readonly id?: string;
}
