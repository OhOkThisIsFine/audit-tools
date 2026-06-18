// Severity / confidence ranking is single-sourced in audit-tools/shared
// (derived from the canonical SEVERITIES/CONFIDENCES tuples so it can never
// drift). This module re-exports the shared functions under the existing import
// path so the auditor's reporting code (workBlocks, mergeFindings) keeps working
// without each package hand-copying a rank table.
export { severityRank, confidenceRank, severityCompare } from "audit-tools/shared";
