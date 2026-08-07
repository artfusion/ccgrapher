# @ccgrapher/trace

The versioned JSONL event contract for workflow runs, and the pure fold that
turns it into state.

```ts
import { parseTraceLine, reduceRun, emptyRunState } from "@ccgrapher/trace";
import { TraceWriter, readTrace, followTrace } from "@ccgrapher/trace/node";

const state = readTrace("run.jsonl").reduce(reduceRun, emptyRunState("run-1"));
```

Every event carries the same envelope — `{ v: 1, type, runId, seq, ts }` — and
`v: 1` is a promise: within it the contract is additive only, forever. New
optional fields and new event types may appear, nothing is removed or narrowed.
`parseTraceLine` never throws, on malformed JSON or on a type it has never heard
of, which is what lets an old reader sit in front of a new writer.

`reduceRun` is the one fold a canvas, a CLI progress display and a hosted
dashboard all bind to, so the three of them cannot quietly disagree about
whether a run is finished.

Every token and cost field is optional, and absent means unknown. Render it
"n/a", never 0. A zero that really means nobody measured is the dishonesty this
project exists to catch.

## Capability events

Three types say what the runtime had to work with:
`capability_available` and `capability_lost` are run-scoped, because whether a
thing exists is a fact about the environment rather than about any one step.
`capability_invoked` carries an optional `node`: a runner knows which node
called, while an adapter watching a live agent session knows a tool was used and
has no spec to attribute it to. Both are telling the truth, and requiring a node
id would have excluded the second while calling the contract general.

The same rule as tokens and cost applies, and matters more here: a capability
nothing reported on is unknown, not absent. `RunState.capabilities` keeps
`available` tri-state so a reader cannot collapse the two.

`capability_denied` does not exist. Nothing can honestly produce one yet, and
adding it can wait until something can.

## What an old reader does with them

These are the additive change `v: 1` promised, and they were the first test of
it. An older `reduceRun` folds them as no update. Specs carrying `uses:` still
parse under older tools, which strip the field silently.

One version degrades rather than ignores. `ccg serve` at 0.3.1 and earlier
named each SSE message after its event type and forwarded only types its own
schema knew, re-emitting the rest as `ccg.unparsed` — and because an unparsed
line carries no `seq`, withholding it entirely on a `Last-Event-ID` resume. So a
newer writer's events reached an older canvas as nothing at all. From 0.4.0 the
server gates structurally instead: anything carrying a `seq` is forwarded with
its id, whether or not this server has heard of it.

Writers are the other way round. `TraceWriter` parses what it is given, so an
older writer cannot emit a type it does not know. Writers upgrade to speak;
readers never had to.

The main entry is bundler-safe. Anything touching the filesystem lives at
`@ccgrapher/trace/node`.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
