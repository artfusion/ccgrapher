// SPDX-License-Identifier: Apache-2.0
export { lint } from "./lint.js";
export { formatReport, type ReportOptions } from "./report.js";
export { proposeRepairs, applyRepairs, type IndexedRepair } from "./repair.js";
export {
  effectiveCarries,
  unsatisfiedInputs,
  fakeEdges,
  missingInputs,
  hiddenEdges,
  selfGrading,
  contextCollapse,
  silentFailure,
  runAllRules,
  CONTEXT_COLLAPSE_THRESHOLD,
} from "./rules.js";
export {
  RULE_ORDER,
  ruleSeverity,
  type RuleId,
  type Severity,
  type Phase,
  type Finding,
  type Repair,
  type LintResult,
} from "./types.js";
