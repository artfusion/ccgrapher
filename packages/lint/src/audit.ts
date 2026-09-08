// SPDX-License-Identifier: Apache-2.0
import { hasPath, type Graph } from "@ccgrapher/core";
import { isTraceEvent, type TraceEvent, type TraceLine } from "@ccgrapher/trace";
import { type Severity } from "./types.js";

/**
 * Holding a run against the spec it claims to implement.
 *
 * `lint` asks whether a graph is honest about itself. This asks a different
 * question, and needs a second input to ask it: a node declares the
 * capabilities it depends on in `uses`, a run reports which capabilities were
 * there, which were lost and which were actually called, and the three can
 * disagree. Every disagreement is a finding here.
 *
 * It is not a lint rule and does not run inside `lint()`. `lint(graph)` takes a
 * graph and nothing else, and a rule that silently did nothing without a trace
 * would be a seventh rule that is only sometimes a rule. So this is its own
 * pass, with its own rule ids and its own result type.
 *
 * **Absent is not zero, and it is not "no".** A capability nobody reported on is
 * UNKNOWN, and unknown produces no finding at all. Only positive evidence of
 * loss — a `capability_lost` event — can make a gap. The same reasoning runs
 * through `Usage` and `HeatData` in the trace contract, and it matters most
 * here, because "your run had no tools" is the kind of claim that sends someone
 * chasing an outage that never happened.
 *
 * **Honest degradation.** A trace written by an adapter watching a live agent
 * session has no `node_started` events and no node attribution on its
 * invocations: nothing there knows about the spec's nodes. UNUSED_CAPABILITY and
 * CAPABILITY_GAP therefore go quiet on such a trace — both need to know a node
 * ran — while UNDECLARED_CAPABILITY still works run-scoped, reporting a
 * capability the session used that no node in the spec declares. Fewer rules
 * firing on a thinner trace is the correct behaviour, not a hole to plug with
 * guesses.
 *
 * **Per run, then deduped.** Each run is a separate observation and is walked on
 * its own timeline; a node that ran without invoking its declared capability is
 * a finding about that run. Identical findings from several pooled runs collapse
 * into one, so a directory of thirty runs of the same broken workflow reports
 * the problem once.
 *
 * **Declared versus observed, at the node level too.** The three capability
 * rules above hold `uses:` against what a run reports. Four more rules hold
 * the graph's nodes and edges themselves against the same run: a node the spec
 * declares that never started (`NODE_NEVER_RAN`), a `node_started` for an id
 * the spec does not know (`UNDECLARED_NODE`), a node that started before its
 * declared predecessor finished (`ORDER_VIOLATION` — the strongest of the four,
 * because it means the dependency the graph promises was not honoured), and
 * two nodes with no declared path between them that consistently never
 * overlap across several runs (`OBSERVED_SERIALISATION` — a candidate hidden
 * edge, reported only once there is more than a single run's worth of
 * evidence). These reuse the same run-matching and the same "absent is not
 * zero" doctrine as the capability rules; see each rule's implementation below
 * for exactly what counts as evidence.
 */

/** Errors first, the way `RULE_ORDER` orders the lint rules. Order here is report order. */
export const AUDIT_RULE_ORDER = [
  "CAPABILITY_GAP",
  "ORDER_VIOLATION",
  "UNUSED_CAPABILITY",
  "UNDECLARED_CAPABILITY",
  "NODE_NEVER_RAN",
  "UNDECLARED_NODE",
  "OBSERVED_SERIALISATION",
] as const;

/** Fewer than this many non-overlapping runs is a coincidence, not evidence. */
const MIN_SERIALISATION_RUNS = 2;

export type AuditRuleId = (typeof AUDIT_RULE_ORDER)[number];

/**
 * `capability` is a field rather than only a phrase inside `message`.
 *
 * A consumer — the canvas tinting a node, a CI job failing on one particular
 * MCP server, a dashboard grouping by tool — needs the id itself. Leaving it in
 * the prose would force every one of them to regex it back out of a sentence
 * this module is free to rewrite.
 *
 * There is no `phase`: audit is a single pass. Nothing is repaired and re-run,
 * so there is no second graph for a finding to belong to.
 */
