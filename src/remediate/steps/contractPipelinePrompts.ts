/**
 * Bounded prompt renderers for each of the contract-pipeline roles.
 * Each renderer accepts only the required artifact paths for its role and
 * fails fast when any required path is missing. Prompts stay path-based and
 * schema-grounded rather than embedding raw artifact content.
 */
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import type { AdversarialDepth } from "../riskSignal.js";
import { loaderCommand } from "./prompts.js";

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
  "source_type": "conversation | document | structured_audit | mixed"
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
  "context_summary": "<free-text summary>"
}`,
    description:
      "Collect the code and documentation context relevant to the goal.",
  },
  decomposition: {
    title: "Module Decomposition",
    requiredInputKeys: ["goal_spec", "context_bundle"],
    outputKey: "module_decomposition",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
  "goal_id": "<from goal_spec>",
  "modules": [{
    "name": "<module-name>",
    "responsibilities": "<brief description of what this module does>",
    "file_scope": ["<repo-relative paths owned by this module>"]
  }]
}`,
    description:
      "Decompose the goal into a set of named modules with rough responsibilities and file scope. Do not draft seam contracts yet — only identify modules and their file ownership.",
  },
  module_contract_drafting: {
    title: "Per-Module Contract Drafting",
    requiredInputKeys: ["goal_spec", "context_bundle", "module_decomposition"],
    outputKey: "module_contracts",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/module-contracts/v1alpha1",
  "goal_id": "<from goal_spec>",
  "module_contracts": [{
    "name": "<module-name — must match module_decomposition>",
    "inputs": ["<what this module receives as input>"],
    "outputs": ["<what this module produces as output>"],
    "invariants": ["<invariant that must hold — include a verification_obligation note>"],
    "side_effects": ["<observable side-effects with owner>"],
    "validation_boundary": "<what this module validates vs. what callers must guarantee>",
    "failure_modes": ["<ways this module can fail and how callers should handle them>"],
    "neighbor_needs": [{
      "neighbor": "<module-name>",
      "needs": "<what this module needs from that neighbor>"
    }]
  }]
}`,
    description:
      "For every module in the decomposition, draft a contract covering inputs, outputs, invariants, side-effects, validation boundary, failure modes, and what it needs from each neighbor. Read each module's file scope from the repository before drafting. No single agent owns both sides of a seam.",
  },
  seam_reconciliation: {
    title: "Seam Reconciliation",
    requiredInputKeys: ["module_decomposition", "module_contracts"],
    outputKey: "seam_reconciliation_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
  "goal_id": "<from module_contracts>",
  "mismatches": [{
    "seam_id": "<seam-identifier>",
    "module_a": "<module-name>",
    "module_b": "<module-name>",
    "description": "<what A declares vs. what B declares — the mismatch>",
    "resolution": {
      "decision": "<which side adjusts — A | B | both>",
      "agreed_interface": "<the reconciled interface both sides must adopt>"
    }
  }]
}`,
    description:
      "Deterministically list every seam mismatch where module A's declared output differs from module B's declared input (or neighbor_need). For each mismatch, decide which side adjusts and what the agreed interface is. A seam_reconciliation_report with no mismatches (all seams already consistent) is valid.",
  },
  contract_finalization: {
    title: "Per-Module Contract Finalization",
    requiredInputKeys: ["module_contracts", "seam_reconciliation_report"],
    outputKey: "finalized_module_contracts",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
  "goal_id": "<from module_contracts>",
  "module_contracts": [{
    "name": "<module-name>",
    "inputs": ["<final — incorporating reconciliation decisions>"],
    "outputs": ["<final — incorporating reconciliation decisions>"],
    "invariants": ["<invariant id + description>"],
    "side_effects": ["<side-effect with owner>"],
    "validation_boundary": "<finalized validation boundary>",
    "failure_modes": ["<failure mode + caller handling>"],
    "seam_adjustments": ["<adjustments made per seam_reconciliation_report, if any>"]
  }]
}`,
    description:
      "For every module contract in module_contracts, incorporate any reconciliation decisions from seam_reconciliation_report and produce the finalized module contract. Record which seam adjustments were applied.",
  },
  cyclic_seam_resolution: {
    title: "Cyclic Seam Resolution",
    requiredInputKeys: ["obligation_ledger"],
    outputKey: "cyclic_seam_resolution",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
  "goal_id": "<from obligation_ledger>",
  "cycles": [{
    "members": ["<obligation-id>", "..."],
    "break_strategy": "mediator | single_authority",
    "resolution_description": "<what was changed and why>",
    "exception_registration": "<scoped exception name when single_authority, otherwise null>"
  }],
  "status": "no_cycles | resolved"
}`,
    description:
      "Detect and resolve circular interface-definition obligations in the obligation ledger. If no cycles exist, record status=no_cycles and an empty cycles array. For each detected cycle, choose a sanctioned break strategy (mediator module or single authority) and record the resolution. Verify mentally that the break does not re-introduce a cycle before writing the output.",
  },
  // NOTE: the obligation ledger is now DERIVED deterministically by the tool
  // (S1, `contractPipeline/derive.ts` → the `obligation_ledger` intercept in
  // `buildNextContractPipelineStep`), so this role is not dispatched on the
  // normal path. It is retained for the judge-repair path (a judge may target
  // `obligation_ledger`) and as the canonical shape documentation.
  obligation_ledger: {
    title: "Obligation Ledger",
    requiredInputKeys: ["goal_spec", "finalized_module_contracts"],
    outputKey: "obligation_ledger",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
  "goal_id": "<from goal_spec>",
  "obligations": [{
    "id": "<obligation-id>",
    "description": "<concrete obligation>",
    "kind": "invariant|behavioral|structural|test",
    "depends_on": [],
    "status": "pending"
  }]
}`,
    description:
      "Derive a bounded set of implementation obligations from the goal spec and finalized module contracts. Each invariant in the finalized module contracts yields an invariant obligation; each seam interface yields a test obligation. Derive obligations largely deterministically from the finalized contracts.",
  },
  critique: {
    title: "Conceptual Design Critique",
    requiredInputKeys: ["goal_spec", "finalized_module_contracts"],
    outputKey: "conceptual_design_critique",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
  "goal_id": "<from goal_spec>",
  "items": [{ "id": "<id>", "kind": "concern|alternative|suggestion", "description": "...", "severity": "blocking|advisory" }],
  "verdict": "approved | approved_with_concerns | rejected"
}`,
    description:
      "Provide philosophy/alternatives/directions critique of the finalized module contracts.",
  },
  test_validator_plan: {
    title: "Test and Validator Plan",
    requiredInputKeys: ["goal_spec", "obligation_ledger"],
    outputKey: "test_validator_plan",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
  "goal_id": "<from goal_spec>",
  "test_specs": [{
    "obligation_id": "<id from obligation_ledger>",
    "name": "<short test name>",
    "kind": "unit | integration | schema | invariant | e2e",
    "assertions": ["<concrete, falsifiable assertion>"],
    "inapplicable_claim": {
      "obligation_id": "<must match obligation_id above>",
      "reason": "<falsifiable reason checkable against the ledger>"
    }
  }]
}`,
    description:
      "Convert every obligation in the obligation ledger into a concrete test spec BEFORE any implementation begins. One TestSpec entry per obligation. A worker may flag a planned test inapplicable only by citing the specific obligation_id it disputes and providing a falsifiable reason that can be checked against the ledger — bare rationale is not sufficient. Do not invent obligations not present in the ledger.",
  },
  assessment: {
    title: "Contract Assessment",
    requiredInputKeys: ["goal_spec", "finalized_module_contracts", "obligation_ledger"],
    outputKey: "contract_assessment_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "findings": [{ "obligation_id": "<id>", "status": "satisfied|violated|uncertain", "evidence": ["..."], "rationale": "..." }],
  "verdict": "passed | failed | partial"
}`,
    description:
      "Assess whether the design spec satisfies all invariants and obligations.",
  },
  critic: {
    title: "Adversarial Critic (Counterexample Search)",
    requiredInputKeys: ["goal_spec", "finalized_module_contracts", "obligation_ledger", "contract_assessment_report"],
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
  }]
}`,
    description:
      "Adversarially attack the design: produce concrete counterexamples that falsify design invariants, obligations, or assessment claims. Each counterexample must name the claim it falsifies, concrete reproduction steps, and the obligation(s) it violates. Search hard for inputs, orderings, and edge states the design mishandles; an empty counterexamples array is only acceptable when you genuinely cannot falsify anything.",
  },
  judge: {
    title: "Adversarial Judge",
    requiredInputKeys: ["goal_spec", "finalized_module_contracts", "obligation_ledger", "contract_assessment_report", "counterexample"],
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
    "target": "finalized_module_contracts | obligation_ledger | contract_assessment_report",
    "instruction": "<bounded instruction for regenerating the target artifact>"
  }
}`,
    description:
      "Judge every counterexample from the critic: `accepted` (real flaw the contract must address), `out_of_scope` (outside the goal spec), `duplicate`, `invalid` (does not actually falsify the claim), or `residual_risk` (real but tolerable; recorded, not repaired). Verdict is `approved` only when no accepted counterexample demands a contract repair — then omit `repair_directive`. Otherwise verdict is `needs_repair` and `repair_directive` must name the single artifact whose regeneration addresses the accepted counterexamples.",
  },
  implementation_planning: {
    title: "Implementation Planning (DAG)",
    requiredInputKeys: ["goal_spec", "context_bundle", "finalized_module_contracts", "obligation_ledger", "contract_assessment_report", "counterexample", "judge_report"],
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
    "addressed_critique_items": ["<advisory conceptual-critique id this node honours, when applicable>"],
    "depends_on": ["<task-id>"],
    "verification_obligation_ids": ["<obligation_id>"],
    "targeted_commands": ["<command to verify>"],
    "status": "pending"
  }],
  "edges": [{ "from": "<id>", "to": "<id>", "kind": "dependency|verification" }]
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
  "overall_status": "passed|failed"
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
  /**
   * Path to the Path-A seed file when the intake source is a structured
   * audit-findings report. When present, goal_normalization and
   * context_collection prompts reference the seed so every pipeline node
   * traces back to an auditor finding.
   */
  pathASeedPath?: string;
  /**
   * Whether the host can dispatch independent sub-agents. Threaded from the
   * resolved `host_can_dispatch_subagents` handshake (NOT a manual flag). The
   * adversarial review phases ('critique' / 'critic') MANDATE an independent
   * sub-agent when true (an author marking their own homework misses gaps) and
   * degrade to an explicit inline-self-review instruction when false. Fail-safe:
   * when omitted, the mandate is rendered (a host that genuinely cannot dispatch
   * opts out explicitly), so the stronger guarantee is the default.
   */
  hostCanDispatchSubagents?: boolean;
  /**
   * Adversarial-depth dial (T1 slice 3), derived from the intake risk signal.
   * `light` (low-risk) renders critique/critic as an inline lightweight
   * self-check; `full` (the fail-safe default when omitted) renders the
   * independent-review mandate. Only affects the adversarial phases.
   */
  adversarialDepth?: AdversarialDepth;
}

