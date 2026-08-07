// SPDX-License-Identifier: Apache-2.0
import { readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { isTraceEvent, type TraceLine } from "@ccgrapher/trace";
import { followTrace } from "@ccgrapher/trace/node";

/**
 * A read-only HTTP window onto a directory of trace files.
 *
 * SSE rather than a socket protocol, on purpose: a run is one long stream of
 * events plus the occasional command back, which is exactly the shape SSE has.
 * It costs no dependency, it survives a proxy that would drop an upgrade, and
 * because every message carries the event's `seq` as its id, a dropped
 * connection resumes from `Last-Event-ID` rather than replaying from zero.
 *
 * The module is exported so a live `ccg run` can hold a server in-process and
 * hand it a gate resolver, instead of shelling out to a second process that
 * would have no way to answer a gate at all.
 */

/** The canvas dev server. The only origin allowed to read a trace by default. */
export const DEFAULT_ORIGIN = "http://localhost:3210";

/** One past the canvas dev port, so the pair is easy to remember. */
export const DEFAULT_PORT = 3211;

/** Comment frames only exist to stop an idle proxy reaping a live stream. */
const HEARTBEAT_MS = 15_000;

/** A gate decision is a few hundred bytes; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * SSE event names the server itself emits — the only named frames on the stream.
 *
 * A real event is forwarded unnamed, so it arrives at the client's `onmessage`
 * and the client discriminates on the `type` inside the payload. Naming the
 * frame after its type would look tidier and would quietly break the contract:
 * `EventSource` delivers only the names a listener asked for, so a type either
 * end had not heard of would never be delivered at all.
 *
 * These two keep names because they are the server talking about the stream
 * rather than the run relaying an event, and the `ccg.` prefix says so. It is
 * `ccg.error` rather than `error` because `error` on an EventSource already
 * means the transport failed, and a stream problem is not a transport problem.
 */
const UNPARSED = "ccg.unparsed";
const STREAM_ERROR = "ccg.error";

/** What a client asks for at a gate. */
export interface GateDecision {
  readonly decision: "approve" | "reject";
  readonly note?: string;
}

/**
 * Delivers a decision to the run that is waiting on it.
 *
 * Absent by design in the standalone server: replaying files means there is no
 * process listening, and a resolver that returned success would be a lie of
 * exactly the kind this project exists to find. Throwing is a legitimate answer
 * — the message reaches the client.
 */
export type GateResolver = (
  runId: string,
  node: string,
  decision: GateDecision,
) => void | Promise<void>;

export interface ServeOptions {
  /** Directory of `<runId>.jsonl` files. */
  readonly dir: string;
  /** 0 asks the OS for a free port, which is what the tests want. */
  readonly port?: number;
  readonly host?: string;
  /** Origin allowed by CORS. One origin, not a wildcard. */
  readonly origin?: string;
  /** How often `followTrace` looks for appended bytes. */
  readonly pollMs?: number;
  readonly resolveGate?: GateResolver;
}

/** What `/runs` knows without opening a single file. */
export interface RunSummary {
  readonly id: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface TraceServer {
  readonly port: number;
  readonly url: string;
  readonly dir: string;
  /** Wire up (or tear down) gate delivery after the server is already listening. */
  setGateResolver(resolver: GateResolver | undefined): void;
  close(): Promise<void>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The file for a run id, or undefined when there is no such run.
 *
 * Resolved and then checked for containment rather than filtered by a charset,
 * so an id with a space in it stays reachable while `../` cannot escape the
 * directory being served.
 */
function tracePath(dir: string, id: string): string | undefined {
  if (id === "" || id.includes("\0")) return undefined;
  const root = resolve(dir);
  const path = resolve(root, `${id}.jsonl`);
  if (!path.startsWith(root + sep)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function listRuns(dir: string): RunSummary[] {
  const runs: RunSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const stats = statSync(join(dir, name));
      if (!stats.isFile()) continue;
      runs.push({
        id: name.slice(0, -".jsonl".length),
        bytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch {
      // Vanished between readdir and stat. It is not a run we can serve, and it
      // is not an error worth failing the whole listing over.
    }
  }
  return runs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
}

/**
 * `Last-Event-ID` from the client, or undefined.
 *
 * An id that is not a sequence number is ignored rather than guessed at: the
 * cost is one full replay, and the alternative is silently starting a stream in
 * the wrong place.
 */
function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.trim() === "") return undefined;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

/** One SSE frame. `data` is single-line because JSON.stringify escapes newlines. */
function frame(id: number | undefined, event: string | undefined, data: unknown): string {
  return (
    `${id === undefined ? "" : `id: ${id}\n`}` +
    `${event === undefined ? "" : `event: ${event}\n`}` +
    `data: ${JSON.stringify(data)}\n\n`
  );
}

/** A line with a `seq`, which is what makes it forwardable and resumable. */
interface Forwardable {
  readonly kind: "event";
  readonly seq: number;
  /** The parsed line, whether or not this server knows what its type means. */
  readonly body: unknown;
}

/** A line that is not an event by any reading this server can apply. */
interface Unforwardable {
  readonly kind: "unparsed";
  readonly raw: string;
}

/**
 * Decide what to do with one line, structurally rather than by schema.
 *
 * The compiled schema is this server's opinion about which types exist, and the
 * contract is additive-only: a writer newer than this build emits types it has
 * never heard of, and those are still events, still ordered, still the client's
 * to interpret. So the test is the envelope, not the type — anything that is
 * JSON and carries a sequence number is forwarded with that number as its SSE
 * id, and a reconnect can resume past it exactly as it resumes past a type this
 * server does understand.
 */
function classify(line: TraceLine): Forwardable | Unforwardable {
  if (isTraceEvent(line)) return { kind: "event", seq: line.seq, body: line };
  let body: unknown;
  try {
    body = JSON.parse(line.raw);
  } catch {
    return { kind: "unparsed", raw: line.raw };
  }
  const seq = (body as { seq?: unknown } | null)?.seq;
  // A seq that is not a sequence number cannot come back as a `Last-Event-ID`,
  // so forwarding it as an id would promise a resume that could not happen.
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0
    ? { kind: "event", seq, body }
    : { kind: "unparsed", raw: line.raw };
}

export async function startTraceServer(options: ServeOptions): Promise<TraceServer> {
  const {
    dir,
    port = DEFAULT_PORT,
    host = "127.0.0.1",
    origin = DEFAULT_ORIGIN,
    pollMs,
  } = options;
  let resolveGate = options.resolveGate;

  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    Vary: "Origin",
  };

  /** Live SSE streams, so `close()` can end them instead of waiting on them. */
  const streams = new Set<AbortController>();

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function streamEvents(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const path = tracePath(dir, id);
    if (path === undefined) {
      // A stream that opened and stayed empty is indistinguishable from a run
      // that has not started yet, so a missing run has to be a status code.
      sendJson(res, 404, { error: `no run '${id}' in ${dir}` });
      return;
    }

    let skipTo = parseLastEventId(req.headers["last-event-id"]);
    res.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx buffers a proxied response by default, which would hold every
      // event back until the run ended.
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const controller = new AbortController();
    streams.add(controller);
    req.on("close", () => controller.abort());
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref();

    try {
      for await (const line of followTrace(path, { signal: controller.signal, pollMs })) {
        if (controller.signal.aborted) break;
        const forward = classify(line);
        if (forward.kind === "unparsed") {
          // A line that is not an event at all is reported, never invented and
          // never quietly dropped. While resuming it is held back instead:
          // it carries no seq, so there is no way to tell whether the client
          // already has it, and re-sending would be a duplicate it cannot detect.
          if (skipTo === undefined) res.write(frame(undefined, UNPARSED, { raw: forward.raw }));
          continue;
        }
        if (skipTo !== undefined) {
          if (forward.seq <= skipTo) continue;
          skipTo = undefined;
        }
        res.write(frame(forward.seq, undefined, forward.body));
      }
    } catch (cause) {
      if (!res.writableEnded) res.write(frame(undefined, STREAM_ERROR, { error: messageOf(cause) }));
    } finally {
      clearInterval(heartbeat);
      streams.delete(controller);
      res.end();
    }
  }

  async function decideGate(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    node: string,
  ): Promise<void> {
    if (tracePath(dir, id) === undefined) {
      sendJson(res, 404, { error: `no run '${id}' in ${dir}` });
      return;
    }
    if (node === "") {
      sendJson(res, 400, { error: "no gate node named in the path" });
      return;
    }

    const body = await readBody(req);
    if (body === undefined) {
      sendJson(res, 413, { error: `a gate decision must be under ${MAX_BODY_BYTES} bytes` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "body is not valid JSON" });
      return;
    }
    const raw = (parsed ?? {}) as Record<string, unknown>;
    if (raw.decision !== "approve" && raw.decision !== "reject") {
      sendJson(res, 400, { error: `decision must be "approve" or "reject"` });
      return;
    }
    if (raw.note !== undefined && typeof raw.note !== "string") {
      sendJson(res, 400, { error: "note must be a string" });
      return;
    }
    const decision: GateDecision = { decision: raw.decision, note: raw.note as string | undefined };

    if (!resolveGate) {
      // The failure this whole project is about: accepting a decision that goes
      // nowhere. 501, because the server genuinely has no facility for it.
      sendJson(res, 501, {
        error:
          `no live run is attached to '${id}': this server replays trace files, so a gate ` +
          `decision has nothing to deliver to. Resolve the gate where the run is executing.`,
      });
      return;
    }

    try {
      await resolveGate(id, node, decision);
    } catch (cause) {
      sendJson(res, 500, { error: `the run refused the decision: ${messageOf(cause)}` });
      return;
    }
    sendJson(res, 202, { run: id, node, decision: decision.decision });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "Access-Control-Max-Age": "600" });
      res.end();
      return;
    }

    if (req.method === "GET" && parts.length === 1 && parts[0] === "runs") {
      try {
        sendJson(res, 200, { dir, runs: listRuns(dir) });
      } catch (cause) {
        sendJson(res, 500, { error: `cannot read ${dir}: ${messageOf(cause)}` });
      }
      return;
    }

    if (req.method === "GET" && parts.length === 3 && parts[0] === "runs" && parts[2] === "events") {
      await streamEvents(req, res, parts[1]!);
      return;
    }

    if (req.method === "POST" && parts.length === 4 && parts[0] === "runs" && parts[2] === "gates") {
      await decideGate(req, res, parts[1]!, parts[3]!);
      return;
    }

    sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((cause: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: messageOf(cause) });
    });
  });

  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(port, host, () => {
      server.removeListener("error", failed);
      ready();
    });
  });

  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: bound,
    url: `http://${host}:${bound}`,
    dir,
    setGateResolver(resolver) {
      resolveGate = resolver;
    },
    close() {
      // Aborting first lets each stream end its response; without it `close()`
      // would wait forever on connections that are working exactly as intended.
      for (const controller of streams) controller.abort();
      return new Promise<void>((done, failed) => {
        server.close((cause) => (cause ? failed(cause) : done()));
        server.closeAllConnections();
      });
    },
  };
}