export interface AuditFinding {
  readonly rule: AuditRuleId;
  readonly severity: Severity;
  readonly message: string;
  /** The node(s) the finding is about. Empty for a run-scoped finding no node can be blamed for. */
  readonly nodes: readonly string[];
  /** Set only for the three capability rules. The four node-level rules are not about any one capability. */
  readonly capability?: string;
}

/** A run left out because it says it came from a different spec. */
export interface SkippedRun {
  readonly runId: string;
  readonly specName: string;
}

export interface AuditResult {
  readonly findings: readonly AuditFinding[];
  /** Every run id that contributed, sorted. One file is usually one; a directory is many. */
  readonly runIds: readonly string[];
  /**
   * Runs excluded because their `run_started` names a different spec.
   *
   * Auditing a run against a spec it did not come from produces findings that
   * are confident, plausible and fiction: two unrelated workflows need only
   * share a node name for the comparison to invent a disagreement.
   */
  readonly skipped: readonly SkippedRun[];
  /**
   * Runs whose spec name matched but whose recorded hash did not.
   *
   * Audited anyway, because editing a spec after a run is ordinary and the
   * findings are usually still worth reading. Reported so nobody mistakes a
   * stale comparison for a current one.
   */
  readonly changedSince: readonly string[];
  /**
   * Did any audited run report a capability event at all?
   *
   * A caller needs this to tell "clean" from "nothing was checked". Absent
   * findings over a silent trace is not a clean bill of health, and a consumer
   * reading only the finding count cannot see the difference.
   */
  readonly reportedCapabilities: boolean;
  /**
   * Did any audited run report a `node_started` event at all?
   *
   * The node-level rules need the same "clean vs. nothing was checked"
   * distinction `reportedCapabilities` gives the capability rules — a trace
   * from an adapter with no node attribution must not read as "every node in
   * the spec never ran".
   */
  readonly reportedNodeEvents: boolean;
}

/** What the caller knows about the spec it is auditing against. */
export interface AuditOptions {
  /**
   * Hash of the spec text, as `run_started.spec.hash` records it.
   *
   * Optional because a caller holding only a parsed graph cannot produce one,
   * and a missing hash must not be treated as a mismatch.
   */
  readonly specHash?: string;
}

export function auditRuleSeverity(rule: AuditRuleId): Severity {
  switch (rule) {
    case "CAPABILITY_GAP":
    case "ORDER_VIOLATION":
      return "error";
    case "UNUSED_CAPABILITY":
    case "UNDECLARED_CAPABILITY":
    case "NODE_NEVER_RAN":
    case "UNDECLARED_NODE":
    case "OBSERVED_SERIALISATION":
      return "warn";
  }
}

const finding = (
  rule: AuditRuleId,
  capability: string,
  nodes: readonly string[],
  message: string,
): AuditFinding => ({ rule, severity: auditRuleSeverity(rule), message, nodes, capability });

/** Same shape, for the four rules that are not about any one capability. */
const nodeFinding = (
  rule: AuditRuleId,
  nodes: readonly string[],
  message: string,
): AuditFinding => ({ rule, severity: auditRuleSeverity(rule), message, nodes });

/**
 * Audits a trace — one run's lines, or several runs concatenated — against the
 * spec it was produced from.
 *
 * A line walk rather than `reduceRun`. The fold's final state is a snapshot: it
 * knows which capabilities ended up lost, and cannot know whether a node ran
 * while one of them was missing. CAPABILITY_GAP is a question about ordering, so
 * it needs the timeline, not the answer at the end of it.
 *
 * Lines this reader does not understand are skipped, exactly as everywhere else
 * in the trace contract. Runs are pooled by concatenation, the way
 * `statsFromLines` pools a directory.
 */
