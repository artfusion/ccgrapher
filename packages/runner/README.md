# @ccgrapher/runner

The execution engine. It starts each step of a workflow graph the moment its
inputs exist, enforces the fan-in guards the spec declared, and emits the trace
contract.

```ts
import { buildGraph } from "@ccgrapher/core";
import { execute } from "@ccgrapher/runner";

const result = await execute(buildGraph(spec), myExecutor, {
  runId: "run-1",
  emit: (event) => writer.write(event),
  gate: async (node, payload) => ask(node, payload),
  timeoutMs: 300_000,
  concurrency: 4, // optional; absent means no limit
});
```

A step starts when every node it has an edge from has settled and delivered,
not when its rank has finished. The ranks from `rankGraph` still say what may
run together, and they order the ready queue, but they are not a barrier: a slow
step holds up only what needs its output. `concurrency` bounds the executor
calls in flight, one per fanned instance; a gate awaiting a decision takes no
slot. When more is ready than there are slots, the lower rank goes first, then
spec order, then instance. That one comparison lives in `src/schedule.ts`, and it
also fixes the order of steps that become ready together, so a trace is
reproducible.

A node that fails does not cancel anything it has no edge to. A node whose
input never arrived is skipped rather than run with a hole in it, the skip is
reported as soon as the failure above it is known, and every other branch runs
on.

`expects` throws. A node that declared it needs five upstream results and got
four ends the run, rather than reporting on four fifths of the data as though it
were whole. From then on nothing new starts; steps already running finish and
are recorded before `run_finished`.

Nothing in here touches a filesystem, a network, a process or a clock of its
own. The executor, the gate resolver, the clock and the event sink are all
injected, which is what lets the same code run a workflow on a laptop and inside
a hosted service. `worktree: true` is passed through to the node's context and
nothing more; creating one is the wrapper's job.

The executor is the seam for anything that runs a node somewhere else. It is
called once per node, or once per instance of a fanned node, with a
`NodeContext`, and returns `{ output?, usage? }` or rejects. The scheduler
decides when it is called and how many calls overlap; the executor decides only
what a call does.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
