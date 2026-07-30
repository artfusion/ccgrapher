// SPDX-License-Identifier: Apache-2.0
import { rankGraph, withEdges, type Graph } from "@ccgrapher/core";
import { applyRepairs, proposeRepairs } from "./repair.js";
import { runAllRules } from "./rules.js";
import { RULE_ORDER, type Finding, type LintResult } from "./types.js";

/**
 * Two passes.
 *
 * The first finds what is wrong with the graph as written. Some problems are
 * invisible at that point: linear-chain's `review_a` and `review_b` both write
 * notes/findings.md, but as written one is a rank behind the other, so they
 * never look concurrent. Only after the fake edges are repointed do they land
 * on the same row and the collision become real. So we repair into a shadow
 * graph, recompute the ranks, and lint again — reporting anything new.
 */
export function lint(graph: Graph): LintResult {
  const rawFindings = runAllRules(graph, "raw");

  const indexed = proposeRepairs(graph);
  const repairedEdges = applyRepairs(graph, indexed);
  const repairedGraph = withEdges(graph, repairedEdges);

  const seen = new Set(rawFindings.map(key));
  const newFindings = runAllRules(repairedGraph, "repaired").filter((f) => !seen.has(key(f)));

  return {
    findings: sortFindings(graph, [...rawFindings, ...newFindings]),
    repairs: indexed.map((r) => r.repair),
    layersBefore: rankGraph(graph).layerCount,
    layersAfter: rankGraph(repairedGraph).layerCount,
    repairedGraph,
    repairedEdges,
  };
}

const key = (f: Finding) =>
  `${f.rule}|${[...f.nodes].sort().join(",")}|${f.edge ? `${f.edge.from}->${f.edge.to}` : ""}|${f.message}`;

function sortFindings(graph: Graph, findings: Finding[]): Finding[] {
  const nodeOrder = new Map(graph.spec.nodes.map((n, i) => [n.id, i]));
  const position = (f: Finding) => Math.min(...f.nodes.map((n) => nodeOrder.get(n) ?? 0));

  return [...findings].sort((a, b) => {
    const byRule = RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule);
    if (byRule !== 0) return byRule;
    return position(a) - position(b);
  });
}
