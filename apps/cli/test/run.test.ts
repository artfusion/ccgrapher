// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRunState, reduceRun, type RunState } from "@ccgrapher/trace";
import { readTrace } from "@ccgrapher/trace/node";
import { afterAll, describe, expect, it } from "vitest";
import { runSpec, type RunOptions } from "../src/commands/run.js";

/**
 * `ccg run` end to end.
 *
 * Every test folds the trace it produced through `reduceRun` and asserts on the
 * resulting `RunState`. That is the property worth pinning: the exit code the
 * CLI reports and the picture the canvas draws are two readings of one file, and
 * a test that only checked the exit code would let them drift apart quietly.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/cli/dist/index.js");
const fixture = (name: string) => join(root, "apps/cli/test/fixtures", name);
const example = (name: string) => join(root, "examples", name);

const work = mkdtempSync(join(tmpdir(), "ccg-run-"));
let written = 0;

/** A fresh trace path, so the "already exists" guard only fires where a test wants it to. */
function tracePath(): string {
  written += 1;
  return join(work, `t${written}.jsonl`);
}

function options(spec: string, impl: string, extra: Partial<RunOptions> = {}): RunOptions {
  return { spec, impl, trace: tracePath(), serve: false, port: 0, ...extra };
}

/** A run's id is its trace filename. That equivalence is what makes `ccg serve` able to find it. */
const idOf = (options: RunOptions) => basename(options.trace!).replace(/\.jsonl$/, "");

/** The state a reader of the file arrives at, which is what the canvas binds to. */
function fold(path: string): RunState {
  const lines = readTrace(path);
  const started = lines.find((line) => line.type === "run_started");
  return lines.reduce(reduceRun, emptyRunState(started?.runId ?? ""));
}

const statuses = (state: RunState): Record<string, string> =>
  Object.fromEntries([...state.nodes].map(([id, node]) => [id, node.status]));

/**
 * Everything the command writes to stderr, readable while it is still running.
 *
 * The embedded server's port is only knowable from what the run prints, and a
 * test that hard-coded one would be fighting whatever else is listening.
 */
function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return { text: () => text, restore: () => void (process.stderr.write = original) };
}

/** Runs the body with stderr captured, and hands back everything it printed. */
async function withStderr<T>(
  body: (text: () => string) => Promise<T>,
): Promise<{ result: T; text: string }> {
  const capture = captureStderr();
  try {
    return { result: await body(capture.text), text: capture.text() };
  } finally {
    capture.restore();
  }
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The `http://host:port` the run printed for its embedded server, once it has printed it. */
async function servedUrl(text: () => string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const url = /serving (http:\/\/\S+)/.exec(text())?.[1];
    if (url) return url;
    await tick(10);
  }
  throw new Error(`no server url in:\n${text()}`);
}

/**
 * Poll until the gate is genuinely waiting, then answer it.
 *
 * A decision offered before the gate is reached is refused rather than
 * remembered, so 202 is the only answer that means it landed.
 */
async function answerGate(
  url: string,
  runId: string,
  node: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(`${url}/runs/${runId}/gates/${node}`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    }).catch(() => undefined);
    if (response?.status === 202) return;
    await tick(20);
  }
  throw new Error(`${node} never accepted a decision`);
}

/** One served run, answered at its one gate. */
async function runAndAnswer(
  run: RunOptions,
  node: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<{ code: number; text: string }> {
  const { result, text } = await withStderr(async (stderr) => {
    const running = runSpec(run);
    const url = await servedUrl(stderr);
    await answerGate(url, idOf(run), node, decision, note);
    return running;
  });
  return { code: result, text };
}

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("a run that goes to plan", () => {
  it("exits 0 and writes a trace the fold reads as done", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-clean.impl.mjs"));
    expect((await withStderr(() => runSpec(run))).result).toBe(0);

    const state = fold(run.trace!);
    expect(state.status).toBe("done");
    expect(statuses(state)).toEqual({ alpha: "done", beta: "done", gamma: "done" });
    expect(state.spec?.name).toBe("run-clean");
    // The hash is of the spec text, so two runs of "the same" workflow can be told apart.
    expect(state.spec?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(state.runId).toBe(idOf(run));
  });

  it("carries a node's logs and usage through to the file", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-clean.impl.mjs"));
    await withStderr(() => runSpec(run));

    const state = fold(run.trace!);
    expect(state.nodes.get("alpha")?.tail).toEqual(["seeding"]);
    expect(state.nodes.get("beta")?.usage).toEqual({
      model: "demo",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0002,
    });
  });

  it("numbers the file's events from zero, without a gap", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-clean.impl.mjs"));
    await withStderr(() => runSpec(run));
    const seqs = readTrace(run.trace!).map((line) => (line.type === "unknown" ? -1 : line.seq));
    expect(seqs).toEqual([...seqs.keys()]);
  });
});

