# @ccgrapher/render-mermaid

Emits a workflow graph as a Mermaid flowchart.

```ts
import { renderMermaid } from "@ccgrapher/render-mermaid";

const text = renderMermaid(graph, { fenced: true });
```

`flowchart TD` with `look: handDrawn`. Takes a `Graph` rather than a positioned
one — Mermaid does its own layering, and because it uses the same longest-path
algorithm, parallel nodes land on the same row there too.

Each node kind gets a distinguishable shape, edges are labelled with the fields
they carry, and fake edges are dotted and red.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
