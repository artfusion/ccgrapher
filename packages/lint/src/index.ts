// SPDX-License-Identifier: Apache-2.0
export { lint } from "./lint.js";
export { renderMarksFor, type FindingMark, type RenderMarks } from "./marks.js";
export { describeRepair, formatReport, type ReportOptions } from "./report.js";
export { proposeRepairs, applyRepairs, type IndexedRepair } from "./repair.js";
export {
  candidateId,
  checkCandidate,
  deriveEdges,
  describePlacement,
  placeCandidate,
  startedConflict,
  type CandidateCheck,
  type Placement,
  type Started,
} from "./intake.js";
export {
  effectiveCarries,
  unsatisfiedInputs,
  fakeEdges,
  missingInputs,
  hiddenEdges,
  selfGrading,
  producers,
  monocultures,
  tierMismatches,
  contextCollapse,
  silentFailure,
  duplicateEffects,
  earlyCommits,
  authorityBreaches,
  writeDenial,
  type WriteDenial,
  runAllRules,
  CONTEXT_COLLAPSE_THRESHOLD,
} from "./rules.js";
export {
  audit,
  auditRuleSeverity,
  AUDIT_RULE_ORDER,
  type AuditRuleId,
  type AuditFinding,
  type AuditResult,
} from "./audit.js";
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
export {
  changeLedger,
  ledgerSections,
  formatLedger,
  LEDGER_FIELDS,
  type Ledger,
  type LedgerTotals,
  type LedgerStep,
  type LedgerField,
  type LedgerFinding,
  type LedgerSection,
  type EdgeChange,
  type GuardChange,
  type FieldChange,
  type WaveMove,
} from "./ledger.js";