describe("an implementation that does not cover the spec", () => {
  it("names every missing node at once, before anything runs", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-missing.impl.mjs"));
    const { result, text } = await withStderr(() => runSpec(run));

    expect(result).toBe(2);
    expect(text).toContain("no implementation for 2 node(s)");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
    expect(text).toContain("Nothing was run.");
    // The point of finding out up front: no trace, because there was no run.
    expect(existsSync(run.trace!)).toBe(false);
  });

  it("reports a module it cannot even load", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("no-such-module.mjs"));
    const { result, text } = await withStderr(() => runSpec(run));
    expect(result).toBe(2);
    expect(text).toContain("cannot load");
    expect(existsSync(run.trace!)).toBe(false);
  });
});

describe("the live demo", () => {
  it("fails the one node that fails, skips what needed it, and finishes the rest", async () => {
    const run = options(example("live-demo.yaml"), example("live-demo.impl.mjs"), { serve: true });
    const { code, text } = await runAndAnswer(run, "review", "approve");

    // 1, not 3: the gate was approved, and a node failed.
    expect(code).toBe(1);
    expect(text).toContain("run failed");

    const state = fold(run.trace!);
    expect(state.status).toBe("failed");
    expect(statuses(state)).toEqual({
      plan: "done",
      fetch_docs: "done",
      fetch_code: "failed",
      count_lines: "failed",
      summarise: "done",
      review: "done",
      publish: "done",
    });
    expect(state.nodes.get("count_lines")?.error).toBe("skipped: no result from fetch_code");
    // The gate saw the summary it was approving, not a bare "please confirm".
    expect(JSON.stringify(state.nodes.get("review")?.gatePayload)).toContain("live-demo");
  });
});

describe("gates", () => {
  it("carries on when the decision is approve", async () => {
    const run = options(fixture("run-gate.yaml"), fixture("run-gate.impl.mjs"), { serve: true });
    const { code } = await runAndAnswer(run, "review", "approve");

    expect(code).toBe(0);
    const state = fold(run.trace!);
    expect(state.status).toBe("done");
    expect(statuses(state)).toEqual({ draft: "done", review: "done", ship: "done" });
  });

  it("stops the downstream when the decision is reject, with its own exit code", async () => {
    const run = options(fixture("run-gate.yaml"), fixture("run-gate.impl.mjs"), { serve: true });
    const { code } = await runAndAnswer(run, "review", "reject", "not this time");

    // 3, distinct from the 1 a broken run gets: a human said no, nothing broke.
    expect(code).toBe(3);
    const state = fold(run.trace!);
    expect(state.status).toBe("failed");
    expect(statuses(state)).toEqual({ draft: "done", review: "failed", ship: "failed" });
    expect(state.nodes.get("review")?.error).toBe("not this time");
    expect(state.nodes.get("ship")?.error).toBe("skipped: no result from review");
  });

  it("refuses to start when nobody could answer, rather than approving unattended", async () => {
    const run = options(fixture("run-gate.yaml"), fixture("run-gate.impl.mjs"));
    // vitest gives the process no TTY, which is exactly the unattended case.
    const { result, text } = await withStderr(() => runSpec(run));

    expect(result).toBe(2);
    expect(text).toContain("review");
    expect(text).toContain("would not be honest");
    expect(existsSync(run.trace!)).toBe(false);
  });
});

describe("--timeout", () => {
  it("fails the node that outlived it, and skips what needed it", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-clean.impl.mjs"), {
      timeoutMs: 20,
    });
    expect((await withStderr(() => runSpec(run))).result).toBe(1);

    const state = fold(run.trace!);
    expect(state.status).toBe("failed");
    expect(statuses(state)).toEqual({ alpha: "done", beta: "failed", gamma: "failed" });
    expect(state.nodes.get("beta")?.error).toContain("timed out after 20ms");
  });
});

describe("the trace file", () => {
  it("is never appended to by a second run", async () => {
    const run = options(fixture("run-clean.yaml"), fixture("run-clean.impl.mjs"));
    expect((await withStderr(() => runSpec(run))).result).toBe(0);

    const { result, text } = await withStderr(() => runSpec(run));
    expect(result).toBe(2);
    expect(text).toContain("a trace is a record");
    expect(readTrace(run.trace!).filter((line) => line.type === "run_started")).toHaveLength(1);
  });
});

describe("through the real binary", () => {
  it("writes runs/<run-id>.jsonl when --trace does not say otherwise", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ccg-run-cwd-"));
    try {
      const run = spawnSync(
        "node",
        [cli, "run", fixture("run-clean.yaml"), "--impl", fixture("run-clean.impl.mjs")],
        { cwd, encoding: "utf8" },
      );
      expect(run.status).toBe(0);

      const files = readdirSync(join(cwd, "runs"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^run-clean-\d{8}T\d{6}-[0-9a-f]{6}\.jsonl$/);
      expect(fold(join(cwd, "runs", files[0]!)).status).toBe("done");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("2 on bad usage, and it says which argument", () => {
    const run = spawnSync("node", [cli, "run", fixture("run-clean.yaml")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--impl");
  });

  it("2 on a --timeout that is not a positive number of seconds", () => {
    const run = spawnSync(
      "node",
      [
        cli,
        "run",
        fixture("run-clean.yaml"),
        "--impl",
        fixture("run-clean.impl.mjs"),
        "--timeout",
        "0",
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--timeout");
  });
});
