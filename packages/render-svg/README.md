# @ccgrapher/render-svg

Renders a workflow graph as a hand-drawn, self-contained SVG.

```ts
import { renderSvg } from "@ccgrapher/render-svg";

const svg = renderSvg(layoutGraph(graph), {
  fakeEdges: [{ from: "a", to: "b" }],   // drawn red and dashed
});
```

rough.js strokes, paper texture, per-kind icons. Agent nodes are sketchy; nodes
with `model: null` get sharp corners to signal "plain code, costs nothing".

The Caveat typeface is embedded as base64 so the file renders identically
anywhere. That makes every output a redistribution of the font, so each SVG
carries its SIL OFL attribution inline — see NOTICE. Pass `embedFont: false` for
a file with no font data, or `grain: false` to drop the paper texture, which is
per-pixel noise and defeats PNG compression.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
