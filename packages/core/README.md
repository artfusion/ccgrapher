# @ccgrapher/core

Spec schema, validation and layer assignment for agent-workflow graphs.

```ts
import { parseSpec, buildGraph, rankGraph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";   // filesystem helpers

const graph = buildGraph(parseSpec(yaml));
const { rank, layers, layerCount } = rankGraph(graph);
```

Ranks are assigned by longest path, so two nodes with no dependency between them
land on the same layer. `layerCount` is the critical path, and it is what the
linter reports — the layout package never gets a say in it.

The main entry is bundler-safe. Anything touching the filesystem lives at
`@ccgrapher/core/node`, which is what lets the same parser run in a browser.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
