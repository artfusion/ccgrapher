// SPDX-License-Identifier: Apache-2.0
import {
  agentTypes,
  ancestors,
  effectiveInboundCount,
  hasPath,
  renderStyle,
  roots,
  type EdgeSpec,
  type Graph,
  type NodeSpec,
} from "@ccgrapher/core";
import { ruleSeverity, type Finding, type Phase, type RuleId } from "./types.js";

/** Fields an edge genuinely transports: declared by the source AND consumed by the target. */
export function effectiveCarries(graph: Graph, edge: EdgeSpec): string[] {
  const source = graph.nodes.get(edge.from);
  const target = graph.nodes.get(edge.to);
  if (!source || !target) return [];
  return edge.carries.filter(
    (field) => Object.hasOwn(source.out, field) && Object.hasOwn(target.in, field),
  );
}

/** Input fields of `id` that no inbound edge actually supplies. */
export function unsatisfiedInputs(graph: Graph, id: string): string[] {
  const node = graph.nodes.get(id);
  if (!node) return [];
  const supplied = new Set<string>();
  for (const edge of graph.inbound.get(id) ?? []) {
    for (const field of effectiveCarries(graph, edge)) supplied.add(field);
  }
  return Object.keys(node.in).filter((field) => !supplied.has(field));
}

/**
 * Nodes that could run at the same moment: no directed path between them
 * either way, regardless of rank.
 *
 * This used to check same-rank pairs only, on the assumption that rank is a
 * proxy for "runs at the same time" — true of `ccg run` and every codegen
 * target, which both execute one full rank at a time behind a barrier. It is
 * not true in general: a layer is a layout fact, not an execution guarantee,
 * and nothing stops a smarter scheduler, a live agent session, or a human
 * team from starting a rank-4 node the moment its own inputs are ready, while
 * an unrelated rank-2 node from a different branch is still running. Two
 * nodes with no declared path between them, in either direction, are exactly
 * the nodes the spec never said had to wait on each other — same rank or not.
 */
function concurrentPairs(graph: Graph): Array<[string, string]> {
  const ids = [...graph.nodes.keys()];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (!hasPath(graph, a, b) && !hasPath(graph, b, a)) pairs.push([a, b]);
    }
  }
  return pairs;
}

const finding = (
  rule: RuleId,
  phase: Phase,
  message: string,
  nodes: string[],
  edge?: { from: string; to: string },
): Finding => ({ rule, severity: ruleSeverity(rule), phase, message, nodes, ...(edge && { edge }) });

/**
 * The fake-edge test. An edge only exists if something real passes along it —
 * so an edge whose carried fields never land in the target's declared input is
 * a wait with nothing behind it.
 */
export function fakeEdges(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const edge of graph.edges) {
    if (effectiveCarries(graph, edge).length > 0) continue;

    const source = graph.nodes.get(edge.from)!;
    const detail =
      edge.carries.length === 0
        ? "carries nothing"
        : `carries [${edge.carries.join(", ")}] but ${
            edge.carries.some((f) => !Object.hasOwn(source.out, f))
              ? `${edge.from} does not declare them as output`
              : `${edge.to} does not consume them`
          }`;

    out.push(
      finding(
        "FAKE_EDGE",
        phase,
        `${edge.from} -> ${edge.to} ${detail} — ${edge.to} does not wait on ${edge.from}`,
        [edge.from, edge.to],
        { from: edge.from, to: edge.to },
      ),
    );
  }
  return out;
}

/**
 * A node declaring an input nothing supplies. Root nodes are exempt: their
 * inputs are invocation parameters, not graph edges.
 */
export function missingInputs(graph: Graph, phase: Phase): Finding[] {
  const rootIds = new Set(roots(graph).map((n) => n.id));
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    if (rootIds.has(node.id)) continue;
    for (const field of unsatisfiedInputs(graph, node.id)) {
      out.push({
        ...finding(
          "MISSING_INPUT",
          phase,
          `${node.id} requires '${field}' but no inbound edge carries it`,
          [node.id],
        ),
        field,
      });
    }
  }
  return out;
}

/**
 * False independence: two nodes that look parallel but contend for the same
 * file or API. An isolated worktree on either one removes the contention.
 */
