// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildGraph, parseSpec, SpecError, type Graph, type NodeSpec } from "@ccgrapher/core";
import {
  execute,
  ExpectsError,
  MissingGateResolverError,
  type GateDecision,
  type GateResolver,
  type NodeContext,
  type NodeExecutor,
  type NodeOutput,
  type RunResult,
} from "@ccgrapher/runner";
import type { TraceEvent } from "@ccgrapher/trace";
import { TraceWriter, type TraceEventInput } from "@ccgrapher/trace/node";
import { DEFAULT_PORT, startTraceServer, type TraceServer } from "../serve.js";

/**
 * `ccg run` — execute a spec for real and write the trace.
 *
 * The engine is `@ccgrapher/runner`, which has no filesystem, no clock of its
 * own and no way to ask a human anything. This command is the half that owns
 * all three: it resolves the implementations, opens the one trace file, and
 * decides who gets to answer a gate.
 *
 * Two things happen before a single node runs. Every non-gate node must have a
 * matching export, and every gate must have somebody who could answer it.
 * Finding either out halfway through a run is the failure this project exists
 * to prevent, so both are checked up front and reported in full.
 */

/** Where a trace goes when `--trace` does not say. Relative to the working directory. */
export const DEFAULT_RUN_DIR = "runs";

/**
 * Exit codes.
 *
 * `GATE_REJECTED` is its own code because the engine already distinguishes a
 * rejection from a failure, and flattening the two here would throw that away:
 * a script needs to be able to tell "the workflow broke" from "a human said no".
 * It is checked first — a run that stopped at a rejected gate is reported as
 * such even when something else failed on the way there.
 */
const OK = 0;
const RUN_FAILED = 1;
const USAGE = 2;
const GATE_REJECTED = 3;

const stderr = (line: string): void => void process.stderr.write(line);

/** How much of the spec hash goes into the trace. Enough to tell two texts apart, short enough to read. */
const SPEC_HASH_CHARS = 16;

/** What an implementation module is expected to export, one per node id. */
type NodeImpl = (context: NodeContext) => unknown;

/**
 * The engine stamps a full envelope; `TraceWriter` stamps its own.
 *
 * The writer owns `seq` for its file, which is the whole reason its counter
 * exists, so the envelope comes off here rather than two counters being trusted
 * to agree. `ts` is kept and passed through: the run's clock is the one that
 * timed the node.
 */
function withoutEnvelope(event: TraceEvent): TraceEventInput {
  const { v: _v, runId: _runId, seq: _seq, ts: _ts, ...rest } = event;
  return rest;
}

/** A short, sortable, unique run id. Doubles as the trace filename and the id `ccg serve` streams. */
function runIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${slug}-${stamp}-${randomBytes(3).toString("hex")}`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** A value in one short phrase, for an error message about a wrong return type. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return `${JSON.stringify(value).slice(0, 60)}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * What an implementation handed back, checked rather than trusted.
 *
 * An impl that returns a bare value instead of `{ output }` would have its
 * result silently dropped — the node would be recorded as done with nothing to
 * show, and everything downstream would run on an input that never arrived.
 * That is a lie the trace would then carry forever, so it fails the node loudly
 * instead.
 */
function asOutput(node: string, value: unknown): NodeOutput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    if ("output" in value || "usage" in value) return value as NodeOutput;
  }
  throw new Error(
    `${node}: the implementation returned ${describe(value)} — a node returns ` +
      `{ output?, usage? } or nothing at all`,
  );
}

/**
 * Ask on the terminal, one gate at a time.
 *
 * Two gates on one rank run concurrently, because that is what the rank says
 * about them, and two readline interfaces reading one stdin would each take
 * half the keystrokes. So the terminal is serialised even though the graph is
 * not: the run is still parallel, only the asking is queued.
 */