export function audit(
  lines: readonly TraceLine[],
  graph: Graph,
  options: AuditOptions = {},
): AuditResult {
  const declared = new Map<string, readonly string[]>();
  for (const node of graph.spec.nodes) {
    if (node.uses && node.uses.length > 0) declared.set(node.id, node.uses);
  }
  const declaredAnywhere = new Set<string>([...declared.values()].flat());

  const byRun = new Map<string, TraceEvent[]>();
  for (const line of lines) {
    if (!isTraceEvent(line)) continue;
    const events = byRun.get(line.runId);
    if (events === undefined) byRun.set(line.runId, [line]);
    else events.push(line);
  }

  const raw: AuditFinding[] = [];
  const runIds: string[] = [];
  const skipped: SkippedRun[] = [];
  const changedSince: string[] = [];
  let reportedCapabilities = false;
  let reportedNodeEvents = false;

  /**
   * Every node id the trace has *any* evidence for — for `NODE_NEVER_RAN`.
   *
   * Not only `node_started`. A gate node never gets one at all: it lives in
   * `gate_waiting`/`gate_resolved` instead. And a node the runner skipped
   * because its own dependency failed gets `node_failed` with no `node_started`
   * ever preceding it (`runner`'s `Promise.allSettled`-per-wave marks it failed
   * without attempting it). Both are real evidence the run engine accounted
   * for the node — treating either as "never ran" would flag every gate and
   * every legitimately-skipped node on an otherwise ordinary run.
   */
  const everObserved = new Set<string>();
  /**
   * One span per node per run, for `OBSERVED_SERIALISATION`. `finish` is the
   * seq of the last finish/fail seen for that node in that run; `undefined`
   * means it never finished there, which rules the run out as evidence.
   *
   * A fanOut node collapses to one span across its instances (first start,
   * last finish) rather than one span per instance — the same simplification
   * `open` already makes elsewhere in this file for counting purposes.
   */
  const spans = new Map<string, Map<string, { start: number; finish: number | undefined }>>();

  for (const [runId, events] of byRun) {
    // `seq` is the writer's counter and is what orders a stream; `ts` cannot,
    // since two events in the same millisecond are ordinary.
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    const claimed = ordered.find((e) => e.type === "run_started")?.spec;

    // A run that never said which spec it came from has made no claim to
    // contradict. Skipping it would be reading absence as mismatch, which is
    // the one thing this whole feature exists not to do.
    if (claimed !== undefined && claimed.name !== graph.spec.name) {
      skipped.push({ runId, specName: claimed.name });
      continue;
    }
    if (
      claimed?.hash !== undefined &&
      options.specHash !== undefined &&
      claimed.hash !== options.specHash
    ) {
      changedSince.push(runId);
    }

    runIds.push(runId);
    if (ordered.some((e) => e.type.startsWith("capability_"))) reportedCapabilities = true;
    if (ordered.some((e) => e.type === "node_started")) reportedNodeEvents = true;
    auditRun(ordered, declared, declaredAnywhere, graph, raw);

    const runSpans = spans.get(runId) ?? new Map<string, { start: number; finish: number | undefined }>();
    spans.set(runId, runSpans);
    for (const event of ordered) {
      if (event.type === "node_started") {
        everObserved.add(event.node);
        if (!runSpans.has(event.node)) runSpans.set(event.node, { start: event.seq, finish: undefined });
      } else if (event.type === "node_finished" || event.type === "node_failed") {
        everObserved.add(event.node);
        const span = runSpans.get(event.node);
        if (span) span.finish = event.seq;
      } else if (event.type === "gate_waiting" || event.type === "gate_resolved") {
        everObserved.add(event.node);
      }
    }
  }

  // Both rules below need to know a node ran at all before treating its
  // absence, or its lack of overlap with another node, as evidence of
  // anything — the same guard `reportedCapabilities` gives the three rules
  // above it.
  if (reportedNodeEvents) {
    for (const node of graph.spec.nodes) {
      if (!everObserved.has(node.id)) {
        raw.push(
          nodeFinding(
            "NODE_NEVER_RAN",
            [node.id],
            `${node.id} is declared in the spec but no audited run shows any evidence it ran`,
          ),
        );
      }
    }
    auditObservedSerialisation(graph, spans, raw);
  }

  return {
    findings: sortFindings(graph, dedupe(raw)),
    runIds: runIds.sort(),
    skipped: skipped.sort((a, b) => a.runId.localeCompare(b.runId)),
    changedSince: changedSince.sort(),
    reportedCapabilities,
    reportedNodeEvents,
  };
}

/**
 * Two nodes with no declared path between them, in either direction, that
 * never overlapped in time across several runs — a candidate hidden edge the
 * spec does not declare.
 *
 * A single non-overlapping run is a coincidence a synchronous scheduler
 * produces constantly; `MIN_SERIALISATION_RUNS` is the line between that and
 * a pattern. Any run where the pair *did* overlap disproves the candidate
 * outright, so one counterexample beats any number of quiet runs.
 */
