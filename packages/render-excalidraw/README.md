# @ccgrapher/render-excalidraw

Emits a workflow graph as an editable Excalidraw scene.

```ts
import { renderExcalidraw } from "@ccgrapher/render-excalidraw";

writeFileSync("out.excalidraw", JSON.stringify(renderExcalidraw(positioned)));
```

The escape hatch: open the file, drag a node, and everything follows. Arrows are
bound to the boxes they connect and labels live inside their containers, so the
scene stays coherent under editing. Uses Virgil, Excalidraw's own hand-drawn
face, so the look survives the round trip with nothing embedded.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
