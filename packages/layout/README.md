# @ccgrapher/layout

Turns a validated workflow graph into positioned nodes and routed edges.

```ts
import { layoutGraph } from "@ccgrapher/layout";

const { nodes, edges, width, height } = layoutGraph(graph);
```

Wraps dagre with `ranker: "longest-path"` so the rows it produces match the ranks
`@ccgrapher/core` computes — the drawing can never contradict the layer count the
linter prints. Node sizes come from measuring the wrapped label, so no coordinate
is ever authored by hand.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
