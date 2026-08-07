// SPDX-License-Identifier: Apache-2.0
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseTraceLine, type TraceEvent } from "@ccgrapher/trace";
import { TraceWriter, resumeSeq } from "@ccgrapher/trace/node";
import { eventsForHook, type HookPayload } from "./map.js";

/** Where traces land when nothing says otherwise, relative to the project directory. */
export const DEFAULT_RUN_DIR = "runs";

/** How long the lock is waited for in total: attempts × {@link LOCK_RETRY_MS}. */
export const LOCK_RETRIES = 100;
export const LOCK_RETRY_MS = 20;

/**
 * When a lockfile is assumed to belong to a process that will never release it.
 *
 * A hook holds the lock for one read and one append — a millisecond or two. A
 * lockfile older than this is not contention, it is a killed process, and
 * without this every hook for the rest of the session would fail waiting on a
 * file nobody owns.
 */
export const LOCK_STALE_MS = 30_000;

/**
 * The run id for a session, and — since the id and the filename are the same
 * fact — the filename stem too.
 *
 * `ccg serve` reads `<runId>.jsonl` and the fold keys on the id, so a stem that
 * disagreed with the id inside the file would make the run unservable and
 * unreadable against itself. The `cc-` prefix keeps hook traces distinguishable
 * from `ccg run`'s own `<slug>-<stamp>-<hex>` files in a shared `runs/`.
 */
export function runIdForSession(sessionId: string): string {
  // Session ids are uuids, so this normally changes nothing. It exists because
  // the id becomes a path, and a payload is another product's data: dots are out
  // along with separators, so no id can name a directory above the run folder.
  const safe = sessionId.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe === "") throw new Error(`session id ${JSON.stringify(sessionId)} has nothing usable in it`);
  return `cc-${safe}`;
}

export function tracePathFor(dir: string, sessionId: string): string {
  return join(dir, `${runIdForSession(sessionId)}.jsonl`);
}

/** Blocks this thread. The whole append path is synchronous, and the waits are milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    // It went away between the failed open and this stat, which is the lock
    // being released rather than a stale one. The next attempt will take it.
    return false;
  }
}

export interface LockOptions {
  readonly retries?: number;
  readonly retryMs?: number;
  readonly staleMs?: number;
}

/**
 * Run `body` while holding `<path>.lock`, an exclusively-created file.
 *
 * Hooks are separate short-lived processes and two tool calls can finish at
 * once, so two of them genuinely race for this file. Without a lock both would
 * read the same tail, pick the same `seq`, and write two events numbered
 * identically — which is not a cosmetic problem: `seq` is what orders a stream
 * whose timestamps collide, and it is the SSE event id a reconnecting reader
 * resumes from.
 *
 * `wx` is the primitive because exclusive create is atomic on every filesystem
 * this will meet, including the network ones where advisory locking is not.
 */
export function withTraceLock<T>(path: string, body: () => T, options: LockOptions = {}): T {
  const { retries = LOCK_RETRIES, retryMs = LOCK_RETRY_MS, staleMs = LOCK_STALE_MS } = options;
  const lockPath = `${path}.lock`;

  let fd: number | undefined;
  for (let attempt = 0; attempt <= retries && fd === undefined; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (isStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else reclaimed it first. Fine: the point was for it to go.
        }
        continue;
      }
      sleepSync(retryMs);
    }
  }
  if (fd === undefined) {
    throw new Error(
      `could not take ${lockPath} after ${retries * retryMs}ms — another hook is holding it, ` +
        `or a stale lock needs removing by hand`,
    );
  }

  closeSync(fd);
  try {
    return body();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Nothing useful to do about a lock that cannot be released; leaving the
      // failure to bubble here would replace the caller's result or its error.
    }
  }
}

/** The `ts` of the first event in the file, which is when this run began. */
function firstTsOf(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseTraceLine(line);
    if (parsed.type !== "unknown") return parsed.ts;
  }
  return undefined;
}

export interface AppendOptions extends LockOptions {
  /** Directory of `<runId>.jsonl` files. Defaults to `runs/` under the payload's `cwd`. */
  readonly dir?: string;
  /** The timestamp to stamp events with. Defaults to now; tests pass a fixed one. */
  readonly now?: string;
}

function defaultDirFor(payload: HookPayload): string {
  const cwd = payload["cwd"];
  return join(typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd(), DEFAULT_RUN_DIR);
}

/**
 * Map one hook payload and append whatever it justifies.
 *
 * The reason this package exists rather than a page of documentation. A hook is
 * a process that starts, writes one line and exits, so a `TraceWriter`
 * constructed the obvious way numbers its first event 0 every single time and
 * the file ends up 0, 0, 0 — unorderable, and colliding on every SSE id. So the
 * tail is read and the counter continues from it, and both the read and the
 * write happen under the lock, because a concurrent hook appending in between
 * would hand this one a number it had already used.
 */
export function appendHook(payload: HookPayload, options: AppendOptions = {}): readonly TraceEvent[] {
  const sessionId = payload["session_id"];
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("hook payload has no session_id, so there is no run to append to");
  }
  const runId = runIdForSession(sessionId);
  const dir = options.dir ?? defaultDirFor(payload);
  const path = join(dir, `${runId}.jsonl`);
  mkdirSync(dir, { recursive: true });

  return withTraceLock(
    path,
    () => {
      const startedAt = firstTsOf(path);
      const events = eventsForHook(payload, {
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      if (events.length === 0) return [];
      const writer = new TraceWriter(path, runId, resumeSeq(path));
      return events.map((event) => writer.write(event, options.now));
    },
    options,
  );
}
