// SPDX-License-Identifier: Apache-2.0
/**
 * The example specs, inlined so the canvas needs no server round trip. They are
 * the same files the CLI uses as fixtures.
 */

export const FIXTURES: Record<string, string> = {
  "linear-chain": `version: 1
name: linear-chain
goal: "review this repo for bugs and doc rot"

nodes:
  - id: setup
    label: clone and index repo
    kind: split
    model: null
    in:  { url: string }
    out: { repo: path }

  - id: review_a
    label: review file A for bugs
    kind: worker
    model: cheap
    in:  { repo: path }
    out: { issues_a: "string[]" }
    writes: ["notes/findings.md"]

  - id: review_b
    label: review file B for bugs
    kind: worker
    model: cheap
    in:  { repo: path }
    out: { issues_b: "string[]" }
    writes: ["notes/findings.md"]

  - id: lint_docs
    label: check docs for rot
    kind: worker
    model: cheap
    in:  { repo: path }
    out: { doc_issues: "string[]" }

  - id: collate
    label: collate everything
    kind: reduce
    model: null
    expects: 3
    in:  { issues_a: "string[]", issues_b: "string[]", doc_issues: "string[]" }
    out: { all_issues: "string[]" }

  - id: write_report
    label: write the report
    kind: synthesize
    model: strong
    in:  { all_issues: "string[]" }
    out: { report: markdown }
    writes: ["review.md"]

edges:
  - { from: setup,     to: review_a,     carries: [repo] }
  - { from: review_a,  to: review_b,     carries: [] }
  - { from: review_b,  to: lint_docs,    carries: [] }
  - { from: review_a,  to: collate,      carries: [issues_a] }
  - { from: review_b,  to: collate,      carries: [issues_b] }
  - { from: lint_docs, to: collate,      carries: [doc_issues] }
  - { from: collate,   to: write_report, carries: [all_issues] }
`,

  diamond: `version: 1
name: diamond
goal: "market scan: how do we compare to the top 3 competitors"

nodes:
  - id: split
    label: split the job
    kind: split
    in:  { question: string }
    out: { angle: string }

  - id: worker_1
    label: worker 1
    kind: worker
    model: cheap
    in:  { angle: string }
    out: { claim: string, source: url, date: "YYYY-MM-DD" }

  - id: worker_2
    label: worker 2
    kind: worker
    model: cheap
    in:  { angle: string }
    out: { claim: string, source: url, date: "YYYY-MM-DD" }

  - id: worker_3
    label: worker 3
    kind: worker
    model: cheap
    in:  { angle: string }
    out: { claim: string, source: url, date: "YYYY-MM-DD" }

  - id: worker_4
    label: worker 4
    kind: worker
    model: cheap
    in:  { angle: string }
    out: { claim: string, source: url, date: "YYYY-MM-DD" }

  - id: worker_5
    label: worker 5
    kind: worker
    model: cheap
    in:  { angle: string }
    out: { claim: string, source: url, date: "YYYY-MM-DD" }

  - id: checker
    label: checker
    kind: verifier
    model: strong
    freshContext: true
    expects: 5
    in:  { claim: string, source: url, date: "YYYY-MM-DD" }
    out: { claim: string, verdict: "keep|drop", why: string }

  - id: merge
    label: merge into one answer
    kind: synthesize
    model: strong
    in:  { claim: string, verdict: "keep|drop" }
    out: { report: markdown }
    writes: ["reports/market-scan.md"]

edges:
  - { from: split, to: worker_1, carries: [angle] }
  - { from: split, to: worker_2, carries: [angle] }
  - { from: split, to: worker_3, carries: [angle] }
  - { from: split, to: worker_4, carries: [angle] }
  - { from: split, to: worker_5, carries: [angle] }
  - { from: worker_1, to: checker, carries: [claim, source, date] }
  - { from: worker_2, to: checker, carries: [claim, source, date] }
  - { from: worker_3, to: checker, carries: [claim, source, date] }
  - { from: worker_4, to: checker, carries: [claim, source, date] }
  - { from: worker_5, to: checker, carries: [claim, source, date] }
  - { from: checker, to: merge, carries: [claim, verdict] }
`,

  "self-grading": `version: 1
name: self-grading
goal: "draft two sections and grade them"

nodes:
  - id: brief
    label: write the brief
    kind: split
    model: strong
    in:  { topic: string }
    out: { section: string }

  - id: draft_a
    label: draft section A
    kind: worker
    model: cheap
    in:  { section: string }
    out: { text_a: markdown }
    writes: ["out/draft.md"]

  - id: draft_b
    label: draft section B
    kind: worker
    model: cheap
    in:  { section: string }
    out: { text_b: markdown }
    writes: ["out/draft.md"]

  - id: check_own
    label: grade the drafts
    kind: verifier
    model: cheap
    expects: 2
    in:  { text_a: markdown, text_b: markdown }
    out: { verdict: "keep|drop" }

  - id: publish
    label: publish
    kind: synthesize
    model: strong
    in:  { verdict: "keep|drop" }
    out: { page: html }
    writes: ["out/page.html"]

edges:
  - { from: brief,     to: draft_a,   carries: [section] }
  - { from: brief,     to: draft_b,   carries: [section] }
  - { from: draft_a,   to: check_own, carries: [text_a] }
  - { from: draft_b,   to: check_own, carries: [text_b] }
  - { from: check_own, to: publish,   carries: [verdict] }
`,

  // The spec behind examples/traces/live-demo.jsonl. Load this one and point the
  // live bar at a server holding that trace, and the canvas has something real
  // to tint: a branch that fails, a node skipped for want of an input, and a gate.
  "live-demo": `version: 1
name: live-demo
goal: "summarise a change: two parallel readers, one that fails, and a human gate"

nodes:
  - id: plan
    label: plan the work
    kind: split
    model: cheap
    in:  { topic: string }
    out: { docs_url: url, code_path: string }

  - id: fetch_docs
    label: read the docs
    kind: worker
    model: cheap
    in:  { docs_url: url }
    out: { notes: markdown }

  - id: fetch_code
    label: read the source
    kind: worker
    model: cheap
    in:  { code_path: string }
    out: { symbols: "string[]" }

  - id: count_lines
    label: count what changed
    kind: worker
    model: null
    in:  { symbols: "string[]" }
    out: { total: number }

  - id: summarise
    label: write the summary
    kind: synthesize
    model: strong
    in:  { notes: markdown }
    out: { summary: markdown }

  - id: review
    label: a human reads it
    kind: gate
    in:  { summary: markdown }
    out: { summary: markdown }

  - id: publish
    label: publish the summary
    kind: worker
    model: null
    in:  { summary: markdown }
    out: { path: string }
    writes: ["out/live-demo.md"]

edges:
  - { from: plan,       to: fetch_docs,  carries: [docs_url] }
  - { from: plan,       to: fetch_code,  carries: [code_path] }
  - { from: fetch_docs, to: summarise,   carries: [notes] }
  - { from: fetch_code, to: count_lines, carries: [symbols] }
  - { from: summarise,  to: review,      carries: [summary] }
  - { from: review,     to: publish,     carries: [summary] }
`,
};

export const DEFAULT_FIXTURE = "linear-chain";