export function hiddenEdges(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const [a, b] of concurrentPairs(graph)) {
    const nodeA = graph.nodes.get(a)!;
    const nodeB = graph.nodes.get(b)!;
    if (nodeA.worktree || nodeB.worktree) continue;

    const shared = (nodeA.writes ?? []).filter((w) => (nodeB.writes ?? []).includes(w));
    for (const resource of shared) {
      out.push({
        ...finding(
          "HIDDEN_EDGE",
          phase,
          `${a} and ${b} run concurrently and both write '${resource}' — set worktree: true or serialise them`,
          [a, b],
        ),
        resource,
      });
    }
  }
  return out;
}

/** A verifier without a fresh context is grading work it already has opinions about. */
export function selfGrading(graph: Graph, phase: Phase): Finding[] {
  return graph.spec.nodes
    .filter((node) => node.kind === "verifier" && node.freshContext !== true)
    .map((node) =>
      finding(
        "SELF_GRADING",
        phase,
        `verifier ${node.id} is not marked freshContext — a worker and its verifier must never share a context`,
        [node.id],
      ),
    );
}

/**
 * Walk back from `id` along every inbound edge that carries something real,
 * stopping at the first node on each path that `stopsAt` accepts and returning
 * those, in spec order. A fake edge carries nothing, so nothing arrives along it.
 */
function firstUpstream(graph: Graph, id: string, stopsAt: (node: NodeSpec) => boolean): NodeSpec[] {
  const seen = new Set<string>([id]);
  const found = new Set<string>();
  const visit = (target: string) => {
    for (const edge of graph.inbound.get(target) ?? []) {
      if (seen.has(edge.from) || effectiveCarries(graph, edge).length === 0) continue;
      seen.add(edge.from);
      const source = graph.nodes.get(edge.from)!;
      if (stopsAt(source)) found.add(source.id);
      else visit(source.id);
    }
  };
  visit(id);
  return graph.spec.nodes.filter((n) => found.has(n.id));
}

/**
 * The steps whose work a node is handed, seen through plain code. A code step
 * (`model: null`) that dedupes or concatenates changes nothing about whose
 * judgement arrives, so the walk goes on past it to the steps behind. It stops
 * at anything else: a model step of any tier or none, or a gate, since a
 * person is not code.
 */
export function producers(graph: Graph, id: string): NodeSpec[] {
  return firstUpstream(graph, id, (n) => renderStyle(n) !== "code");
}

/**
 * A verifier on the same model as the work it checks. A shared model shares
 * blind spots, so the check agrees with the mistake it was there to catch.
 * SELF_GRADING asks whether the two share a context; this asks whether they
 * share a model, and a fresh context does not answer it.
 *
 * The spec names a tier and never a model id, and a target resolves each tier
 * to one model, so two steps on one tier run on one model. Same tier counts;
 * an unspecified tier never does, since unknown is not equal to anything, and
 * plain code has no model to share. The same declared `agent:<type>` counts
 * whatever the tiers, since one agent definition is one model and one prompt.
 */
export function monocultures(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const verifier of graph.spec.nodes) {
    if (verifier.kind !== "verifier") continue;
    const tier = verifier.model ?? undefined;
    const agents = agentTypes(verifier);

    const sameTier: string[] = [];
    const sameAgent: string[] = [];
    let agent: string | undefined;
    for (const step of producers(graph, verifier.id)) {
      if (tier !== undefined && step.model === tier) sameTier.push(step.id);
      const shared = agentTypes(step).find((a) => agents.includes(a));
      if (shared !== undefined) {
        sameAgent.push(step.id);
        agent ??= shared;
      }
    }
    if (sameTier.length === 0 && sameAgent.length === 0) continue;

    // The agent is the narrower claim, so it leads when both hold.
    const steps = [...new Set([...sameAgent, ...sameTier])];
    const what = [
      ...(agent !== undefined ? [`${listed(sameAgent)} as the same agent, '${agent}'`] : []),
      ...(sameTier.length > 0 ? [`${listed(sameTier)} on the same tier, ${tier}`] : []),
    ].join(", and ");
    out.push({
      ...finding(
        "MONOCULTURE",
        phase,
        `verifier ${verifier.id} checks ${what}; a shared model shares blind spots, so give the check a different tier or agent`,
        [verifier.id, ...steps],
      ),
      ...(sameTier.length > 0 && { tier: tier! }),
      ...(agent !== undefined && { agent }),
    });
  }
  return out;
}

