// SPDX-License-Identifier: Apache-2.0
import type { Finding, RuleId } from "./types.js";

/**
 * What a renderer is told about the findings, so that every rule has a mark and
 * no renderer works a rule out for itself. The renderers do not depend on this
 * package; they declare the same shapes structurally and draw what they are given.
 *
 *   FAKE_EDGE         the edge, red and dashed, "carries no data"
 *   MISSING_INPUT     a ring on the starved node, captioned with the field
 *   HIDDEN_EDGE       a thin solid line between the two writers, labelled with the file
 *   SELF_GRADING      a ring on the verifier, "grades own work"
 *   MONOCULTURE       a ring on the verifier, captioned with the shared tier or agent
 *   CONTEXT_COLLAPSE  a ring on the overloaded node, captioned with the count
 *   SILENT_FAILURE    a ring on the fan-in, "no count guard" or `9 ≠ 8`
 *   AUTHORITY_BREACH  a ring on the writer, captioned with the store or "writes in read-only"
 *   DUPLICATE_EFFECT  a ring on the performer, captioned with the unguarded effect
 *   EARLY_COMMIT      a ring on the early writer, captioned with the store
 *   TIER_MISMATCH     a ring on the step, captioned with the tier that is the wrong way round
 */
export type FindingMark =
  | { readonly rule: "MISSING_INPUT"; readonly id: string; readonly field: string }
  | { readonly rule: "SELF_GRADING"; readonly id: string }
  | { readonly rule: "CONTEXT_COLLAPSE"; readonly id: string; readonly arriving: number }
  | { readonly rule: "HIDDEN_EDGE"; readonly between: readonly [string, string]; readonly file: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly store: string }
  | { readonly rule: "AUTHORITY_BREACH"; readonly id: string; readonly boundary: string }
  | { readonly rule: "DUPLICATE_EFFECT"; readonly id: string; readonly effect: string }
  | { readonly rule: "EARLY_COMMIT"; readonly id: string; readonly store: string }
  | { readonly rule: "MONOCULTURE"; readonly id: string; readonly agent: string }
  | { readonly rule: "MONOCULTURE"; readonly id: string; readonly tier: string }
  | { readonly rule: "TIER_MISMATCH"; readonly id: string; readonly tier: string };

export interface RenderMarks {
  readonly fakeEdges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly guardFindings: ReadonlyArray<{ readonly id: string; readonly arriving: number }>;
  readonly findingMarks: readonly FindingMark[];
}

interface Parts {
  fakeEdges?: RenderMarks["fakeEdges"];
  guardFindings?: RenderMarks["guardFindings"];
  findingMarks?: readonly FindingMark[];
}

/**
 * One entry per rule. Keyed by `RuleId`, so a rule added to `RULE_ORDER` without
 * a mark here does not compile. A finding missing the detail its mark needs
 * (one built by hand, say) is left unmarked rather than drawn wrong.
 */
const MARK: { readonly [R in RuleId]: (f: Finding) => Parts } = {
  FAKE_EDGE: (f) => (f.edge ? { fakeEdges: [f.edge] } : {}),
  MISSING_INPUT: (f) =>
    f.nodes[0] !== undefined && f.field !== undefined
      ? { findingMarks: [{ rule: "MISSING_INPUT", id: f.nodes[0], field: f.field }] }
      : {},
  HIDDEN_EDGE: (f) =>
    f.nodes[0] !== undefined && f.nodes[1] !== undefined && f.resource !== undefined
      ? { findingMarks: [{ rule: "HIDDEN_EDGE", between: [f.nodes[0], f.nodes[1]], file: f.resource }] }
      : {},
  SELF_GRADING: (f) =>
    f.nodes[0] !== undefined ? { findingMarks: [{ rule: "SELF_GRADING", id: f.nodes[0] }] } : {},
  CONTEXT_COLLAPSE: (f) =>
    f.nodes[0] !== undefined && f.arriving !== undefined
      ? { findingMarks: [{ rule: "CONTEXT_COLLAPSE", id: f.nodes[0], arriving: f.arriving }] }
      : {},
  SILENT_FAILURE: (f) =>
    f.nodes[0] !== undefined && f.arriving !== undefined
      ? { guardFindings: [{ id: f.nodes[0], arriving: f.arriving }] }
      : {},
  AUTHORITY_BREACH: (f) =>
    f.nodes[0] === undefined
      ? {}
      : f.boundary !== undefined
        ? { findingMarks: [{ rule: "AUTHORITY_BREACH", id: f.nodes[0], boundary: f.boundary }] }
        : f.resource !== undefined
          ? { findingMarks: [{ rule: "AUTHORITY_BREACH", id: f.nodes[0], store: f.resource }] }
          : {},
  DUPLICATE_EFFECT: (f) =>
    f.nodes[0] !== undefined && f.effect !== undefined
      ? { findingMarks: [{ rule: "DUPLICATE_EFFECT", id: f.nodes[0], effect: f.effect }] }
      : {},
  EARLY_COMMIT: (f) =>
    f.nodes[0] !== undefined && f.resource !== undefined
      ? { findingMarks: [{ rule: "EARLY_COMMIT", id: f.nodes[0], store: f.resource }] }
      : {},
  MONOCULTURE: (f) =>
    f.nodes[0] === undefined
      ? {}
      : f.agent !== undefined
        ? { findingMarks: [{ rule: "MONOCULTURE", id: f.nodes[0], agent: f.agent }] }
        : f.tier !== undefined
          ? { findingMarks: [{ rule: "MONOCULTURE", id: f.nodes[0], tier: f.tier }] }
          : {},
  TIER_MISMATCH: (f) =>
    f.nodes[0] !== undefined && f.tier !== undefined
      ? { findingMarks: [{ rule: "TIER_MISMATCH", id: f.nodes[0], tier: f.tier }] }
      : {},
};

/** The render options for these findings, in the order they were found. */
export function renderMarksFor(findings: readonly Finding[]): RenderMarks {
  const parts = findings.map((f) => MARK[f.rule](f));
  return {
    fakeEdges: parts.flatMap((p) => p.fakeEdges ?? []),
    guardFindings: parts.flatMap((p) => p.guardFindings ?? []),
    findingMarks: parts.flatMap((p) => p.findingMarks ?? []),
  };
}
