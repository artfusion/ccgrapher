// SPDX-License-Identifier: Apache-2.0
import { basename, resolve } from "node:path";
import type { TraceEventInput } from "@ccgrapher/trace/node";

/**
 * What Claude Code hands a hook on stdin.
 *
 * Deliberately loose, and read defensively everywhere below. The hook payload is
 * another product's shape, not this contract's: fields get added, and a version
 * of Claude Code newer than this package will send things it has never heard of.
 * Refusing a payload over an unexpected field would lose the whole event, so an
 * unreadable field is skipped and the rest of the payload still counts.
 *
 * The fields named here are the documented ones — `hook_event_name`,
 * `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, and
 * `SessionStart`'s own `source`. The capability fields read by
 * {@link capabilitiesIn} are **not** documented and are a guess; see its notes.
 */
export interface HookPayload {
  readonly [key: string]: unknown;
}

/** Where a hook's events are attributed. `claude-code-watch` is a different, unbuilt component. */
export const HOOK_TRACE_SOURCE = "claude-code-hooks";

/** The name a session gets when the payload names no directory to derive one from. */
export const FALLBACK_SPEC_NAME = "claude-code-session";

/**
 * `mcp__<server>__<tool>`, split at the **first** `__` after the prefix.
 *
 * Server and tool names may both contain single underscores — `ccd_session`,
 * `mark_chapter` — so the separator is the doubled one, and the lazy first group
 * takes the earliest of them. A tool name that itself contains `__` therefore
 * keeps it, which is the only reading that does not corrupt the server name.
 */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/**
 * Error text that means the server was never reached.
 *
 * A **heuristic**, and the weakest thing in this package. Claude Code does not
 * tell a hook why a tool failed in any structured way, so this reads the message
 * — which is written for a human, differs between MCP transports, and is not a
 * contract anyone promised to keep. A phrase drifts and a lost capability goes
 * unrecorded; the reverse is rarer but possible. Anything matching here has to
 * also be flagged as an error by {@link errorTextOf}, so a tool that merely
 * *returned* the words "connection refused" in its output is not mistaken for
 * one that hit them.
 */
const CONNECTION_CLASS = [
  "not connected",
  "connection closed",
  "connection refused",
  "connection reset",
  "failed to connect",
  "econnrefused",
  "econnreset",
  "enotfound",
  "epipe",
  "socket hang up",
  "transport closed",
  "server disconnected",
  "server has closed",
  "server closed the connection",
] as const;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** One named string field of a value that may not be an object at all. */
function fieldOf(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return str((value as Record<string, unknown>)[key]);
}

/** Every string buried in a tool result, flattened. Enough to grep, not to parse. */
function textOf(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth > 4 || value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).join(" ");
  const record = value as Record<string, unknown>;
  return ["error", "message", "text", "content", "result", "stderr"]
    .map((key) => textOf(record[key], depth + 1))
    .filter((text) => text !== "")
    .join(" ");
}

/**
 * What a tool result says went wrong, or nothing if it does not claim to have.
 *
 * Requires an explicit signal — an `error` field, `is_error`, `success: false` —
 * rather than sniffing the text, because "this output mentions an error" and
 * "this call errored" are different facts and only the second one is ours to
 * report.
 */
function errorTextOf(response: unknown): string | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  const error = record["error"];
  if (error !== undefined && error !== null && error !== false) {
    return textOf(error).trim() || "the tool reported an error without saying what";
  }
  const flagged =
    record["is_error"] === true || record["isError"] === true || record["success"] === false;
  if (!flagged) return undefined;
  return textOf(response).trim() || "the tool reported an error without saying what";
}

