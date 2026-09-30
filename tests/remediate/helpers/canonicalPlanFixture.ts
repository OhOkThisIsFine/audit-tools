import { contentSha256 } from "../../../src/shared/submission/hostHandoffCore.js";
import type { RemediationPlan, ExecutionUnit, RemediationItemState, Finding } from "../../../src/remediate/state/types.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../../src/remediate/state/store.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readOptionalJsonFile } from "../../../src/shared/io/json.js";
import { ExecutableChangePlanSchema } from "../../../src/shared/types/executionPlan.js";
import { captureExecutionContext, executionPlanPaths, executionPlanRevision, readExecutionIntent, type PlanSource, type CanonicalPlan } from "../../../src/remediate/contractPipeline/executionPlan.js";

/** Explicit test-only reviewed semantic plan. Never used for accepting real authored input. */
export function canonicalPlanFixture(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
  const semantic = {
    plan_id: "PLAN-test", objective: "Exercise the production runtime contract", non_goals: [],
    findings: [], requirements: [], units: [], source_dispositions: [], review_counterexamples: [],
    project_type: "unknown", candidate_closing_actions: [], ...overrides,
  };
  return { ...semantic, review_revision_sha256: overrides.review_revision_sha256 ?? contentSha256(semantic) };
}

export function canonicalUnitFixture(id: string, overrides: Partial<ExecutionUnit> = {}): ExecutionUnit {
  return {
    id, title: id, description: `Implement ${id}`, source_finding_ids: [],
    requirement_ids: [`REQ-${id}`], dependencies: [], read_paths: ["src/a.ts"],
    allowed_files: ["src/a.ts"], required_tests: [], affected_interfaces: [],
    addresses_counterexample_ids: [], ...overrides,
  };
}

/** Deliberate test approval boundary. Call again only when a test intentionally renews approval. */
export async function writeApprovedPlanFixture(artifactsDir: string, state: RemediationState, contextOrRoot?: CanonicalPlan["context_files"] | string): Promise<void> {
  if (!state.plan) throw new Error("A fixture approval requires a runtime plan");
  const plan = ExecutableChangePlanSchema.strip().parse(state.plan);
  const inferredRoot = basename(artifactsDir) === "remediation" && basename(dirname(artifactsDir)) === ".audit-tools"
    ? dirname(dirname(artifactsDir)) : undefined;
  const root = typeof contextOrRoot === "string" ? contextOrRoot : inferredRoot;
  if (!Array.isArray(contextOrRoot) && !root) throw new Error("Approval fixture needs an explicit repository root for a noncanonical artifact layout");
  const contextFiles = Array.isArray(contextOrRoot) ? contextOrRoot : await captureExecutionContext(root!, plan);
  const intent = await readExecutionIntent(artifactsDir);
  const source: PlanSource = {
    plan_id: plan.plan_id, findings: state.plan.findings,
    ...(state.plan.request ? { request: state.plan.request } : {}),
    audit_read: state.plan.audit_read ?? null, sources: [],
    ...(intent ? { intent } : {}),
  };
  const sourceSha = contentSha256(source);
  const revision = executionPlanRevision(plan, sourceSha, contextFiles);
  state.plan.review_revision_sha256 = revision;
  const paths = executionPlanPaths(artifactsDir);
  await mkdir(paths.directory, { recursive: true });
  const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  await put(paths.source, source);
  await put(paths.canonical, { contract_version: "remediate-code-executable-plan/v1", revision_sha256: revision, source_sha256: sourceSha, context_files: contextFiles, plan });
  const history = { counterexamples: state.plan.review_counterexamples, accepted_ids: [], repair_rounds: 0 };
  await put(paths.history, history);
  const input = contentSha256({ fixture_review: revision });
  const reviewDigests: Record<string, string> = {};
  for (const role of ["critique", "critic", "judge"] as const) {
    const result = role === "critic" ? { counterexamples: [] } : role === "critique" ? { verdict: "approved", issues: [] } : {
      verdict: "approved", classifications: state.plan.review_counterexamples.map(example => ({ counterexample_id: example.id, classification: "repaired", rationale: "The fixture plan explicitly addresses this historical counterexample" })),
      requirement_assessments: plan.requirements.map(requirement => ({ requirement_id: requirement.id, verdict: "satisfied", evidence: ["Explicit test fixture approval"] })),
      disposition_assessments: plan.source_dispositions.map(disposition => ({ finding_id: disposition.finding_id, verdict: "satisfied", evidence: ["Explicit test fixture approval"] })),
      ...(plan.request_disposition ? { request_disposition_assessment: { verdict: "satisfied", evidence: ["Explicit test fixture approval"] } } : {}),
    };
    const receipt = {
      revision_sha256: revision, role, input_sha256: input,
      provenance: { requirement: "independent", prompt_sha256: input, review: { mode: "independent", reason: "Explicit independent-review fixture" }, reviewed_content_hash: revision },
      result,
    };
    reviewDigests[role] = contentSha256(receipt);
    await put(paths.review(role).accepted, receipt);
  }
  const owner = await readOptionalJsonFile<unknown>(join(paths.directory, "owner-decision.json"));
  const risk = await readOptionalJsonFile<unknown>(join(paths.directory, "risk-decisions.json"));
  await put(paths.approval, { revision_sha256: revision, judge_input_sha256: input,
    owner_decision_sha256: contentSha256(owner ?? null), risk_decision_sha256: contentSha256(risk ?? null),
    history_sha256: contentSha256(history), review_sha256: reviewDigests,
  });
}

