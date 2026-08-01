// SPDX-License-Identifier: Apache-2.0
import { TraceEvent } from "./schema.js";

/**
 * What a line becomes when this reader cannot make sense of it: malformed JSON,
 * a missing or wrong-typed field, or — the case that actually matters — a `type`
 * emitted by a writer newer than this reader.
 *
 * `"unknown"` is reserved and will never be a real event type, so a consumer can
 * discriminate on `type` and treat this arm as "not mine to interpret" without
 * ever colliding with a future event.
 */
export interface UnknownTraceLine {
  readonly type: "unknown";
  readonly raw: string;
}

/** One line of a trace file, understood or not. */
export type TraceLine = TraceEvent | UnknownTraceLine;

/**
 * Parse one JSONL line. Never throws, for any input at all.
 *
 * The raw line is kept rather than discarded, so a stream can be forwarded
 * verbatim by a reader that does not understand all of it. That is what lets an
 * old reader sit in front of a new writer without losing data.
 */
export function parseTraceLine(line: string): TraceLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: "unknown", raw: line };
  }
  const result = TraceEvent.safeParse(raw);
  return result.success ? result.data : { type: "unknown", raw: line };
}

/** Narrow a parsed line to an event this reader understands. */
export function isTraceEvent(line: TraceLine): line is TraceEvent {
  return line.type !== "unknown";
}

/** One JSONL line, without the trailing newline. The writer adds that. */
export function serializeEvent(event: TraceEvent): string {
  return JSON.stringify(event);
}
