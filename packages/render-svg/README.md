# @ccgrapher/render-svg

Renders a workflow graph as a hand-drawn, self-contained SVG.

```ts
import { renderSvg } from "@ccgrapher/render-svg";

const svg = renderSvg(layoutGraph(graph), {
  fakeEdges: [{ from: "a", to: "b" }],   // drawn red and dashed
  guardFindings: [{ id: "ci", arriving: 8 }], // fan-ins lint flagged, with what really arrives
});

// Or every finding at once, as the CLI does:
import { lint, renderMarksFor } from "@ccgrapher/lint";
const marked = renderSvg(layoutGraph(graph), renderMarksFor(lint(graph).findings.filter((f) => f.phase === "raw")));
```

A node that declares `expects` always shows the count. A node named in `guardFindings`
is also ringed in solid red: with no `expects` it reads "no count guard", with one it reads
`9 ≠ 8`. The renderer draws what it is told and does not compare the two itself.

Every other rule arrives in `findingMarks`. A starved node, a verifier that grades its own
work and an overloaded fan-in are ringed the same way and captioned: `no repo`,
`grades own work`, `200 in, no reduce`. A node has room for one caption, so with several
findings it names the first in rule order and counts the rest (`no repo +1`), using a
shorter form where the box is tight. Two concurrent writers of one file are joined by a thin
solid red line, labelled with the file and routed above their row or round the margin, so it
never crosses a box or reads as an edge.

rough.js strokes, paper texture, per-kind icons. Agent nodes are sketchy; nodes
with `model: null` get sharp corners to signal "plain code, costs nothing".

A node with a tier names it top left, `strong` or `cheap`, and carries `data-tier`. A node
that declares `uses: [agent:<type>]` shows `agent: <type>` as a quieter line under its label,
with `data-agent`. The layout sizes the box for both, so nothing is moved to make room.

The Caveat typeface is embedded as base64 so the file renders identically
anywhere. That makes every output a redistribution of the font, so each SVG
carries its SIL OFL attribution inline — see NOTICE. Pass `embedFont: false` for
a file with no font data, or `grain: false` to drop the paper texture, which is
per-pixel noise and defeats PNG compression.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
