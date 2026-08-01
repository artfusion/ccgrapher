// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * The envelope every event carries.
 *
 * `v` is the contract version and is a literal, exactly as `WorkflowSpec.version`
 * is. Within `v: 1` this contract is additive only, forever: new optional fields
 * and new `type` values may appear, but nothing is removed, renamed or narrowed.
 * That promise is only worth anything if readers hold up their end, so a reader
 * that meets a `type` it has never heard of must keep going — see
 * `parseTraceLine`.
 *
 * `seq` is a per-writer counter starting at 0. Two events in the same
 * millisecond are ordinary, so `ts` alone cannot order a stream; `seq` breaks
 * the tie, and it doubles as the SSE event id when a run is replayed over HTTP.
 *
 * `ts` is ISO-8601, and is typed as a plain string on purpose. A writer in
 * another language that emits `+00:00` rather than `Z` is still telling the
 * truth, and dropping a whole event over a formatting difference would be the
 * reader inventing a problem it does not have.
 */
const envelope = {
  v: z.literal(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
};

/**
 * What a node cost.
 *
 * Every field is optional and **absent means unknown**. A consumer must render
 * an absent number as "n/a" and never as 0, and must only aggregate the fields
 * that are actually present. A zero that really means "nobody measured this" is
 * precisely the dishonesty this project exists to catch, and it is worse here
 * than anywhere else, because a cost total is the number people trust most.
 */
export const Usage = z.object({
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

/**
 * Who wrote the trace.
 *
 * Open, and it has to be. The envelope above promises this contract is additive
 * only within `v: 1`, and adding a source is exactly the kind of additive change
 * that promise covers. A closed enum here would break it in the worst possible
 * place: `run_started` is the only event carrying the spec, so a reader that
 * rejected an unfamiliar source would not merely skip a line, it would lose the
 * identity of the whole run.
 *
 * The known values are still named, so writers get autocomplete and a reader can
 * branch on them. They are a vocabulary, not a gate.
 */
export const KNOWN_TRACE_SOURCES = ["ccg-run", "claude-code-watch", "custom"] as const;
export type KnownTraceSource = (typeof KNOWN_TRACE_SOURCES)[number];

export const TraceSource = z.string().min(1);
// eslint-disable-next-line @typescript-eslint/ban-types -- the `string & {}` keeps
// autocomplete on the known values while still accepting anything a future writer sends.
export type TraceSource = KnownTraceSource | (string & {});

/** The run began. First event of a stream, and the only one carrying the spec. */
export const RunStarted = z.object({
  ...envelope,
  type: z.literal("run_started"),
  /** `hash` identifies the exact spec text, so a dashboard can tell two runs of "the same" workflow apart. */
  spec: z.object({ name: z.string().min(1), hash: z.string().optional() }),
  source: TraceSource,
  args: z.record(z.string(), z.unknown()).optional(),
});
export type RunStarted = z.infer<typeof RunStarted>;

/**
 * A node, or one instance of a fanned node, started.
 *
 * `of` is what makes a node fanned: a writer expanding a `fanOut` must send it
 * on every instance start, because it is the only place the reader learns how
 * many instances to wait for. Without it the fold treats the node as single-shot.
 */
export const NodeStarted = z.object({
  ...envelope,
  type: z.literal("node_started"),
  node: z.string().min(1),
  instance: z.number().int().nonnegative().optional(),
  of: z.number().int().positive().optional(),
});
export type NodeStarted = z.infer<typeof NodeStarted>;

/** One line of output. `node` is absent for a line that belongs to the run itself. */
export const NodeLog = z.object({
  ...envelope,
  type: z.literal("node_log"),
  node: z.string().min(1).optional(),
  line: z.string(),
});
export type NodeLog = z.infer<typeof NodeLog>;

/** A node, or one instance of it, finished successfully. */
export const NodeFinished = z.object({
  ...envelope,
  type: z.literal("node_finished"),
  node: z.string().min(1),
  instance: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative(),
  output: z.unknown().optional(),
  usage: Usage.optional(),
});
export type NodeFinished = z.infer<typeof NodeFinished>;

/** A node, or one instance of it, failed. `durationMs` is optional: a node can fail before it is timed. */
export const NodeFailed = z.object({
  ...envelope,
  type: z.literal("node_failed"),
  node: z.string().min(1),
  instance: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string(),
});
export type NodeFailed = z.infer<typeof NodeFailed>;

/** A gate is blocked on a human. `payload` is whatever that human needs to see to decide. */
export const GateWaiting = z.object({
  ...envelope,
  type: z.literal("gate_waiting"),
  node: z.string().min(1),
  payload: z.unknown().optional(),
});
export type GateWaiting = z.infer<typeof GateWaiting>;

/** The human decided. */
export const GateResolved = z.object({
  ...envelope,
  type: z.literal("gate_resolved"),
  node: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});
export type GateResolved = z.infer<typeof GateResolved>;

/** The run ended. Nodes still running at this point stayed unreported; the fold does not close them. */
export const RunFinished = z.object({
  ...envelope,
  type: z.literal("run_finished"),
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
export type RunFinished = z.infer<typeof RunFinished>;

export const TraceEvent = z.discriminatedUnion("type", [
  RunStarted,
  NodeStarted,
  NodeLog,
  NodeFinished,
  NodeFailed,
  GateWaiting,
  GateResolved,
  RunFinished,
]);
export type TraceEvent = z.infer<typeof TraceEvent>;

export type TraceEventType = TraceEvent["type"];
