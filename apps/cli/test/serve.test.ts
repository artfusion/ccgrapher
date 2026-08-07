// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTraceServer, type GateDecision, type TraceServer } from "../src/serve.js";

let dir: string;
let server: TraceServer;
let base: string;

/** One SSE frame, as the client sees it. */
interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    let id: string | undefined;
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    // A frame with no `event:` is what the browser calls "message" and delivers
    // to `onmessage`, which is how every real event now arrives.
    if (data !== undefined) {
      frames.push({ id, event: event ?? "message", data: JSON.parse(data) });
    }
  }
  return frames;
}

/**
 * What each frame is about: the event type it carries, or the server's own frame
 * name when it carries no type. Asserting on this rather than on `event:` is the
 * point — the transport no longer names the events it forwards.
 */
function kinds(got: Frame[]): string[] {
  return got.map((f) => (f.data as { type?: string }).type ?? f.event);
}

/**
 * Reads the stream until `enough` frames have arrived, then aborts.
 *
 * Aborting is the point: these streams follow the file forever, so a test that
 * waited for the body to end would hang rather than fail.
 */
async function frames(
  path: string,
  enough: number,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; frames: Frame[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    controller.abort();
    return { status: response.status, headers: response.headers, frames: [] };
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let text = "";
  let seen: Frame[] = [];
  try {
    while (seen.length < enough) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      seen = parseFrames(text);
    }
  } catch {
    // The abort below lands here on the timeout path; the frames so far still
    // tell the test what it needs to know.
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  // Exactly `enough`, never more. One `read()` can deliver several frames in a
  // single chunk, so the loop above overshoots whenever the server's writes
  // happen to coalesce — which they do under CI's timing and not under a
  // developer's. A test that passes locally and fails on the runner for that
  // reason is worse than no test, so the helper honours the count it was asked
  // for rather than leaving every caller to remember to slice.
  return { status: response.status, headers: response.headers, frames: seen.slice(0, enough) };
}

const line = (seq: number, extra: string) =>
  `{"v":1,"runId":"live","seq":${seq},"ts":"2026-08-01T09:00:0${seq}.000Z",${extra}}\n`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ccg-serve-"));

  // A finished three-event run.
  writeFileSync(
    join(dir, "done.jsonl"),
    [
      `{"v":1,"runId":"done","seq":0,"ts":"2026-08-01T09:00:00.000Z","type":"run_started","spec":{"name":"demo"},"source":"ccg-run"}`,
      `{"v":1,"runId":"done","seq":1,"ts":"2026-08-01T09:00:01.000Z","type":"node_started","node":"plan"}`,
      `{"v":1,"runId":"done","seq":2,"ts":"2026-08-01T09:00:02.000Z","type":"node_finished","node":"plan","durationMs":1000}`,
      `{"v":1,"runId":"done","seq":3,"ts":"2026-08-01T09:00:03.000Z","type":"run_finished","ok":true,"durationMs":3000}`,
      "",
    ].join("\n"),
    "utf8",
  );

  // A run with one line no reader can make sense of, in the middle.
  writeFileSync(
    join(dir, "torn.jsonl"),
    [
      `{"v":1,"runId":"torn","seq":0,"ts":"2026-08-01T09:00:00.000Z","type":"run_started","spec":{"name":"demo"},"source":"ccg-run"}`,
      `{"v":1,"runId":"torn","seq":1,"ts":"2026-08-01T09`,
      `{"v":1,"runId":"torn","seq":2,"ts":"2026-08-01T09:00:02.000Z","type":"run_finished","ok":false,"error":"cut short","durationMs":2000}`,
      "",
    ].join("\n"),
    "utf8",
  );

  // A run written by something newer than this server: one event whose `type` is
  // not in the schema compiled into it, and one line that is not a trace line at
  // all. Only the second is beyond the transport's reach.
  writeFileSync(
    join(dir, "ahead.jsonl"),
    [
      `{"v":1,"runId":"ahead","seq":0,"ts":"2026-08-01T09:00:00.000Z","type":"run_started","spec":{"name":"demo"},"source":"ccg-run"}`,
      `{"v":1,"runId":"ahead","seq":1,"ts":"2026-08-01T09:00:01.000Z","type":"node_annotated","node":"plan","note":"from a later writer"}`,
      `{"v":1,"runId":"ahead","seq":2,"ts":"2026-08-01T09:00:02.000Z","type":"node_finished","node":"plan","durationMs":1000}`,
      `{"hello":"world"}`,
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(join(dir, "live.jsonl"), line(0, `"type":"node_started","node":"a"`), "utf8");

  server = await startTraceServer({ dir, port: 0, pollMs: 20 });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /runs", () => {
  it("lists every trace file with the metadata a stat gives", async () => {
    const response = await fetch(`${base}/runs`);
    const body = (await response.json()) as { runs: Array<{ id: string; bytes: number }> };
    expect(response.status).toBe(200);
    expect(body.runs.map((run) => run.id).sort()).toEqual(["ahead", "done", "live", "torn"]);
    expect(body.runs.every((run) => run.bytes > 0)).toBe(true);
  });
});

describe("GET /runs/:id/events", () => {
  it("replays a finished run from the start, seq as the SSE id", async () => {
    const { frames: got } = await frames("/runs/done/events", 4);
    expect(kinds(got)).toEqual(["run_started", "node_started", "node_finished", "run_finished"]);
    expect(got.map((f) => f.id)).toEqual(["0", "1", "2", "3"]);
    expect(got[0]?.data).toMatchObject({ runId: "done", spec: { name: "demo" } });
    // Unnamed on purpose: a name would be a list of types the server knows, and
    // the client only hears the names it subscribed to.
    expect(got.map((f) => f.event)).toEqual(["message", "message", "message", "message"]);
  });

  it("follows the file, picking up events appended after the connection opened", async () => {
    const path = join(dir, "live.jsonl");
    const appended = setTimeout(() => {
      appendFileSync(path, line(1, `"type":"node_finished","node":"a","durationMs":10`));
      appendFileSync(path, line(2, `"type":"run_finished","ok":true,"durationMs":20`));
    }, 100);
    try {
      const { frames: got } = await frames("/runs/live/events", 3);
      expect(kinds(got)).toEqual(["node_started", "node_finished", "run_finished"]);
    } finally {
      clearTimeout(appended);
    }
  });

  it("resumes after the seq in Last-Event-ID rather than replaying", async () => {
    const { frames: got } = await frames("/runs/done/events", 2, {
      headers: { "Last-Event-ID": "1" },
    });
    expect(got.map((f) => f.id)).toEqual(["2", "3"]);
    expect(kinds(got)[0]).toBe("node_finished");
  });

  it("replays from the start when Last-Event-ID is not a sequence number", async () => {
    const { frames: got } = await frames("/runs/done/events", 1, {
      headers: { "Last-Event-ID": "not-a-seq" },
    });
    expect(got[0]?.id).toBe("0");
  });

  it("forwards a line it cannot parse as such, and keeps going", async () => {
    const { frames: got } = await frames("/runs/torn/events", 3);
    expect(kinds(got)).toEqual(["run_started", "ccg.unparsed", "run_finished"]);
    expect(got[1]?.data).toMatchObject({ raw: expect.stringContaining(`"seq":1`) as unknown });
  });

  it("404s an unknown run instead of opening an empty stream", async () => {
    const response = await fetch(`${base}/runs/nope/events`);
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no run 'nope'") as unknown,
    });
  });

  it("404s a run id that tries to climb out of the directory", async () => {
    const response = await fetch(`${base}/runs/${encodeURIComponent("../secret")}/events`);
    expect(response.status).toBe(404);
  });
});

