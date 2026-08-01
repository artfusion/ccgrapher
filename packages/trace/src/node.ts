// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseTraceLine, serializeEvent, type TraceLine } from "./codec.js";
import { TraceEvent } from "./schema.js";

/** Filesystem entry points, kept out of `index.ts` so that stays bundler-safe. */

/**
 * The write caps.
 *
 * A trace is a record, not a store. One node that prints a 40MB stack trace or
 * returns a whole scraped page should not make the file unreadable for every
 * other node in the run, and should not make a hosted ingest endpoint refuse it.
 * Oversized values keep their head and are marked as cut, so a reader can always
 * tell the difference between "short" and "shortened".
 */
export const MAX_LOG_LINE = 4_000;
export const MAX_OUTPUT_CHARS = 16_000;
export const OUTPUT_PREVIEW_CHARS = 500;

/**
 * What an oversized `node_finished.output` is replaced with.
 *
 * `chars` is the length of the JSON that was dropped, or `null` when the value
 * could not be serialised at all — which is a different failure and is not
 * dressed up as a big one.
 */
export interface TruncatedOutput {
  readonly truncated: true;
  readonly chars: number | null;
  readonly preview: string;
}

/** An event minus the envelope, which is the writer's job to fill in. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "v" | "runId" | "seq" | "ts"> : never;
export type TraceEventInput = WithoutEnvelope<TraceEvent>;

function capOutput(output: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    return { truncated: true, chars: null, preview: "<not serialisable as JSON>" } as TruncatedOutput;
  }
  if (json === undefined || json.length <= MAX_OUTPUT_CHARS) return output;
  return {
    truncated: true,
    chars: json.length,
    preview: json.slice(0, OUTPUT_PREVIEW_CHARS),
  } as TruncatedOutput;
}

function cap(input: TraceEventInput): TraceEventInput {
  if (input.type === "node_log" && input.line.length > MAX_LOG_LINE) {
    const dropped = input.line.length - MAX_LOG_LINE;
    return { ...input, line: `${input.line.slice(0, MAX_LOG_LINE)}… (${dropped} more chars)` };
  }
  if (input.type === "node_finished" && input.output !== undefined) {
    const output = capOutput(input.output);
    return output === input.output ? input : { ...input, output };
  }
  return input;
}

/**
 * Appends events to a JSONL file, one line each.
 *
 * Owns `seq` for its file: the counter is the writer's, which is what makes it
 * monotonic. Two writers on one file would each number from their own zero, so
 * do not do that.
 *
 * Writes are synchronous. A run emits tens of events, not thousands, and a
 * trace that survives the process being killed is worth more than the
 * microseconds — the runs most worth reading afterwards are the ones that died.
 */
export class TraceWriter {
  #seq: number;

  constructor(
    readonly path: string,
    readonly runId: string,
    startSeq = 0,
  ) {
    this.#seq = startSeq;
  }

  /** The `seq` the next event will carry. */
  get seq(): number {
    return this.#seq;
  }

  /** Caps oversized fields, stamps the envelope, appends. Returns the event as written. */
  write(input: TraceEventInput, ts: string = new Date().toISOString()): TraceEvent {
    // Parsed rather than cast, so a writer bug cannot put a line into the file
    // that readers of this same contract would reject.
    const event = TraceEvent.parse({
      v: 1,
      runId: this.runId,
      seq: this.#seq,
      ts,
      ...cap(input),
    });
    this.#seq += 1;
    appendFileSync(this.path, `${serializeEvent(event)}\n`);
    return event;
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Read a whole trace file.
 *
 * Lines this reader cannot parse come back as unknown rather than being dropped,
 * so a caller can see that something was there and decide for itself.
 */
export function readTrace(path: string): TraceLine[] {
  return splitLines(readFileSync(path, "utf8")).map(parseTraceLine);
}

export interface FollowOptions {
  /** Ends the iteration cleanly. Without one, following a live file never returns. */
  signal?: AbortSignal;
  /** How often to look for appended bytes. Default 100ms. */
  pollMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Yield everything in the file, then everything appended to it: `tail -f`.
 *
 * Polls rather than watches, because file watching disagrees with itself across
 * platforms and network filesystems and this has to be boring. A trailing
 * partial line is held back until its newline arrives, and bytes are decoded
 * incrementally so a multi-byte character split across two reads survives.
 */
export async function* followTrace(
  path: string,
  options: FollowOptions = {},
): AsyncGenerator<TraceLine> {
  const { signal, pollMs = 100 } = options;
  const handle = await open(path, "r");
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let carry = "";

  try {
    while (!signal?.aborted) {
      const { size } = await handle.stat();
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        carry += decoder.write(buffer.subarray(0, bytesRead));
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() !== "") yield parseTraceLine(line);
        }
        continue;
      }
      await sleep(pollMs, signal);
    }
  } finally {
    await handle.close();
  }
}