/** The capability id for a tool call, or nothing when the tool is not one. */
export function capabilityForTool(toolName: string, toolInput?: unknown): string | undefined {
  const mcp = MCP_TOOL.exec(toolName);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server !== undefined && tool !== undefined) return `mcp:${server}/${tool}`;
  }
  if (toolName === "Skill") {
    // `skill` is the documented parameter; the other two are older spellings
    // kept because a payload from a different Claude Code version costs nothing
    // to accept. With none of them present the skill has no name, and
    // `skill:unknown` would be an invention, so nothing is recorded.
    const name = fieldOf(toolInput, "skill") ?? fieldOf(toolInput, "name") ?? fieldOf(toolInput, "command");
    return name === undefined ? undefined : `skill:${name}`;
  }
  if (toolName === "Task" || toolName === "Agent") {
    const type = fieldOf(toolInput, "subagent_type") ?? fieldOf(toolInput, "subagentType");
    return type === undefined ? undefined : `agent:${type}`;
  }
  // Read, Write, Bash and the rest of the built-ins are not capabilities in this
  // vocabulary. They are what the agent is, not what it was given.
  return undefined;
}

function pushUnique(into: string[], seen: Set<string>, capability: string | undefined): void {
  if (capability === undefined || seen.has(capability)) return;
  seen.add(capability);
  into.push(capability);
}

