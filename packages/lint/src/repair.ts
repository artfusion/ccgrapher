// SPDX-License-Identifier: Apache-2.0
import { ancestors, type EdgeSpec, type Graph } from "@ccgrapher/core";
import { effectiveCarries, unsatisfiedInputs } from "./rules.js";
import type { Repair } from "./types.js";

interface IndexedRepair {
  readonly index: number;
  readonly repair: Repair;
}

/**
 * For every fake edge, work out the honest fix.
 *
 * Deleting is the obvious move and it is usually wrong: in linear-chain,
 * dropping `review_a -> review_b` leaves review_b as a root that would start
 * before `setup` has produced the repo it reads. So we look for the nearest
 * ancestor that actually declares the field the target is missing, and repoint
 * there instead. Only when nothing upstream can supply it do we drop.
 */
export function proposeRepairs(graph: Graph): IndexedRepair[] {
  const out: IndexedRepair[] = [];

  graph.edges.forEach((edge, index) => {
    if (effectiveCarries(graph, edge).length > 0) return;

    const missing = unsatisfiedInputs(graph, edge.to);
    if (missing.length === 0) {
      out.push({
        index,
        repair: {
          kind: "drop",
          from: edge.from,
          to: edge.to,
          why: `${edge.to} already has every input it declares`,
        },
      });
      return;
    }

    // The source may declare the missing field and simply not carry it — then
    // the edge is real and only `carries` was wrong.
    const source = graph.nodes.get(edge.from)!;
    const selfSupplied = missing.filter((field) => Object.hasOwn(source.out, field));
    if (selfSupplied.length > 0) {
      out.push({
        index,
        repair: {
          kind: "repoint",
          from: edge.from,
          to: edge.to,
          newFrom: edge.from,
          carries: selfSupplied,
          why: `${edge.from} declares ${fmt(selfSupplied)} but the edge carried nothing`,
        },
      });
      return;
    }

    // ancestors() is nearest-first, so the first supplier found is the closest.
    const supplier = ancestors(graph, edge.to).find((candidate) =>
      missing.some((field) => Object.hasOwn(candidate.out, field)),
    );

    if (!supplier) {
      out.push({
        index,
        repair: {
          kind: "drop",
          from: edge.from,
          to: edge.to,
          why: `nothing upstream of ${edge.to} supplies ${fmt(missing)}`,
        },
      });
      return;
    }

    const carries = missing.filter((field) => Object.hasOwn(supplier.out, field));
    out.push({
      index,
      repair: {
        kind: "repoint",
        from: edge.from,
        to: edge.to,
        newFrom: supplier.id,
        carries,
        why: `${supplier.id} is the nearest node that supplies ${fmt(carries)}`,
      },
    });
  });

  return out;
}

/** Apply repairs by edge index, returning the repaired edge list. */
export function applyRepairs(graph: Graph, repairs: readonly IndexedRepair[]): EdgeSpec[] {
  const byIndex = new Map(repairs.map((r) => [r.index, r.repair]));

  return graph.edges.flatMap((edge, index) => {
    const repair = byIndex.get(index);
    if (!repair) return [edge];
    if (repair.kind === "drop") return [];
    return [{ from: repair.newFrom, to: repair.to, carries: [...repair.carries] }];
  });
}

const fmt = (fields: readonly string[]) => fields.map((f) => `'${f}'`).join(", ");

export type { IndexedRepair };
