# The trace contract

A trace is a JSONL file: one event per line, written as a run happens. It is the
one thing the runner, the Claude Code adapter, `ccg serve`, the canvas and
`ccg trace audit` all agree on, which makes it the part of ccgrapher other
people can build against. This page says what they can rely on.

The contract lives in [`@ccgrapher/trace`](../packages/trace). Its version is the
`v` field on every event, and today that is `1`.

## The promise

Within `v: 1` the contract is additive only. New optional fields and new event
types may appear. Nothing is removed, renamed, retyped or narrowed.

That is a promise from writers to readers, and it only holds if readers keep
their half: a reader meets things it does not recognise, and carries on. The
rest of this page is that bargain in detail.

## What is fixed

**The envelope.** Every event carries these, and always will.

| Field | Meaning |
|---|---|
| `v` | The contract version. Always `1` for now. |
| `type` | The event type. |
| `runId` | A non-empty string naming the run. |
| `seq` | A non-negative integer, counting up from 0 per writer. It orders events when `ts` cannot, and it is the SSE event id when `ccg serve` replays a run. |
| `ts` | An ISO-8601 timestamp, held as a plain string. A writer that emits `+00:00` rather than `Z` is not wrong. |

**The event types.** Eleven exist today. Every field below is as the schema
defines it; fields marked optional may be absent.

| Type | Says | Fields beyond the envelope |
|---|---|---|
| `run_started` | The run began. The only event that carries the spec. | `spec.name`, `spec.hash` (optional), `source`, `args` (optional) |
| `node_started` | A node, or one instance of a fanned node, began. | `node`, `instance` (optional), `of` (optional) |
| `node_log` | A line of output. | `line`, `node` (optional: absent means the run itself) |
| `node_finished` | A node, or instance, succeeded. | `node`, `durationMs`, `instance`, `output`, `usage` (all but the first two optional) |
| `node_failed` | A node, or instance, failed. | `node`, `error`, `instance`, `durationMs` (optional) |
| `gate_waiting` | A gate is blocked on a person. | `node`, `payload` (optional) |
| `gate_resolved` | The person decided. | `node`, `decision` (`approve` or `reject`), `note` (optional) |
| `run_finished` | The run ended. | `ok`, `durationMs`, `error` (optional) |
| `capability_available` | The runtime says a capability is there. | `capability` |
| `capability_lost` | A capability that was there is gone. | `capability`, `reason` (optional) |
| `capability_invoked` | Something used a capability. | `capability`, `node` and `instance` (optional) |

`of` on `node_started` is what makes a node fanned. A writer expanding a
`fanOut` sends it on every instance start, because it is the only place a reader
learns how many instances to wait for.

**Absent means unknown.** Every token and cost field in `usage` is optional. A
reader renders an absent number as "n/a", never as 0, and sums only what is
present. The same rule governs capabilities: a run that reported nothing about a
capability is a run where nobody looked, which is not the same as the capability
being missing.

**Two vocabularies are open.** `source` (who wrote the trace) is any non-empty
string; `ccg-run`, `claude-code-watch`, `claude-code-hooks` and `custom` are the
known values, and a reader should not reject the rest. A capability id is opaque
and namespaced (`mcp:<server>/<tool>`, `skill:<name>`, `plugin:<name>`,
`agent:<type>`), and a reader should not reject a namespace it has not met.

## What a reader must do

1. **Never fail on a line it cannot read.** `parseTraceLine` does not throw, for
   any input. A malformed line, or a `type` from a newer writer, comes back as
   `{ type: "unknown", raw }`. `"unknown"` is reserved and will never be a real
   event type.
2. **Keep the raw line** if it forwards the stream. That is how an old reader
   sits in front of a new writer without losing anything.
3. **Ignore events for another `runId`**, so a file holding several runs folds
   correctly.
4. **Not invent.** Do not coerce an absent value to zero, a silent capability to
   a missing one, or a node that never reported an end to a finished one.

`reduceRun` does all of this, and is the fold a canvas, a progress display and a
hosted dashboard should share, so that they cannot quietly disagree about
whether a run is over. Unknown events leave its state untouched.

## What a writer must do

- **Use `TraceWriter`, or match it.** It stamps the envelope, owns `seq`, and
  parses each event before writing it, so a writer bug cannot put a line in the
  file that readers of the same contract would reject.
- **One writer per file.** Two writers each number from their own zero. A process
  that appends one event and exits should start from `resumeSeq(path)`, which
  returns the next unused number. It does not make concurrent appends safe.
- **Expect long values to be cut.** A trace is a record, not a store. A
  `node_log` line or a `capability_lost` reason over 4,000 characters keeps its
  head and ends with a note of how much was dropped. A `node_finished` output
  whose JSON exceeds 16,000 characters is replaced by
  `{ "truncated": true, "chars": <length or null>, "preview": "<first 500 characters>" }`.
  A reader can always tell short from shortened.

## What additive means in practice

Safe, and may happen in any release that keeps `v: 1`:

- a new event type;
- a new optional field on an existing event;
- a new known `source` value, or a new capability namespace.

Not done within `v: 1`:

- removing or renaming an event type or a field;
- making an optional field required, or changing a field's type;
- adding a value to a closed enum on an existing event. `decision` on
  `gate_resolved` is one. A reader that has not met the new value fails to parse
  the whole line and treats it as unknown, so the gate would stay waiting
  on a decision that had already been made. New behaviour arrives as a new event type or an optional field instead.

A change that cannot be made this way is a `v: 2`, with a version bump and a
migration note, and not a quiet edit.

## What has happened so far

| Release | Change to the contract |
|---|---|
| 0.3.0 | The contract itself: the envelope and the eight run and node events. |
| 0.4.0 | `capability_available`, `capability_lost`, `capability_invoked`, and the `claude-code-hooks` source. Older readers fold them as no update. |
| 0.5.0 | None. `ccg trace audit` gained rules, but they read the same events. |

One transport detail from that history is worth knowing. `ccg serve` at 0.3.1 and
earlier forwarded only the event types it knew, so a newer writer's events
reached an older canvas as nothing at all. From 0.4.0 it forwards anything
carrying a `seq`, with its id, whether or not it recognises the type.

## Checking your own writer or reader

The fixtures in [`packages/trace/test/fixtures`](../packages/trace/test/fixtures)
cover a clean run, a failed node, a gate and a fan-out, and
[`examples/traces`](../examples/traces) holds capability traces that `ccg trace
audit` is run against. A reader that folds all of them, and survives a line of
your own invention in the middle, is holding up its end.