function auditObservedSerialisation(
  graph: Graph,
  spans: ReadonlyMap<string, ReadonlyMap<string, { start: number; finish: number | undefined }>>,
  out: AuditFinding[],
): void {
  const ids = graph.spec.nodes.map((n) => n.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (hasPath(graph, a, b) || hasPath(graph, b, a)) continue;

      let nonOverlapping = 0;
      let overlapped = false;
      for (const runSpans of spans.values()) {
        const sa = runSpans.get(a);
        const sb = runSpans.get(b);
        if (!sa || !sb || sa.finish === undefined || sb.finish === undefined) continue;
        if (sa.start <= sb.finish && sb.start <= sa.finish) {
          overlapped = true;
          break;
        }
        nonOverlapping++;
      }
      if (!overlapped && nonOverlapping >= MIN_SERIALISATION_RUNS) {
        out.push(
          nodeFinding(
            "OBSERVED_SERIALISATION",
            [a, b],
            `${a} and ${b} share no declared path and never overlapped in ${nonOverlapping} audited runs — a candidate hidden edge`,
          ),
        );
      }
    }
  }
}

/** One run's timeline. Findings are appended to `out` rather than returned, so pooled runs share a list. */
function auditRun(
  events: readonly TraceEvent[],
  declared: ReadonlyMap<string, readonly string[]>,
  declaredAnywhere: ReadonlySet<string>,
  graph: Graph,
  out: AuditFinding[],
): void {
  const uses = (node: string) => declared.get(node) ?? [];

  /** Capabilities the run has said are gone, and why. Not being in here means unknown or present. */
  const lost = new Map<string, string | undefined>();
  /** Nodes with at least one instance started and not yet balanced, in the order they opened. */
  const open = new Map<string, number>();
  const started = new Set<string>();
  const invoked = new Set<string>();
  /** How many times each node has finished (successfully or not) so far, for `ORDER_VIOLATION`. */
  const finishedCount = new Map<string, number>();
  /** How many times each node has started so far, for the same rule. */
  const startedCount = new Map<string, number>();
  // A separator that cannot occur in either half, so the key is unambiguous.
  // Written as an escape rather than the byte itself: a literal NUL in the
  // source makes git treat this whole file as binary, and a source file with
  // no readable diff is a source file nobody can review.
  const pair = (node: string, capability: string) => `${node}\u0000${capability}`;
  /**
   * Did this run report invocations at all?
   *
   * Not "did this node use this capability", but "does this producer speak
   * that part of the contract". Without it, an absent invocation is unknown
   * rather than absent, and UNUSED has nothing to stand on.
   */
  let reportsInvocations = false;

  for (const event of events) {
    switch (event.type) {
      case "capability_available":
        lost.delete(event.capability);
        break;

      case "capability_lost": {
        lost.set(event.capability, event.reason);
        for (const node of open.keys()) {
          if (uses(node).includes(event.capability)) {
            out.push(
              finding(
                "CAPABILITY_GAP",
                event.capability,
                [node],
                `${node} declares '${event.capability}' and the run reported it lost while the node was running${because(event.reason)}`,
              ),
            );
          }
        }
        break;
      }

      case "node_started": {
        started.add(event.node);
        open.set(event.node, (open.get(event.node) ?? 0) + 1);
        for (const capability of uses(event.node)) {
          if (!lost.has(capability)) continue;
          out.push(
            finding(
              "CAPABILITY_GAP",
              capability,
              [event.node],
              `${event.node} declares '${capability}' but the run reported it lost before the node started${because(lost.get(capability))}`,
            ),
          );
        }

        if (!graph.nodes.has(event.node)) {
          out.push(
            nodeFinding(
              "UNDECLARED_NODE",
              [event.node],
              `${event.node} started but is not declared in the spec`,
            ),
          );
        } else {
          // A predecessor that has *started* but not yet finished is positive
          // evidence the run did not wait for it — the trace clearly tracks
          // that node, it just has not reported it done. A predecessor that
          // never started at all says nothing either way (it might simply be
          // outside this trace's coverage), so it is not evidence here, the
          // same "absent is not zero" reasoning as everywhere else in this file.
          for (const edge of graph.inbound.get(event.node) ?? []) {
            const from = edge.from;
            if ((startedCount.get(from) ?? 0) > 0 && (finishedCount.get(from) ?? 0) === 0) {
              out.push(
                nodeFinding(
                  "ORDER_VIOLATION",
                  [from, event.node],
                  `${event.node} started before ${from} finished, though the spec declares ${from} -> ${event.node}`,
                ),
              );
            }
          }
        }
        startedCount.set(event.node, (startedCount.get(event.node) ?? 0) + 1);
        break;
      }

      case "node_finished":
      case "node_failed": {
        const remaining = (open.get(event.node) ?? 0) - 1;
        if (remaining > 0) open.set(event.node, remaining);
        else open.delete(event.node);
        finishedCount.set(event.node, (finishedCount.get(event.node) ?? 0) + 1);
        break;
      }

      case "capability_invoked": {
        reportsInvocations = true;
        if (event.node === undefined) {
          // A node-less invocation cannot satisfy any node's declaration, so it
          // is only ever evidence against the spec as a whole: nothing here
          // claims to need what the run just used.
          if (!declaredAnywhere.has(event.capability)) {
            out.push(
              finding(
                "UNDECLARED_CAPABILITY",
                event.capability,
                [],
                `the run invoked '${event.capability}' and no node declares it`,
              ),
            );
          }
          break;
        }
        invoked.add(pair(event.node, event.capability));
        if (!uses(event.node).includes(event.capability)) {
          out.push(
            finding(
              "UNDECLARED_CAPABILITY",
              event.capability,
              [event.node],
              `${event.node} invoked '${event.capability}' but does not declare it in uses`,
            ),
          );
        }
        break;
      }

      default:
        break;
    }
  }

  // Two things have to be true before a declaration can be called unused, and
  // the second is easy to miss.
  //
  // The node must have started: one that never ran had no opportunity to use
  // what it declares.
  //
  // And the run must have reported at least one invocation somewhere. Otherwise
  // this is a producer that does not report invocations at all — a session
  // adapter, an implementation that never calls the reporting hook — and "never
  // invoked" would be the audit reading silence as absence. That is the mistake
  // CAPABILITY_GAP refuses to make above, and it would be no more honest here
  // for being only a warning. Every declaration in the spec would be scolded on
  // the strength of evidence nobody produced.
  if (!reportsInvocations) return;

  for (const node of started) {
    for (const capability of uses(node)) {
      if (invoked.has(pair(node, capability))) continue;
      out.push(
        finding(
          "UNUSED_CAPABILITY",
          capability,
          [node],
          `${node} ran but never invoked '${capability}', which it declares in uses`,
        ),
      );
    }
  }
}

