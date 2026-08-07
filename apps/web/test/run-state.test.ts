// SPDX-License-Identifier: Apache-2.0
import { serializeEvent, type TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import {
  connectRun,
  eventsUrl,
  TRACE_EVENT_NAMES,
  type ConnectionStatus,
  type EventSourceLike,
  type RunConnection,
} from "../lib/run-state";

/**
 * A stand-in for the browser's `EventSource`, driven by the test.
 *
 * The one behaviour worth imitating exactly is what a browser does on failure:
 * a dropped wire leaves `readyState` at CONNECTING and the browser retries by
 * itself, while a fatal answer such as a 404 moves it to CLOSED and it does not.
 * The client tells those two apart, so a fake that blurred them would test
 * nothing.
 */
class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** A frame the server sent, named as the server names it. */
  send(event: TraceEvent): void {
    this.emit(event.type, serializeEvent(event));
  }

  emit(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }

  /** The wire dropped. The browser will retry this same object. */
  drop(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  /** The server answered and said no. The browser gives up. */
  reject(): void {
    this.readyState = 2;
    this.onerror?.();
  }
}

interface Harness {
  readonly source: FakeEventSource;
  readonly seen: RunConnection[];
  readonly last: () => RunConnection;
  readonly statuses: () => ConnectionStatus[];
  readonly stop: () => void;
}

function harness(runId = "live-demo", serverUrl = "http://localhost:3211"): Harness {
  let source: FakeEventSource | undefined;
  const seen: RunConnection[] = [];
  const stop = connectRun(serverUrl, runId, (c) => seen.push(c), (url) => {
    source = new FakeEventSource(url);
    return source;
  });
  return {
    source: source!,
    seen,
    last: () => seen[seen.length - 1]!,
    statuses: () => seen.map((c) => c.status),
    stop,
  };
}

let seq = 0;
function started(runId = "live-demo"): TraceEvent {
  return {
    v: 1,
    runId,
    seq: seq++,
    ts: "2026-08-01T16:37:10.254Z",
    type: "run_started",
    spec: { name: "live-demo" },
    source: "ccg-run",
  };
}
function nodeStarted(node: string, runId = "live-demo", of?: number): TraceEvent {
  return {
    v: 1,
    runId,
    seq: seq++,
    ts: "2026-08-01T16:37:10.256Z",
    type: "node_started",
    node,
    ...(of === undefined ? {} : { of }),
  };
}
function nodeFinished(node: string, runId = "live-demo"): TraceEvent {
  return {
    v: 1,
    runId,
    seq: seq++,
    ts: "2026-08-01T16:37:10.277Z",
    type: "node_finished",
    node,
    durationMs: 21,
  };
}

describe("the event names the client subscribes to", () => {
  it("covers every type in the contract", () => {
    // Derived from the schema at import time. `EventSource` only delivers events
    // it was asked for by name, so a type missing from this list would be
    // silently invisible on the canvas — hence a test rather than a comment.
    expect([...TRACE_EVENT_NAMES].sort()).toEqual(
      [
        "capability_available",
        "capability_invoked",
        "capability_lost",
        "gate_resolved",
        "gate_waiting",
        "node_failed",
        "node_finished",
        "node_log",
        "node_started",
        "run_finished",
        "run_started",
      ].sort(),
    );
  });
});

describe("connectRun", () => {
  it("opens the run's event stream and reports connecting first", () => {
    const h = harness("live-demo", "http://localhost:3211/");
    expect(h.source.url).toBe("http://localhost:3211/runs/live-demo/events");
    expect(h.statuses()).toEqual(["connecting"]);
    h.stop();
  });

  it("goes connected on open and folds events into run state", () => {
    const h = harness();
    h.source.open();
    expect(h.last().status).toBe("connected");

    h.source.send(started());
    h.source.send(nodeStarted("plan"));
    expect(h.last().run?.nodes.get("plan")?.status).toBe("running");

    h.source.send(nodeFinished("plan"));
    expect(h.last().run?.nodes.get("plan")?.status).toBe("done");
    expect(h.last().run?.status).toBe("running");
    h.stop();
  });

  it("treats a dropped wire as a pause, keeping the state it already folded", () => {
    const h = harness();
    h.source.open();
    h.source.send(started());
    h.source.send(nodeFinished("plan"));

    h.source.drop();
    expect(h.last().status).toBe("reconnecting");
    // Nothing is thrown away: the browser resumes this same stream with
    // Last-Event-ID, so the events already folded are still the truth.
    expect(h.last().run?.nodes.get("plan")?.status).toBe("done");

    h.source.open();
    expect(h.last().status).toBe("connected");
    h.stop();
  });

  it("drops events it has already folded, so a replay cannot double-count", () => {
    const h = harness();
    h.source.open();
    const fanStart = nodeStarted("review", "live-demo", 3);
    const first = nodeFinished("review");
    h.source.send(fanStart);
    h.source.send(first);
    expect(h.last().run?.nodes.get("review")?.instances).toEqual({ done: 1, failed: 0, of: 3 });

    // A reconnect the browser could not resume replays from seq 0.
    h.source.send(fanStart);
    h.source.send(first);
    expect(h.last().run?.nodes.get("review")?.instances).toEqual({ done: 1, failed: 0, of: 3 });
    h.stop();
  });

  it("ignores events belonging to another run", () => {
    const h = harness();
    h.source.open();
    h.source.send(nodeStarted("plan", "some-other-run"));
    expect(h.last().run?.nodes.size).toBe(0);
    h.stop();
  });

  it("takes the run's identity from run_started, not from the file it was served as", () => {
    // A trace copied or renamed is served under the new file name while its
    // events still carry the original runId. Folding against the file name would
    // discard every event and draw a graph in which nothing ever happened.
    const h = harness("renamed-copy");
    h.source.open();
    h.source.send(started("live-demo"));
    h.source.send(nodeStarted("plan", "live-demo"));
    expect(h.last().run?.runId).toBe("live-demo");
    expect(h.last().run?.nodes.get("plan")?.status).toBe("running");

    // And a genuinely foreign run in the same file is still ignored.
    h.source.send(nodeStarted("plan", "somebody-elses-run"));
    expect(h.last().run?.nodes.size).toBe(1);
    h.stop();
  });

  it("ignores a line it cannot parse rather than throwing", () => {
    const h = harness();
    h.source.open();
    h.source.emit("node_started", "{not json");
    h.source.emit("node_started", JSON.stringify({ v: 1, type: "node_started" }));
    expect(h.last().run?.nodes.size).toBe(0);
    h.stop();
  });

  it("reports a server that answers and says no, without retrying", () => {
    const h = harness("no-such-run");
    h.source.reject();
    expect(h.last().status).toBe("closed");
    expect(h.last().error).toContain("no-such-run");
    h.stop();
  });

  it("distinguishes a stream that closed after working from one that never opened", () => {
    const h = harness();
    h.source.open();
    h.source.reject();
    expect(h.last().status).toBe("closed");
    expect(h.last().error).toBe("the server closed the stream");
    h.stop();
  });

  it("surfaces a ccg.error frame without treating it as a disconnection", () => {
    const h = harness();
    h.source.open();
    h.source.emit("ccg.error", JSON.stringify({ error: "trace file vanished" }));
    expect(h.last().status).toBe("connected");
    expect(h.last().error).toBe("trace file vanished");
    h.stop();
  });

  it("says nothing at all once torn down", () => {
    const h = harness();
    h.source.open();
    const before = h.seen.length;
    h.stop();
    h.source.send(nodeStarted("plan"));
    expect(h.seen.length).toBe(before);
    expect(h.source.closed).toBe(true);
  });

  it("reports a server it cannot even construct a stream for", () => {
    const seen: RunConnection[] = [];
    connectRun("http://localhost:3211", "live-demo", (c) => seen.push(c), () => {
      throw new Error("EventSource is not available");
    });
    expect(seen).toEqual([{ status: "closed", error: "EventSource is not available" }]);
  });
});

describe("eventsUrl", () => {
  it("escapes a run id that is not URL-safe", () => {
    expect(eventsUrl("http://x", "a b/c")).toBe("http://x/runs/a%20b%2Fc/events");
  });
});
