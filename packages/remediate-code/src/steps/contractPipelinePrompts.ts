/**
 * Bounded prompt renderers for each of the contract-pipeline roles.
 * Each renderer accepts only the required artifact paths for its role and
 * fails fast when any required path is missing. Prompts stay path-based and
 * schema-grounded rather than embedding raw artifact content.
 */
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";

// ── Role definitions ──────────────────────────────────────────────────────────

interface ContractPipelineRole {
  /** Display title for the role step heading. */
  title: string;
  /** Artifact path keys required as input (must all be provided). */
  requiredInputKeys: ContractPipelineArtifactName[];
  /** Artifact path key that this role produces as output. */
  outputKey: ContractPipelineArtifactName;
  /** JSON schema / contract shape description for the output. */
  outputSchema: string;
  /** Short description of what this role does. */
  description: string;
}

const ROLES: Record<string, ContractPipelineRole> = {
  goal_normalization: {
    title: "Goal Normalization",
    requiredInputKeys: [],
    outputKey: "goal_spec",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/goal-spec/v1alpha1",
  "goal_id": "<stable-identifier>",
  "objective": "<single-sentence primary objective>",
  "non_goals": ["<explicit out-of-scope items>"],
  "success_criteria": ["<measurable criteria>"],
  "source_type": "conversation | document | structured_audit | mixed",
  "created_at": "<ISO-8601>"
}`,
    description:
      "Normalize the remediation objective into a bounded, unambiguous goal spec.",
  },
  context_collection: {
    title: "Context Collection",
    requiredInputKeys: ["goal_spec"],
    outputKey: "context_bundle",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/context-bundle/v1alpha1",
  "goal_id": "<from goal_spec>",
  "entries": [{ "path": "<repo-relative>", "kind": "source|test|config|doc", "relevance_reason": "..." }],
  "context_summary": "<free-text summary>",
  "created_at": "<ISO-8601>"
}`,
    description:
      "Collect the code and documentation context relevant to the goal.",
  },
  design: {
    title: "Design",
    requiredInputKeys: ["goal_spec", "context_bundle"],
    outputKey: "design_spec",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/design-spec/v1alpha1",
  "goal_id": "<from goal_spec>",
  "design_narrative": "<high-level narrative>",
  "invariants": [{ "id": "<id>", "description": "<boundary/invariant>" }],
  "affected_paths": ["<repo-relative paths>"],
  "created_at": "<ISO-8601>"
}`,
    description: "Propose a design that satisfies the goal spec invariants.",
  },
  critique: {
    title: "Conceptual Design Critique",
    requiredInputKeys: ["goal_spec", "design_spec"],
    outputKey: "conceptual_design_critique",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
  "goal_id": "<from goal_spec>",
  "items": [{ "id": "<id>", "kind": "concern|alternative|suggestion", "description": "...", "severity": "blocking|advisory" }],
  "verdict": "approved | approved_with_concerns | rejected",
  "created_at": "<ISO-8601>"
}`,
    description:
      "Provide philosophy/alternatives/directions critique of the proposed design.",
  },
  assessment: {
    title: "Contract Assessment",
    requiredInputKeys: ["goal_spec", "design_spec", "obligation_ledger"],
    outputKey: "contract_assessment_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "findings": [{ "obligation_id": "<id>", "status": "satisfied|violated|uncertain", "evidence": ["..."], "rationale": "..." }],
  "verdict": "passed | failed | partial",
  "created_at": "<ISO-8601>"
}`,
    description:
      "Assess whether the design spec satisfies all invariants and obligations.",
  },
  critic: {
    title: "Adversarial Critic (Counterexample Search)",
    requiredInputKeys: ["goal_spec", "design_spec", "obligation_ledger", "contract_assessment_report"],
    outputKey: "counterexample",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/counterexample/v1alpha1",
  "goal_id": "<from goal_spec>",
  "counterexamples": [{
    "id": "CE-001",
    "claim": "<the design/assessment claim being falsified>",
    "reproduction_steps": ["<concrete step>"],
    "expected": "<what the design promises>",
    "actual": "<what actually happens under this counterexample>",
    "violated_obligation_ids": ["<obligation_id>"]
  }],
  "created_at": "<ISO-8601>"
}`,
    description:
      "Adversarially attack the design: produce concrete counterexamples that falsify design invariants, obligations, or assessment claims. Each counterexample must name the claim it falsifies, concrete reproduction steps, and the obligation(s) it violates. Search hard for inputs, orderings, and edge states the design mishandles; an empty counterexamples array is only acceptable when you genuinely cannot falsify anything.",
  },
  judge: {
    title: "Adversarial Judge",
    requiredInputKeys: ["goal_spec", "design_spec", "obligation_ledger", "contract_assessment_report", "counterexample"],
    outputKey: "judge_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/judge-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "verdict": "approved | needs_repair",
  "classifications": [{
    "counterexample_id": "<id from the counterexample report>",
    "classification": "accepted | out_of_scope | duplicate | invalid | residual_risk",
    "rationale": "<one-line justification>"
  }],
  "repair_directive": {
    "target": "design_spec | obligation_ledger | contract_assessment_report",
    "instruction": "<bounded instruction for regenerating the target artifact>"
  },
  "created_at": "<ISO-8601>"
}`,
    description:
      "Judge every counterexample from the critic: `accepted` (real flaw the contract must address), `out_of_scope` (outside the goal spec), `duplicate`, `invalid` (does not actually falsify the claim), or `residual_risk` (real but tolerable; recorded, not repaired). Verdict is `approved` only when no accepted counterexample demands a contract repair — then omit `repair_directive`. Otherwise verdict is `needs_repair` and `repair_directive` must name the single artifact whose regeneration addresses the accepted counterexamples.",
  },
  implementation_planning: {
    title: "Implementation Planning (DAG)",
    requiredInputKeys: ["goal_spec", "context_bundle", "design_spec", "obligation_ledger", "contract_assessment_report", "counterexample", "judge_report"],
    outputKey: "implementation_dag",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
  "goal_id": "<from goal_spec>",
  "nodes": [{
    "id": "<task-id>",
    "title": "<short title>",
    "description": "<bounded task description>",
    "satisfies_obligations": ["<obligation_id>"],
    "addresses_counterexamples": ["<accepted counterexample id, when applicable>"],
    "depends_on": ["<task-id>"],
    "verification_obligation_ids": ["<obligation_id>"],
    "targeted_commands": ["<command to verify>"],
    "status": "pending"
  }],
  "edges": [{ "from": "<id>", "to": "<id>", "kind": "dependency|verification" }],
  "created_at": "<ISO-8601>"
}`,
    description:
      "Decompose the implementation into a bounded dependency DAG of tasks. Traceability is mandatory: every node must list at least one obligation id from the obligation ledger (in satisfies_obligations or verification_obligation_ids) or one judge-accepted counterexample id (in addresses_counterexamples) — untraceable nodes are rejected. Accepted and residual_risk counterexamples from the judge report must be covered by nodes or verification obligations.",
  },
  closing: {
    title: "Contract Pipeline Closing",
    requiredInputKeys: ["goal_spec", "implementation_dag"],
    outputKey: "verification_report",
    outputSchema: `{
  "contract_version": "remediate-code-verification-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "findings": [{
    "finding_id": "<id>",
    "traces": [{ "trace_id": "<id>", "kind": "requirement|invariant|task|file|command", "label": "...", "evidence": ["..."], "status": "passed|failed" }],
    "overall_status": "passed|failed"
  }],
  "overall_status": "passed|failed",
  "created_at": "<ISO-8601>"
}`,
    description:
      "Verify all obligations are satisfied and produce the verification report.",
  },
};

