# @ccgrapher/runner-managed-agents

Runs each model step of a ccgrapher workflow as its own Claude Managed Agents
session. The ccgrapher runner keeps everything else: the order, the `expects`
guards, the gates, the plain-code steps and the trace. This is orchestrated
mode. Nothing here asks a coordinator agent to keep the order in a prompt.

The core runner has no dependency on the Anthropic SDK. This package has it,
and loads it only when credentials are present.

## From the command line

```bash
ccg codegen spec.yaml -t managed-agents -o agents-out/
cd agents-out
grep -rn YOUR_ agents/                        # placeholders the spec could not fill
ant apply --dry-run agents/plan/agent.md ...  # name the files, as the generated README lists them
ant apply agents/plan/agent.md ...            # writes claude-lock.json here
cd ..
ANTHROPIC_API_KEY=... ccg run spec.yaml --managed-agents agents-out --impl local.mjs
```

`--managed-agents <dir>` reads `<dir>/claude-lock.json` and pairs every model
node with its agent by the path the codegen target wrote it to. `--impl` is
still needed for the plain-code steps (`model: null`), and an export for a model
node wins over its session, which is a way to stub one expensive step. Gates
are answered as in any other run.

Before anything starts, the run checks that the lock covers every model node
and that `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set. Either missing
exits 2 with nothing created. A profile saved by `ant auth login` is not enough
on its own, on purpose: a profile left on a machine is not a decision to spend
from it.

`--session-budget <usd>` sets a hard cap on each session, passed to the platform
as the session's `budget`. It is one cap per session, not per run.

## What it costs

One session per model node, and one per copy of a fanned node. The
research-desk example opens ten: plan, five researchers, three skeptics and the
report. Each is a container billed for its running time as well as its tokens,
and each pays a start-up delay. The run prints the count, and which account it
will bill, before the first session opens. Usage is recorded on each
`node_finished` from the session's own figures: tokens, and cost at list price,
which can be more than a discounted bill.

## The protocol

**In.** The session's one `user.message` is a sentence, then a ```json block:

```json
{
  "protocol": "ccg-node-input/1",
  "run": "research-desk-20261010T120000-a1b2c3",
  "spec": "research-desk",
  "node": "research",
  "instance": 2,
  "of": 5,
  "args": {},
  "inputs": [{ "from": "plan", "fields": ["angle"], "output": { "angle": ["cost", "speed"] } }]
}
```

`instance` and `of` appear only for a fanned node. `inputs` holds only what
genuinely arrived, exactly as the runner hands it to any implementation. The
system prompt the codegen target writes describes the same envelope.

**Out.** The text of the last `agent.message` before the session goes idle with
`end_turn`, read as one JSON object: the whole reply, or else the last ```json
block in it. The object must hold every field the node declares in `out`;
extra fields are kept. A reply with no object, or one missing a field, fails
the node with a message naming what was wrong. A node with no declared outputs
accepts any reply.

## How a session is driven

1. `sessions.create` with the node's agent id, the workflow's environment id, a
   title, and metadata `ccg_run`, `ccg_spec`, `ccg_node` (and `ccg_instance`
   for a fanned copy), so a session can be traced back to its run.
2. The event stream is opened first, and only then is the input sent.
3. Events are read until the session is idle with any stop reason other than
   `requires_action`, or terminated. An idle from before the turn started is
   ignored. A dropped stream is reopened and the history read to cover the
   gap, deduplicated by event id, up to three times.
4. Nobody is watching, so a tool call that asks for confirmation is denied with
   a message saying why, and a custom tool call is answered with a note that
   there is no handler. An MCP tool the platform allowed is recorded as a
   `capability_invoked` for `mcp:<server>/<tool>`.
5. The session is polled until it no longer reports `running`, since the stream
   reports idle slightly before the status does, and then archived. Archived
   sessions stay readable. Sessions are never deleted: the event history is the
   record a trace points back to. A session that still reports running after
   two seconds is left alone and said so.
6. `end_turn` is a success if the output reads. `retries_exhausted`,
   `budget_reached`, any other stop reason, or termination fails the node, with
   the last `session.error` in the message.

The session id is written to the trace as a `node_log` line, so the trace
points to the session and the session's metadata points back to the trace.

**Timeouts.** On the runner's `--timeout` the session is sent `user.interrupt`,
drained to idle and archived, and the node fails. The runner moves on at once;
`settled()` waits for the clean-up, and `ccg run` awaits it before exiting. A
session that does not go idle within 30 seconds of the interrupt is given up on
and left unarchived.

## As a library

```ts
import { execute } from "@ccgrapher/runner";
import { clientFromEnvironment, managedAgents, readLock, resolveIds } from "@ccgrapher/runner-managed-agents";

const client = await clientFromEnvironment(); // undefined without a key or token
const managed = managedAgents({ graph, ids: resolveIds(graph, readLock("agents-out")), client: client! });
const impls = new Map([...managed.impls, ...Object.entries(localSteps)]);
await execute(graph, (context) => impls.get(context.node.id)!(context), { runId, emit });
await managed.settled();
```

`client` is anything with the six methods the package calls
(`beta.sessions.create`, `retrieve`, `archive`, and `events.send`, `stream`,
`list`), which is how the tests run with no network at all. A type check in the
build fails if the real SDK client stops fitting that shape.

## Applying the files

Name the files. `ant apply .` walks the whole tree and applies everything that
looks like a resource; in a repository that holds other skills, it would upload
those too.

## Not yet

- Reading a coordinator-mode session back into a trace. Here the runner writes
  the trace itself, so nothing needs reading back.
- A first run against a real account. Everything above is tested against a
  mocked client; nothing in this package's tests or CI can reach the network.
