# CLAUDE.md — ccgrapher

@~/.claude/standards/ticket-workflow.md

A compiler and linter for agent workflow DAGs. The repo invariant, everywhere: core computes
ranks, layout computes pixels, overlays only tint. The picture is a consequence of the `in:`/`out:`
declarations, never something a human drags. `goal:` is a caption and must never become a node.

## Working here

- pnpm 11, Node 22+. `pnpm build`, then `pnpm test` (vitest; CI runs Node 22 + 24 plus an
  acceptance-criteria shell block in `.github/workflows/ci.yml`).
- ESM throughout, `.js` extensions in relative imports, strict TS with `noUncheckedIndexedAccess`,
  SPDX `Apache-2.0` header on every source file (CI enforces).
- Tickets: Linear workspace `artfusion`, team ART, project CCGrapher. The roadmap is a lintable
  spec at `plans/vision-rollout.yaml` — after editing it, re-run `ccg lint` and re-render the SVG
  and mermaid next to it. Direction history lives on ART-155; the dual-track decision is VISION.md.
- Commit style: conventional commits with a scope and an editorial subject after an em dash,
  e.g. `feat(cli): \`ccg retro\` — the as-merged workflow from a repo's PR history`.
- Releases: bump all publishable packages together, tag, GitHub release, then `tools/publish.sh`
  (requires Michael's authenticated npm session — see ART-161/ART-157). `apps/web` and `apps/site`
  stay private and unpublished.
- `HANDOFF-SESSION.md` (gitignored) is the working handoff. `HANDOFF.md` is the original browser
  drop and stays verbatim.
- Published prose (README, VISION.md, site copy) follows the `michael-voice` skill: British
  spelling, no em dashes in prose, no exclamation marks, understatement, no corporate verbs.
- The trace contract (`@ccgrapher/trace`, once it exists) is additive-only within `v: 1`. It is the
  future Cloud ingest API; treat every schema change as a compatibility decision.