/**
 * The tiers the wrong way round for a fan-out. The usual shape is many cheap
 * readers and one strong step to put their results together: a strong tier on
 * a fanned worker pays the strong price once per item for reading, and a cheap
 * tier on the synthesize step that puts fanned results together leaves the
 * hardest step to the weakest model.
 *
 * Fanned means `fanOut`. The step that puts the results together is the first
 * synthesize step below the fan-out: plain code, verifiers and other steps in
 * between filter or check rather than combine. A synthesize step further down
 * is handed what that one already combined, and is not judged here.
 *
 * Advice rather than a defect, since a strong reader over a handful of hard
 * documents can be a fair choice. So it is a warning, which leaves the exit
 * code alone. On by default: no example as written trips it.
 */
export function tierMismatches(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    if (node.kind === "worker" && node.fanOut && node.model === "strong") {
      out.push({
        ...finding(
          "TIER_MISMATCH",
          phase,
          `${node.id} runs once per ${node.fanOut.over} on the strong tier; reading fanned out is usually cheap work, and the strong tier pays where the results are combined`,
          [node.id],
        ),
        tier: "strong",
      });
    }
    if (node.kind === "synthesize" && node.model === "cheap") {
      const fanned = firstUpstream(graph, node.id, (n) => n.fanOut !== undefined || n.kind === "synthesize").filter(
        (n) => n.fanOut !== undefined,
      );
      if (fanned.length === 0) continue;
      out.push({
        ...finding(
          "TIER_MISMATCH",
          phase,
          `${node.id} combines what ${listed(fanned.map((n) => n.id))} fanned out, on the cheap tier; putting many results together is where the strong tier pays`,
          [node.id],
        ),
        tier: "cheap",
      });
    }
  }
  return out;
}

const listed = (ids: readonly string[]) =>
  ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;

export const CONTEXT_COLLAPSE_THRESHOLD = 30;

/** Pouring hundreds of raw outputs into one synthesis step. Fix with a summarize layer. */
export function contextCollapse(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    const arriving = effectiveInboundCount(graph, node.id);
    if (arriving <= CONTEXT_COLLAPSE_THRESHOLD) continue;

    const summarised = (graph.inbound.get(node.id) ?? []).some(
      (edge) => graph.nodes.get(edge.from)!.kind === "reduce",
    );
    if (summarised) continue;

    out.push({
      ...finding(
        "CONTEXT_COLLAPSE",
        phase,
        `${node.id} takes ${arriving} inbound results with no intermediate reduce layer — summarise in batches first`,
        [node.id],
      ),
      arriving,
    });
  }
  return out;
}

/**
 * A fan-in without a count guard silently synthesises on partial data when one
 * upstream node dies. Only applies to real fan-ins — a single inbound edge
 * needs no guard, which is why diamond's merge stays clean.
 *
 * This is the strict end of the `expects` rule: equality, not a floor. A guard
 * that overshoots the graph is stale, and stale is a spec defect worth a
 * warning even though nothing is missing at run time — where the same guard
 * only tests for a shortfall. The whole reasoning lives on `NodeSpec.expects`
 * in `@ccgrapher/core`; read it there before changing either comparison.
 */
export function silentFailure(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    const arriving = effectiveInboundCount(graph, node.id);
    if (arriving <= 1) continue;

    if (node.expects === undefined) {
      out.push({
        ...finding(
          "SILENT_FAILURE",
          phase,
          `${node.id} fans in ${arriving} results with no 'expects' guard — a dead upstream node would go unnoticed`,
          [node.id],
        ),
        arriving,
      });
    } else if (node.expects !== arriving) {
      out.push({
        ...finding(
          "SILENT_FAILURE",
          phase,
          `${node.id} declares expects: ${node.expects} but ${arriving} results actually arrive`,
          [node.id],
        ),
        arriving,
      });
    }
  }
  return out;
}

/**
 * An effect in a scheduled workflow that nothing makes at-most-once. A schedule
 * fires again, and a failed run is retried, so a post with no check before it
 * is a post that can happen twice. The check is a node declaring the effect in
 * `guards`: the performer itself (an idempotency key) or any node it waits on.
 *
 * Only a scheduled workflow is checked. A one-off run can repeat an effect too,
 * when someone reruns it by hand, but then a person is there to see it.
 */
export function duplicateEffects(graph: Graph, phase: Phase): Finding[] {
  if (graph.spec.schedule === undefined) return [];
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    const upstream = [node, ...ancestors(graph, node.id)];
    for (const effect of node.effects ?? []) {
      if (upstream.some((n) => n.guards?.includes(effect))) continue;
      out.push({
        ...finding(
          "DUPLICATE_EFFECT",
          phase,
          `${node.id} performs '${effect}' on a schedule, and neither it nor any step before it guards '${effect}'; a rerun would perform it again`,
          [node.id],
        ),
        effect,
      });
    }
  }
  return out;
}

