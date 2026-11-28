// sites-pinned: tests/shared/prompt-capability.test.ts, tests/shared/prompt-renders-its-contract.test.ts, tests/remediate/adversarial-depth-dial.test.ts
import type { ReviewRequirement } from "../../shared/types/reviewIndependence.js";
import type { AdversarialDepth } from "../riskSignal.js";
import type { PlanReviewRole, PlanSource, CanonicalPlan, PlanReviewHistory } from "../contractPipeline/executionPlan.js";

export function reviewRequirementForRole(role: PlanReviewRole, depth?: AdversarialDepth): ReviewRequirement {
  return role === "judge" || depth !== "light" ? "independent" : "degraded_allowed";
}

export function renderPlanAuthorPrompt(params: {
  root: string; source: PlanSource; canonical?: CanonicalPlan; history: PlanReviewHistory;
  sourcePath: string; planPath: string; outputPath: string; reason?: string; graphHint?: string;
}): string {
  const findingIds = params.source.findings.map(f => f.id);
  return `# ${params.canonical ? "Revise" : "Author"} the executable change plan

Goal: make the agreed changes and demonstrate that they work. Plan cohesive implementation units, not a complete restatement of every module in the repository.
Read ${params.sourcePath}${params.canonical ? ` and ${params.planPath}` : ""}. Source finding identities and payloads are immutable provenance. You may inspect repository source/tests/configuration relevant to this request beneath ${params.root}. Inspect actual source before deciding the affected behavior and boundaries.
${params.graphHint ?? ""}
${params.reason ? `\nRequired corrections:\n${params.reason}\n` : ""}
${params.history.accepted_ids.length ? `Accepted counterexamples that must remain addressed:\n${JSON.stringify(params.history, null, 2)}` : ""}
${params.source.question_report ? params.source.request
  ? "This is mixed input. The approved canonical findings and the operator's separate request are distinct. Preserve finding provenance for work that addresses a finding; keep request-only work in separate units without a finding ID. Scope those units to the explicit request and present them for operator approval before execution. Do not import additional design work from report prose."
  : "This is structured-report-only input. Every unit with write scope must actually address an approved confirmed finding. Do not attach a finding ID just to make a separate design change eligible. If the operator wants that change, ask them to restate it as separate guidance for a new mixed run; report prose or topical relevance is not authorization."
  : ""}

Write ONLY ${params.outputPath}, with this shape:
${JSON.stringify({
    base_revision_sha256: params.canonical?.revision_sha256 ?? null,
    plan: {
      plan_id: params.source.plan_id,
      objective: "<agreed goal>", non_goals: [],
      requirements: [{ id: "REQ-stable-name", description: "<specific required behavior>", source_finding_ids: findingIds, change_kind: "behavior_change", assertions: [
        { kind: "positive", description: "<falsifiable success case>", scope_paths: ["<affected source/test>"] },
        { kind: "negative", description: "<falsifiable failure/regression case>", scope_paths: ["<affected source/test>"] },
      ] }],
      units: [{ id: "UNIT-stable-name", title: "<cohesive change>", description: "<exact implementation intent>", source_finding_ids: findingIds, requirement_ids: ["REQ-stable-name"], dependencies: [], read_paths: ["<existing source/test>"], allowed_files: ["<every source/test/config file to edit or create>"], required_tests: ["<one executable command per entry>"], affected_interfaces: [], addresses_counterexample_ids: params.history.accepted_ids }],
      source_dispositions: [],
    },
    retired_requirements: [],
  }, null, 2)}

Stable IDs identify requirements and units, not array positions. Preserve existing IDs when unrelated work is inserted/reordered. To remove a requirement, supply retired_requirements: [{id,reason,replaced_by:[]}]. This is a complete semantic revision, not patch operations. Never change or remove a previously accepted execution unit; add an explicit follow-up unit instead.

For question-report findings, keep every original source and its verification obligations attached to the approved canonical finding. Plan each original assertion with its exact expected text, all referenced scope paths and source_obligation:{finding_id,obligation_id}; add separate regression assertions as needed. Identify actual dependencies and integration checks; the close step reruns each required analyzer separately. An opportunity, lead, or unresolved question is context, not permission to implement it. For a canonical finding presented as a \`Design option:\`, do not assume the present behavior is broken. Carry forward the option and its tradeoff to the existing plan decision. If the operator has authorized the change, define the chosen endpoint and prove that required behavior survives; otherwise propose a \`deferred\` disposition with the local evidence and the choice still open. Do not label an unchosen or deferred option \`refuted\` unless the evidence actually refutes its premise.

Each source finding must be covered by execution units OR one source_dispositions entry {finding_id,status:"already_fixed"|"refuted"|"deferred",reason,evidence:[...]}. Evidence must explain the actual source/test basis; these decisions are independently reviewed. Do not invent tasks for an already-fixed or empty scope. Requirements and units may both be empty when no implementation is appropriate. A conversation request with no units must carry request_disposition:{status:"already_satisfied"|"deferred",reason,evidence:[...]}; an objective alone is not a completion claim.

Behavior changes need scoped positive and negative assertions; additions need at least one. Structural requirements still need an executable verification command or an explicit inapplicable_reason for independent assessment. An inapplicable requirement carries no assertions. Keep source and tests together. List actual dependencies explicitly; no module-token or separate obligation graph is authored. affected_interfaces is only for boundaries changed or endangered by this work, not every module interface.

Choose focused required_tests for each unit. Leave repository-wide verification to the final check and declared landing gates to the merged-tree close. If a broad check is indispensable for a particular unit, explain what only it can verify instead of repeating it by default. Do not omit required evidence to save time.

Every planned command is one invocation, with no shell chaining, redirects or substitutions. Directory write grants end in /. Source-level write scope is enforced against the resulting change. No changes, commits, or implementation yet.
`;
}

