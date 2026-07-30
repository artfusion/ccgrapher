# HANDOFF: Graph Engineering Diagram Generator (ccgrapher)

**Prepared:** 2026-07-30
**Origin:** browser session reading an X article, handing off to Claude Code on desktop
**Goal of the project:** build a tool that takes a machine-readable agent-workflow spec and
generates a layered, hand-drawn-style "graph" diagram — plus lints the workflow for wasted
sequencing and generates the matching orchestration code.

---

## 1. Source material

**Canonical URL (tracking params stripped):**
https://x.com/anatolikopadze/status/2080668775796314331

**Author:** Anatoli Kopadze (@AnatoliKopadze)
**Title:** "Graph Engineering explained: what it is, when to use it and when not to"
**Posted:** 2026-07-24 · ~1.3M views at time of reading

**Referenced quote-tweet that kicked off the trend:** Peter Steinberger (@steipete), 2026-07-18,
joking about whether the field had moved from loops to graphs.

> Note on why the article body is not pasted in full here: it is copyrighted material from a
> public web page, so this document carries the URL, the direct image links, and a paraphrased
> concept digest instead. Open the URL to read the original wording.

### Diagram images (direct links, in article order)

Append `?format=png&name=orig` to any of these for full resolution.

| # | Image | What it shows |
|---|-------|---------------|
| 1 | https://pbs.twimg.com/media/HOAA7BpW0AE_Dxe | Cover: "The Graph Blueprint" — the full pipeline: goal → split → 4 parallel workers → verifier → merge → final answer. Best single reference for the target aesthetic. |
| 2 | https://pbs.twimg.com/media/HN_lWe1WUAA-3E0 | "Nodes & Edges" — node = one agent / one job / one input / one output; edge = one node's output feeds the next node's input. |
| 3 | https://pbs.twimg.com/media/HN_ot18WwAA4lk- | The fake-edge test. |
| 4 | https://pbs.twimg.com/media/HN_qHfuXcAAlcLr | "THE DIAMOND: fan out → reduce → synthesize" — split the job / 5 workers on one row / checker / merge into one answer. **This is the primary layout to reproduce.** |
| 5 | https://pbs.twimg.com/media/HN_wbhWWUAAJteJ | Anchors — nodes that cannot be argued with. |
| 6 | https://pbs.twimg.com/media/HN_0W-CXIAAndeR | Screenshot of Claude Code running a dynamic workflow. |

### Visual conventions observed in his images

