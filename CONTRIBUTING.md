# Contributing

Thanks for taking a look. This is a small, focused project — a linter for agent workflows and four
ways to draw the result — so contributions that keep it small and focused are the easiest to merge.

## Setup

```bash
git clone https://github.com/artfusion/ccgrapher.git
cd ccgrapher
pnpm install
pnpm build
pnpm test
```

Node 22 or newer, pnpm 10 or newer. CI runs on Node 22 and 24.

| Command | Does |
| --- | --- |
| `pnpm build` | `tsc -b` across the workspace |
| `pnpm test` | the full vitest suite |
| `pnpm test:watch` | the suite in watch mode |
| `pnpm --filter @ccgrapher/web dev` | the canvas on `localhost:3210` |

The CLI runs from `node apps/cli/dist/index.js` after a build.

## The one invariant

`core` computes **ranks** — which row a node sits on, by longest path. `layout` computes **pixels**.
The linter's "6 layers → 4" figure comes from `core` and must never come from the layout library,
or the diagram and the report could disagree without anyone noticing.

`packages/layout/test/layout.test.ts` asserts that dagre's rows match `core`'s ranks on every
fixture. If you change layout, that test is the one that matters.

## Adding a lint rule

The most likely contribution. Four steps:

1. **Add the id** to `RULE_ORDER` in [`packages/lint/src/types.ts`](packages/lint/src/types.ts) and
   give it a severity in `ruleSeverity`. Order in that array is report order.
2. **Write the rule** in [`packages/lint/src/rules.ts`](packages/lint/src/rules.ts) as
   `(graph: Graph, phase: Phase) => Finding[]`, and add it to `runAllRules`. Helpers you probably
   want already exist: `effectiveCarries`, `unsatisfiedInputs`, and from `core`
   `effectiveInboundCount`, `roots`, `ancestors`, `hasPath`.
3. **Add a fixture** to `examples/` that trips it, with the expected findings written in the header
   comment. Every existing fixture does this and the tests check the comment is true.
4. **Assert it in** [`packages/lint/test/lint.test.ts`](packages/lint/test/lint.test.ts) — both that
   it fires on your fixture and that it stays silent on `diamond`, `research-desk` and
   `route-auth-audit`, which are the clean controls.

Two things to know before writing one:

- **Lint is two-pass.** Rules run against the graph as written, then again against the repaired
  graph, and new findings are reported with `phase: "repaired"`. `HIDDEN_EDGE` only becomes true
  after repair — as written, the two colliding nodes are a rank apart. If your rule depends on which
  nodes are *concurrent*, it belongs in the second pass and you get that for free.
- **A rule that fires on a clean fixture is a bug.** `SILENT_FAILURE` is scoped to fan-ins of more
  than one precisely so `diamond`'s single-inbound `merge` stays quiet.

## Adding an audit rule

Audit rules live in [`packages/lint/src/audit.ts`](packages/lint/src/audit.ts) and compare a run's
trace against its spec. They follow the same four steps, with two differences. The id goes in
`AUDIT_RULE_ORDER` rather than `RULE_ORDER`, so the six lint rules stay six — an audit rule needs a
run and a spec alone can never produce one. And the fixture is a *pair*: a spec in `examples/` plus
a trace in `examples/traces/`, with the expected findings written in the spec's header comment.

One rule of its own, and it is the whole reason these are separate: **a finding needs positive
evidence, not the absence of contrary evidence.** A capability nothing reported on is unknown, not
missing. A run that never reports invocations has not told you a declaration went unused. If your
rule would fire on a trace that simply said nothing, it is asserting more than it checked, and that
is the failure this project exists to catch rather than commit.

Two fixtures that will find this out for you: a trace with the capability events stripped, and one
from a producer that reports availability but never invocations.

## Adding a render target

Implement against `PositionedGraph` from `@ccgrapher/layout` (as `render-svg` and
`render-excalidraw` do) — or against `Graph` alone if your target does its own layout, as
`render-mermaid` does. Then wire it into `resolveFormat` in
[`apps/cli/src/commands/render.ts`](apps/cli/src/commands/render.ts).

Whatever you emit should be deterministic: same spec in, byte-identical output out. The existing
renderers seed rough.js from a hash of the node id for exactly this reason, and each has a test
asserting it.

## Adding a codegen target

Implement the `Emitter` interface in [`packages/codegen/src/types.ts`](packages/codegen/src/types.ts)
and register it in `EMITTERS`. Use `stages(graph)` — one entry per rank, and everything in a stage
can run at once, which is the whole point of having drawn the graph.

Generated code is verified by actually parsing it, not by eyeballing: TypeScript targets go through
real `ts.createProgram` diagnostics under `strict`, and the Claude Code target is parsed as an async
function body. Both live in `packages/codegen/test/codegen.test.ts`. Please keep that up — it has
already caught bugs that reviewing the strings would not have.

## Style

- Match the surrounding code. Comments explain *why*, not *what*.
- No new dependency without a reason in the PR description.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`. CI fails without it.
- British or American spelling, whichever the file already uses.

## Licensing of contributions

By submitting a pull request you agree that your contribution is licensed under Apache-2.0, per
section 5 of the licence. There is no separate CLA.

If you add a dependency, check its licence is permissive and add it to
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). If it ships anything that ends up *inside*
generated output — as the Caveat font does — its notice has to travel inside that output too, not
just sit in the repo.

## Releasing

The packages are not yet published. When they are, from a clean `main`:

```bash
pnpm build && pnpm test          # must be green
pnpm -r exec npm version <patch|minor|major>
pnpm -r --filter "./packages/*" --filter @ccgrapher/cli publish --access public
git push --follow-tags
```

There is deliberately no `release` script in `package.json`, so publishing is never one stray
keystroke away.