/**
 * Progress state written before the effect it records. A store with
 * `records: E` says E has happened, so every node that writes it must come
 * strictly after every node that performs E: after, not beside, and not the
 * same step, whose order inside is unknown. Written early, a run that fails in
 * between leaves the store saying E happened when it did not, and the next run
 * skips it for good.
 */
export function earlyCommits(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const [store, spec] of Object.entries(graph.spec.stores ?? {})) {
    const effect = spec.records;
    if (effect === undefined) continue;
    const performers = graph.spec.nodes.filter((n) => n.effects?.includes(effect));
    const writers = graph.spec.nodes.filter((n) => n.writes?.includes(store));
    for (const writer of writers) {
      for (const performer of performers) {
        if (writer.id !== performer.id && hasPath(graph, performer.id, writer.id)) continue;
        const message =
          writer.id === performer.id
            ? `${writer.id} writes '${store}', which records '${effect}', in the same step that performs it; move the write to a step after it`
            : `${writer.id} writes '${store}', which records '${effect}', without waiting for ${performer.id} to perform it; a run that fails in between skips '${effect}' next time`;
        out.push({
          ...finding("EARLY_COMMIT", phase, message, writer.id === performer.id ? [writer.id] : [writer.id, performer.id]),
          resource: store,
          effect,
        });
      }
    }
  }
  return out;
}

/** Why a node may not write something. See `writeDenial`. */
export type WriteDenial =
  | { readonly kind: "read-only"; readonly boundary: string }
  | { readonly kind: "human-owned"; readonly store: string };

/**
 * The one authority predicate: whether `node` may write `resource`, a `writes`
 * entry or an effect it performs, and if not, why. Authority is declared in two
 * places and checked here for both. On the actor: a member of a `read-only`
 * boundary writes nothing and performs nothing. On the resource: a store a
 * person owns may be written by a gate, the only human actor, and by nothing else.
 *
 * Whether a tool a node `uses` writes is not decidable here, because capability
 * ids are opaque; only what the spec declares is checked.
 */
export function writeDenial(graph: Graph, node: NodeSpec, resource: string): WriteDenial | undefined {
  const boundary = (graph.spec.boundaries ?? []).find((b) => b.members.includes(node.id));
  if (boundary?.access === "read-only") return { kind: "read-only", boundary: boundary.id };
  if (graph.spec.stores?.[resource]?.owner === "human" && node.kind !== "gate") {
    return { kind: "human-owned", store: resource };
  }
  return undefined;
}

/** A write or an effect the spec itself says is not the node's to make. */
export function authorityBreaches(graph: Graph, phase: Phase): Finding[] {
  const out: Finding[] = [];
  for (const node of graph.spec.nodes) {
    const writes = node.writes ?? [];
    const effects = node.effects ?? [];
    const denials = [...writes, ...effects].flatMap((r) => {
      const denial = writeDenial(graph, node, r);
      return denial ? [denial] : [];
    });

    const readOnly = denials.find((d) => d.kind === "read-only");
    if (readOnly) {
      const what = [
        ...(writes.length > 0 ? [`writes ${quoted(writes)}`] : []),
        ...(effects.length > 0 ? [`performs ${quoted(effects)}`] : []),
      ].join(" and ");
      out.push({
        ...finding(
          "AUTHORITY_BREACH",
          phase,
          `${node.id} is in read-only boundary '${readOnly.boundary}' but ${what}`,
          [node.id],
        ),
        boundary: readOnly.boundary,
      });
      continue;
    }

    for (const denial of denials) {
      if (denial.kind !== "human-owned") continue;
      out.push({
        ...finding(
          "AUTHORITY_BREACH",
          phase,
          `${node.id} writes '${denial.store}', which a person owns; only a gate may write it`,
          [node.id],
        ),
        resource: denial.store,
      });
    }
  }
  return out;
}

const quoted = (ids: readonly string[]) => ids.map((id) => `'${id}'`).join(", ");

export function runAllRules(graph: Graph, phase: Phase): Finding[] {
  return [
    ...fakeEdges(graph, phase),
    ...missingInputs(graph, phase),
    ...authorityBreaches(graph, phase),
    ...hiddenEdges(graph, phase),
    ...selfGrading(graph, phase),
    ...monocultures(graph, phase),
    ...contextCollapse(graph, phase),
    ...silentFailure(graph, phase),
    ...duplicateEffects(graph, phase),
    ...earlyCommits(graph, phase),
    ...tierMismatches(graph, phase),
  ];
}
