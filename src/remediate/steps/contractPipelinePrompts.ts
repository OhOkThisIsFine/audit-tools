// sites-pinned: tests/remediate/contract-pipeline-prompts.test.ts, tests/remediate/step-prompt-sketch-drift.test.ts, tests/remediate/contract-validation-gates.test.ts
/**
 * Bounded prompt renderers for each of the contract-pipeline roles.
 * Each renderer accepts only the required artifact paths for its role and
 * fails fast when any required path is missing. Prompts stay path-based and
 * schema-grounded rather than embedding raw artifact content.
 */
import { DEPENDENCY_MAP } from "../contractPipeline/artifactStore.js";
import { GOAL_ID_MAX_LENGTH } from "../contractPipeline/idRegistry.js";
import {
  ASSESSMENT_FINDING_STATUSES,
  ASSESSMENT_VERDICTS,
  CONTRACT_REPAIR_TARGETS_OFFERED,
  CONTEXT_ENTRY_KINDS,
  COUNTEREXAMPLE_CLASSIFICATIONS,
  CRITIQUE_ITEM_KINDS,
  CRITIQUE_ITEM_SEVERITIES,
  CRITIQUE_VERDICTS,
  GOAL_SOURCE_TYPES,
  IMPLEMENTATION_EDGE_KINDS,
  IMPLEMENTATION_NODE_STATUSES,
  JUDGE_VERDICTS,
  OBLIGATION_KINDS,
  OBLIGATION_STATUSES,
  SEAM_RESOLUTION_DECISIONS,
  TEST_SPEC_KINDS,
  sketchValues,
} from "../contractPipeline/sketchSource.js";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import type { AdversarialDepth } from "../riskSignal.js";
import { renderIndependentReviewMandate } from "audit-tools/shared";
import { loaderCommand } from "./prompts.js";

// ── Role definitions ──────────────────────────────────────────────────────────

interface ContractPipelineRole {
  /** Display title for the role step heading. */
  title: string;
  /**
   * Artifact path key that this role produces as output.
   *
   * This is also, transitively, its INPUT declaration: the required inputs are
   * read off `DEPENDENCY_MAP[outputKey]` at render time (see
   * `requiredInputKeysFor`), never re-listed here. One map decides both what
   * makes this artifact stale and what its prompt tells the worker to read, so a
   * hand-kept per-role list cannot drift out of agreement with the write map.
   */
  outputKey: ContractPipelineArtifactName;
  /** JSON schema / contract shape description for the output. */
  outputSchema: string;
  /** The role's task: what the worker writes, and nothing the tool does later. */
  description: string;
  /**
   * The rules the tool ENFORCES on this role's output, stated where the field is
   * written. The repair prompt for an artifact states the same rules (see
   * `REPAIR_TARGET_ROLE`), so a first write and a repair cannot be told
   * different things. Only rules a validator or gate refuses belong here.
   */
  fieldRules?: readonly string[];
  /**
   * Which repository files the worker may read beyond the listed inputs, as the
   * end of "You may also read repository files …". Absent: the worker reads the
   * listed files only. Present only for the roles whose output cannot be right
   * without the source: an unconditional "do not read source files" made a
   * careful worker guess where a module's logic lives.
   */
  repoReads?: string;
  /**
   * What the Path-A seed asks of THIS role. Absent: the role gets no seed
   * section. One sentence per role, because "frame the goal and context" is the
   * task of the first two roles only.
   */
  pathASeed?: string;
  /** Whether this phase requires independent review (not the author). Defaults to false. */
  isIndependentCritic?: boolean;
}

/**
 * The ONE statement of the `targeted_commands` rule. The tool executes each
 * entry verbatim through a shell, one invocation per entry; the rule is
 * single-sourced in `audit-tools/shared` (`commandLeavesDeclaredShape`), and
 * this text states it where the field is written. A worker that emitted
 * `npm run build && npm run check` on 23 nodes cost a whole DAG regeneration.
 */
const TARGETED_COMMANDS_RULE =
  "`targeted_commands`: one command per entry, run verbatim through a shell. Write `\"npm run build\"` and `\"npm run check\"` as two entries, never `\"npm run build && npm run check\"`. Do not use a pipe, a redirect, `;` or command substitution: the tool refuses those, and the whole DAG is written again.";

