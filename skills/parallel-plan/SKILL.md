---
name: parallel-plan
description: Before executing a multi-step plan, check which steps actually depend on each other and run the independent ones concurrently. Use when a plan has roughly five or more steps, when a session will merge several PRs or tickets, when fanning work out to subagents, or when the user asks what can be parallelised. Also catches a step that grades its own work and a fan-in with no count guard.
---

# Parallel plan

Most plans get written as a straight chain, because that is the order the steps
occurred to you. Very few are actually shaped that way. This skill finds the
difference between *"I did this, then that"* and *"that needed this"* — and it
does it mechanically rather than by eyeballing.

An edge between two steps only exists if **real data passes along it**. If step
B does not consume anything step A produced, B was never waiting on A, and the
wait was free to delete.

## The protocol: when it runs, and what one invocation does

**Not during planning.** Brainstorm and draft the plan freely first. Invoke this AFTER the
plan exists and BEFORE any tickets are written — and run the review in a **fresh context**
(a new session, or a fresh-context subagent), never the plan's author. An author grading
their own declarations is SELF_GRADING, the exact finding this tool exists to catch. The
mechanical lint is impartial either way; the honesty of the `in:`/`out:` fields is judgment,
and judgment is what needs the fresh eyes.

**One invocation is snapshot → pair → revision.** Snapshot the plan as it stands and render
it AS IS — that is the before, taken untouched. Then revise: lint findings, repairs,
restructuring, new ideas folded in. Render the after. **Post the pair, always** — never a
lone render; if a change is invisible in the picture, say so beside the pair rather than
posting one image.

**It is not a one-off.** Re-invoke at every change: a new idea introduced, a piece of work
finished, something studied that alters the shape. Each re-invocation snapshots again and
produces a new pair, so the plan's history is a sequence of pairs. The standing aim is the
diamond — keep pressing toward the widest honest waves. Being summoned is the current
limitation, not the ambition: a plan optimiser that notices change on its own is the obvious
next thing, and these invocation points are what stands in for it today.

## When this is worth doing

Use it when the plan has **five or more steps**, or whenever you are about to
fan work out to subagents. Below that the ceremony costs more than it saves —
just do the work.

Reach for it also when:

- a session will merge several PRs or tickets
- the user asks "what can run in parallel?"
- a plan has a review or verification step (the rules catch self-grading)
- many results converge on one step (the rules catch missing count guards)

Skip it for a single task, a genuinely sequential migration, or exploratory work
where you do not yet know the steps.

## How to use it

### 1. Write the plan as a spec

The whole value is in declaring what each step **consumes** and **produces**.
That act is what exposes the fake edges — you cannot write `in:` honestly and
still believe step 7 was waiting on step 6.

Write it to a scratch file:

```yaml
version: 1
name: session-plan
goal: "what this session is for"

nodes:
  - id: scope
    label: decide the scope
    kind: split
    out: { brief: string }

  - id: fix_auth
    label: fix the auth bug
    kind: worker
    in:  { brief: string }
    out: { auth_patch: patch }

  - id: add_tests
    label: add coverage for it
    kind: worker
    in:  { auth_patch: patch }        # genuinely downstream
    out: { tests: patch }

  - id: update_docs
    label: refresh the README
    kind: worker
    in:  { brief: string }            # needs the brief, NOT the auth fix
    out: { docs: patch }

edges:
  - { from: scope,    to: fix_auth,    carries: [brief] }
  - { from: fix_auth, to: add_tests,   carries: [auth_patch] }
  - { from: fix_auth, to: update_docs, carries: [] }   # ← nothing passes
```

Rules of thumb while writing it:

- **`in:` is what the step reads, not what happened before it.** This is the
  whole discipline. If you find yourself unable to name a field, there is no
  dependency.
- **`carries:` must name fields that exist in the source's `out` and the
  target's `in`.** Anything else is a fake edge and will be reported.
- Use `kind: verifier` with `freshContext: true` for anything that checks work,
  and `model: null` for steps that are plain code.
- **Every fan-in needs `expects: N`, and a verifier most of all.** Any step with
  more than one inbound edge is a fan-in. It is tempting to guard only the final
  synthesise step, because that is the one that looks like a join — but an
  unguarded verifier is the expensive miss: lose one upstream branch and it
  still emits a verdict, and the check passes without having seen the thing it
  was checking.

### 2. Run it

```bash
npx @ccgrapher/cli lint plan.yaml      # what is wrong with the shape
npx @ccgrapher/cli plan plan.yaml --fix # how to actually run it
```

`lint` names every step that is waiting on nothing and proposes where the edge
should have pointed. `plan --fix` prints the execution waves — everything in a
wave has no dependency on anything else in it.

Use `--json` on either when you want to consume the result programmatically
rather than read it.

### 3. Draw it, before and after

```bash
npx @ccgrapher/cli render plan.yaml -o before.svg
npx @ccgrapher/cli render plan.yaml --fix -o after.svg
```

Fake edges come out red. `-f mermaid` instead of an `.svg` path gives you
something that pastes into a pull request or a ticket comment.

Two habits make the picture worth having:

- **Put the ticket ID at the front of `label:`.** `YOG-164 Stripe live-mode
  cutover`, not `Stripe cutover`. It costs nothing while you are writing the
  spec, and it is the difference between a nice diagram and one you can act on
  — the shapes become the board.
- **Keep both renders.** The as-written graph shows what you believed; the
  repaired one shows what was true. The pair is the argument. A lone `--fix`
  render just looks like a plan somebody drew.

### 4. Execute in waves, not in order

Run each wave concurrently, then move on. In Claude Code that means one
`parallel()` per wave, or several `Agent` calls in a single message.

Do not silently ignore the findings. If the linter says two steps could run
together and you run them sequentially anyway, say why — usually a real reason
the spec did not capture, such as both touching the same file.

## What the findings mean

| Finding | What to do |
| --- | --- |
| `FAKE_EDGE` | The step was not waiting. Repoint the edge where the linter suggests, or drop it. |
| `MISSING_INPUT` | The step reads something nothing supplies. Usually the *real* dependency you missed. |
| `HIDDEN_EDGE` | Two concurrent steps write the same file. Isolate them or serialise — do not just run them together. |
| `SELF_GRADING` | Something checks its own work. Give the check a fresh context and a different agent. |
| `CONTEXT_COLLAPSE` | Too many results land on one step. Summarise in batches first. |
| `SILENT_FAILURE` | A fan-in with no count guard. One dead branch and the result looks complete but is not. |

The last three are not about speed. `SILENT_FAILURE` in particular is how a
release passes a check that never ran.

## Interpreting the plan honestly

- **Waves are an upper bound on concurrency, not an instruction.** Six steps in
  one wave means six *may* run at once; rate limits, cost, or a shared resource
  may say otherwise.
- **A wave of one is fine.** Not every plan has slack in it, and reporting "no
  parallelism available" is a real result.
- **The layer count is only as honest as the `in:` fields.** Declare a
  dependency that is not real and you get a chain back; declare none and
  everything looks parallel. The spec is the argument — the tool only checks it
  for consistency.

## Worked example

`examples/release-session.yaml` in the ccgrapher repo is a real session: nine
pull requests shipped one after another. `ccg plan` on it as written reports 12
waves. With `--fix` it reports 5 — six of the nine were never waiting on
anything. Nothing about the work changed; only the claim about its shape.