export function renderPlanReviewPrompt(params: {
  role: PlanReviewRole; root: string; sourcePath: string; planPath: string;
  canonical: CanonicalPlan; history: PlanReviewHistory; priorReviewPaths: string[];
  requirement: ReviewRequirement;
  requiredCounterexampleIds: ReadonlySet<string>;
  graphHint?: string;
}): string {
  const tasks = {
    critique: `Assess whether this is the right approach to the user's goal: scope, simpler alternatives, affected boundaries, ownership, and execution partition. Check whether keeping the current design, simplifying, replacing, or deleting better serves the agreed goal. For consequential choices, assess concrete costs and benefits against the current design and verify what actual callers and requirements must survive. Separate optional improvements from the chosen plan and explain rejection on evidence rather than treating alternatives as defects. Do not require whole-module documentation where no boundary changes. Return {verdict:"approved"|"needs_repair",issues:[{id,description,requirement_ids:[],unit_ids:[],blocking:true|false}]}.`,
    critic: `Try to falsify the plan's behavior, integration assumptions, and acceptance assertions. Inspect cited source/tests. Return {counterexamples:[{id,claim,reproduction_steps:[...],expected,actual,requirement_ids:[],unit_ids:[]}]}. Use stable IDs for repeated counterexamples; an empty list is permitted only after a real search.`,
    judge: `Independently judge every current or previously accepted counterexample, and assess every requirement and source disposition against concrete evidence. Return {verdict:"approved"|"needs_repair",classifications:[{counterexample_id,classification:"accepted"|"repaired"|"invalid"|"out_of_scope"|"duplicate"|"residual_risk",rationale}],requirement_assessments:[{requirement_id,verdict:"satisfied"|"insufficient",evidence:[...]}],disposition_assessments:[{finding_id,verdict:"satisfied"|"insufficient",evidence:[...]}]}. Approved means every requirement/disposition is sufficient and no accepted counterexample remains. For an empty request, include request_disposition_assessment:{verdict:"satisfied"|"insufficient",evidence:[...]}. Use repaired only with concrete evidence that the plan now addresses a previously accepted counterexample. A claimed repair must actually address the counterexample; merely listing its ID is not proof.`,
  };
  const scope = [...new Set(params.canonical.plan.units.flatMap(unit => [...unit.read_paths, ...unit.allowed_files]))];
  const counterexamples = params.role === "judge"
    ? `Required counterexample classification IDs: ${JSON.stringify([...params.requiredCounterexampleIds])}.
${params.requiredCounterexampleIds.size ? "Classify exactly these IDs once each." : "No IDs are required; return classifications: []."}
Active counterexamples carried from earlier reviews: ${JSON.stringify(params.history.counterexamples.filter(entry => params.requiredCounterexampleIds.has(entry.id)))}.
Historical counterexamples (reference only; do not classify): ${JSON.stringify(params.history.counterexamples.filter(entry => !params.requiredCounterexampleIds.has(entry.id)))}.`
    : `Historical counterexamples: ${JSON.stringify(params.history.counterexamples)}.`;
  return `# Executable plan ${params.role}

${tasks[params.role]}

Read the source record ${params.sourcePath}, canonical plan ${params.planPath}, and prior review records ${params.priorReviewPaths.join(", ") || "(none)"}.
You may inspect the affected repository files and their immediate callers/tests beneath ${params.root}; initial evidence scope: ${JSON.stringify(scope)}. File paths in the supplied records are evidence references you may follow within that repository. Do not edit repository source or the canonical plan.
${params.graphHint ?? ""}

Review the exact executable units, not a future planner's interpretation. Revision: ${params.canonical.revision_sha256}.
${counterexamples}
Review requirement: ${params.requirement}. ${params.requirement === "independent" ? "Use an independent context that did not author this plan and cannot see its author's reasoning. Unavailable independence must be declared; it cannot be replaced with self-review." : "A declared lightweight self-review is allowed for this low-risk lane."}
Independence is a host declaration; binding does not prove reviewer identity.
`;
}
