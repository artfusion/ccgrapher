// SPDX-License-Identifier: Apache-2.0
import { emptyRunState, parseTraceLine, reduceRun, type RunState } from "@ccgrapher/trace";
import { useCallback, useEffect, useState } from "react";

/**
 * The canvas end of `ccg serve`.
 *
 * Everything here folds events through `reduceRun` from `@ccgrapher/trace`, the
 * same fold the CLI uses, so the picture and the terminal cannot disagree about
 * whether a node finished. Nothing here computes a position, a rank or a size:
 * run state tints a graph that was already laid out, and never moves it.
 */

/** What `ccg serve` binds to unless it is told otherwise. */
export const DEFAULT_SERVER_URL = "http://localhost:3211";

/** One entry of `GET /runs`. */
export interface RunSummary {
  readonly id: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

/**
 * `connecting` — no frame has arrived yet, and the server may not be there.
 * `reconnecting` — the stream was open and dropped; the browser is retrying and
 * will send `Last-Event-ID`, so this is a pause, not a restart.
 * `closed` — the server answered and said no: usually a run id it does not have.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface RunConnection {
  readonly status: ConnectionStatus;
  readonly run?: RunState;
  readonly error?: string;
}

/**
 * The server's own frames, which are about the stream and not about the run.
 *
 * Named, and so subscribed to by name. Real events are not: they arrive unnamed,
 * on `message`, because `EventSource` delivers only the names a listener asked
 * for and no list of names can contain a type a later writer will invent.
 */
const UNPARSED = "ccg.unparsed";
const STREAM_ERROR = "ccg.error";

/** Just enough of `EventSource` to stream a run, so a test can supply its own. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

export function eventsUrl(serverUrl: string, runId: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}/events`;
}

/** `GET /runs`. Rejects when the server is not there, which is how the UI stays hidden. */
export async function fetchRuns(serverUrl: string, signal?: AbortSignal): Promise<RunSummary[]> {
  const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/runs`, { signal });
  if (!response.ok) throw new Error(`${response.status} from ${serverUrl}/runs`);
  const body = (await response.json()) as { runs?: RunSummary[] };
  return body.runs ?? [];
}

/**
 * Stream one run, folding as it goes. Returns the teardown.
 *
 * Two reconnection paths, and they are not the same:
 *
 *   - The browser's own retry reuses this `EventSource` and sends `Last-Event-ID`,
 *     so the server resumes from the next event and the fold carries on.
 *   - Anything that builds a *new* `EventSource` — a URL change, a remount —
 *     cannot send that header, so the server replays from the top.
 *
 * The `seq` guard below makes the second case harmless: a replayed event has a
 * sequence number already folded and is dropped. Without it a replay would count
 * `node_finished` twice and a fanned node would claim 6/5 instances.
 */
export function connectRun(
  serverUrl: string,
  runId: string,
  onChange: (connection: RunConnection) => void,
  factory: EventSourceFactory = defaultFactory,
): () => void {
  let state = emptyRunState(runId);
  let lastSeq = -1;
  let opened = false;
  let error: string | undefined;
  let live = true;

  const emit = (status: ConnectionStatus): void => {
    if (live) onChange({ status, run: state, ...(error === undefined ? {} : { error }) });
  };

  let source: EventSourceLike;
  try {
    source = factory(eventsUrl(serverUrl, runId));
  } catch (cause) {
    onChange({
      status: "closed",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return () => {
      live = false;
    };
  }

  // One subscription for every real event, because the server sends them unnamed.
  // The discrimination happens in `parseTraceLine`, which is where the contract
  // already lives: a type this bundle has never heard of parses to `unknown` and
  // is passed over here rather than never being delivered at all.
  source.addEventListener("message", (event) => {
    const line = parseTraceLine(event.data);
    if (line.type === "unknown") return;
    // Already folded. See the note above about replay.
    if (line.seq <= lastSeq) return;
    lastSeq = line.seq;
    // The id in the URL is a file name; `run_started` is the run saying what it
    // is actually called. `ccg run` keeps the two the same, but anything that
    // renamed or copied a trace would otherwise fold to an empty run and draw a
    // graph in which nothing ever happened — a silent lie, and the loudest kind.
    // Foreign events after this point are still ignored, by `reduceRun`.
    if (line.type === "run_started" && line.runId !== state.runId) {
      state = emptyRunState(line.runId);
    }
    state = reduceRun(state, line);
    emit("connected");
  });

  source.addEventListener(UNPARSED, () => {
    // The server could not parse a line and said so rather than dropping it. The
    // trace file is the place to look; the canvas has nothing useful to draw.
  });

  source.addEventListener(STREAM_ERROR, (event) => {
    const body = parseErrorFrame(event.data);
    if (body !== undefined) error = body;
    emit("connected");
  });

  source.onopen = () => {
    opened = true;
    error = undefined;
    emit("connected");
  };

  source.onerror = () => {
    if (source.readyState === CLOSED) {
      // A fatal answer, not a dropped wire: a 404 for a run this server has never
      // heard of looks exactly like this.
      error = opened
        ? "the server closed the stream"
        : `no stream at ${serverUrl} for run '${runId}'`;
      emit("closed");
      return;
    }
    emit(opened ? "reconnecting" : "connecting");
  };

  emit("connecting");

  return () => {
    live = false;
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
}

function parseErrorFrame(data: string): string | undefined {
  try {
    const body = JSON.parse(data) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to a run. `runId` undefined means "not watching anything", which is
 * the state the canvas is in whenever there is no server.
 */
export function useRunState(
  serverUrl: string,
  runId: string | undefined,
  factory?: EventSourceFactory,
): RunConnection | undefined {
  const [connection, setConnection] = useState<RunConnection>();

  useEffect(() => {
    if (runId === undefined) {
      setConnection(undefined);
      return;
    }
    return connectRun(serverUrl, runId, setConnection, factory);
  }, [serverUrl, runId, factory]);

  return connection;
}

export interface TraceServer {
  /** True once `GET /runs` has answered. Until then the live UI does not exist. */
  readonly reachable: boolean;
  readonly runs: readonly RunSummary[];
  readonly probe: () => void;
}

/**
 * Look for a trace server, quietly.
 *
 * Re-probed when the window regains focus rather than on a timer: the case worth
 * handling is "started `ccg serve` in a terminal, came back to the tab", and a
 * poll that runs forever to catch it would be a background request the user
 * never asked for.
 */
export function useTraceServer(serverUrl: string): TraceServer {
  const [runs, setRuns] = useState<readonly RunSummary[]>();
  const [attempt, setAttempt] = useState(0);
  const probe = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchRuns(serverUrl, controller.signal).then(
      (found) => setRuns(found),
      () => {
        if (!controller.signal.aborted) setRuns(undefined);
      },
    );
    return () => controller.abort();
  }, [serverUrl, attempt]);

  useEffect(() => {
    window.addEventListener("focus", probe);
    return () => window.removeEventListener("focus", probe);
  }, [probe]);

  return { reachable: runs !== undefined, runs: runs ?? [], probe };
}