export const ROLES: Record<string, ContractPipelineRole> = {
  goal_normalization: {
    title: "Goal Normalization",
    outputKey: "goal_spec",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/goal-spec/v1alpha1",
  "goal_id": "<stable-identifier>",
  "objective": "<single-sentence primary objective>",
  "non_goals": ["<explicit out-of-scope items>"],
  "success_criteria": ["<measurable criteria>"],
  "source_type": "${sketchValues(GOAL_SOURCE_TYPES)}"
}`,
    description: "State the remediation objective as one bounded goal.",
    fieldRules: [
      `\`goal_id\` is kebab-case: a lowercase letter first, then lowercase letters, digits and single \`-\` separators, at most ${GOAL_ID_MAX_LENGTH} characters.`,
    ],
    pathASeed: "Frame the goal around these findings.",
  },
  context_collection: {
    title: "Context Collection",
    outputKey: "context_bundle",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/context-bundle/v1alpha1",
  "goal_id": "<from goal_spec>",
  "entries": [{ "path": "<repo-relative>", "kind": "${sketchValues(CONTEXT_ENTRY_KINDS)}", "relevance_reason": "..." }],
  "context_summary": "<free-text summary>"
}`,
    description:
      "Collect the code and documents that the goal touches. Give one reason for each entry.",
    fieldRules: ["Every `path` is relative to the repository root."],
    repoReads: "that are relevant to the goal",
    pathASeed: "Include every file these findings name.",
  },
  decomposition: {
    title: "Module Decomposition",
    outputKey: "module_decomposition",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
  "goal_id": "<from goal_spec>",
  "modules": [{
    "name": "<module-name>",
    "responsibilities": "<brief description of what this module does>",
    "file_scope": ["<repo-relative paths owned by this module>"],
    "source_work_block_ids": ["<audit work-block ids implemented by this module; [] outside Path A>"],
    "prepares_seam_ids": ["<required audit seam ids prepared by this module before parallel refactors; [] when none>"]
  }]
}`,
    description:
      "Split the goal into named modules. Give each module its responsibility and the files it owns. On Path A, map modules to work blocks with `source_work_block_ids`, and add one seam-preparation module for each seam in the seed where `requires_preparation` is true (one module may prepare several seams). Do not draft contracts.",
    fieldRules: [
      "Scope each module at the file that holds its logic, never at a file that only re-exports (`export * from …`, `export { x } from …`).",
      "Every `file_scope` path exists in the repository.",
      "A seam-preparation module lists the seams in `prepares_seam_ids`, and its `file_scope` includes each prepared seam's `file`.",
    ],
    repoReads: "to confirm where each module's logic lives",
    pathASeed: "Map every work block in the seed to a module.",
  },
  module_contract_drafting: {
    title: "Per-Module Contract Drafting",
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
      "Draft a contract for each module in the decomposition: inputs, outputs, invariants, side effects, validation boundary, failure modes, and what it needs from each neighbor.",
    fieldRules: [
      "Each `name` equals a module name in the decomposition.",
      "`inputs` and `outputs` are not empty.",
      "On Path A, each finding id in the seed appears in an invariant, a failure mode, an input or an output.",
    ],
    repoReads: "in each module's file scope",
    pathASeed: "Cover every finding id in the seed.",
  },
  seam_reconciliation: {
    title: "Seam Reconciliation",
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
      "decision": "<which side adjusts — ${sketchValues(SEAM_RESOLUTION_DECISIONS)}>",
      "agreed_interface": "<the reconciled interface both sides must adopt>"
    }
  }]
}`,
    description:
      "For each seam where one module's output differs from its neighbor's input or need, record the mismatch, which side adjusts, and the agreed interface. An empty `mismatches` list is correct when every seam agrees.",
    fieldRules: [
      "`module_a` and `module_b` are exact module names from the module contracts.",
    ],
  },
  contract_finalization: {
    title: "Per-Module Contract Finalization",
    outputKey: "finalized_module_contracts",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
  "goal_id": "<from module_contracts>",
  "module_contracts": [{
    "name": "<module-name>",
    "inputs": ["<final — incorporating reconciliation decisions; tag a shared artifact this module CONSUMES with an 'artifact:<name>' token>"],
    "outputs": ["<final — incorporating reconciliation decisions; tag a shared artifact this module PRODUCES with an 'artifact:<name>' token>"],
    "invariants": ["<invariant id + description>"],
    "side_effects": ["<side-effect with owner>"],
    "validation_boundary": "<finalized validation boundary>",
    "failure_modes": ["<failure mode + caller handling>"],
    "seam_adjustments": ["<adjustments made per seam_reconciliation_report, if any>"]
  }]
}`,
    description:
      "Apply each reconciliation decision and write the final contract for each module. Record the seam adjustments you applied. When one module produces something another consumes, tag it as `artifact:<name>` (for example `artifact:validated-roster`) in the producer's `outputs` and in the consumer's `inputs`: the tool orders the implementation from these tokens.",
    fieldRules: [
      "Keep the module set exactly: one contract for each module in `module_contracts`, and no other.",
      "`inputs` and `outputs` are not empty.",
      "Do not add `depends_on`.",
    ],
  },
  // Repair only: the tool derives the obligation ledger itself
  // (`contractPipeline/derive.ts`), so this role reaches a worker only as the
  // target of a judge repair. The text states that derivation, because a
  // repaired ledger passes the same gates as a derived one.
  obligation_ledger: {
    title: "Obligation Ledger",
    outputKey: "obligation_ledger",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
  "goal_id": "<from goal_spec>",
  "obligations": [{
    "id": "OBL-<module-slug>-<suffix>",
    "description": "<concrete obligation>",
    "kind": "${sketchValues(OBLIGATION_KINDS)}",
    "depends_on": [],
    "status": "${sketchValues(OBLIGATION_STATUSES)}",
    "module": "<module-name>",
    "change_classification": "<keep the value from the current ledger>",
    "source_finding_ids": ["<audit finding id this obligation implements, when any>"]
  }]
}`,
    description: "Rewrite the obligation ledger from the finalized module contracts.",
    fieldRules: [
      "One `structural` obligation for each module, one `invariant` obligation for each module invariant, and one `behavioral` obligation for each module failure mode.",
      "Each id is `OBL-<module-slug>-<suffix>`. The suffix is `contract` for the structural obligation, `inv-<n>` for the n-th invariant and `fail-<n>` for the n-th failure mode. `<module-slug>` is the module name in lowercase, with each run of other characters replaced by one `-`.",
      "`module` is the module name. Keep each obligation's `change_classification` from the current ledger.",
      "Keep every audit finding id that the current ledger names, in `source_finding_ids` or in the description.",
    ],
  },
  critique: {
    title: "Conceptual Design Critique",
    outputKey: "conceptual_design_critique",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
  "goal_id": "<from goal_spec>",
  "items": [{ "id": "<id>", "kind": "${sketchValues(CRITIQUE_ITEM_KINDS)}", "description": "...", "severity": "${sketchValues(CRITIQUE_ITEM_SEVERITIES)}" }],
  "verdict": "${sketchValues(CRITIQUE_VERDICTS)}"
}`,
    description:
      "Critique the finalized module contracts: philosophy, alternatives, direction.",
    fieldRules: [
      "Mark an item `blocking` only when the finalized contracts must change and can express the change. Mark every other item `advisory`.",
    ],
    isIndependentCritic: true,
  },
  test_validator_plan: {
    title: "Test and Validator Plan",
    outputKey: "test_validator_plan",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
  "goal_id": "<from goal_spec>",
  "test_specs": [{
    "obligation_id": "<id from obligation_ledger>",
    "name": "<short test name>",
    "kind": "${sketchValues(TEST_SPEC_KINDS)}",
    "assertions": ["<concrete, falsifiable assertion>"],
    "inapplicable_claim": {
      "obligation_id": "<must match obligation_id above>",
      "reason": "<falsifiable reason checkable against the ledger>"
    }
  }]
}`,
    description:
      "Write one test spec for each invariant and behavioral obligation, before any implementation. To dispute an obligation, write an `inapplicable_claim` with a reason that the ledger can disprove. Do not invent obligations.",
    fieldRules: [
      "A spec for a behavior change has at least one positive (success-path) assertion and one negative (failure-path) assertion. The negative assertion names the changed symbol or file, not the whole repository. An obligation classified as an addition needs one assertion of either kind.",
      "A disputed spec has only `obligation_id`, `name` and `inapplicable_claim`, and the claim's `obligation_id` equals the spec's.",
    ],
  },
  assessment: {
    title: "Contract Assessment",
    outputKey: "contract_assessment_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "findings": [{ "obligation_id": "<id>", "status": "${sketchValues(ASSESSMENT_FINDING_STATUSES)}", "evidence": ["..."], "rationale": "..." }],
  "verdict": "${sketchValues(ASSESSMENT_VERDICTS)}"
}`,
    description:
      "For each obligation, state whether the design satisfies it, with evidence.",
    fieldRules: ["A `violated` finding lists at least one evidence entry."],
  },
  critic: {
    title: "Adversarial Critic (Counterexample Search)",
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
    isIndependentCritic: true,
  },
  judge: {
    title: "Adversarial Judge",
    outputKey: "judge_report",
    outputSchema: `{
  "contract_version": "remediate-code-contract-pipeline/judge-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "verdict": "${sketchValues(JUDGE_VERDICTS)}",
  "classifications": [{
    "counterexample_id": "<id from the counterexample report>",
    "classification": "${sketchValues(COUNTEREXAMPLE_CLASSIFICATIONS)}",
    "rationale": "<one-line justification>"
  }],
  "repair_directive": {
    "target": "${sketchValues(CONTRACT_REPAIR_TARGETS_OFFERED)}",
    "instruction": "<bounded instruction for regenerating the target artifact>"
  }
}`,
    description:
      "Judge every counterexample from the critic: `accepted` (a real flaw the contract must address), `out_of_scope` (outside the goal spec), `duplicate`, `invalid` (does not falsify the claim), or `residual_risk` (real but tolerable; recorded, not repaired). The verdict is `approved` only when no accepted counterexample needs a contract repair; then omit `repair_directive`. Otherwise the verdict is `needs_repair`, and `repair_directive` names the one artifact whose rewrite addresses the accepted counterexamples.",
    fieldRules: [
      `\`repair_directive.target\` is one of ${CONTRACT_REPAIR_TARGETS_OFFERED.map((t) => `\`${t}\``).join(", ")}.`,
      "A repair must be expressible in the target's own schema. For `finalized_module_contracts`, that is the seven interface fields, prose `seam_adjustments`, and implementation order only as `artifact:<name>` tokens in `inputs` and `outputs`, with the module set kept. A counterexample whose remedy needs anything else (a new schema field, a new module, structured per-block data) is `residual_risk`, not `accepted`.",
    ],
    isIndependentCritic: true,
  },
  implementation_planning: {
    title: "Implementation Planning (DAG)",
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
    "output_files": ["<EVERY file this node creates or edits — the tests it must write, the source a generated artifact mirrors, new shared modules, manifests>"],
    "verification_obligation_ids": ["<obligation_id>"],
    "targeted_commands": ["<command to verify>"],
    "status": "${sketchValues(IMPLEMENTATION_NODE_STATUSES)}"
  }],
  "edges": [{ "from": "<id>", "to": "<id>", "kind": "${sketchValues(IMPLEMENTATION_EDGE_KINDS)}" }]
}`,
    description: "Split the implementation into a dependency DAG of bounded tasks.",
    fieldRules: [
      "Every node lists at least one obligation id (in `satisfies_obligations` or `verification_obligation_ids`) or one accepted counterexample id (in `addresses_counterexamples`).",
      "Every accepted counterexample that is not waived is in some node's `addresses_counterexamples`.",
      "`output_files` lists every file the node creates or edits: the tests it writes, the sources a generated artifact mirrors, new shared modules and manifests. Each file is in a directory that exists.",
      TARGETED_COMMANDS_RULE,
    ],
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
   * audit-findings report. When present, each role with a `pathASeed` sentence
   * lists the seed and says what that role must do with it.
   */
  pathASeedPath?: string;
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
 * author of the design under review. Derived from ROLES' isIndependentCritic flag
 * so the set is always in sync with the phase definitions and never hand-maintained.
 *
 * Currently includes 'critique' (conceptual design critique), 'critic' (counterexample search), and
 * 'judge' (adjudicates the critic's counterexamples — a judge who authored the
 * design systematically dismisses valid counterexamples against it, so the
 * adjudication is only worth anything from an independent reviewer; memory:
 * delegate the judge too). The 'assessment' phase is the author's OWN coverage
 * self-assessment (not an adversarial review of someone else's work), so it is
 * intentionally excluded (isIndependentCritic is not set).
 */
function getIndependentCriticPhases(): Set<string> {
  const phases = new Set<string>();
  for (const [roleName, role] of Object.entries(ROLES)) {
    if (role.isIndependentCritic) {
      phases.add(roleName);
    }
  }
  return phases;
}

const INDEPENDENT_CRITIC_PHASES = getIndependentCriticPhases();

/**
 * Render the independent-review directive for an adversarial review phase.
 *
 * Depth-gated (T1 slice 3): when `adversarialDepth` is `light` (a low-risk run),
 * the phase runs as a lightweight inline self-check — the floor, never skipped.
 * Otherwise (`full`, the fail-safe default) it requires an INDEPENDENT CONTEXT
 * (no shared authorship), degrading to an explicit inline-self-review
 * instruction the host can honestly take. Empty for any non-adversarial phase.
 *
 * The mandate text itself is single-sourced in `audit-tools/shared`
 * (`renderIndependentReviewMandate`) and states the NEED, not a mechanism —
 * read that function's header before rewording anything here.
 */
function renderIndependentCriticDirective(
  role: string,
  adversarialDepth: AdversarialDepth | undefined,
): string {
  if (!INDEPENDENT_CRITIC_PHASES.has(role)) return "";
  // LANE-CLASS-conditional, never capability-conditional (design resolution 2,
  // gate-resolved 2026-08-05): the shared mandate text carries both the
  // independent-context requirement and the explicitly-degraded fallback in one
  // capability-neutral form. Depth stays a policy axis: light (low-risk floor)
  // keeps its proportionate inline self-check.
  return renderIndependentReviewMandate(
    adversarialDepth === "light" ? "light" : "full",
  );
}

/**
 * The `## Field Rules` section, or nothing when a role has no enforced rule.
 * The worker prompt and the repair prompt both render it, from the same role.
 */
function renderFieldRules(rules: readonly string[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  return `\n## Field Rules\n\n${rules.map((rule) => `- ${rule}`).join("\n")}\n`;
}

/** The self-check block both prompts end with. */
function renderSelfCheck(
  outputKey: ContractPipelineArtifactName,
  outputPath: string,
  repoRoot: string | undefined,
): string {
  return `
Check the file before you stop:

\`${loaderCommand(
    `validate-artifact --name ${outputKey} --file ${outputPath}${repoRoot ? ` --root ${repoRoot}` : ""}`,
  )}\`

\`status: "ok"\` means the file is admissible. Otherwise, fix each problem it names.
`;
}

function renderCwdNote(repoRoot: string | undefined): string {
  return repoRoot
    ? `\n> Set the shell/tool working directory to \`${repoRoot}\` before running any commands.\n`
    : "";
}

export interface ContractPipelineRenderResult {
  prompt: string;
  outputPath: string;
  role: ContractPipelineRole;
}

/**
 * The artifacts a role must read, DERIVED from the artifact store's dependency
 * DAG rather than re-declared per role.
 *
 * `DEPENDENCY_MAP[outputKey]` is already the authoritative statement of what
 * this artifact is built from — it is what re-stales the artifact when an
 * upstream changes, and (with `writeDerivedContractArtifact`) every entry in it
 * is a file some producer actually wrote. Reading the prompt's input list off
 * the same map means the two can never disagree: a prompt cannot name an input
 * nothing produces, and a new dependency cannot be added to the DAG while the
 * prompt still withholds it from the worker.
 */
function requiredInputKeysFor(
  role: ContractPipelineRole,
): readonly ContractPipelineArtifactName[] {
  return DEPENDENCY_MAP[role.outputKey];
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
  const requiredInputKeys = requiredInputKeysFor(role);

  // Validate required inputs.
  for (const key of requiredInputKeys) {
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

  const inputSections = requiredInputKeys.map((key) => {
    const path = input.artifactPaths[key]!;
    return `- \`${path}\` (${key})`;
  });

  const sourceSections =
    input.sourcePaths && input.sourcePaths.length > 0
      ? `\n## Source Inputs\n\n${input.sourcePaths.map((p) => `- \`${p}\``).join("\n")}\n`
      : "";

  const pathASeedSection =
    input.pathASeedPath && role.pathASeed
      ? `\n## Path-A Audit Seed\n\n- \`${input.pathASeedPath}\` (path_a_seed) — ${role.pathASeed}\n`
      : "";

  const readScope = role.repoReads
    ? `Read the files above. You may also read repository files ${role.repoReads}.`
    : "Read the files above. Do not read other files.";

  const independentCriticDirective = renderIndependentCriticDirective(
    input.role,
    input.adversarialDepth,
  );

  const prompt = `# ${role.title}

${role.description}
${renderCwdNote(input.repoRoot)}${independentCriticDirective}
## Required Inputs
${inputSections.length > 0 ? inputSections.join("\n") : "_No artifact inputs required for this role._"}
${sourceSections}${pathASeedSection}
## What You May Read

${readScope}

## Your Task

Write the complete artifact to exactly:

\`${outputPath}\`

It must have this JSON shape:

\`\`\`json
${role.outputSchema}
\`\`\`
${renderFieldRules(role.fieldRules)}${renderSelfCheck(role.outputKey, outputPath, input.repoRoot)}
**Stop after you write the output file.** Do not edit source files. Do not start the next phase.
`;

  return { prompt, outputPath, role };
}

/**
 * Phase → artifact name mapping. SINGLE SOURCE OF TRUTH for both the phase set
 * and the phase progression order (object insertion order is the dependency
 * order). `CONTRACT_PIPELINE_PHASE_ORDER` and contractPipeline.ts's
 * `ARTIFACT_TO_PHASE` both derive from this — never re-list the phases.
 *
 * `cyclic_seam_resolution` has no entry in `ROLES`: its one prompt is rendered
 * by the gate that owns the phase (`renderCyclicSeamResolutionPrompt` in
 * `contractPipeline.ts`), because it needs the detected cycles. There is no
 * `closing` phase: the close phase writes the verification report itself.
 */
export const PHASE_TO_ARTIFACT: Record<string, ContractPipelineArtifactName> = {
  goal_normalization: "goal_spec",
  context_collection: "context_bundle",
  decomposition: "module_decomposition",
  module_contract_drafting: "module_contracts",
  seam_reconciliation: "seam_reconciliation_report",
  contract_finalization: "finalized_module_contracts",
  critique: "conceptual_design_critique",
  obligation_ledger: "obligation_ledger",
  cyclic_seam_resolution: "cyclic_seam_resolution",
  test_validator_plan: "test_validator_plan",
  assessment: "contract_assessment_report",
  critic: "counterexample",
  judge: "judge_report",
  implementation_planning: "implementation_dag",
};

/**
 * Dependency order for pipeline phase progression — derived from
 * PHASE_TO_ARTIFACT's insertion order so the phase list lives in exactly one
 * place (single-source; no drift between the mapping and the order).
 */
export const CONTRACT_PIPELINE_PHASE_ORDER: string[] = Object.keys(PHASE_TO_ARTIFACT);

// ── Repair prompt ─────────────────────────────────────────────────────────────

/**
 * Which gate ordered this repair. The two are NOT interchangeable: they run at
 * different points, they are handed different artifacts, and a worker told the
 * wrong one goes looking for inputs that were never produced.
 */
export type ContractRepairTrigger = "judge" | "critique";

export interface ContractRepairRenderInput {
  /** Which gate ordered the repair — selects the framing and the input set. */
  trigger: ContractRepairTrigger;
  /** The contract artifact the gate ordered regenerated. */
  target: "finalized_module_contracts" | "obligation_ledger" | "contract_assessment_report";
  /** The gate's bounded regeneration instruction. */
  instruction: string;
  /** Resolved file paths for all contract-pipeline artifacts. */
  artifactPaths: Partial<Record<ContractPipelineArtifactName, string>>;
  /** Repository root path — passed to workers for cwd anchoring. */
  repoRoot?: string;
}

/**
 * Per-trigger prompt contract, as DECLARED DATA rather than a branch in the
 * renderer, so a third trigger cannot be added without stating its framing and
 * its inputs.
 *
 * The defect this closes (observed live 2026-08-22 on the first-draw remediation
 * run, `Contract Repair: finalized_module_contracts`): the renderer had ONE
 * hard-coded framing and ONE hard-coded six-artifact input list, so a repair
 * ordered by the CONCEPTUAL-CRITIQUE gate told the worker "the adversarial judge
 * rejected the current contract" and listed `obligation_ledger`,
 * `contract_assessment_report`, `counterexample` and `judge_report` as Required
 * Inputs. On that trigger those four do not exist on disk. The worker burned
 * turns hunting inputs the tool never bound.
 *
 * ⚠ The old existence check could not catch it and was never going to: it tested
 * whether a PATH STRING was present in `artifactPaths`, and that record is
 * populated for every `CP_ARTIFACT_NAMES` entry unconditionally
 * (`contractPipeline.ts`), with no disk check. So it never threw in production —
 * it silently rendered paths to files that were not there, which is worse than a
 * refusal. Checking only the trigger's own set is what makes the guard mean
 * something.
 */
const REPAIR_TRIGGER_CONTRACT: Record<
  ContractRepairTrigger,
  {
    /** Opening sentence, which must name the gate that actually fired. */
    lead: (target: ContractRepairRenderInput["target"]) => string;
    /** Heading above the gate's own instruction. */
    instructionHeading: string;
    /** The artifacts this trigger genuinely binds — nothing else is listed. */
    requiredInputs: readonly ContractPipelineArtifactName[];
    /** What to attend to while reading the inputs above. */
    readingNote: string;
  }
> = {
  judge: {
    lead: (target) =>
      `The adversarial judge rejected the current contract. Rewrite \`${target}\` in full so that it addresses every accepted counterexample.`,
    instructionHeading: "Judge Instruction",
    requiredInputs: [
      "goal_spec",
      "finalized_module_contracts",
      "obligation_ledger",
      "contract_assessment_report",
      "counterexample",
      "judge_report",
    ],
    readingNote: "the accepted counterexamples in the judge report's classifications",
  },
  critique: {
    lead: (target) =>
      `The conceptual design critique raised blocking concerns. Rewrite \`${target}\` in full so that no blocking concern still applies.`,
    instructionHeading: "Blocking Concerns",
    // The critique gate runs BEFORE any downstream artifact is derived, so the
    // judge-side artifacts do not exist yet. Listing them is what sent workers
    // hunting. These three are the whole of what this trigger binds.
    requiredInputs: [
      "goal_spec",
      "finalized_module_contracts",
      "conceptual_design_critique",
    ],
    readingNote: "each blocking concern in the conceptual design critique",
  },
};

/**
 * The role that first writes each repair target. The repair prompt renders
 * that role's sketch AND its field rules: a repaired artifact passes the same
 * validator and the same gates as a first write, so the two prompts state one
 * set of rules from one place.
 */
const REPAIR_TARGET_ROLE: Record<ContractRepairRenderInput["target"], ContractPipelineRole> = {
  finalized_module_contracts: ROLES.contract_finalization,
  obligation_ledger: ROLES.obligation_ledger,
  contract_assessment_report: ROLES.assessment,
};

/**
 * Render the bounded repair step for a failing gate: rewrite the named contract
 * artifact in full, addressing the gate's instruction. The worker edits only the
 * target; the pipeline brings every later artifact back on its own.
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
  const contract = REPAIR_TRIGGER_CONTRACT[input.trigger];
  const requiredInputs = contract.requiredInputs;
  for (const key of requiredInputs) {
    if (!input.artifactPaths[key]) {
      throw new Error(
        `Contract repair (${input.trigger}) requires artifact path for "${key}" but it was not provided.`,
      );
    }
  }
  const role = REPAIR_TARGET_ROLE[input.target];

  const prompt = `# Contract Repair: ${input.target}

${contract.lead(input.target)}
${renderCwdNote(input.repoRoot)}
## ${contract.instructionHeading}

${input.instruction}

## Required Inputs

${requiredInputs.map((key) => `- \`${input.artifactPaths[key]}\` (${key})`).join("\n")}

## Your Task

Read the inputs above. Attend to ${contract.readingNote}. Write the complete artifact, not a diff, to exactly:

\`${outputPath}\`

It must have this JSON shape:

\`\`\`json
${role.outputSchema}
\`\`\`
${renderFieldRules(role.fieldRules)}${renderSelfCheck(input.target, outputPath, input.repoRoot)}
**Stop after you write the output file.** Do not edit any other artifact or any source file. Do not start the next phase.
`;

  return { prompt, outputPath };
}
