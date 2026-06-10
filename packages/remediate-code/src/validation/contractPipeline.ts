/**
 * Validation helpers for contract-pipeline artifacts.
 * Follows the ValidationIssue[] pattern used by the rest of the remediator
 * validation layer.
 */
import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
} from "@audit-tools/shared";
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
} from "@audit-tools/shared";

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

// ── GoalSpec ──────────────────────────────────────────────────────────────────

export function validateGoalSpec(
  value: unknown,
  path = "goal_spec",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_GOAL_SPEC_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_GOAL_SPEC_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  requireString(value.objective, `${path}.objective`, issues);
  requireStringArray(value.non_goals, `${path}.non_goals`, issues);
  requireStringArray(value.success_criteria, `${path}.success_criteria`, issues);
  requireOneOf(
    value.source_type,
    ["conversation", "document", "structured_audit", "mixed"],
    `${path}.source_type`,
    issues,
  );
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ContextBundle ─────────────────────────────────────────────────────────────

export function validateContextBundle(
  value: unknown,
  path = "context_bundle",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.entries)) {
    pushValidationIssue(issues, `${path}.entries`, `${path}.entries must be an array.`);
  } else {
    for (const [i, entry] of value.entries.entries()) {
      if (!isRecord(entry)) {
        pushValidationIssue(issues, `${path}.entries[${i}]`, `${path}.entries[${i}] must be an object.`);
        continue;
      }
      requireString(entry.path, `${path}.entries[${i}].path`, issues);
      requireOneOf(entry.kind, ["source", "test", "config", "doc"], `${path}.entries[${i}].kind`, issues);
      requireString(entry.relevance_reason, `${path}.entries[${i}].relevance_reason`, issues);
    }
  }
  requireString(value.context_summary, `${path}.context_summary`, issues);
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── DesignSpec ────────────────────────────────────────────────────────────────