describe("an event type this server has never heard of", () => {
  it("is forwarded with its seq, not reported as unparsed", async () => {
    const { frames: got } = await frames("/runs/ahead/events", 3);
    expect(kinds(got)).toEqual(["run_started", "node_annotated", "node_finished"]);
    expect(got.map((f) => f.id)).toEqual(["0", "1", "2"]);
    expect(got[1]?.data).toMatchObject({ node: "plan", note: "from a later writer" });
  });

  it("survives a resume, which is where withholding it was fatal", async () => {
    // The regression that matters: an unparsed line carries no seq and so is held
    // back on resume. A newer writer's events would therefore vanish on every
    // reconnect — the additive-only promise kept at the parse layer and broken
    // one layer down.
    const { frames: got } = await frames("/runs/ahead/events", 2, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(got.map((f) => f.id)).toEqual(["1", "2"]);
    expect(kinds(got)).toEqual(["node_annotated", "node_finished"]);
  });

  it("still reports a line with no seq as unparsed, since it cannot be resumed", async () => {
    const { frames: got } = await frames("/runs/ahead/events", 4);
    expect(kinds(got)[3]).toBe("ccg.unparsed");
    expect(got[3]?.id).toBeUndefined();
    expect(got[3]?.data).toMatchObject({ raw: `{"hello":"world"}` });
  });
});

describe("POST /runs/:id/gates/:node", () => {
  it("refuses a decision when no live run is attached", async () => {
    const response = await fetch(`${base}/runs/done/gates/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(501);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no live run is attached") as unknown,
    });
  });

  it("delivers to a resolver once one is wired up", async () => {
    const seen: Array<[string, string, GateDecision]> = [];
    server.setGateResolver((runId, node, decision) => {
      seen.push([runId, node, decision]);
    });
    try {
      const response = await fetch(`${base}/runs/done/gates/approval`, {
        method: "POST",
        body: JSON.stringify({ decision: "reject", note: "not yet" }),
      });
      expect(response.status).toBe(202);
      expect(seen).toEqual([["done", "approval", { decision: "reject", note: "not yet" }]]);
    } finally {
      server.setGateResolver(undefined);
    }
  });

  it("reports a resolver that refuses, rather than swallowing it", async () => {
    server.setGateResolver(() => {
      throw new Error("gate already closed");
    });
    try {
      const response = await fetch(`${base}/runs/done/gates/approval`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(response.status).toBe(500);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("gate already closed") as unknown,
      });
    } finally {
      server.setGateResolver(undefined);
    }
  });

  it("400s a decision that is not approve or reject", async () => {
    const response = await fetch(`${base}/runs/done/gates/approval`, {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(response.status).toBe(400);
  });

  it("404s a gate on a run that does not exist", async () => {
    const response = await fetch(`${base}/runs/nope/gates/approval`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("CORS", () => {
  it("allows the canvas dev origin on a listing", async () => {
    const response = await fetch(`${base}/runs`);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3210");
  });

  it("allows it on the stream too, and answers the preflight", async () => {
    const stream = await frames("/runs/done/events", 1);
    expect(stream.headers.get("access-control-allow-origin")).toBe("http://localhost:3210");

    const preflight = await fetch(`${base}/runs/done/gates/approval`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Last-Event-ID");
  });
});
