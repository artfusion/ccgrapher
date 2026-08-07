# @ccgrapher/adapter-claude-code

Turns Claude Code hook invocations into a ccgrapher trace, so a real agent
session becomes a readable, auditable run.

```bash
npm i -g @ccgrapher/adapter-claude-code
```

Wire it into `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "ccg-claude-code-hook" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "ccg-claude-code-hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "ccg-claude-code-hook" }] }]
  }
}
```

Each invocation reads the hook payload as JSON on stdin and appends to
`runs/cc-<sessionId>.jsonl` under the session's project directory. Set
`CCG_TRACE_DIR` to put them somewhere else. Then read the run the same way as
any other:

```bash
ccg trace stats runs/cc-<sessionId>.jsonl
ccg serve runs        # the canvas, live, while the session is still going
```

The run id equals the filename stem. That is not a convention, it is what makes
the file servable: `ccg serve` streams `<id>.jsonl` and the fold keys on the id.

## Why a package rather than a documented recipe

A hook is a separate short-lived process, one per event. A `TraceWriter` built
the obvious way owns `seq` for its file, and `seq` is what orders a stream whose
timestamps collide and what a reconnecting reader resumes from — so a hook that
constructed one fresh each time would write `0, 0, 0` and produce a file whose
order cannot be recovered. Continuing from the tail fixes that, and then two tool
calls finishing at once reintroduce it, because both read the same tail and pick
the same number. So every append reads and writes under an exclusively-created
`<runId>.jsonl.lock`, with a bounded wait and a reclaim for a lock left behind by
a process that died holding it.

None of that is paste-able, and a recipe that waved at it would teach people to
write traces that violate the contract they are supposed to be honouring.

## What it records

| Hook | Event |
| --- | --- |
| `SessionStart` | `run_started`, source `claude-code-hooks`, `spec.name` from the project directory, then one `capability_available` per capability the payload names |
| `PostToolUse` on `mcp__<server>__<tool>` | `capability_invoked`, id `mcp:<server>/<tool>` |
| `PostToolUse` on `Skill` | `capability_invoked`, id `skill:<name>` |
| `PostToolUse` on `Task` | `capability_invoked`, id `agent:<type>` |
| `PostToolUse` on an MCP tool that could not reach its server | `capability_lost`, with the message as `reason` |
| `SessionEnd` | `run_finished`, duration measured from the file's first event |

Everything else — `PreToolUse`, `UserPromptSubmit`, `Stop`, `Notification`,
`PreCompact` — writes nothing. This contract has no word for them, and padding a
trace with events that mean nothing is not recording more, it is recording worse.

Invocations carry **no `node`**. A hook knows a tool ran; it has no spec to
attribute it to, and the contract makes `node` optional for exactly this reason.
So a hook trace shows what a session had and what it used, and does not pretend
to know which step of a workflow used it.

## Honest limits

- **The connection-class rule is a heuristic.** Claude Code does not tell a hook
  *why* a tool failed in any structured way, so `capability_lost` is decided by
  reading the error message for phrases like "connection closed" or "socket hang
  up". Those are written for humans, differ between MCP transports, and nobody
  promised to keep them stable. A phrase drifts and a lost server goes
  unrecorded. A failure that reaches the server and is refused by it stays an
  invocation, because the capability was there and was used.
- **`SessionStart` capabilities are a guess.** The documented payload carries no
  inventory of servers, tools or skills at all. The adapter reads several
  plausible fields in case a future version sends one, and most sessions will
  match none of them and report nothing. That is the honest answer, and the
  contract is explicit about how to read it: silence is not absence. A run
  reporting no availability is a run where nobody looked, not a run where
  nothing was there. A server listed without its tools contributes nothing,
  because `mcp:<server>` is not an id in this vocabulary and would never match
  an invocation.
- **A session whose start was never seen gets no finish.** Install the hooks
  halfway through a session and `SessionEnd` writes nothing, because the only
  duration available would be a zero meaning "nobody measured".
- **Names come from inputs.** A `Skill` or `Task` call whose input does not name
  the skill or subagent is not recorded, rather than recorded as `skill:unknown`.
- **The adapter can fail, and says so.** It exits 1 with a message on stderr,
  never 2 — Claude Code reads 2 as "block this", and something that only records
  a session must never be able to change it.
- **One session, one file.** Resuming a session appends to the same run, which is
  usually what you want; two concurrent sessions sharing a session id would not
  be, and nothing here can tell them apart.

## API

The mapping is exported, so it can be tested and reused without spawning a
process:

```ts
import { eventsForHook, appendHook, capabilityForTool } from "@ccgrapher/adapter-claude-code";

capabilityForTool("mcp__linear__issues_list"); // "mcp:linear/issues_list"
eventsForHook(payload, { startedAt });         // pure: payload in, events out
appendHook(payload, { dir: "runs" });          // resume, lock, append
```

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