/**
 * Phases whose value is adversarial independence — the reviewer must NOT be the
 * author of the design under review. Keyed strictly off phase identity:
 * 'critique' (conceptual design critique), 'critic' (counterexample search), and
 * 'judge' (adjudicates the critic's counterexamples — a judge who authored the
 * design systematically dismisses valid counterexamples against it, so the
 * adjudication is only worth anything from an independent reviewer; memory:
 * delegate the judge too). The 'assessment' phase is the author's OWN coverage
 * self-assessment (not an adversarial review of someone else's work), so it is
 * intentionally excluded.
 */
const INDEPENDENT_CRITIC_PHASES = new Set(["critique", "critic", "judge"]);

/**
 * Render the independent-dispatch directive for an adversarial review phase.
 *
 * Depth-gated (T1 slice 3): when `adversarialDepth` is `light` (a low-risk run),
 * the phase runs as a lightweight inline self-check — the floor, never skipped.
 * Otherwise (`full`, the fail-safe default) it MANDATES an independent sub-agent
 * when the host can dispatch, degrading to an explicit inline-self-review
 * instruction when it provably cannot. Empty for any non-adversarial phase.
 */
function renderIndependentCriticDirective(
  role: string,
  hostCanDispatchSubagents: boolean | undefined,
  adversarialDepth: AdversarialDepth | undefined,
): string {
  if (!INDEPENDENT_CRITIC_PHASES.has(role)) return "";
  // Light depth: a low-risk run earns the inline lightweight self-check. This is
  // the floor — proportionate, never zero. A genuine concern here is evidence
  // the change is harder than assessed → escalate to full independent review.
  if (adversarialDepth === "light") {
    return `\n## Adversarial Review — light inline self-check

The assessed risk for this change is low, so this adversarial phase runs as a **lightweight inline self-check** rather than a full independent review. Do a quick, honest adversarial pass yourself: scan the design for obvious gaps, contradictions, or unhandled cases and record any real concern you find. Keep it proportionate — this is a floor (never skipped), not an exhaustive independent counterexample search. If your self-check surfaces a genuine concern, treat that as evidence the change is harder than assessed and escalate to a full independent review.
`;
  }
  // Fail-safe default: undefined ⇒ mandate. A host that genuinely cannot
  // dispatch opts out by passing false explicitly.
  const mandate = hostCanDispatchSubagents !== false;
  if (mandate) {
    return `\n## Independent Review — MANDATORY

This is an adversarial review phase: its value comes from a reviewer who is **not** the author of the design under review. You MUST dispatch this review to a fresh, independent sub-agent — one that did NOT author the upstream contract artifacts and does not see the author's reasoning. An author grading their own work systematically misses the gaps this phase exists to catch. Do NOT perform this review inline yourself.
`;
  }
  return `\n## Independent Review — degraded to inline self-review

This host reported it cannot dispatch an independent sub-agent, so this adversarial review runs inline. Compensate deliberately: adopt a fresh adversarial stance, set aside the author's reasoning, and attack the design as a hostile outside reviewer would. (When sub-agent dispatch is available this review is MANDATED to an independent agent — inline self-review is the degraded fallback, not the intended path.)
`;
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

  // Path-A seed section: included for goal_normalization and context_collection
  // when the intake source is a structured audit-findings report.
  const PATH_A_SEED_ROLES = new Set([
    "goal_normalization",
    "context_collection",
    "decomposition",
    "module_contract_drafting",
  ]);
  const pathASeedSection =
    input.pathASeedPath && PATH_A_SEED_ROLES.has(input.role)
      ? `\n## Path-A Audit Seed\n\nThis run originates from a structured audit-findings report. The seed file below contains the findings summary and affected files — your output must frame the goal and context around these findings so every subsequent pipeline node traces to an auditor finding:\n\n- \`${input.pathASeedPath}\` (path_a_seed)\n`
      : "";

  const independentCriticDirective = renderIndependentCriticDirective(
    input.role,
    input.hostCanDispatchSubagents,
    input.adversarialDepth,
  );

  const prompt = `# ${role.title}

${role.description}
${cwdNote}${independentCriticDirective}
## Required Inputs
${inputSections.length > 0 ? inputSections.join("\n") : "_No artifact inputs required for this role._"}
${sourceSections}${pathASeedSection}
## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

\`${outputPath}\`

The output must conform to this JSON schema shape:

\`\`\`json
${role.outputSchema}
\`\`\`

Before advancing, you can self-check the output against its contract:

\`${loaderCommand(`validate-artifact --name ${role.outputKey} --file ${outputPath}`)}\`

A \`status: "ok"\` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.
`;

  return { prompt, outputPath, role };
}

