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

**Opening the file.** Drag `out.excalidraw` onto [excalidraw.com](https://excalidraw.com), or
File → Open it from there, or open it with the [Excalidraw extension for VS
Code](https://marketplace.visualstudio.com/items?itemName=pomdtr.excalidraw-editor). Either way
you land in a normal, zoomable Excalidraw canvas — pan, zoom, and rearrange freely.

Edits made in Excalidraw are **not** written back to the spec. This is a picture to hand someone
or sketch on top of, not a second source of truth — the spec's `in:`/`out:` declarations remain
the only thing that decides the graph's shape.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
