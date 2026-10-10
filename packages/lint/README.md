# @ccgrapher/lint

Finds the steps in an agent workflow that are waiting on nothing.

```ts
import { lint, formatReport } from "@ccgrapher/lint";

const result = lint(graph);
console.log(formatReport(graph, result));
console.log(result.layersBefore, "->", result.layersAfter);
```

Eleven rules: `FAKE_EDGE`, `MISSING_INPUT`, `AUTHORITY_BREACH`, `HIDDEN_EDGE`,
`SELF_GRADING`, `MONOCULTURE`, `CONTEXT_COLLAPSE`, `SILENT_FAILURE`,
`DUPLICATE_EFFECT`, `EARLY_COMMIT`, `TIER_MISMATCH`. `DUPLICATE_EFFECT`,
`EARLY_COMMIT` and the store form of `AUTHORITY_BREACH` read what a spec says
one run hands the next: its schedule, its stores and the effects its steps
perform. `MONOCULTURE` and `TIER_MISMATCH` read who does the work: the model
tier, and the `agent:` a step declares in `uses`. None of these repairs.

Lint runs twice. Some problems only become visible after repair — two nodes that
collide on a file may be a rank apart until the fake edge between them is gone —
so findings carry `phase: "raw" | "repaired"`. Repairs repoint to the nearest
ancestor that supplies the missing field rather than deleting, which would leave
the target starting before its real dependency.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