/** A list entry that may be a bare name or an object carrying one. */
function nameOf(entry: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof entry === "string") return str(entry);
  for (const key of keys) {
    const found = fieldOf(entry, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Capabilities a `SessionStart` payload says are present.
 *
 * **A heuristic, and an optimistic one.** The documented `SessionStart` payload
 * carries no inventory of tools, servers or skills at all, so every field read
 * here is a guess at a shape a future Claude Code might send. Today most
 * payloads will match none of them and this returns nothing — which is the
 * honest answer, and exactly the case the contract warns about: silence is not
 * absence. A run that reports no availability is a run where nobody looked, and
 * a reader must not draw it as "nothing was there".
 *
 * A server with no tool list contributes nothing on purpose. `mcp:<server>` is
 * not an id in this vocabulary, and minting one would put availability in a
 * different id space from the invocations, so the fold would show a capability
 * that is never used sitting beside uses of a capability never declared.
 */
export function capabilitiesIn(payload: HookPayload): string[] {
  const capabilities: string[] = [];
  const seen = new Set<string>();

  // Already-namespaced ids, if something ever hands them over directly.
  for (const entry of listOf(payload["capabilities"])) {
    pushUnique(capabilities, seen, nameOf(entry, "id", "capability", "name"));
  }
  // Tool names, in the same spelling `PostToolUse` reports them.
  for (const entry of listOf(payload["tools"])) {
    const name = nameOf(entry, "name");
    if (name !== undefined) pushUnique(capabilities, seen, capabilityForTool(name));
  }
  for (const server of listOf(payload["mcp_servers"] ?? payload["mcpServers"])) {
    const serverName = nameOf(server, "name", "server");
    if (serverName === undefined) continue;
    for (const tool of listOf(readTools(server))) {
      const toolName = nameOf(tool, "name");
      if (toolName !== undefined) pushUnique(capabilities, seen, `mcp:${serverName}/${toolName}`);
    }
  }
  for (const entry of listOf(payload["skills"])) {
    const name = nameOf(entry, "name", "skill");
    if (name !== undefined) pushUnique(capabilities, seen, `skill:${name}`);
  }
  for (const entry of listOf(payload["agents"] ?? payload["subagents"])) {
    const name = nameOf(entry, "type", "subagent_type", "name");
    if (name !== undefined) pushUnique(capabilities, seen, `agent:${name}`);
  }
  return capabilities;
}

function readTools(server: unknown): unknown {
  if (server === null || typeof server !== "object") return undefined;
  return (server as Record<string, unknown>)["tools"];
}

/** What the appender knows about the file that the mapping cannot work out for itself. */
export interface HookContext {
  /**
   * The `ts` of the first event already in this run's file.
   *
   * `run_finished.durationMs` is measured from it. Absent means no run was ever
   * recorded for this session — hooks installed halfway through one, say — and
   * a session whose start was never seen does not get a finish, because the only
   * duration available would be a zero that means "nobody measured".
   */
  readonly startedAt?: string;
  /** When the hook fired, ISO-8601. Defaults to now. */
  readonly now?: string;
}

/** The project directory's own name, which is the closest thing a hook has to a spec name. */
function specNameFor(payload: HookPayload): string {
  const cwd = str(payload["cwd"]);
  if (cwd === undefined) return FALLBACK_SPEC_NAME;
  return basename(resolve(cwd)) || FALLBACK_SPEC_NAME;
}

function sessionStart(payload: HookPayload): TraceEventInput[] {
  const args: Record<string, unknown> = {};
  const sessionId = str(payload["session_id"]);
  if (sessionId !== undefined) args["sessionId"] = sessionId;
  const cwd = str(payload["cwd"]);
  if (cwd !== undefined) args["cwd"] = cwd;
  // `SessionStart.source` is startup / resume / clear / compact. Named
  // `startSource` here so it can never be read as the trace's own `source`,
  // which is a different fact and always `claude-code-hooks`.
  const startSource = str(payload["source"]);
  if (startSource !== undefined) args["startSource"] = startSource;

  const started: TraceEventInput = {
    type: "run_started",
    spec: { name: specNameFor(payload) },
    source: HOOK_TRACE_SOURCE,
    ...(Object.keys(args).length > 0 ? { args } : {}),
  };
  return [
    started,
    ...capabilitiesIn(payload).map<TraceEventInput>((capability) => ({
      type: "capability_available",
      capability,
    })),
  ];
}

function postToolUse(payload: HookPayload): TraceEventInput[] {
  const toolName = str(payload["tool_name"]);
  if (toolName === undefined) return [];
  const capability = capabilityForTool(toolName, payload["tool_input"]);
  if (capability === undefined) return [];

  const error = errorTextOf(payload["tool_response"]);
  if (error !== undefined && capability.startsWith("mcp:")) {
    const haystack = error.toLowerCase();
    if (CONNECTION_CLASS.some((needle) => haystack.includes(needle))) {
      // Lost rather than invoked, and never both. A call that could not reach
      // the server did not use the capability, and counting it as an invocation
      // would inflate the one number a reader uses to judge whether a tool is
      // pulling its weight.
      return [{ type: "capability_lost", capability, reason: error }];
    }
  }

  // No `node`. A hook knows a tool ran; it has no spec and therefore nothing to
  // attribute it to. The contract makes `node` optional for exactly this, and
  // inventing one would be the adapter making up an attribution nobody made.
  return [{ type: "capability_invoked", capability }];
}

function sessionEnd(payload: HookPayload, context: HookContext): TraceEventInput[] {
  const { startedAt } = context;
  if (startedAt === undefined) return [];
  const from = Date.parse(startedAt);
  const to = Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  // Clamped, because a clock that moved backwards during a session is a fact
  // about the machine and not a negative duration anybody spent.
  return [{ type: "run_finished", ok: true, durationMs: Math.max(0, to - from) }];
}

/**
 * The whole mapping: one hook payload in, the events it justifies out.
 *
 * Pure, and separate from the file handling on purpose — the interesting
 * decisions here are all about what a hook does and does not know, and they are
 * worth reading and testing without a filesystem in the way.
 *
 * An empty array is an ordinary answer. Most hooks Claude Code fires —
 * `PreToolUse`, `UserPromptSubmit`, `Stop`, `Notification`, `PreCompact` — say
 * nothing this contract has a word for, and writing a line anyway would pad the
 * trace with events that mean nothing.
 */
export function eventsForHook(payload: HookPayload, context: HookContext = {}): TraceEventInput[] {
  switch (str(payload["hook_event_name"])) {
    case "SessionStart":
      return sessionStart(payload);
    case "PostToolUse":
      return postToolUse(payload);
    case "SessionEnd":
      return sessionEnd(payload, context);
    default:
      return [];
  }
}