export function validateDesignSpec(
  value: unknown,
  path = "design_spec",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_DESIGN_SPEC_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_DESIGN_SPEC_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  requireString(value.design_narrative, `${path}.design_narrative`, issues);
  if (!Array.isArray(value.invariants)) {
    pushValidationIssue(issues, `${path}.invariants`, `${path}.invariants must be an array.`);
  } else {
    for (const [i, inv] of value.invariants.entries()) {
      if (!isRecord(inv)) {
        pushValidationIssue(issues, `${path}.invariants[${i}]`, `${path}.invariants[${i}] must be an object.`);
        continue;
      }
      requireString(inv.id, `${path}.invariants[${i}].id`, issues);
      requireString(inv.description, `${path}.invariants[${i}].description`, issues);
    }
  }
  requireStringArray(value.affected_paths, `${path}.affected_paths`, issues);
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ConceptualDesignCritique ──────────────────────────────────────────────────

export function validateConceptualDesignCritique(
  value: unknown,
  path = "conceptual_design_critique",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.items)) {
    pushValidationIssue(issues, `${path}.items`, `${path}.items must be an array.`);
  } else {
    for (const [i, item] of value.items.entries()) {
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
  requireOneOf(value.verdict, ["approved", "approved_with_concerns", "rejected"], `${path}.verdict`, issues);
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ObligationLedger ──────────────────────────────────────────────────────────

export function validateObligationLedger(
  value: unknown,
  path = "obligation_ledger",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.obligations)) {
    pushValidationIssue(issues, `${path}.obligations`, `${path}.obligations must be an array.`);
  } else {
    for (const [i, obl] of value.obligations.entries()) {
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
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ContractAssessmentReport ──────────────────────────────────────────────────

export function validateContractAssessmentReport(
  value: unknown,
  path = "contract_assessment_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.findings)) {
    pushValidationIssue(issues, `${path}.findings`, `${path}.findings must be an array.`);
  } else {
    for (const [i, finding] of value.findings.entries()) {
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
  requireOneOf(value.verdict, ["passed", "failed", "partial"], `${path}.verdict`, issues);
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── CounterexampleReport ──────────────────────────────────────────────────────

export function validateCounterexample(
  value: unknown,
  path = "counterexample",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.counterexamples)) {
    pushValidationIssue(issues, `${path}.counterexamples`, `${path}.counterexamples must be an array.`);
  } else {
    for (const [i, entry] of value.counterexamples.entries()) {
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
  requireString(value.created_at, `${path}.created_at`, issues);
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
  "design_spec",
  "obligation_ledger",
  "contract_assessment_report",
] as const;

export function validateJudgeReport(
  value: unknown,
  path = "judge_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_JUDGE_REPORT_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_JUDGE_REPORT_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  requireOneOf(value.verdict, ["approved", "needs_repair"], `${path}.verdict`, issues);
  if (!Array.isArray(value.classifications)) {
    pushValidationIssue(issues, `${path}.classifications`, `${path}.classifications must be an array.`);
  } else {
    for (const [i, entry] of value.classifications.entries()) {
      if (!isRecord(entry)) {
        pushValidationIssue(issues, `${path}.classifications[${i}]`, `${path}.classifications[${i}] must be an object.`);
        continue;
      }
      requireString(entry.counterexample_id, `${path}.classifications[${i}].counterexample_id`, issues);
      requireOneOf(entry.classification, COUNTEREXAMPLE_CLASSIFICATIONS, `${path}.classifications[${i}].classification`, issues);
      requireString(entry.rationale, `${path}.classifications[${i}].rationale`, issues);
    }
  }
  if (value.verdict === "needs_repair") {
    if (!isRecord(value.repair_directive)) {
      pushValidationIssue(
        issues,
        `${path}.repair_directive`,
        `${path}.repair_directive is required when verdict is "needs_repair".`,
      );
    }
  }
  if (value.repair_directive !== undefined) {
    if (!isRecord(value.repair_directive)) {
      pushValidationIssue(issues, `${path}.repair_directive`, `${path}.repair_directive must be an object.`);
    } else {
      requireOneOf(value.repair_directive.target, JUDGE_REPAIR_TARGETS, `${path}.repair_directive.target`, issues);
      requireString(value.repair_directive.instruction, `${path}.repair_directive.instruction`, issues);
    }
  }
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── ImplementationDAG ─────────────────────────────────────────────────────────

export function validateImplementationDAG(
  value: unknown,
  path = "implementation_dag",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION}".`,
    );
  }
  requireString(value.goal_id, `${path}.goal_id`, issues);
  if (!Array.isArray(value.nodes)) {
    pushValidationIssue(issues, `${path}.nodes`, `${path}.nodes must be an array.`);
  } else {
    const nodeIds = new Set<string>();
    for (const [i, node] of value.nodes.entries()) {
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
      if (typeof node.id === "string") nodeIds.add(node.id);
    }
  }
  if (!Array.isArray(value.edges)) {
    pushValidationIssue(issues, `${path}.edges`, `${path}.edges must be an array.`);
  } else {
    for (const [i, edge] of value.edges.entries()) {
      if (!isRecord(edge)) {
        pushValidationIssue(issues, `${path}.edges[${i}]`, `${path}.edges[${i}] must be an object.`);
        continue;
      }
      requireString(edge.from, `${path}.edges[${i}].from`, issues);
      requireString(edge.to, `${path}.edges[${i}].to`, issues);
      requireOneOf(edge.kind, ["dependency", "verification"], `${path}.edges[${i}].kind`, issues);
    }
  }
  requireString(value.created_at, `${path}.created_at`, issues);
  return issues;
}

// ── VerificationReport ────────────────────────────────────────────────────────

export function validateVerificationReport(
  value: unknown,
  path = "verification_report",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path}.contract_version must be "${CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION}".`,
    );
  }
  if (!Array.isArray(value.findings)) {
    pushValidationIssue(issues, `${path}.findings`, `${path}.findings must be an array.`);
  } else {
    for (const [i, finding] of value.findings.entries()) {
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
  requireOneOf(value.overall_status, ["passed", "failed"], `${path}.overall_status`, issues);
  requireString(value.created_at, `${path}.created_at`, issues);
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
  design_spec: validateDesignSpec,
  conceptual_design_critique: validateConceptualDesignCritique,
  obligation_ledger: validateObligationLedger,
  contract_assessment_report: validateContractAssessmentReport,
  counterexample: validateCounterexample,
  judge_report: validateJudgeReport,
  implementation_dag: validateImplementationDAG,
  verification_report: validateVerificationReport,
};
