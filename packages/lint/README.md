# @ccgrapher/lint

Finds the steps in an agent workflow that are waiting on nothing.

```ts
import { lint, formatReport } from "@ccgrapher/lint";

const result = lint(graph);
console.log(formatReport(graph, result));
console.log(result.layersBefore, "->", result.layersAfter);
```

Six rules: `FAKE_EDGE`, `MISSING_INPUT`, `HIDDEN_EDGE`, `SELF_GRADING`,
`CONTEXT_COLLAPSE`, `SILENT_FAILURE`.

Lint runs twice. Some problems only become visible after repair — two nodes that
collide on a file may be a rank apart until the fake edge between them is gone —
so findings carry `phase: "raw" | "repaired"`. Repairs repoint to the nearest
ancestor that supplies the missing field rather than deleting, which would leave
the target starting before its real dependency.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