// ── Renderer ──────────────────────────────────────────────────────────────────

export interface ContractPipelineRenderInput {
  /** The role to render a prompt for. */
  role: string;
  /** Resolved file paths for all contract-pipeline artifacts. */
  artifactPaths: Partial<Record<ContractPipelineArtifactName, string>>;
  /** Sources available to the worker (remediation brief, conversation, etc.). */
  sourcePaths?: string[];
  /** Repository root path — passed to workers for cwd anchoring. */
  repoRoot?: string;
}

export interface ContractPipelineRenderResult {
  prompt: string;
  outputPath: string;
  role: ContractPipelineRole;
}

/**
 * Render a bounded prompt for the given contract-pipeline role.
 * Throws a descriptive error when any required artifact path is missing.
 */
export function renderContractPipelinePrompt(
  input: ContractPipelineRenderInput,
): ContractPipelineRenderResult {
  const role = ROLES[input.role];
  if (!role) {
    throw new Error(
      `Unknown contract-pipeline role: "${input.role}". Valid roles: ${Object.keys(ROLES).join(", ")}.`,
    );
  }

  // Validate required inputs.
  for (const key of role.requiredInputKeys) {
    if (!input.artifactPaths[key]) {
      throw new Error(
        `Contract-pipeline role "${input.role}" requires artifact path for "${key}" but it was not provided.`,
      );
    }
  }

  const outputPath = input.artifactPaths[role.outputKey];
  if (!outputPath) {
    throw new Error(
      `Contract-pipeline role "${input.role}" requires output artifact path for "${role.outputKey}" but it was not provided.`,
    );
  }

  const inputSections = role.requiredInputKeys.map((key) => {
    const path = input.artifactPaths[key]!;
    return `- \`${path}\` (${key})`;
  });

  const sourceSections =
    input.sourcePaths && input.sourcePaths.length > 0
      ? `\n## Source Inputs\n\n${input.sourcePaths.map((p) => `- \`${p}\``).join("\n")}\n`
      : "";

  const cwdNote = input.repoRoot
    ? `\n> Set the shell/tool working directory to \`${input.repoRoot}\` before running any commands.\n`
    : "";

  const prompt = `# ${role.title}

${role.description}
${cwdNote}
## Required Inputs
${inputSections.length > 0 ? inputSections.join("\n") : "_No artifact inputs required for this role._"}
${sourceSections}
## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

\`${outputPath}\`

The output must conform to this JSON schema shape:

\`\`\`json
${role.outputSchema}
\`\`\`

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.
`;

  return { prompt, outputPath, role };
}

