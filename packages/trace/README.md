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

The main entry is bundler-safe. Anything touching the filesystem lives at
`@ccgrapher/trace/node`.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
