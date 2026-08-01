# @ccgrapher/codegen

Generates orchestration code from a workflow spec.

```ts
import { codegen } from "@ccgrapher/codegen";

codegen(graph, "claude-code");  // agent() / parallel()
codegen(graph, "plain-ts");     // typed functions + Promise.all
codegen(graph, "langgraph");    // StateGraph wiring
```

Stages come straight from the graph's ranks, so the concurrency in the generated
script is exactly the concurrency the diagram shows.

`fanOut` becomes a capped parallel map, `worktree` becomes isolation, and
`expects` becomes a guard on the results that *arrived* — a dead upstream node
otherwise slips through and the synthesis step reports on partial data as though
it were whole. The guard is a floor, matching `@ccgrapher/runner`: a shortfall is
the failure, while more arrivals than declared means the count is stale, which
lint reports at spec time. `NodeSpec.expects` in `@ccgrapher/core` carries the
reasoning.

The `claude-code` script narrates itself. It logs a `ccg:` marker line at each
phase, around each node, and on an `expects` miss, using the field names
`@ccgrapher/trace` already has. A Workflow script has no filesystem and so cannot
write a trace, which is why the payloads are partial: `runId`, `seq` and `ts`
belong to a watcher reading Claude Code's journal, and it fills them in. The
`label` on every `agent()` call is exactly the node id, or `id:i` for one
instance of a `fanOut`, because that is what ties a journal record back to a
graph node.

```ts
import { codegenWarnings } from "@ccgrapher/codegen";

codegenWarnings(graph, "claude-code");  // what this target cannot honour
```

Today that is gate nodes: a Workflow script cannot block on a human, so the step
runs straight through. It is generated anyway, with the warning on stderr and a
comment in the file, rather than quietly pretending to be a gate.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