/** Historical fixture projection. Real production code has no legacy-shape adapter. */
export function canonicalStateFromLegacyFixture(value: {
  status: RemediationState["status"];
  plan?: { plan_id: string; findings: Finding[]; blocks: Array<{
    block_id: string; items: string[]; touched_files: string[]; dependencies?: string[];
    targeted_commands?: string[]; [key: string]: unknown;
  }>; [key: string]: unknown };
  items?: Record<string, { finding_id: string; block_id: string; status: RemediationItemState["status"]; [key: string]: unknown }>;
  [key: string]: unknown;
}): RemediationState {
  if (!value.plan) return { ...value, contract_version: REMEDIATION_STATE_CONTRACT_VERSION } as RemediationState;
  const { blocks, block_strategy: _retiredStrategy, ...oldPlan } = value.plan;
  const units = blocks.map(block => canonicalUnitFixture(block.block_id, {
    title: block.items.map(id => oldPlan.findings.find(finding => finding.id === id)?.title ?? id).join("; ") || block.block_id,
    description: block.items.map(id => oldPlan.findings.find(finding => finding.id === id)?.summary ?? id).join("\n") || `Implement ${block.block_id}`,
    source_finding_ids: [...block.items], dependencies: [...(block.dependencies ?? [])],
    ...(typeof block.phase_ordinal === "number" ? { phase_ordinal: block.phase_ordinal } : {}),
    allowed_files: [...block.touched_files], read_paths: block.touched_files.length ? [...block.touched_files] : ["README.md"],
    required_tests: [...(block.targeted_commands ?? [])],
  }));
  const requirements = units.map(unit => ({
    id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: [...unit.source_finding_ids],
    change_kind: "structural" as const, assertions: [], inapplicable_reason: "The fixture exercises runtime transport/lifecycle behavior",
  }));
  const items: Record<string, RemediationItemState> = {};
  for (const unit of units) {
    const historical = unit.source_finding_ids.map(id => value.items?.[id]).filter(entry => entry !== undefined);
    const statuses = new Set(historical.map(entry => entry.status));
    if (statuses.size > 1) throw new Error(`Migrate mixed-status unit ${unit.id} explicitly; the fixture adapter cannot merge lifecycle histories`);
    const { finding_id: _finding, block_id: _block, ...item } = historical[0] ?? { status: "pending", finding_id: "", block_id: "" };
    items[unit.id] = { ...item, status: item.status, unit_id: unit.id };
  }
  return { ...value, contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    plan: canonicalPlanFixture({ ...oldPlan, requirements, units }), items,
  } as RemediationState;
}