function terminalGate(): GateResolver {
  let queue: Promise<unknown> = Promise.resolve();
  return (node, payload) => {
    const asked = queue.then(() => promptGate(node, payload));
    // The queue itself must never reject, or every gate after a failed one
    // would inherit that failure instead of getting its turn.
    queue = asked.catch(() => undefined);
    return asked;
  };
}

/**
 * Ask on the terminal.
 *
 * The payload is printed first, because a gate whose prompt cannot show what is
 * being approved is asking for a rubber stamp. A terminal that closes mid-
 * question fails the run rather than hanging on an answer that is never coming.
 */
async function promptGate(node: NodeSpec, payload: unknown): Promise<GateDecision> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let onClose: ((cause: Error) => void) | undefined;
  const closed = new Promise<never>((_, fail) => {
    onClose = fail;
  });
  rl.once("close", () => onClose?.(new Error(`${node.id}: the terminal closed before the gate was answered`)));

  try {
    stderr(`\n${node.label} (${node.id}) is waiting on you:\n`);
    stderr(`${JSON.stringify(payload, null, 2)}\n`);
    for (;;) {
      const answer = await Promise.race([rl.question(`  approve ${node.id}? [y/n] `), closed]);
      const said = answer.trim().toLowerCase();
      if (said === "y" || said === "yes") return { decision: "approve" };
      if (said === "n" || said === "no") return { decision: "reject", note: "rejected at the terminal" };
      stderr(`  answer y or n\n`);
    }
  } finally {
    // Dropped before closing, so the close this very line causes cannot reject
    // a promise nobody is waiting on any more.
    onClose = undefined;
    rl.close();
  }
}

/**
 * Load the module and pair every node with its export.
 *
 * Gates are not in the list: the engine never calls an executor for one, so
 * demanding an implementation would be asking for code that could only ever be
 * dead. Lookup is by property rather than by destructuring, because a node id
 * is any non-empty string and need not be a valid identifier.
 */
async function loadImpls(
  path: string,
  graph: Graph,
): Promise<{ impls: Map<string, NodeImpl> } | { missing: string[] }> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;

  const impls = new Map<string, NodeImpl>();
  const missing: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind === "gate") continue;
    const impl = module[node.id];
    if (typeof impl === "function") impls.set(node.id, impl as NodeImpl);
    else missing.push(node.id);
  }
  return missing.length > 0 ? { missing } : { impls };
}

/** One line of human progress per event. The trace has the detail; this wants to be readable. */
function report(event: TraceEvent, gateHint: (node: string) => void): void {
  switch (event.type) {
    case "node_started":
      stderr(`  → ${event.node}${event.of === undefined ? "" : ` [${event.instance}/${event.of}]`}\n`);
      return;
    case "node_log":
      stderr(`    ${event.node ?? "run"}: ${event.line}\n`);
      return;
    case "node_finished":
      stderr(
        `  ✔ ${event.node}${event.instance === undefined ? "" : ` [${event.instance}]`}  ${formatMs(event.durationMs)}\n`,
      );
      return;
    case "node_failed":
      stderr(
        `  ✘ ${event.node}${event.instance === undefined ? "" : ` [${event.instance}]`}  ${event.error}\n`,
      );
      return;
    case "gate_waiting":
      stderr(`  ⏸ ${event.node} — waiting for a decision\n`);
      gateHint(event.node);
      return;
    case "gate_resolved": {
      const approved = event.decision === "approve";
      stderr(
        `  ${approved ? "✔" : "✘"} ${event.node} — ${approved ? "approved" : "rejected"}` +
          `${event.note ? `: ${event.note}` : ""}\n`,
      );
      return;
    }
    case "run_started":
    case "run_finished":
      return;
  }
}

/** How the run ended, in the terms `RunResult` uses. */
function summarise(result: RunResult): string {
  const counts = new Map<string, number>();
  for (const node of result.nodes.values()) {
    counts.set(node.outcome, (counts.get(node.outcome) ?? 0) + 1);
  }
  const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  return `${result.nodes.size} node(s): ${parts.join(", ")}`;
}

