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
it were whole.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
