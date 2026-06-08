/**
 * Bounded prompt renderers for each of the seven contract-pipeline roles.
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
  implementation_planning: {
    title: "Implementation Planning (DAG)",
    requiredInputKeys: ["goal_spec", "context_bundle", "design_spec", "obligation_ledger", "contract_assessment_report"],
    outputKey: "implementation_dag",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
  "goal_id": "<from goal_spec>",
  "nodes": [{
    "id": "<task-id>",
    "title": "<short title>",
    "description": "<bounded task description>",
    "satisfies_obligations": ["<obligation_id>"],
    "depends_on": ["<task-id>"],
    "verification_obligation_ids": ["<obligation_id>"],
    "targeted_commands": ["<command to verify>"],
    "status": "pending"
  }],
  "edges": [{ "from": "<id>", "to": "<id>", "kind": "dependency|verification" }],
  "created_at": "<ISO-8601>"
}`,
    description:
      "Decompose the implementation into a bounded dependency DAG of tasks.",
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
  "implementation_planning",
  "closing",
];

// Re-export the obligation-ledger role separately since it maps to a phase that
// exists in the DAG but is triggered from the assessment step internally.
export const OBLIGATION_LEDGER_ROLE_KEY = "obligation_ledger_phase" as const;
