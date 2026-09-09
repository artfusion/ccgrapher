# Changelog

All notable changes to ccgrapher, newest first. The `vX.Y.Z` entries cover the
published npm packages, which move together; `apps/web vX.Y.Z` entries cover the
private web canvas, which has its own train. Full notes accompany each
[GitHub release](https://github.com/artfusion/ccgrapher/releases).

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
