# CLAUDE.md — ccgrapher

A compiler and linter for agent workflow DAGs. The repo invariant, everywhere: core computes
ranks, layout computes pixels, overlays only tint. The picture is a consequence of the `in:`/`out:`
declarations, never something a human drags. `goal:` is a caption and must never become a node.

## Working here

- pnpm 11, Node 22+. `pnpm build`, then `pnpm test` (vitest; CI runs Node 22 + 24 plus an
  acceptance-criteria shell block in `.github/workflows/ci.yml`).
- ESM throughout, `.js` extensions in relative imports, strict TS with `noUncheckedIndexedAccess`,
  SPDX `Apache-2.0` header on every source file (CI enforces).
- Commit style: conventional commits with a scope and an editorial subject after an em dash.
- Releases: bump all publishable packages together, tag, GitHub release, then `tools/publish.sh`.
  `apps/web` stays private and unpublished.
- The trace contract (`@ccgrapher/trace`, once it exists) is additive-only within `v: 1`. It is a
  compatibility surface; treat every schema change as a compatibility decision.
- This repository holds code and public documentation only. Project planning lives elsewhere; a
  local, gitignored `CLAUDE.local.md` supplies that context when present.
