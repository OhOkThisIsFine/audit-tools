/**
 * Validation helpers for contract-pipeline artifacts.
 * Follows the ValidationIssue[] pattern used by the rest of the remediator
 * validation layer.
 */
import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
} from "audit-tools/shared";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";

// Version constant for cyclic_seam_resolution artifact.
export const CP_CYCLIC_SEAM_RESOLUTION_VERSION =
  "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1" as const;

const CYCLIC_SEAM_RESOLUTION_STATUSES = [
  "no_cycles",
  "resolved",
  "user_decision_required",
  "blocked",
] as const;

// Version constants for seam-negotiation artifacts not yet in audit-tools/shared.
export const CP_MODULE_DECOMPOSITION_VERSION =
  "remediate-code-contract-pipeline/module-decomposition/v1alpha1" as const;
export const CP_MODULE_CONTRACTS_VERSION =
  "remediate-code-contract-pipeline/module-contracts/v1alpha1" as const;
export const CP_SEAM_RECONCILIATION_REPORT_VERSION =
  "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1" as const;
export const CP_FINALIZED_MODULE_CONTRACTS_VERSION =
  "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    pushValidationIssue(issues, path, `${path} must be a non-empty string.`);
  }
}

function requireStringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushValidationIssue(issues, path, `${path} must be an array of strings.`);
  }
}

function requireOneOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (!allowed.includes(String(value))) {
    pushValidationIssue(
      issues,
      path,
      `${path} must be one of: ${allowed.join(", ")}.`,
    );
  }
}

/**
 * Shared envelope guard for every contract-pipeline validator (MNT-86b18f1b):
 * the isRecord guard + contract_version match + optional goal_id check that each
 * validator opened with verbatim. Returns the value narrowed to a record when it
 * is one, or `undefined` when it is not (the caller returns its issues early).
 * The trailing `created_at` check stays in each validator since it runs after
 * the artifact-specific body.
 */
function validateEnvelope(
  value: unknown,
  path: string,
  expectedVersion: string,
  issues: ValidationIssue[],
  opts: { goalId?: boolean } = { goalId: true },
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return undefined;
  }
  if (value.contract_version !== expectedVersion) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${expectedVersion}".`,
    );
  }
  if (opts.goalId !== false) {
    requireString(value.goal_id, `${path}.goal_id`, issues);
  }
  return value;
}

// ── GoalSpec ──────────────────────────────────────────────────────────────────

export function validateGoalSpec(
  value: unknown,
  path = "goal_spec",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_GOAL_SPEC_VERSION, issues);
  if (!v) return issues;
  requireString(v.objective, `${path}.objective`, issues);
  requireStringArray(v.non_goals, `${path}.non_goals`, issues);
  requireStringArray(v.success_criteria, `${path}.success_criteria`, issues);
  requireOneOf(
    v.source_type,
    ["conversation", "document", "structured_audit", "mixed"],
    `${path}.source_type`,
    issues,
  );
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ContextBundle ─────────────────────────────────────────────────────────────

export function validateContextBundle(
  value: unknown,
  path = "context_bundle",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.entries)) {
    pushValidationIssue(issues, `${path}.entries`, `${path}.entries must be an array.`);
  } else {
    for (const [i, entry] of v.entries.entries()) {
      if (!isRecord(entry)) {
        pushValidationIssue(issues, `${path}.entries[${i}]`, `${path}.entries[${i}] must be an object.`);
        continue;
      }
      requireString(entry.path, `${path}.entries[${i}].path`, issues);
      requireOneOf(entry.kind, ["source", "test", "config", "doc"], `${path}.entries[${i}].kind`, issues);
      requireString(entry.relevance_reason, `${path}.entries[${i}].relevance_reason`, issues);
    }
  }
  requireString(v.context_summary, `${path}.context_summary`, issues);
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ModuleDecomposition ───────────────────────────────────────────────────────

