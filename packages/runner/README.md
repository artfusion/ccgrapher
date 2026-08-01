# @ccgrapher/runner

The execution engine. It walks a workflow graph rank by rank, enforces the
fan-in guards the spec declared, and emits the trace contract.

```ts
import { buildGraph } from "@ccgrapher/core";
import { execute } from "@ccgrapher/runner";

const result = await execute(buildGraph(spec), myExecutor, {
  runId: "run-1",
  emit: (event) => writer.write(event),
  gate: async (node, payload) => ask(node, payload),
  timeoutMs: 300_000,
});
```

The waves come from `rankGraph`, so the concurrency in a run is the concurrency
the diagram shows. Within a rank the nodes are settled independently: they are
on the same rank because nothing connects them, so one failing does not cancel
the others.

`expects` throws. A node that declared it needs five upstream results and got
four ends the run, rather than reporting on four fifths of the data as though it
were whole. A node whose input never arrived is skipped rather than run with a
hole in it, and the skip is reported.

Nothing in here touches a filesystem, a network, a process or a clock of its
own. The executor, the gate resolver, the clock and the event sink are all
injected, which is what lets the same code run a workflow on a laptop and inside
a hosted service. `worktree: true` is passed through to the node's context and
nothing more; creating one is the wrapper's job.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