function because(reason: string | undefined): string {
  return reason === undefined ? "" : ` (${reason})`;
}

/**
 * The same disagreement seen in thirty pooled runs is one disagreement.
 *
 * The message is deliberately outside the key: a gap found once before a node
 * started and once while it was running is the same missing capability for the
 * same node, and reporting it twice with different prose would be noise.
 */
function dedupe(findings: readonly AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  const out: AuditFinding[] = [];
  for (const f of findings) {
    const key = `${f.rule}|${f.capability}|${[...f.nodes].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Rule order first, then spec order, so the report reads down the graph. */
function sortFindings(graph: Graph, findings: readonly AuditFinding[]): AuditFinding[] {
  const nodeOrder = new Map(graph.spec.nodes.map((n, i) => [n.id, i]));
  // A run-scoped finding belongs to no node, so it sorts after the ones that do.
  const position = (f: AuditFinding) =>
    f.nodes.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...f.nodes.map((n) => nodeOrder.get(n) ?? Number.MAX_SAFE_INTEGER));

  return [...findings].sort((a, b) => {
    const byRule = AUDIT_RULE_ORDER.indexOf(a.rule) - AUDIT_RULE_ORDER.indexOf(b.rule);
    if (byRule !== 0) return byRule;
    const byNode = position(a) - position(b);
    if (byNode !== 0) return byNode;
    // The node-level rules have no capability to break the tie on; fall back
    // to the message, which is unique per finding in practice.
    return (a.capability ?? a.message).localeCompare(b.capability ?? b.message);
  });
}
