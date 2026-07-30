# ccgrapher

A tool that turns a machine-readable agent-workflow spec into a layered, hand-drawn-style
graph diagram, lints the workflow for wasted sequencing, and generates the matching
orchestration code.

**Target location on this machine:** `~/Development/ccgrapher`

## What is in this drop

| File | Purpose |
|------|---------|
| `README.md` | This file. Orientation and how to start. |
| `HANDOFF.md` | The full project handoff: source material, image links, concept digest, architecture, repo shape, acceptance criteria, open questions. **Read this first.** |
| `CONVERSATION.md` | Complete transcript of the browser session that produced this, including every comment and aside. Nothing trimmed. |
| `examples/diamond.yaml` | Exact reproduction of the source article's diamond figure. 4 layers, 5 workers on one row. |
| `examples/research-desk.yaml` | Fuller diamond: code-only reduce step, three-lens verification, majority vote, human gate. |
| `examples/route-auth-audit.yaml` | Fan-out over a file glob with a cap, isolated worktrees, fan-in guard. |
| `examples/linear-chain.yaml` | Deliberately broken. The linter's test fixture. |

## Install into place

```bash
mkdir -p ~/Development/ccgrapher
unzip ~/Downloads/ccgrapher-handoff.zip -d ~/Development/ccgrapher
cd ~/Development/ccgrapher
```

## First prompt for Claude Code

> Read HANDOFF.md and CONVERSATION.md. Scaffold packages/core, packages/lint, packages/layout
> and packages/render-svg as a pnpm workspace in TypeScript. Implement the Zod schema, a
> topological layer assignment, the fake-edge lint rule, and a dagre-backed SVG renderer.
> The four specs in examples/ are your fixtures. Then run the acceptance criteria in HANDOFF.md
> section 4 and show me the output SVG.

## The one-line version of the idea

An edge between two agent nodes only exists if real data passes along it. Most workflows are
typed as a straight chain out of habit, so most edges are fake. Delete the fake ones, the graph
gets wide instead of tall, and the same work finishes in the time of the slowest layer instead
of the sum of every step. The diagram is just how you see that.