/** Return the dependency order for pipeline phase progression. */
export const CONTRACT_PIPELINE_PHASE_ORDER: string[] = [
  "goal_normalization",
  "context_collection",
  "decomposition",
  "module_contract_drafting",
  "seam_reconciliation",
  "contract_finalization",
  "critique",
  "obligation_ledger",
  "cyclic_seam_resolution",
  "test_validator_plan",
  "assessment",
  "critic",
  "judge",
  "implementation_planning",
  "closing",
];

// ── Repair prompt ─────────────────────────────────────────────────────────────

export interface ContractRepairRenderInput {
  /** The contract artifact the judge ordered regenerated. */
  target: "finalized_module_contracts" | "obligation_ledger" | "contract_assessment_report";
  /** The judge's bounded regeneration instruction. */
  instruction: string;
  /** Resolved file paths for all contract-pipeline artifacts. */
  artifactPaths: Partial<Record<ContractPipelineArtifactName, string>>;
  /** Repository root path — passed to workers for cwd anchoring. */
  repoRoot?: string;
}

/** Schema shape per repair target, sourced from the producing role. */
const REPAIR_TARGET_SCHEMA: Record<ContractRepairRenderInput["target"], () => string> = {
  finalized_module_contracts: () => ROLES.contract_finalization.outputSchema,
  obligation_ledger: () => ROLES.obligation_ledger.outputSchema,
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
    "finalized_module_contracts",
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

