// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyRunState, isTraceEvent, reduceRun } from "@ccgrapher/trace";
import { readTrace } from "@ccgrapher/trace/node";
import {
  appendHook,
  capabilitiesIn,
  capabilityForTool,
  eventsForHook,
  runIdForSession,
  tracePathFor,
  withTraceLock,
  HOOK_TRACE_SOURCE,
  type HookPayload,
} from "../src/index.js";

let dir: string;
let next = 0;
const session = (): string => `session-${(next += 1)}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccg-cc-hooks-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionStart = (overrides: HookPayload = {}): HookPayload => ({
  hook_event_name: "SessionStart",
  session_id: "s-1",
  cwd: "/Users/someone/Development/research-desk",
  source: "startup",
  ...overrides,
});

const postToolUse = (
  tool_name: string,
  tool_input?: unknown,
  tool_response?: unknown,
): HookPayload => ({
  hook_event_name: "PostToolUse",
  session_id: "s-1",
  cwd: "/Users/someone/Development/research-desk",
  tool_name,
  ...(tool_input === undefined ? {} : { tool_input }),
  ...(tool_response === undefined ? {} : { tool_response }),
});

describe("eventsForHook — SessionStart", () => {
  it("opens the run, names the spec after the project directory, and never claims the reserved source", () => {
    const [started, ...rest] = eventsForHook(sessionStart());

    expect(started).toEqual({
      type: "run_started",
      spec: { name: "research-desk" },
      source: "claude-code-hooks",
      args: {
        sessionId: "s-1",
        cwd: "/Users/someone/Development/research-desk",
        startSource: "startup",
      },
    });
    // `claude-code-watch` names a different, unbuilt component. A hook trace
    // claiming it would attribute this file to something that never ran.
    expect(HOOK_TRACE_SOURCE).toBe("claude-code-hooks");
    expect(started).not.toHaveProperty("source", "claude-code-watch");
    expect(rest).toEqual([]);
  });

  it("falls back to a generic name when no directory is reported", () => {
    const [started] = eventsForHook({ hook_event_name: "SessionStart", session_id: "s-1" });
    expect(started).toMatchObject({ spec: { name: "claude-code-session" } });
  });

  it("reports one capability_available per capability the payload names", () => {
    const events = eventsForHook(
      sessionStart({
        mcp_servers: [{ name: "linear", tools: ["issues_list", { name: "issues_create" }] }],
        tools: ["Read", "Bash", "mcp__hostinger__dns_get"],
        skills: ["house-style"],
        agents: [{ type: "Explore" }],
      }),
    );

    expect(events.slice(1)).toEqual([
      { type: "capability_available", capability: "mcp:hostinger/dns_get" },
      { type: "capability_available", capability: "mcp:linear/issues_list" },
      { type: "capability_available", capability: "mcp:linear/issues_create" },
      { type: "capability_available", capability: "skill:house-style" },
      { type: "capability_available", capability: "agent:Explore" },
    ]);
  });

  it("reports nothing rather than guessing when a server lists no tools", () => {
    // Silence is not absence, and `mcp:<server>` is not an id in this
    // vocabulary — minting one would never match any invocation.
    expect(capabilitiesIn({ mcp_servers: [{ name: "linear", status: "connected" }] })).toEqual([]);
  });
});

describe("capabilityForTool", () => {
  it("translates an MCP tool name into the namespaced id", () => {
    expect(capabilityForTool("mcp__srv__tool")).toBe("mcp:srv/tool");
  });

  it("splits at the first doubled underscore, so single ones survive in both halves", () => {
    expect(capabilityForTool("mcp__ccd_session__mark_chapter")).toBe("mcp:ccd_session/mark_chapter");
    expect(capabilityForTool("mcp__srv__a__b")).toBe("mcp:srv/a__b");
  });

  it("names a skill and a subagent from their inputs", () => {
    expect(capabilityForTool("Skill", { skill: "house-style" })).toBe("skill:house-style");
    expect(capabilityForTool("Task", { subagent_type: "Explore" })).toBe("agent:Explore");
  });

  it("records nothing for a built-in, or for a call whose input names nothing", () => {
    expect(capabilityForTool("Read", { file_path: "/tmp/x" })).toBeUndefined();
    expect(capabilityForTool("Bash")).toBeUndefined();
    expect(capabilityForTool("Skill", {})).toBeUndefined();
    expect(capabilityForTool("Task", { description: "look around" })).toBeUndefined();
  });
});

describe("eventsForHook — PostToolUse", () => {
  it("records an invocation with no node, because a hook has no spec to attribute it to", () => {
    const events = eventsForHook(postToolUse("mcp__srv__tool"));
    expect(events).toEqual([{ type: "capability_invoked", capability: "mcp:srv/tool" }]);
    expect(events[0]).not.toHaveProperty("node");
  });

  it("records a skill call and a subagent call", () => {
    expect(eventsForHook(postToolUse("Skill", { skill: "wrap" }))).toEqual([
      { type: "capability_invoked", capability: "skill:wrap" },
    ]);
    expect(eventsForHook(postToolUse("Task", { subagent_type: "Explore" }))).toEqual([
      { type: "capability_invoked", capability: "agent:Explore" },
    ]);
  });

  it("says nothing at all about a built-in tool call", () => {
    expect(eventsForHook(postToolUse("Write", { file_path: "/tmp/x" }))).toEqual([]);
  });

  it("reads a connection-class failure as the capability going away", () => {
    const events = eventsForHook(
      postToolUse("mcp__srv__tool", {}, { error: "MCP error -32000: Connection closed" }),
    );
    expect(events).toEqual([
      { type: "capability_lost", capability: "mcp:srv/tool", reason: "MCP error -32000: Connection closed" },
    ]);
  });

  it("still counts an invocation when the server answered, badly", () => {
    // The server was reached and said no. That is a use of the capability.
    const events = eventsForHook(
      postToolUse("mcp__srv__tool", {}, { is_error: true, content: "invalid arguments: expected a number" }),
    );
    expect(events).toEqual([{ type: "capability_invoked", capability: "mcp:srv/tool" }]);
  });

  it("does not mistake a successful result that merely mentions a connection for a lost one", () => {
    const events = eventsForHook(
      postToolUse("mcp__srv__tool", {}, { content: "the log says: connection refused" }),
    );
    expect(events).toEqual([{ type: "capability_invoked", capability: "mcp:srv/tool" }]);
  });
});

describe("eventsForHook — the hooks with nothing to say", () => {
  it("writes no line for the events this contract has no word for", () => {
    for (const name of ["PreToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "Notification", "PreCompact"]) {
      expect(eventsForHook({ hook_event_name: name, session_id: "s-1" })).toEqual([]);
    }
    expect(eventsForHook({ session_id: "s-1" })).toEqual([]);
  });
});

describe("eventsForHook — SessionEnd", () => {
  it("closes the run with a duration measured from the run's first event", () => {
    const events = eventsForHook(
      { hook_event_name: "SessionEnd", session_id: "s-1", reason: "clear" },
      { startedAt: "2026-08-07T10:00:00.000Z", now: "2026-08-07T10:02:30.000Z" },
    );
    expect(events).toEqual([{ type: "run_finished", ok: true, durationMs: 150_000 }]);
  });

  it("closes nothing when no start was ever recorded, rather than inventing a zero", () => {
    expect(eventsForHook({ hook_event_name: "SessionEnd", session_id: "s-1" }, {})).toEqual([]);
  });
});

describe("appendHook", () => {
  it("writes <runId>.jsonl, with the run id equal to the filename stem", () => {
    const id = session();
    appendHook(sessionStart({ session_id: id }), { dir });

    const path = tracePathFor(dir, id);
    expect(existsSync(path)).toBe(true);
    const [first] = readTrace(path).filter(isTraceEvent);
    expect(first?.runId).toBe(runIdForSession(id));
    expect(path.endsWith(`${first?.runId}.jsonl`)).toBe(true);
  });

  it("keeps seq strictly increasing across separate invocations", () => {
    // The whole reason this is a package. Each call builds its own writer from
    // the file's tail exactly as a fresh hook process does; a writer that simply
    // started at zero would produce 0, 0, 0 — unorderable, and colliding on
    // every SSE id a reconnecting reader resumes from.
    const id = session();
    appendHook(sessionStart({ session_id: id }), { dir });
    for (const tool of ["mcp__srv__one", "mcp__srv__two", "Skill", "mcp__srv__three"]) {
      appendHook({ ...postToolUse(tool, { skill: "wrap" }), session_id: id }, { dir });
    }

    const seqs = readTrace(tracePathFor(dir, id))
      .filter(isTraceEvent)
      .map((event) => event.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }
  });

  it("produces a file that folds with no unknown lines and no reserved source", () => {
    const id = session();
    const started = "2026-08-07T09:00:00.000Z";
    appendHook(sessionStart({ session_id: id, mcp_servers: [{ name: "srv", tools: ["tool"] }] }), {
      dir,
      now: started,
    });
    appendHook({ ...postToolUse("mcp__srv__tool"), session_id: id }, { dir });
    appendHook({ ...postToolUse("Task", { subagent_type: "Explore" }), session_id: id }, { dir });
    appendHook(
      { ...postToolUse("mcp__srv__tool", {}, { error: "socket hang up" }), session_id: id },
      { dir },
    );
    appendHook({ hook_event_name: "SessionEnd", session_id: id, reason: "clear" }, {
      dir,
      now: "2026-08-07T09:00:12.000Z",
    });

    const lines = readTrace(tracePathFor(dir, id));
    expect(lines.filter((line) => line.type === "unknown")).toEqual([]);
    expect(lines.length).toBe(6);

    const events = lines.filter(isTraceEvent);
    const opened = events.find((event) => event.type === "run_started");
    expect(opened).toMatchObject({ source: "claude-code-hooks" });
    expect(opened).not.toMatchObject({ source: "claude-code-watch" });
    const closed = events.find((event) => event.type === "run_finished");
    expect(closed).toMatchObject({ ok: true, durationMs: 12_000 });

    const state = lines.reduce(reduceRun, emptyRunState(runIdForSession(id)));
    expect(state.status).toBe("done");
    expect(state.spec?.name).toBe("research-desk");
    expect(state.capabilities.get("mcp:srv/tool")).toMatchObject({ available: false, invocations: 1 });
    expect(state.capabilities.get("agent:Explore")).toMatchObject({ invocations: 1 });
    // Nothing was attributed to a node, because nothing could honestly be.
    expect(state.nodes.size).toBe(0);
  });

  it("refuses a payload with no session id rather than writing an unidentifiable run", () => {
    expect(() => appendHook({ hook_event_name: "SessionStart" }, { dir })).toThrow(/session_id/);
  });
});

describe("withTraceLock", () => {
  const lockOf = (path: string): string => `${path}.lock`;

  it("releases the lock afterwards, including when the body throws", () => {
    const path = join(dir, "lock-1.jsonl");
    expect(withTraceLock(path, () => "done")).toBe("done");
    expect(existsSync(lockOf(path))).toBe(false);

    expect(() =>
      withTraceLock(path, () => {
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    expect(existsSync(lockOf(path))).toBe(false);
  });

  it("gives up rather than appending beside another holder", () => {
    const path = join(dir, "lock-2.jsonl");
    closeSync(openSync(lockOf(path), "wx"));
    let ran = false;
    expect(() =>
      withTraceLock(path, () => (ran = true), { retries: 2, retryMs: 1, staleMs: 60_000 }),
    ).toThrow(/could not take/);
    expect(ran).toBe(false);
    rmSync(lockOf(path));
  });

  it("reclaims a lock left behind by a process that died holding it", () => {
    const path = join(dir, "lock-3.jsonl");
    closeSync(openSync(lockOf(path), "wx"));
    const longAgo = new Date(Date.now() - 120_000);
    utimesSync(lockOf(path), longAgo, longAgo);

    expect(withTraceLock(path, () => "reclaimed", { retries: 2, retryMs: 1 })).toBe("reclaimed");
    expect(existsSync(lockOf(path))).toBe(false);
  });

  it("waits for a lock a genuinely separate process is holding", async () => {
    const path = join(dir, "lock-4.jsonl");
    closeSync(openSync(lockOf(path), "wx"));

    // A real second process, because the wait is a synchronous block: nothing
    // in this thread could release the lock while `withTraceLock` is spinning.
    const child = spawn(process.execPath, [
      "-e",
      `setTimeout(() => require("node:fs").unlinkSync(${JSON.stringify(lockOf(path))}), 250)`,
    ]);
    const exited = new Promise<void>((done) => child.once("exit", () => done()));

    const before = Date.now();
    const value = withTraceLock(path, () => "waited");
    const waited = Date.now() - before;
    await exited;

    expect(value).toBe("waited");
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(existsSync(lockOf(path))).toBe(false);
  });
});

describe("runIdForSession", () => {
  it("prefixes the session id, so hook traces are distinguishable in a shared runs/", () => {
    expect(runIdForSession("0199-abcd")).toBe("cc-0199-abcd");
  });

  it("keeps the id usable as a filename", () => {
    expect(runIdForSession("../../etc/passwd")).toBe("cc-etc-passwd");
    expect(() => runIdForSession("///")).toThrow(/nothing usable/);
  });
});

describe("a hook event from a newer Claude Code", () => {
  it("is skipped rather than guessed at, and leaves no file behind", () => {
    const id = session();
    expect(appendHook({ hook_event_name: "SomethingLater", session_id: id }, { dir })).toEqual([]);
    expect(existsSync(tracePathFor(dir, id))).toBe(false);
  });
});