/** Return the ordered list of valid role names. */
export function listContractPipelineRoles(): string[] {
  return Object.keys(ROLES);
}

/** Return the dependency order for pipeline phase progression. */
export const CONTRACT_PIPELINE_PHASE_ORDER: string[] = [
  "goal_normalization",
  "context_collection",
  "design",
  "critique",
  "assessment",
  "critic",
  "judge",
  "implementation_planning",
  "closing",
];

// ── Repair prompt ─────────────────────────────────────────────────────────────

export interface ContractRepairRenderInput {
  /** The contract artifact the judge ordered regenerated. */
  target: "design_spec" | "obligation_ledger" | "contract_assessment_report";
  /** The judge's bounded regeneration instruction. */
  instruction: string;
  /** Resolved file paths for all contract-pipeline artifacts. */
  artifactPaths: Partial<Record<ContractPipelineArtifactName, string>>;
  /** Repository root path — passed to workers for cwd anchoring. */
  repoRoot?: string;
}

/** Schema shape per repair target, sourced from the producing role. */
const REPAIR_TARGET_SCHEMA: Record<ContractRepairRenderInput["target"], () => string> = {
  design_spec: () => ROLES.design.outputSchema,
  // obligation_ledger has no ROLES entry (it renders via the bespoke
  // obligation-ledger prompt), so its schema shape lives here.
  obligation_ledger: () => `{
  "contract_version": "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
  "goal_id": "<from goal_spec>",
  "obligations": [{
    "id": "<obligation-id>",
    "description": "<concrete obligation>",
    "kind": "invariant|behavioral|structural|test",
    "depends_on": [],
    "status": "pending"
  }],
  "created_at": "<ISO-8601>"
}`,
  contract_assessment_report: () => ROLES.assessment.outputSchema,
};

/**
 * Render the bounded repair step for a failing judge verdict: regenerate the
 * named contract artifact in full, addressing the accepted counterexamples and
 * the judge's instruction. The next pipeline invocation re-validates and
 * re-derives everything downstream via the staleness DAG.
 */
export function renderContractRepairPrompt(
  input: ContractRepairRenderInput,
): { prompt: string; outputPath: string } {
  const outputPath = input.artifactPaths[input.target];
  if (!outputPath) {
    throw new Error(
      `Contract repair requires an artifact path for "${input.target}" but it was not provided.`,
    );
  }
  const requiredInputs = [
    "goal_spec",
    "design_spec",
    "obligation_ledger",
    "contract_assessment_report",
    "counterexample",
    "judge_report",
  ] as ContractPipelineArtifactName[];
  for (const key of requiredInputs) {
    if (!input.artifactPaths[key]) {
      throw new Error(
        `Contract repair requires artifact path for "${key}" but it was not provided.`,
      );
    }
  }

  const cwdNote = input.repoRoot
    ? `\n> Set the shell/tool working directory to \`${input.repoRoot}\` before running any commands.\n`
    : "";

  const prompt = `# Contract Repair: ${input.target}

The adversarial judge rejected the current contract. Regenerate \`${input.target}\` IN FULL so that every judge-accepted counterexample is addressed.
${cwdNote}
## Judge Instruction

${input.instruction}

## Required Inputs

${requiredInputs.map((key) => `- \`${input.artifactPaths[key]}\` (${key})`).join("\n")}

## Your Task

Read the inputs above — pay particular attention to the accepted counterexamples in the judge report's classifications. Rewrite the complete, corrected artifact (not a diff) to exactly:

\`${outputPath}\`

The output must conform to this JSON schema shape:

\`\`\`json
${REPAIR_TARGET_SCHEMA[input.target]()}
\`\`\`

Downstream artifacts are re-derived automatically after this repair — do not edit any other artifact.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.
`;

  return { prompt, outputPath };
}

// Re-export the obligation-ledger role separately since it maps to a phase that
// exists in the DAG but is triggered from the assessment step internally.
export const OBLIGATION_LEDGER_ROLE_KEY = "obligation_ledger_phase" as const;