export function validateModuleDecomposition(
  value: unknown,
  path = "module_decomposition",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CP_MODULE_DECOMPOSITION_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.modules)) {
    pushValidationIssue(issues, `${path}.modules`, `${path}.modules must be an array.`);
  } else {
    for (const [i, mod] of v.modules.entries()) {
      if (!isRecord(mod)) {
        pushValidationIssue(issues, `${path}.modules[${i}]`, `${path}.modules[${i}] must be an object.`);
        continue;
      }
      requireString(mod.name, `${path}.modules[${i}].name`, issues);
      requireString(mod.responsibilities, `${path}.modules[${i}].responsibilities`, issues);
      requireStringArray(mod.file_scope, `${path}.modules[${i}].file_scope`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ModuleContracts ───────────────────────────────────────────────────────────

function validateModuleContractEntry(entry: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  requireString(entry.name, `${path}.name`, issues);
  requireStringArray(entry.inputs, `${path}.inputs`, issues);
  requireStringArray(entry.outputs, `${path}.outputs`, issues);
  requireStringArray(entry.invariants, `${path}.invariants`, issues);
  requireStringArray(entry.side_effects, `${path}.side_effects`, issues);
  requireString(entry.validation_boundary, `${path}.validation_boundary`, issues);
  requireStringArray(entry.failure_modes, `${path}.failure_modes`, issues);
}

export function validateModuleContracts(
  value: unknown,
  path = "module_contracts",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CP_MODULE_CONTRACTS_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.module_contracts)) {
    pushValidationIssue(issues, `${path}.module_contracts`, `${path}.module_contracts must be an array.`);
  } else {
    for (const [i, mod] of v.module_contracts.entries()) {
      if (!isRecord(mod)) {
        pushValidationIssue(issues, `${path}.module_contracts[${i}]`, `${path}.module_contracts[${i}] must be an object.`);
        continue;
      }
      validateModuleContractEntry(mod, `${path}.module_contracts[${i}]`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── SeamReconciliationReport ──────────────────────────────────────────────────

export function validateSeamReconciliationReport(
  value: unknown,
  path = "seam_reconciliation_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CP_SEAM_RECONCILIATION_REPORT_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.mismatches)) {
    pushValidationIssue(issues, `${path}.mismatches`, `${path}.mismatches must be an array.`);
  } else {
    for (const [i, mismatch] of v.mismatches.entries()) {
      if (!isRecord(mismatch)) {
        pushValidationIssue(issues, `${path}.mismatches[${i}]`, `${path}.mismatches[${i}] must be an object.`);
        continue;
      }
      requireString(mismatch.seam_id, `${path}.mismatches[${i}].seam_id`, issues);
      requireString(mismatch.module_a, `${path}.mismatches[${i}].module_a`, issues);
      requireString(mismatch.module_b, `${path}.mismatches[${i}].module_b`, issues);
      requireString(mismatch.description, `${path}.mismatches[${i}].description`, issues);
      if (!isRecord(mismatch.resolution)) {
        pushValidationIssue(
          issues,
          `${path}.mismatches[${i}].resolution`,
          `${path}.mismatches[${i}].resolution must be an object (every mismatch requires a resolution decision).`,
        );
      } else {
        requireOneOf(
          mismatch.resolution.decision,
          ["A", "B", "both"],
          `${path}.mismatches[${i}].resolution.decision`,
          issues,
        );
        requireString(
          mismatch.resolution.agreed_interface,
          `${path}.mismatches[${i}].resolution.agreed_interface`,
          issues,
        );
      }
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── FinalizedModuleContracts ──────────────────────────────────────────────────

export function validateFinalizedModuleContracts(
  value: unknown,
  path = "finalized_module_contracts",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CP_FINALIZED_MODULE_CONTRACTS_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.module_contracts)) {
    pushValidationIssue(issues, `${path}.module_contracts`, `${path}.module_contracts must be an array.`);
  } else {
    for (const [i, mod] of v.module_contracts.entries()) {
      if (!isRecord(mod)) {
        pushValidationIssue(issues, `${path}.module_contracts[${i}]`, `${path}.module_contracts[${i}] must be an object.`);
        continue;
      }
      validateModuleContractEntry(mod, `${path}.module_contracts[${i}]`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── DesignSpec ────────────────────────────────────────────────────────────────

export function validateDesignSpec(
  value: unknown,
  path = "design_spec",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_DESIGN_SPEC_VERSION, issues);
  if (!v) return issues;
  requireString(v.design_narrative, `${path}.design_narrative`, issues);
  if (!Array.isArray(v.invariants)) {
    pushValidationIssue(issues, `${path}.invariants`, `${path}.invariants must be an array.`);
  } else {
    for (const [i, inv] of v.invariants.entries()) {
      if (!isRecord(inv)) {
        pushValidationIssue(issues, `${path}.invariants[${i}]`, `${path}.invariants[${i}] must be an object.`);
        continue;
      }
      requireString(inv.id, `${path}.invariants[${i}].id`, issues);
      requireString(inv.description, `${path}.invariants[${i}].description`, issues);
    }
  }
  requireStringArray(v.affected_paths, `${path}.affected_paths`, issues);
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── DesignSpec structural gates + cross-artifact gates ────────────────────────
// Extracted to contractPipelineGates.ts (MNT-86b18f1b). Re-exported here for
// backward-compatible imports — callers do not need to update their import paths.
export {
  validateDesignSpecGates,
  validateGoalIdConsistency,
  validateImplementationDAGIntegrity,
  validatePairedObligations,
  validateEvidenceThreaded,
  validateDigestCoverage,
  validateReconciliationDerivation,
  deriveNodeModelTier,
  deriveNodeModelTierFromNode,
  type NodeComplexitySignals,
} from "./contractPipelineGates.js";

// ── ConceptualDesignCritique ──────────────────────────────────────────────────

export function validateConceptualDesignCritique(
  value: unknown,
  path = "conceptual_design_critique",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.items)) {
    pushValidationIssue(issues, `${path}.items`, `${path}.items must be an array.`);
  } else {
    for (const [i, item] of v.items.entries()) {
      if (!isRecord(item)) {
        pushValidationIssue(issues, `${path}.items[${i}]`, `${path}.items[${i}] must be an object.`);
        continue;
      }
      requireString(item.id, `${path}.items[${i}].id`, issues);
      requireOneOf(item.kind, ["concern", "alternative", "suggestion"], `${path}.items[${i}].kind`, issues);
      requireString(item.description, `${path}.items[${i}].description`, issues);
      requireOneOf(item.severity, ["blocking", "advisory"], `${path}.items[${i}].severity`, issues);
    }
  }
  requireOneOf(v.verdict, ["approved", "approved_with_concerns", "rejected"], `${path}.verdict`, issues);
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ObligationLedger ──────────────────────────────────────────────────────────

export function validateObligationLedger(
  value: unknown,
  path = "obligation_ledger",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.obligations)) {
    pushValidationIssue(issues, `${path}.obligations`, `${path}.obligations must be an array.`);
  } else {
    for (const [i, obl] of v.obligations.entries()) {
      if (!isRecord(obl)) {
        pushValidationIssue(issues, `${path}.obligations[${i}]`, `${path}.obligations[${i}] must be an object.`);
        continue;
      }
      requireString(obl.id, `${path}.obligations[${i}].id`, issues);
      requireString(obl.description, `${path}.obligations[${i}].description`, issues);
      requireOneOf(obl.kind, ["invariant", "behavioral", "structural", "test"], `${path}.obligations[${i}].kind`, issues);
      requireStringArray(obl.depends_on, `${path}.obligations[${i}].depends_on`, issues);
      requireOneOf(obl.status, ["pending", "satisfied", "failed"], `${path}.obligations[${i}].status`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── TestValidatorPlan ─────────────────────────────────────────────────────────

const TEST_SPEC_KINDS = ["unit", "integration", "schema", "invariant", "e2e"] as const;

export function validateTestValidatorPlan(
  value: unknown,
  path = "test_validator_plan",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.test_specs)) {
    pushValidationIssue(issues, `${path}.test_specs`, `${path}.test_specs must be an array.`);
  } else {
    for (const [i, spec] of v.test_specs.entries()) {
      if (!isRecord(spec)) {
        pushValidationIssue(issues, `${path}.test_specs[${i}]`, `${path}.test_specs[${i}] must be an object.`);
        continue;
      }
      requireString(spec.obligation_id, `${path}.test_specs[${i}].obligation_id`, issues);
      requireString(spec.name, `${path}.test_specs[${i}].name`, issues);
      requireOneOf(spec.kind, TEST_SPEC_KINDS, `${path}.test_specs[${i}].kind`, issues);
      if (!Array.isArray(spec.assertions) || spec.assertions.length === 0) {
        pushValidationIssue(
          issues,
          `${path}.test_specs[${i}].assertions`,
          `${path}.test_specs[${i}].assertions must be a non-empty array of strings.`,
        );
      } else {
        requireStringArray(spec.assertions, `${path}.test_specs[${i}].assertions`, issues);
      }
      if (spec.inapplicable_claim !== undefined) {
        if (!isRecord(spec.inapplicable_claim)) {
          pushValidationIssue(
            issues,
            `${path}.test_specs[${i}].inapplicable_claim`,
            `${path}.test_specs[${i}].inapplicable_claim must be an object.`,
          );
        } else {
          requireString(
            spec.inapplicable_claim.obligation_id,
            `${path}.test_specs[${i}].inapplicable_claim.obligation_id`,
            issues,
          );
          requireString(
            spec.inapplicable_claim.reason,
            `${path}.test_specs[${i}].inapplicable_claim.reason`,
            issues,
          );
        }
      }
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ContractAssessmentReport ──────────────────────────────────────────────────

export function validateContractAssessmentReport(
  value: unknown,
  path = "contract_assessment_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.findings)) {
    pushValidationIssue(issues, `${path}.findings`, `${path}.findings must be an array.`);
  } else {
    for (const [i, finding] of v.findings.entries()) {
      if (!isRecord(finding)) {
        pushValidationIssue(issues, `${path}.findings[${i}]`, `${path}.findings[${i}] must be an object.`);
        continue;
      }
      requireString(finding.obligation_id, `${path}.findings[${i}].obligation_id`, issues);
      requireOneOf(finding.status, ["satisfied", "violated", "uncertain"], `${path}.findings[${i}].status`, issues);
      requireStringArray(finding.evidence, `${path}.findings[${i}].evidence`, issues);
      requireString(finding.rationale, `${path}.findings[${i}].rationale`, issues);
    }
  }
  requireOneOf(v.verdict, ["passed", "failed", "partial"], `${path}.verdict`, issues);
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── CounterexampleReport ──────────────────────────────────────────────────────

export function validateCounterexample(
  value: unknown,
  path = "counterexample",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.counterexamples)) {
    pushValidationIssue(issues, `${path}.counterexamples`, `${path}.counterexamples must be an array.`);
  } else {
    for (const [i, entry] of v.counterexamples.entries()) {
      if (!isRecord(entry)) {
        pushValidationIssue(issues, `${path}.counterexamples[${i}]`, `${path}.counterexamples[${i}] must be an object.`);
        continue;
      }
      requireString(entry.id, `${path}.counterexamples[${i}].id`, issues);
      requireString(entry.claim, `${path}.counterexamples[${i}].claim`, issues);
      requireStringArray(entry.reproduction_steps, `${path}.counterexamples[${i}].reproduction_steps`, issues);
      requireString(entry.expected, `${path}.counterexamples[${i}].expected`, issues);
      requireString(entry.actual, `${path}.counterexamples[${i}].actual`, issues);
      requireStringArray(entry.violated_obligation_ids, `${path}.counterexamples[${i}].violated_obligation_ids`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── JudgeReport ───────────────────────────────────────────────────────────────

const COUNTEREXAMPLE_CLASSIFICATIONS = [
  "accepted",
  "out_of_scope",
  "duplicate",
  "invalid",
  "residual_risk",
] as const;

const JUDGE_REPAIR_TARGETS = [
  "finalized_module_contracts",
  "obligation_ledger",
  "contract_assessment_report",
  // Legacy alias: pre-redesign judge reports may reference design_spec.
  "design_spec",
] as const;

export function validateJudgeReport(
  value: unknown,
  path = "judge_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_JUDGE_REPORT_VERSION, issues);
  if (!v) return issues;
  requireOneOf(v.verdict, ["approved", "needs_repair"], `${path}.verdict`, issues);
  if (!Array.isArray(v.classifications)) {
    pushValidationIssue(issues, `${path}.classifications`, `${path}.classifications must be an array.`);
  } else {
    for (const [i, entry] of v.classifications.entries()) {
      if (!isRecord(entry)) {
        pushValidationIssue(issues, `${path}.classifications[${i}]`, `${path}.classifications[${i}] must be an object.`);
        continue;
      }
      requireString(entry.counterexample_id, `${path}.classifications[${i}].counterexample_id`, issues);
      requireOneOf(entry.classification, COUNTEREXAMPLE_CLASSIFICATIONS, `${path}.classifications[${i}].classification`, issues);
      requireString(entry.rationale, `${path}.classifications[${i}].rationale`, issues);
    }
  }
  if (v.verdict === "needs_repair") {
    if (!isRecord(v.repair_directive)) {
      pushValidationIssue(
        issues,
        `${path}.repair_directive`,
        `${path}.repair_directive is required when verdict is "needs_repair".`,
      );
    }
  }
  if (v.repair_directive !== undefined) {
    if (!isRecord(v.repair_directive)) {
      pushValidationIssue(issues, `${path}.repair_directive`, `${path}.repair_directive must be an object.`);
    } else {
      requireOneOf(v.repair_directive.target, JUDGE_REPAIR_TARGETS, `${path}.repair_directive.target`, issues);
      requireString(v.repair_directive.instruction, `${path}.repair_directive.instruction`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ImplementationDAG ─────────────────────────────────────────────────────────

export function validateImplementationDAG(
  value: unknown,
  path = "implementation_dag",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.nodes)) {
    pushValidationIssue(issues, `${path}.nodes`, `${path}.nodes must be an array.`);
  } else {
    const nodeIds = new Set<string>();
    for (const [i, node] of v.nodes.entries()) {
      if (!isRecord(node)) {
        pushValidationIssue(issues, `${path}.nodes[${i}]`, `${path}.nodes[${i}] must be an object.`);
        continue;
      }
      requireString(node.id, `${path}.nodes[${i}].id`, issues);
      requireString(node.title, `${path}.nodes[${i}].title`, issues);
      requireString(node.description, `${path}.nodes[${i}].description`, issues);
      requireStringArray(node.satisfies_obligations, `${path}.nodes[${i}].satisfies_obligations`, issues);
      if (node.addresses_counterexamples !== undefined) {
        requireStringArray(node.addresses_counterexamples, `${path}.nodes[${i}].addresses_counterexamples`, issues);
      }
      requireStringArray(node.depends_on, `${path}.nodes[${i}].depends_on`, issues);
      requireStringArray(node.verification_obligation_ids, `${path}.nodes[${i}].verification_obligation_ids`, issues);
      requireStringArray(node.targeted_commands, `${path}.nodes[${i}].targeted_commands`, issues);
      requireOneOf(node.status, ["pending", "in_progress", "resolved", "blocked"], `${path}.nodes[${i}].status`, issues);
      if (node.files_likely_touched !== undefined) {
        requireStringArray(node.files_likely_touched, `${path}.nodes[${i}].files_likely_touched`, issues);
      }
      if (node.preconditions !== undefined) {
        requireStringArray(node.preconditions, `${path}.nodes[${i}].preconditions`, issues);
      }
      if (node.expected_changes !== undefined && node.expected_changes !== null) {
        if (typeof node.expected_changes !== "string") {
          pushValidationIssue(issues, `${path}.nodes[${i}].expected_changes`, `${path}.nodes[${i}].expected_changes must be a string when present.`);
        }
      }
      if (typeof node.id === "string") nodeIds.add(node.id);
    }
  }
  if (!Array.isArray(v.edges)) {
    pushValidationIssue(issues, `${path}.edges`, `${path}.edges must be an array.`);
  } else {
    for (const [i, edge] of v.edges.entries()) {
      if (!isRecord(edge)) {
        pushValidationIssue(issues, `${path}.edges[${i}]`, `${path}.edges[${i}] must be an object.`);
        continue;
      }
      requireString(edge.from, `${path}.edges[${i}].from`, issues);
      requireString(edge.to, `${path}.edges[${i}].to`, issues);
      requireOneOf(edge.kind, ["dependency", "verification"], `${path}.edges[${i}].kind`, issues);
    }
  }
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── VerificationReport ────────────────────────────────────────────────────────

export function validateVerificationReport(
  value: unknown,
  path = "verification_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // VerificationReport has no goal_id at the top level (it carries an optional
  // goal_id elsewhere); skip the goal_id envelope check for this artifact.
  const v = validateEnvelope(value, path, CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION, issues, {
    goalId: false,
  });
  if (!v) return issues;
  if (!Array.isArray(v.findings)) {
    pushValidationIssue(issues, `${path}.findings`, `${path}.findings must be an array.`);
  } else {
    for (const [i, finding] of v.findings.entries()) {
      if (!isRecord(finding)) {
        pushValidationIssue(issues, `${path}.findings[${i}]`, `${path}.findings[${i}] must be an object.`);
        continue;
      }
      requireString(finding.finding_id, `${path}.findings[${i}].finding_id`, issues);
      if (!Array.isArray(finding.traces)) {
        pushValidationIssue(issues, `${path}.findings[${i}].traces`, `${path}.findings[${i}].traces must be an array.`);
      } else {
        for (const [j, trace] of finding.traces.entries()) {
          if (!isRecord(trace)) {
            pushValidationIssue(issues, `${path}.findings[${i}].traces[${j}]`, `${path}.findings[${i}].traces[${j}] must be an object.`);
            continue;
          }
          requireString(trace.trace_id, `${path}.findings[${i}].traces[${j}].trace_id`, issues);
          requireOneOf(trace.kind, ["requirement", "invariant", "counterexample", "task", "file", "command"], `${path}.findings[${i}].traces[${j}].kind`, issues);
          requireString(trace.label, `${path}.findings[${i}].traces[${j}].label`, issues);
          requireStringArray(trace.evidence, `${path}.findings[${i}].traces[${j}].evidence`, issues);
          requireOneOf(trace.status, ["passed", "failed"], `${path}.findings[${i}].traces[${j}].status`, issues);
        }
      }
      requireOneOf(finding.overall_status, ["passed", "failed"], `${path}.findings[${i}].overall_status`, issues);
    }
  }
  requireOneOf(v.overall_status, ["passed", "failed"], `${path}.overall_status`, issues);
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── CyclicSeamResolution ──────────────────────────────────────────────────────

export function validateCyclicSeamResolution(
  value: unknown,
  path = "cyclic_seam_resolution",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const v = validateEnvelope(value, path, CP_CYCLIC_SEAM_RESOLUTION_VERSION, issues);
  if (!v) return issues;
  if (!Array.isArray(v.cycles)) {
    pushValidationIssue(issues, `${path}.cycles`, `${path}.cycles must be an array.`);
  } else {
    for (const [i, cycle] of v.cycles.entries()) {
      if (!isRecord(cycle)) {
        pushValidationIssue(issues, `${path}.cycles[${i}]`, `${path}.cycles[${i}] must be an object.`);
        continue;
      }
      if (!Array.isArray(cycle.members) || cycle.members.some((m) => typeof m !== "string")) {
        pushValidationIssue(
          issues,
          `${path}.cycles[${i}].members`,
          `${path}.cycles[${i}].members must be an array of strings.`,
        );
      }
    }
  }
  requireOneOf(
    v.status,
    CYCLIC_SEAM_RESOLUTION_STATUSES,
    `${path}.status`,
    issues,
  );
  requireString(v.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── Validator registry ────────────────────────────────────────────────────────

/**
 * One validator per contract-pipeline artifact payload. Used by the driver's
 * ingestion pass (worker-written raw payloads are untrusted until validated)
 * and by the artifacts validation sweep.
 */
export const CONTRACT_PIPELINE_VALIDATORS: Record<
  ContractPipelineArtifactName,
  (value: unknown, path: string) => ValidationIssue[]
> = {
  goal_spec: validateGoalSpec,
  context_bundle: validateContextBundle,
  module_decomposition: validateModuleDecomposition,
  module_contracts: validateModuleContracts,
  seam_reconciliation_report: validateSeamReconciliationReport,
  finalized_module_contracts: validateFinalizedModuleContracts,
  conceptual_design_critique: validateConceptualDesignCritique,
  obligation_ledger: validateObligationLedger,
  cyclic_seam_resolution: validateCyclicSeamResolution,
  test_validator_plan: validateTestValidatorPlan,
  contract_assessment_report: validateContractAssessmentReport,
  counterexample: validateCounterexample,
  judge_report: validateJudgeReport,
  implementation_dag: validateImplementationDAG,
  verification_report: validateVerificationReport,
};