- Sketch / hand-drawn strokes on a light paper-textured background.
- Orange (#E8763A-ish) accents on edges, underlines, and node borders; near-black text.
- Handwriting font throughout (Excalifont / Virgil / Caveat / Patrick Hand are close matches).
- Small line icons inside nodes (magnifier = research, scales = compare, clipboard = check).
- Short labels only — 1–4 words per node.
- Strictly layered top-to-bottom; **anything running in parallel sits on the same horizontal row.**

### Concept digest (paraphrase — see URL for the original wording)

- A graph answers two questions: which jobs must happen, and which job waits on which.
- **Node** = one bounded job with a defined input and defined output. A node whose output is
  free text is human-readable only; a node with an enforced output schema is wire-able.
- **Edge** = a real data dependency. It only counts if something real passes along it.
- **Fake-edge test:** at each step ask whether it actually needs the previous step's *result*.
  If not, there is no edge and the wait is wasted — run them concurrently. Most workflows
  contain two or three of these.
- A linear "A then B then C" workflow is already a graph — the worst one: N sequential failure
  points and the latency of all N summed. Redrawn, it finishes at the speed of the slowest layer.
- **The diamond** is the pattern that pays: fan out for breadth, reduce with plain code (no
  model, no tokens), verify, then synthesize one answer with a final agent.
- **The checker is the trick:** never let the agent that did the work check the work, and the
  verifier must have a fresh, empty context. Split checking three ways — is it correct, is it
  current, is the source real — and keep a finding only on majority pass. His rule, quoted:
  a worker and its verifier "must never share a context."
- **Known break modes:** context collapse (pouring 1,000 raw outputs into one synthesis step —
  fix with layered fan-in, summarize batches then combine summaries); false independence (two
  "unrelated" nodes writing the same file or hitting the same rate-limited API — a hidden edge;
  fix with isolated worktrees per worker); silent node failure (one dead node among hundreds
  slipping into a report that looks complete — fix with a fan-in count guard).
- **Anchors:** topology alone doesn't buy truth. Ground the graph in facts that can't be argued
  with (tests that actually ran, money that actually landed), and freeze the rules an optimizer
  would be tempted to weaken.
- **When to skip a graph:** small isolated tasks, work where you want to approve every step,
  exploratory work where you don't know what you're looking for, and genuinely sequential steps.
  If you can't find two jobs with no edge between them, it's a loop, and a loop is fine.
- **Cost reality:** graphs cost much more than a chat — coordination gets cheaper, the work
  doesn't. Cited example: a Bun runtime rewrite, ~535k lines translated to 1M+ lines in ~11 days,
  ~50 workflows, up to 64 concurrent agents, roughly \$165k in usage, with a human designing and
  supervising throughout.

---

## 2. Build write-up (verbatim from the browser session)

I looked at his diagrams so I could match what we'd be targeting. There are three visual
conventions worth noting: a sketch/hand-drawn aesthetic on a paper-textured background with
orange accents and a handwriting font, boxes-as-nodes with small icons and short labels, and a
strictly layered top-to-bottom flow where anything running in parallel sits on the same
horizontal row. The diamond image is literally "split the job" on row one, five workers on row
two, one checker on row three, one merge node on row four. That layered structure is the
important part, because it's something you can compute rather than draw by hand.

His images appear to be hand-illustrated, so the interesting build isn't reproducing those
specific pictures — it's building a generator that takes a workflow description and emits that
picture automatically. Here's how I'd approach it.

**Start with the spec, not the drawing.** The whole thing hinges on having a machine-readable
graph definition, which is really just his node contract turned into a schema. Something like
this, validated with Zod:

```ts
const Node = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["goal","split","worker","verifier","reduce","synthesize","gate"]),
  model: z.enum(["cheap","strong"]).optional(),
  in:  z.record(z.string()),        // declared input fields
  out: z.record(z.string()),        // declared output fields
  writes: z.array(z.string()).optional(), // files/APIs it touches
});

const Edge = z.object({ from: z.string(), to: z.string(), carries: z.array(z.string()) });
```

The `carries` field is what makes the tool more than a drawing app. An edge is only legitimate
if it actually transports named fields from the source's `out` into the target's `in`. That gives
you his fake-edge test as a lint rule you can run mechanically: any edge where `carries` is
empty, or where the fields don't appear in the downstream node's declared input, gets flagged as
removable. Delete it, recompute the layers, and the diagram visibly collapses from a tall chain
into a wide graph. That single feature is the product, honestly — the picture is just how you
show the result.

**Layout is a solved problem, so don't hand-roll it.** Run the validated graph through elkjs
(`layered` algorithm, direction DOWN) or dagre with `rankdir: TB`. Layered graph drawing assigns
every node a rank based on its longest dependency path, which means nodes with no dependency
between them automatically land on the same row. The diamond shape emerges for free; you never
position anything manually. Give it generous `ranksep` and small `nodesep` and it comes out
looking like his images.

**Then choose your render target based on how much polish you want.** The cheapest path is
emitting Mermaid `flowchart TD` text, which renders anywhere including GitHub and Notion, and
recent Mermaid versions support a `look: 'handDrawn'` config that gets you partway to the
aesthetic in about twenty lines of code. The best-looking path is generating SVG yourself and
drawing every box and arrow with rough.js, which produces genuinely wobbly hand-drawn strokes,
then layering a subtle paper texture and setting a handwriting face like Excalifont, Caveat, or
Patrick Hand. Pair that with his orange accent on edges and node borders and you're visually
indistinguishable. Export to PNG with resvg-js or sharp. A third option is emitting
`.excalidraw` scene JSON, which is just an array of element objects — that gives you a file the
user can open and nudge by hand in Excalidraw afterwards, which is a genuinely nice escape hatch.

If you want it interactive rather than a static export, React Flow with elkjs driving layout is
the standard combination. Users drag nodes, the linter re-runs on every change, and fake edges
get a red dashed style with a "this carries no data" tooltip.

**Two extra features that make it worth using rather than admiring.** First, generate the
orchestration code from the same spec. Since the graph already knows which nodes are
independent, emitting his `parallel(...)` / `agent(...)` skeleton is a template fill — meaning
the diagram and the runtime never drift apart, which is the usual failure mode of architecture
diagrams. Second, go the other direction: parse an existing TypeScript orchestration file with
ts-morph, find the `parallel()` and `agent()` calls, and reconstruct the graph from real code.
That answers "what does my workflow actually do" instead of "what did I intend it to do," and
it's where the fake-edge audit finds real waste.

Beyond the fake-edge check, the linter can encode his other failure modes cheaply. Any two nodes
on the same rank that share an entry in `writes` is a hidden edge, so warn about false
independence. Any worker whose verifier isn't marked `freshContext` is self-grading. Any fan-in
node with more than roughly thirty inbound edges and no intermediate summarize layer is a
context-collapse risk. Any merge node without an input count guard can silently synthesize on
partial data.

**For scope, I'd build it in this order.** A weekend gets you the Zod schema, three example
specs typed by hand, dagre layout, plain SVG output, and the fake-edge linter — that's the whole
value proposition proven. After that, add rough.js styling and the paper texture for the look,
then a natural-language front door where a schema-constrained model call turns "audit every
route file for missing auth checks" into a valid spec, then the code generator, and finally a
live mode where execution events stream in over a websocket and nodes light up green, red, or
amber with per-node token cost, which turns the static diagram into a monitoring dashboard.

---

## 3. Suggested repo shape

```
graph-engineer/            # i.e. ~/Development/ccgrapher
  packages/
    core/          # zod schema, spec parser, topo sort, layer assignment
    lint/          # fake-edge, hidden-edge, self-grading, fan-in, silent-failure rules
    layout/        # elkjs/dagre wrapper -> positioned graph
    render-svg/    # rough.js + paper texture + handwriting font -> SVG
    render-mermaid/# flowchart TD emitter (fallback / embeds)
    render-excalidraw/ # .excalidraw scene JSON emitter
    codegen/       # spec -> parallel()/agent() orchestration script
    ingest/        # ts-morph: existing code -> spec (reverse direction)
  apps/
    cli/           # graph lint <spec>, graph render <spec> -o out.svg
    web/           # optional: Next.js + React Flow editor + live run overlay
  examples/
    diamond.yaml
    research-desk.yaml
    route-auth-audit.yaml
    linear-chain.yaml
```

## 4. Acceptance criteria for the MVP

1. `graph render examples/diamond.yaml -o diamond.svg` produces a 4-layer diagram with the five
   workers on one row.
2. `graph lint` on the deliberately linear spec (`examples/linear-chain.yaml`) reports at least
   2 fake edges and prints the before/after critical-path length (expected: 6 layers → 4).
3. Removing the flagged edges and re-rendering visibly widens the diagram.
4. Zero manual coordinates anywhere in the codebase.

## 5. First prompt to use in Claude Code

> Read HANDOFF.md. Scaffold packages/core, packages/lint, packages/layout and packages/render-svg
> as a pnpm workspace in TypeScript. Implement the Zod schema, a topological layer assignment,
> the fake-edge lint rule, and a dagre-backed SVG renderer. Use the four specs in examples/ as
> fixtures. Then run the acceptance criteria in section 4 and show me the output SVG.

## 6. Open questions for the human

- Static export tool, interactive canvas, or both?
- Do we care about the reverse direction (code → diagram) in v1, or is spec → diagram enough?
- Which runtime are we generating code for — Claude Code dynamic workflows, LangGraph, plain
  TS with Promise.all, or pluggable adapters?
- Is the live execution overlay in scope, or a later phase?

---

## 7. Example specs

The four files in `examples/` are the fixtures. Two notes before you read them.

**Schema addendum.** The examples use three fields beyond what section 2 defined, so add them to
the Zod schema: `freshContext: z.boolean().optional()` on nodes, `expects: z.number().optional()`
for the fan-in count guard, and a `fanOut: z.object({ over: z.string(), cap: z.number().optional() }).optional()`
shorthand that `core` expands at layout time into a single stacked-card node with an `×N` badge
rather than N separate boxes. `route-auth-audit.yaml` also uses `worktree: z.boolean().optional()`.

**Known conflict to resolve early.** `model: null` on the reduce nodes conflicts with the
`z.enum(["cheap","strong"]).optional()` in the section 2 schema. Either widen it to
`z.enum(["cheap","strong","none"]).nullable().optional()` or drop the key entirely on code-only
nodes. Worth deciding early since the renderer keys node styling off it, and a no-model node
should probably draw as a sharp-cornered box rather than a sketchy one to signal "this is plain
code, it costs nothing."

**Why linear-chain.yaml earns its keep.** It encodes the fake-edge case from the article almost
literally — reviewing file A then file B where the second never reads the first's output — and
pairs it with a `MISSING_INPUT` finding, because the honest fix isn't just deleting the dead
edge, it's repointing it to whoever actually supplies `repo`. Do that and layers two through
four merge into a single row, which is the visible before-and-after your renderer needs to
demonstrate.
