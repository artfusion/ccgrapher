# Changelog

All notable changes to ccgrapher, newest first. The `vX.Y.Z` entries cover the
published npm packages, which move together; `apps/web vX.Y.Z` entries cover the
private web canvas, which has its own train. Full notes accompany each
[GitHub release](https://github.com/artfusion/ccgrapher/releases).

## Unreleased

- A spec can now say what one run hands the next. `schedule:` is one opaque line; `stores:` names
  state that outlives a run, each with an `owner` (`human` or `agent`) and, for progress state,
  the effect it `records`; on a node, `effects:` names what cannot be taken back and `guards:` the
  effects it makes at-most-once. All optional, and `version` stays 1. A guard or a `records` that
  names an effect no node performs is rejected when the spec loads.
- Three rules read them. `AUTHORITY_BREACH` (error) fires when a node that is not a gate writes a
  store a person owns, or when a member of a `read-only` boundary has `writes` or `effects`.
  `DUPLICATE_EFFECT` (warn) fires on an effect in a scheduled workflow that nothing at or before
  it guards. `EARLY_COMMIT` (warn) fires when a store that records an effect is written anywhere
  but strictly after it. None repairs; `--fix` still only moves edges. A "do this after that"
  edge that carries nothing is still dropped by `--fix`, and the repaired pass now says what that
  costs.
- Each has a mark, in the same red ring as the others: `writes preferences` or "writes in
  read-only", `unguarded post:brief-channel`, `ledger too early`. Mermaid and Excalidraw note the
  same in the label.
- `examples/daily-brief.yaml` is a scheduled workflow written with all of it, and lints clean.
- plain-ts carries the new fields through codegen and back: the schedule and the stores as
  header lines, effects and guards as doc-comment traits. claude-code, langgraph and
  managed-agents say in a warning that they cannot.
- Findings gain optional `effect` and `boundary` fields, and `resource` now also names the store
  on `EARLY_COMMIT` and `AUTHORITY_BREACH`. `@ccgrapher/lint` exports `writeDenial`, the one
  predicate behind both forms of `AUTHORITY_BREACH`.
- A CLI from before this release ignores the new fields without a word, so a spec using them
  lints clean there whatever it declares.

- `ccg codegen -t managed-agents -o <dir>` writes the directory `ant apply` reads for Claude
  Managed Agents: one agent per model node, named by node id, plus one environment. Plain-code
  nodes and gates get no agent and are listed in a generated README. Without `-o` it exits 2, and
  it will not write into a directory that has files in it unless given `--force`.
- `uses:` carries over where there is an equivalent. MCP servers arrive as `YOUR_` placeholders,
  since a spec names no server URL, and plugins are warned about rather than dropped quietly.
- `@ccgrapher/codegen` gains `codegenFiles` and a `DirectoryEmitter` for targets that write a
  directory. `TARGETS` is unchanged; `ALL_TARGETS` and `isAnyTarget` include the new kind.
- Model tiers now resolve through one table, `TIER_FAMILY`. The claude-code output is
  byte-identical to before.
- `ccg run` starts a step the moment its inputs exist. The runner used to run each wave as a
  barrier, so every step waited for the slowest step of the wave before it, even when its own
  inputs had arrived long ago. Now a step starts once every step it has an edge from has finished
  and delivered and its `expects` guard is met. The waves remain the plan's picture in `ccg plan`;
  they are no longer a barrier in the run.
- `ccg run --concurrency <n>`, and `concurrency` on the runner's options, bound how many node calls
  run at once. Each fanned instance is one call; a gate waiting on a human and a skipped node take
  none. The default is no limit, which is what a wave already did with everything in it. When more
  is ready than there are slots, the lower rank goes first, then spec order, then instance; the
  same order starts steps that become ready together, so traces are reproducible.
- What changes on failure. As before, a failed step's descendants are skipped and branches that do
  not depend on it carry on. The difference is timing: the skips are recorded the moment the
  failure is known rather than when its wave ends, and an unrelated branch no longer waits on a
  failed or slow neighbour at each wave boundary. A gate now pauses only its own descendants; under
  waves it held up every later wave. When an `expects` guard or a missing gate resolver stops the
  run, nothing new starts, including steps that became ready at the same moment, which under waves
  would already have been started alongside it. Steps already running still finish and are
  recorded before `run_finished`.
- Trace events are unchanged in shape, and `ccg trace audit` finds nothing to report on traces
  from the new scheduler. The committed `examples/traces/live-demo.jsonl` was written by the old
  one; a rerun would differ only in the skip of `count_lines` arriving earlier.
- `ccg trace audit` no longer takes the first copy of a fanned step back as the whole step. A
  node that starts after one of five research copies has finished is now an `ORDER_VIOLATION`;
  it is in order once every copy has finished, counting the copies the run started or the `of`
  it announced, whichever is more. The declared `cap` is not the yardstick, since it is a
  maximum rather than a promise.
- A new audit rule, `FAN_IN_SHORTFALL`, an error: a node with `expects: N` that started with
  fewer than N results recorded upstream. A failed copy delivers nothing and an approved gate
  delivers one. A surplus is left to the linter, and a trace that never mentions the upstream is
  not counted as zero.
- The run-time `expects` comparison is now one function, `expectsShortfall` in
  `@ccgrapher/core`, and the runner and the audit both call it. The guards that codegen emits
  are source text for other runtimes and stay held level by tests. The trace contract is
  unchanged.
- `ccg render` draws the count guard. Every node that declares `expects` carries the number,
  bottom right, and the node group carries `data-expects`. A repair that adds a guard now shows
  in the picture; before, the picture could not tell a guarded fan-in from an unguarded one.
- Fan-ins the linter flags are marked in all four formats: a solid red ring and a small flag,
  with "no count guard" when `expects` is missing and `9 ≠ 8` when it disagrees with the edges.
  Mermaid and Excalidraw carry the same count and a red outline. `--plain` leaves the marks off.
- `ccg render --pair` writes a before and an after, `<name>-before` and `<name>-after`. With one
  spec that is as written and repaired; with two (`--pair before.yaml after.yaml`) it is each as
  written, which is how a hand-added guard shows. It needs `-o` and refuses `--fix`.
- Lint findings for `SILENT_FAILURE` gain an optional `arriving` field, so a renderer need not
  count again. Additive: existing `--json` consumers see one extra key on those findings.
- `render-svg` takes a `guardFindings` option, and `render-mermaid` and `render-excalidraw` take
  the same. The theme gains `quiet` and `dangerInk`, the small-text variants of its muted and
  danger colours.
- The README images are regenerated, and `tools/rasterize.mjs` now falls back to system fonts
  for the `≠` that Caveat does not have.
- `ccg render` says who does each step. The model tier sits top left, `strong` or `cheap`, with
  `data-tier` on the node group; plain code and an unspecified tier carry no mark. A node that
  declares `uses: [agent:<type>]` shows `agent: <type>` under its label, with `data-agent`.
  Mermaid and Excalidraw append the same words to the label.
- Layout makes the room: a tiered node is 10px taller, and an agent tag adds a line and widens
  the box when it is longer than the label. `Metrics` gains `tierBand`, `tagSize` and
  `tagLineHeight`, so a caller building its own metrics must now supply them. Core exports
  `agentTypes` and `agentTag`. The spec still names a tier, never a model id.
- Every lint rule now has a mark, so the picture is the lint report and any repair shows as a
  before and an after. A starved node reads `no repo`, a verifier without a fresh context reads
  "grades own work", an overloaded fan-in reads `200 in, no reduce`, each inside the same red
  ring. Two concurrent writers of one file are joined by a thin solid red line, labelled with the
  file and routed above their row or round the margin, never through a box.
- A node with several findings carries one caption: the first in rule order, then a count of
  the rest (`no rubric +2`), shortened where the box is tight. Node groups list their rules in
  `data-findings`; a dead edge carries `data-finding="FAKE_EDGE"`.
- Mermaid notes each finding in the node label with a red outline. A shared write is noted on
  both nodes rather than drawn, since any Mermaid link would move a node down a row. Excalidraw
  draws the line, bound to nothing, with the file beside it.
- `@ccgrapher/lint` exports `renderMarksFor`, which turns findings into render options and has
  an entry for every rule, so a rule added without a mark does not compile. A test over
  `RULE_ORDER` checks each one is drawn in all three formats and that `--plain` leaves it off.
- Findings gain more optional fields, all additive: `field` on `MISSING_INPUT`, `resource` on
  `HIDDEN_EDGE`, and `arriving` now also on `CONTEXT_COLLAPSE`. `@ccgrapher/layout` exports
  `routeLinks`, and the renderers take a `findingMarks` option.
- The structural check now renders every example with its findings marked, plain, and repaired,
  plus four small specs built to crowd a node, and holds the shared-write line to the same
  rules as an edge. It passes with no new allowances.

Web canvas (`apps/web`, its own train; not in the published packages):

- A node inspector. Click a step, or pick it from the list in the new right-hand panel, and its
  fields can be edited there: tier, kind, label, `in` and `out`, `writes`, `uses`, `effects`,
  `guards`, `expects`, `fanOut`, `worktree`, `freshContext`. An edit rewrites the spec text, and the picture and the
  findings follow, as they do for typing. The text area stays; the two are views of one spec.
- The controls are read off the spec schema rather than written per field, so a field the schema
  gains appears in the panel without UI work. A shape the panel has no control for is edited as
  YAML.
- A value the schema refuses is shown next to its control with the reason, and the spec is left
  alone. Nothing is applied in part.
- The step's lint findings sit at the top of the panel. A fake edge offers the linter's own
  repair, applied with one click; the other rules are reported, not repaired.
- Undo and redo for edits made in the panel, one step per edit, back to the exact text. Typing in
  the text area, loading a spec or drawing a link starts the history afresh.
- The canvas now redraws whenever the laid-out picture changes, not only when the number of steps
  does, so a rewired dependency moves its box. It reframes when it does; animating the move is
  separate work.

## v0.5.0 — 2026-09-09

- New `html` render format: the same picture as `svg`, wrapped in a self-contained
  page with cursor-anchored wheel zoom and drag-to-pan. No CDN, no server — it opens
  as a chat attachment or a browser tab and reads fine at any size.
- `ccg trace audit` gains four rules that hold the graph's nodes and edges against a
  run, not only its capabilities: `NODE_NEVER_RAN`, `UNDECLARED_NODE`,
  `ORDER_VIOLATION` (a node started before its declared predecessor finished) and
  `OBSERVED_SERIALISATION` (a candidate hidden edge, evidenced across several runs).
- `HIDDEN_EDGE` now compares every pair of nodes with no declared path between them,
  not only nodes on the same layer. A real cross-layer write collision was going
  unreported.
- `render-excalidraw`'s README says how to open the file it produces; the main
  README documents all four render formats.

## apps/web v0.4.0 — 2026-09-09

- `next build` produces a static export. No Node server — the canvas has always
  been client-only.
- A spec carried in the URL fragment (`#spec=...`) loads directly and turns on a
  read-only viewer mode: the editing surface hides, the repair toggle and the
  live-run bar stay.
- Deployed at ccgrapher.artfusion.com/app — `basePath: "/app"` so it sits in a
  subdirectory of the existing site rather than needing its own subdomain.

No published package changed.

## apps/web v0.3.0 — 2026-08-31

- Mouse-wheel zoom and drag-to-pan on the canvas.
- Open a spec file directly into the canvas.
- jsdom smoke tests for the editor and direct coverage for the graph model.

No published package changed. The CLI and every `@ccgrapher/*` package remain
at 0.4.0.

## apps/web v0.2.0 — 2026-08-10

- The canvas moved from React Flow to JointJS. Same picture, same overlays,
  same lint findings.
- Declared `in:`/`out:` fields are real ports. Drawing a connection between
  ports edits the YAML and lints as you draw; dragging a node changes nothing,
  because the picture is a consequence of the declarations.
- Two seeding and event-timing bugs surfaced by the migration were fixed along
  the way.

## v0.4.0 — 2026-08-07

- Nodes can declare capabilities with `uses:` (MCP servers, skills, plugins,
  other agents), as opaque namespaced ids.
- Three new trace events, additive within `v: 1`: `capability_available`,
  `capability_lost` and `capability_invoked`.
- `ccg trace audit` reports `CAPABILITY_GAP`, `UNUSED_CAPABILITY` and
  `UNDECLARED_CAPABILITY`, and refuses to guess: a capability nothing reported
  on is unknown rather than missing, and an audit only speaks for the run it
  was given.
- New package `@ccgrapher/adapter-claude-code`: a Claude Code session becomes
  the same trace through its hooks.
- The SSE transport forwards unknown event types with sequence numbers intact,
  honouring the additive-only contract one layer below where it was made.

## v0.3.1 — 2026-08-07

- An unknown flag now exits 2 with a usage message instead of exiting 1 with a
  stack trace, so a typo is no longer indistinguishable from a failing check.
- `--help` after a subcommand prints usage and exits 0.

## v0.3.0 — 2026-08-02

- `ccg retro <owner/repo>` rebuilds the as-merged workflow from pull request
  history, no spec required.
- New package `@ccgrapher/trace`: a versioned JSONL event contract, additive
  only within `v: 1`, with the reducer that folds it back into state.
- New package `@ccgrapher/runner`: `ccg run` executes a spec and writes a
  trace; `ccg serve` streams it over SSE and survives a dropped connection.
- Ingest recovers edges from dataflow rather than variable names, and warns
  when nodes parse but no dependency does.
- One `expects` rule across all three runtimes, where there had been three
  implementations and two comparisons.
- `tools/publish.sh` refuses to run while any publishable package is missing
  from its list, closing a path that shipped ten of eleven packages silently.

## v0.2.0 — 2026-07-30

- First public release: six lint rules with a two-pass repair pipeline,
  `ccg plan` with honest wave counts, four render targets, codegen for three
  runtimes, and lossless ingest round-trips.
- A Claude Code skill, `parallel-plan`, that has an agent check its own plan
  for false ordering before executing it.
- 0.1.0 on npm is deprecated and broken; it shipped with the `workspace:`
  protocol unresolved.
