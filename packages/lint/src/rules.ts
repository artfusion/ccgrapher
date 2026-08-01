// SPDX-License-Identifier: Apache-2.0
import {
  effectiveInboundCount,
  hasPath,
  rankGraph,
  roots,
  type EdgeSpec,
  type Graph,
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

/** Nodes that could run at the same moment: same rank, no directed path either way. */
function concurrentPairs(graph: Graph): Array<[string, string]> {
  const { layers } = rankGraph(graph);
  const pairs: Array<[string, string]> = [];
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      for (let j = i + 1; j < layer.length; j++) {
        const a = layer[i]!;
        const b = layer[j]!;
        if (!hasPath(graph, a, b) && !hasPath(graph, b, a)) pairs.push([a, b]);
      }
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
      out.push(
        finding(
          "MISSING_INPUT",
          phase,
          `${node.id} requires '${field}' but no inbound edge carries it`,
          [node.id],
        ),
      );
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
      out.push(
        finding(
          "HIDDEN_EDGE",
          phase,
          `${a} and ${b} run concurrently and both write '${resource}' — set worktree: true or serialise them`,
          [a, b],
        ),
      );
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

    out.push(
      finding(
        "CONTEXT_COLLAPSE",
        phase,
        `${node.id} takes ${arriving} inbound results with no intermediate reduce layer — summarise in batches first`,
        [node.id],
      ),
    );
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
      out.push(
        finding(
          "SILENT_FAILURE",
          phase,
          `${node.id} fans in ${arriving} results with no 'expects' guard — a dead upstream node would go unnoticed`,
          [node.id],
        ),
      );
    } else if (node.expects !== arriving) {
      out.push(
        finding(
          "SILENT_FAILURE",
          phase,
          `${node.id} declares expects: ${node.expects} but ${arriving} results actually arrive`,
          [node.id],
        ),
      );
    }
  }
  return out;
}

export function runAllRules(graph: Graph, phase: Phase): Finding[] {
  return [
    ...fakeEdges(graph, phase),
    ...missingInputs(graph, phase),
    ...hiddenEdges(graph, phase),
    ...selfGrading(graph, phase),
    ...contextCollapse(graph, phase),
    ...silentFailure(graph, phase),
  ];
}
