// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, Graph } from "@ccgrapher/core";

export const RULE_ORDER = [
  "FAKE_EDGE",
  "MISSING_INPUT",
  "HIDDEN_EDGE",
  "SELF_GRADING",
  "CONTEXT_COLLAPSE",
  "SILENT_FAILURE",
] as const;

export type RuleId = (typeof RULE_ORDER)[number];

export type Severity = "error" | "warn";

/**
 * Which pass surfaced the finding. HIDDEN_EDGE on linear-chain only becomes
 * true once the fake edges are repaired and the ranks recomputed, so findings
 * have to record which graph they were found in.
 */
export type Phase = "raw" | "repaired";

export interface Finding {
  readonly rule: RuleId;
  readonly severity: Severity;
  readonly phase: Phase;
  readonly message: string;
  readonly nodes: readonly string[];
  readonly edge?: { readonly from: string; readonly to: string };
}

/**
 * Deleting a fake edge leaves the target as a root that starts before its real
 * dependency has produced anything. Repointing keeps the ordering honest, so
 * that is the repair we propose whenever a supplier can be found.
 */
export type Repair =
  | {
      readonly kind: "repoint";
      readonly from: string;
      readonly to: string;
      readonly newFrom: string;
      readonly carries: readonly string[];
      readonly why: string;
    }
  | {
      readonly kind: "drop";
      readonly from: string;
      readonly to: string;
      readonly why: string;
    };

export interface LintResult {
  readonly findings: readonly Finding[];
  readonly repairs: readonly Repair[];
  readonly layersBefore: number;
  readonly layersAfter: number;
  readonly repairedGraph: Graph;
  readonly repairedEdges: readonly EdgeSpec[];
}

export function ruleSeverity(rule: RuleId): Severity {
  switch (rule) {
    case "FAKE_EDGE":
    case "MISSING_INPUT":
      return "error";
    case "HIDDEN_EDGE":
    case "SELF_GRADING":
    case "CONTEXT_COLLAPSE":
    case "SILENT_FAILURE":
      return "warn";
  }
}
