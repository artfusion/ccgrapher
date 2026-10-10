# @ccgrapher/layout

Turns a validated workflow graph into positioned nodes and routed edges.

```ts
import { layoutGraph } from "@ccgrapher/layout";

const { nodes, edges, width, height } = layoutGraph(graph);
```

Wraps dagre, but hands it the ranks `@ccgrapher/core` computes instead of letting it
rank the graph, so every step is drawn on the row of its wave and the drawing can
never contradict the layer count the linter prints. (dagre's own `longest-path`
ranker counts from the bottom, so it would sink a step towards whatever reads it.)
Node sizes come from measuring the wrapped label, so no coordinate is ever
authored by hand.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