export interface RunOptions {
  readonly spec: string;
  readonly impl: string;
  readonly trace?: string;
  readonly serve: boolean;
  readonly port: number;
  readonly timeoutMs?: number;
}

/**
 * The whole command, minus argument parsing.
 *
 * Async, so a test can await the exit code instead of watching a process; the
 * dispatcher gets the synchronous wrapper below.
 */
export async function runSpec(options: RunOptions): Promise<number> {
  let text: string;
  let graph: Graph;
  try {
    text = readFileSync(options.spec, "utf8");
    graph = buildGraph(parseSpec(text, options.spec));
  } catch (cause) {
    if (cause instanceof SpecError) {
      stderr(`${cause.message}\n`);
      return USAGE;
    }
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      stderr(`ccg run: cannot read ${options.spec}\n`);
      return USAGE;
    }
    throw cause;
  }

  const gates = [...graph.nodes.values()].filter((node) => node.kind === "gate");
  const onTty = process.stdin.isTTY === true;
  if (gates.length > 0 && !options.serve && !onTty) {
    // The one thing this command must never do. An unattended gate that
    // approves itself is precisely the lie the project keeps finding.
    stderr(
      `ccg run: ${options.spec} has ${gates.length} gate(s) — ${gates.map((g) => g.id).join(", ")} — ` +
        `and nothing here can answer them: stdin is not a terminal and --serve was not given.\n` +
        `  Approving them unattended would not be honest, so the run does not start.\n`,
    );
    return USAGE;
  }

  // The trace file and the run id are the same fact: `ccg serve` streams
  // `<id>.jsonl`, and the fold keys on the id, so letting them drift would make
  // a run unservable and its own file unreadable against it.
  const tracePath = options.trace ?? join(DEFAULT_RUN_DIR, `${runIdFor(graph.spec.name)}.jsonl`);
  const runId = basename(tracePath).replace(/\.jsonl$/, "");
  if (options.serve && !tracePath.endsWith(".jsonl")) {
    stderr(`ccg run: --serve needs the trace to be named <run-id>.jsonl; ${tracePath} is not\n`);
    return USAGE;
  }
  if (existsSync(tracePath)) {
    // Appending would put two runs in one file with two sequences numbered from
    // zero, and a trace is a record rather than something to write over.
    stderr(`ccg run: ${tracePath} already exists — a trace is a record, not something to overwrite\n`);
    return USAGE;
  }

  const loaded = await loadImpls(options.impl, graph).catch((cause: unknown) => cause as Error);
  if (loaded instanceof Error) {
    stderr(`ccg run: cannot load ${options.impl}: ${loaded.message}\n`);
    return USAGE;
  }
  if ("missing" in loaded) {
    // Every one of them, now, rather than one per run until they are all found.
    stderr(
      `ccg run: ${options.impl} has no implementation for ${loaded.missing.length} node(s):\n` +
        loaded.missing.map((id) => `  ${id}\n`).join("") +
        `  Each node needs an exported function named after its id. Nothing was run.\n`,
    );
    return USAGE;
  }
  const { impls } = loaded;

  mkdirSync(dirname(resolve(tracePath)), { recursive: true });

  /**
   * One writer, always. With `--serve` the server reads this same file rather
   * than a second process writing its own copy of the same run.
   */
  const writer = new TraceWriter(tracePath, runId);

  let server: TraceServer | undefined;
  const pending = new Map<string, (decision: GateDecision) => void>();
  if (options.serve) {
    server = await startTraceServer({ dir: dirname(resolve(tracePath)), port: options.port });
    server.setGateResolver((id, node, decision) => {
      if (id !== runId) throw new Error(`this process is running '${runId}', not '${id}'`);
      const settle = pending.get(node);
      // Refused rather than remembered: a decision filed against a gate nobody
      // is waiting at would either be lost or applied to a later run of it.
      if (!settle) throw new Error(`${node} is not waiting for a decision`);
      pending.delete(node);
      settle(decision);
    });
  }

  const gate: GateResolver = server
    ? (node) =>
        new Promise<GateDecision>((settle) => {
          pending.set(node.id, settle);
        })
    : terminalGate();

  const gateHint = (node: string): void => {
    if (!server) return;
    stderr(
      `      curl -sX POST ${server.url}/runs/${runId}/gates/${node} ` +
        `-d '{"decision":"approve"}'\n`,
    );
  };

  const executor: NodeExecutor = async (context) => {
    const impl = impls.get(context.node.id);
    // Unreachable: every non-gate node was paired with an export above.
    if (!impl) throw new Error(`${context.node.id}: no implementation was resolved`);
    return asOutput(context.node.id, await impl(context));
  };

  stderr(`ccg run: ${graph.spec.name} — ${graph.nodes.size} node(s), trace ${tracePath}\n`);
  if (server) stderr(`  serving ${server.url} — GET /runs/${runId}/events\n`);

  try {
    const result = await execute(graph, executor, {
      runId,
      emit: (event) => {
        writer.write(withoutEnvelope(event), event.ts);
        report(event, gateHint);
      },
      gate: gates.length > 0 ? gate : undefined,
      timeoutMs: options.timeoutMs,
      specHash: createHash("sha256").update(text).digest("hex").slice(0, SPEC_HASH_CHARS),
    });

    const rejected = [...result.nodes.values()].filter((node) => node.outcome === "rejected");
    if (rejected.length > 0) {
      stderr(`run stopped at a rejected gate in ${formatMs(result.durationMs)} — ${summarise(result)}\n`);
      return GATE_REJECTED;
    }
    stderr(
      `${result.ok ? "run ok" : "run failed"} in ${formatMs(result.durationMs)} — ${summarise(result)}\n`,
    );
    return result.ok ? OK : RUN_FAILED;
  } catch (cause) {
    // `execute` rejects only where the run could not honestly continue. The
    // trace already carries `run_finished`, so this is about the exit code and
    // saying the same thing on the terminal.
    if (cause instanceof ExpectsError) {
      stderr(`run stopped: ${cause.message}\n`);
      return RUN_FAILED;
    }
    if (cause instanceof MissingGateResolverError) {
      stderr(`run stopped: ${cause.message}\n`);
      return USAGE;
    }
    stderr(`run stopped: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return RUN_FAILED;
  } finally {
    // Closed either way. The run is over, so a stream held open would be
    // following a file nothing is going to append to; `ccg serve` replays it.
    await server?.close();
    stderr(`trace: ${tracePath}\n`);
  }
}

/**
 * The dispatcher is synchronous and a run is not, so the exit code lands on
 * `process.exitCode` once the run ends — the same shape `ccg serve` uses. The
 * assignment in `index.ts` has already happened by then, which is what makes
 * this safe rather than a race.
 */
export function runCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      /** The module whose exports implement the nodes. */
      impl: { type: "string" },
      trace: { type: "string" },
      /** Embed the trace server so a canvas can watch, and answer gates over HTTP. */
      serve: { type: "boolean", default: false },
      port: { type: "string", default: String(DEFAULT_PORT) },
      /** Per node, in seconds. */
      timeout: { type: "string" },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const spec = positionals[0];
  if (!spec) {
    stderr("ccg run: no spec file given\n");
    return USAGE;
  }
  if (!values.impl) {
    stderr("ccg run: --impl <module> is required (a JS module exporting one function per node)\n");
    return USAGE;
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      stderr("ccg run: --timeout must be a positive number of seconds\n");
      return USAGE;
    }
    timeoutMs = Math.round(seconds * 1000);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    stderr("ccg run: --port must be a whole number from 0 to 65535\n");
    return USAGE;
  }

  void runSpec({
    spec,
    impl: values.impl,
    trace: values.trace,
    serve: values.serve,
    port,
    timeoutMs,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      stderr(`ccg run: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = USAGE;
    },
  );

  return OK;
}
