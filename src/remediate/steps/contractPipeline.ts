// sites-pinned: tests/remediate/executable-plan-identity.test.ts, tests/remediate/executable-plan-safety.test.ts, tests/remediate/contract-review-independence.test.ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hashContent, stableStringify, readOptionalJsonFile, writeJsonFile, FindingSchema, AuditReadSchema } from "audit-tools/shared";
import { bindWorkerPrompt } from "../../shared/submission/workerPromptBinding.js";
import { parseReviewSubmissionEnvelope, reviewIndependenceIssue } from "../../shared/types/reviewIndependence.js";
import { readIntakeRiskSignal, adversarialDepthForTier, escalateRiskSignal, writeIntakeRiskSignal, decompositionRiskEvidence } from "../riskSignal.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import { loaderCommand } from "./prompts.js";
import { renderPlanAuthorPrompt, renderPlanReviewPrompt, reviewRequirementForRole } from "./contractPipelinePrompts.js";
import {
  executionPlanPaths, PlanSourceSchema, readPlanSource, readCanonicalPlan, ingestExecutionPlan,
  readPlanReviewHistory, readPlanReview, readApprovedExecutionPlan,
  CritiqueSchema, CriticSchema, PlanJudgeSchema, PlanRiskDecisionSchema, PLAN_REVIEW_ROLES, executionPlanContextIssues,
  PlanReviewReceiptSchema, readExecutionIntent, type PlanSource, type PlanReviewRole, type CanonicalPlan, type PlanReviewReceipt,
} from "../contractPipeline/executionPlan.js";

export { readApprovedExecutionPlan } from "../contractPipeline/executionPlan.js";

export interface ContractPipelineStepOptions {
  root: string; artifactsDir: string; runId: string; sourcePaths?: string[]; forceRevision?: boolean;
}

export async function resolveAdversarialDepth(artifactsDir: string) {
  let riskSignal = await readIntakeRiskSignal(artifactsDir);
  const canonical = await readCanonicalPlan(artifactsDir);
  if (riskSignal && canonical) {
    const files = [...new Set(canonical.plan.units.flatMap(unit => unit.allowed_files))];
    // The run's existing shared classifier remains the policy authority.
    const evidence = decompositionRiskEvidence({ moduleCount: canonical.plan.units.length, fileScopes: files });
    const raised = evidence ? escalateRiskSignal(riskSignal, evidence) : riskSignal;
    if (raised !== riskSignal) { riskSignal = raised; await writeIntakeRiskSignal(artifactsDir, raised); }
  }
  return { riskSignal, adversarialDepth: adversarialDepthForTier(riskSignal?.tier) };
}


async function sourceDigests(paths: readonly string[]): Promise<PlanSource["sources"]> {
  return Promise.all([...new Set(paths)].sort().map(async path => ({ path, sha256: hashContent(await readFile(path, "utf8")) })));
}

export async function writePathASeedFromFindings(artifactsDir: string, sourcePath: string, payload: unknown): Promise<void> {
  const raw = payload as { findings?: unknown[]; audit_read?: unknown };
  const findings = (raw.findings ?? []).map(finding => FindingSchema.parse(finding));
  const paths = executionPlanPaths(artifactsDir);
  const existing = await readPlanSource(artifactsDir);
  if (existing) {
    if (stableStringify(existing.findings) !== stableStringify(findings)) throw new Error("Approved source findings changed during this run; preserve the current run and explicitly start a new source selection.");
    return;
  }
  const audit = AuditReadSchema.safeParse(raw.audit_read);
  await writeJsonFile(paths.source, PlanSourceSchema.parse({
    plan_id: `plan-${randomUUID()}`, findings, audit_read: audit.success ? audit.data : null,
    sources: await sourceDigests([sourcePath]), intent: await readExecutionIntent(artifactsDir),
  }));
}


async function ensureSource(options: ContractPipelineStepOptions): Promise<PlanSource> {
  const existing = await readPlanSource(options.artifactsDir);
  if (existing) return existing;
  const sources = await sourceDigests(options.sourcePaths ?? []);
  const requestText = (await Promise.all(sources.map(source => readFile(source.path, "utf8")))).join("\n\n");
  const id = `plan-${randomUUID()}`;
  const source = PlanSourceSchema.parse({
    plan_id: id, findings: [], audit_read: null, sources, intent: await readExecutionIntent(options.artifactsDir),
    request: { id: `request-${randomUUID()}`, text: requestText || "Implement the operator's confirmed request.", source_paths: sources.map(entry => entry.path) },
  });
  await writeJsonFile(executionPlanPaths(options.artifactsDir).source, source);
  return source;
}

async function emit(options: ContractPipelineStepOptions, prompt: string, status: "ready" | "blocked" = "ready"): Promise<RemediationStep> {
  const paths = executionPlanPaths(options.artifactsDir);
  return writeCurrentStep({
    stepKind: "contract_pipeline", status, runId: options.runId, repoRoot: options.root,
    artifactsDir: options.artifactsDir,
    prompt: `${prompt}\n\nAfter writing the requested response, run \`${loaderCommand("next-step")}\`.`,
    allowedCommands: [loaderCommand("next-step")],
    stopCondition: "Complete only the bound planning/review assignment, then call next-step.",
    artifactPaths: { source: paths.source, execution_plan: paths.canonical, plan_submission: paths.submission },
  });
}

/**
 * The repair bound is spent for this review cycle. Nothing records an operator override of a reviewer's refusal (by design;
 * #14 removed waivers), so the step names the only working exits: a revised plan that is reviewed again, or cancelling the run.
 */
function repairBoundSpent(options: ContractPipelineStepOptions, review: string, kind: string, remaining: unknown): Promise<RemediationStep> {
  return emit(options, `${review} has not converged after eight repair decisions in this review cycle. There is no operator override of the reviewers' refusal. To continue, revise the plan so it addresses every one of these ${kind}, and write the complete revision to ${executionPlanPaths(options.artifactsDir).submission}; the revision is reviewed again. Otherwise the operator may cancel the run. Do not implement an unapproved plan.\n\nRemaining ${kind}:\n${JSON.stringify(remaining, null, 2)}`, "blocked");
}

async function authorStep(options: ContractPipelineStepOptions, source: PlanSource, canonical?: CanonicalPlan, reason?: string) {
  const paths = executionPlanPaths(options.artifactsDir);
  return emit(options, renderPlanAuthorPrompt({ root: options.root, source, canonical,
    history: await readPlanReviewHistory(options.artifactsDir), sourcePath: paths.source,
    planPath: paths.canonical, outputPath: paths.submission, reason }));
}

/** Review dependencies are declarations over one revision, never a second artifact-state graph. */
const REVIEW_DEPENDENCIES: Record<PlanReviewRole, readonly PlanReviewRole[]> = {
  critique: [], critic: ["critique"], judge: ["critique", "critic"],
};

async function reviewStep(options: ContractPipelineStepOptions, canonical: CanonicalPlan, role: PlanReviewRole): Promise<RemediationStep | PlanReviewReceipt> {
  const paths = executionPlanPaths(options.artifactsDir), rolePaths = paths.review(role);
  const history = await readPlanReviewHistory(options.artifactsDir);
  const dependencies = await Promise.all(REVIEW_DEPENDENCIES[role].map(dependency => readPlanReview(options.artifactsDir, dependency, canonical.revision_sha256)));
  const ownerDecision = await readOptionalJsonFile<unknown>(join(paths.directory, "owner-decision.json"));
  const inputSha = hashContent(stableStringify({ revision: canonical.revision_sha256, role, dependencies, history, ownerDecision }));
  const prior = await readPlanReview(options.artifactsDir, role, canonical.revision_sha256);
  const { adversarialDepth } = await resolveAdversarialDepth(options.artifactsDir);
  const requirement = reviewRequirementForRole(role, adversarialDepth);
  const body = renderPlanReviewPrompt({ role, root: options.root, sourcePath: paths.source, planPath: paths.canonical,
    canonical, history, priorReviewPaths: REVIEW_DEPENDENCIES[role].map(dependency => paths.review(dependency).accepted), requirement });
  const bound = bindWorkerPrompt(body + `\nInput binding: ${inputSha}`, prompt_sha256 => JSON.stringify({
    contract_version: "review-submission/v1", prompt_sha256,
    review: { mode: requirement === "independent" ? "independent" : "degraded", reason: "<how the context meets the review policy>" },
    result: "<the role's result object>",
  }, null, 2));
  if (prior?.input_sha256 === inputSha &&
      prior.provenance.reviewed_content_hash === canonical.revision_sha256 &&
      prior.provenance.requirement === requirement &&
      prior.provenance.prompt_sha256 === bound.sha256 &&
      !reviewIndependenceIssue(requirement, prior.provenance.review)) return prior;
  const request = { role, revision_sha256: canonical.revision_sha256, input_sha256: inputSha, prompt_sha256: bound.sha256, requirement };
  const issued = await readOptionalJsonFile<unknown>(rolePaths.request);
  const raw = await readOptionalJsonFile<unknown>(rolePaths.submission);
  let errors: string[] = [];
  if (raw !== undefined && stableStringify(issued) === stableStringify(request)) {
    const result = parseReviewSubmissionEnvelope(raw, { requirement, promptSha256: bound.sha256 });
    if (!result.ok) errors = [result.issue];
    else {
      const schema = role === "critique" ? CritiqueSchema : role === "critic" ? CriticSchema : PlanJudgeSchema;
      const parsed = schema.safeParse(result.result);
      if (!parsed.success) errors = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`);
      else {
        const payload = parsed.data;
        const reqIds = new Set(canonical.plan.requirements.map(entry => entry.id));
        const unitIds = new Set(canonical.plan.units.map(entry => entry.id));
        if (role === "critique" || role === "critic") {
          const references = role === "critique" ? CritiqueSchema.parse(payload).issues : CriticSchema.parse(payload).counterexamples;
          if (new Set(references.map(entry => entry.id)).size !== references.length) errors.push("Review issue identities must be unique.");
          for (const entry of references) {
            if (entry.requirement_ids.some(id => !reqIds.has(id)) || entry.unit_ids.some(id => !unitIds.has(id))) errors.push(`Review issue ${entry.id} references missing plan entities.`);
          }
        }
        if (role === "judge") {
          const judge = PlanJudgeSchema.parse(payload);
          const critic = CriticSchema.parse(dependencies[1]?.result);
          const ids = new Set([...history.accepted_ids, ...critic.counterexamples.map(entry => entry.id)]);
          const given = judge.classifications.map(entry => entry.counterexample_id);
          if (given.length !== ids.size || new Set(given).size !== given.length || given.some(id => !ids.has(id))) errors.push("Judge must classify every current/previously accepted counterexample exactly once.");
          const assessed = judge.requirement_assessments.map(entry => entry.requirement_id);
          if (assessed.length !== reqIds.size || new Set(assessed).size !== assessed.length || assessed.some(id => !reqIds.has(id))) errors.push("Judge must assess every requirement exactly once.");
          const disposed = new Set(canonical.plan.source_dispositions.map(entry => entry.finding_id));
          const reviewed = judge.disposition_assessments.map(entry => entry.finding_id);
          if (reviewed.length !== disposed.size || new Set(reviewed).size !== reviewed.length || reviewed.some(id => !disposed.has(id))) errors.push("Judge must assess every source disposition exactly once.");
          if (canonical.plan.request_disposition && !judge.request_disposition_assessment) errors.push("Judge must assess the evidence-backed request disposition.");
          if (judge.verdict === "approved" && (judge.request_disposition_assessment?.verdict === "insufficient" || judge.classifications.some(entry => entry.classification === "accepted") || judge.requirement_assessments.some(entry => entry.verdict !== "satisfied") || judge.disposition_assessments.some(entry => entry.verdict !== "satisfied"))) errors.push("An approval cannot contain unresolved counterexamples or insufficient evidence.");
        }
        if (!errors.length) {
          const receipt: PlanReviewReceipt = { ...request, provenance: { requirement, prompt_sha256: bound.sha256, review: result.review!, reviewed_content_hash: canonical.revision_sha256 }, result: payload };
          // Only canonical accepted receipts are downstream inputs.
          const { requirement: _requirement, prompt_sha256: _prompt, ...accepted } = receipt as PlanReviewReceipt & typeof request;
          const previousReceipt = PlanReviewReceiptSchema.safeParse(await readOptionalJsonFile<unknown>(rolePaths.accepted));
          if (previousReceipt.success) { const old = previousReceipt.data; await writeJsonFile(join(paths.directory,"history","reviews",`${old.revision_sha256}-${role}-${old.input_sha256}.json`),old); }
          await writeJsonFile(join(paths.directory,"submissions",`${canonical.revision_sha256}-${role}-${bound.sha256}.json`),raw);
          await writeJsonFile(rolePaths.accepted, accepted);
          return accepted;
        }
      }
    }
  } else if (raw !== undefined) errors = ["A current tool-issued request is required; a stale response cannot authorize this revision."];
  await writeJsonFile(rolePaths.request, request);
  return emit(options, `${bound.text}\n\nWrite the complete bound response to ${rolePaths.submission}.${errors.length ? `\nRefused response:\n${errors.join("\n")}` : ""}`);
}

/** One author/revision loop, with independent review over the executable plan itself. */
export async function buildNextContractPipelineStep(options: ContractPipelineStepOptions): Promise<RemediationStep | null> {
  const source = await ensureSource(options);
  if (stableStringify(source.intent ?? null) !== stableStringify(await readExecutionIntent(options.artifactsDir) ?? null)) {
    return emit(options,
      "The confirmed scope or intent changed after this plan's input was captured. The saved plan and execution evidence are preserved. Restore the agreed checkpoint or explicitly start a new run with the changed scope; the previous review cannot authorize it.",
      "blocked");
  }
  for (const entry of source.sources) {
    let actual: string;
    try { actual = hashContent(await readFile(entry.path, "utf8")); } catch { actual = "missing"; }
    if (actual !== entry.sha256) return emit(options, `The agreed input ${entry.path} changed or disappeared. The current plan is preserved. Restore the agreed source or explicitly start a new run; an old review cannot authorize changed source evidence.`, "blocked");
  }
  const state = await readOptionalJsonFile<{ plan?: { units?: unknown[] }; items?: Record<string, { status: string }> }>(join(options.artifactsDir, "state.json"));
  const acceptedUnits = new Map<string, unknown>();
  for (const unit of state?.plan?.units ?? []) {
    const entry = unit as { id: string };
    if (["resolved", "resolved_no_change"].includes(state?.items?.[entry.id]?.status ?? "")) acceptedUnits.set(entry.id, unit);
  }
  const ingestion = await ingestExecutionPlan({ ...options, acceptedUnits });
  const canonical = await readCanonicalPlan(options.artifactsDir);
  if (ingestion.issues.length || !canonical) return authorStep(options, source, canonical, ingestion.issues.join("\n"));
  if (await readApprovedExecutionPlan(options.artifactsDir)) return options.forceRevision && !ingestion.changed ? authorStep(options,source,canonical,"The operator requested a revised plan. Preserve accepted execution units and add explicit follow-up work where needed.") : null;
  const contextIssues = await executionPlanContextIssues(options.root, canonical);
  if (contextIssues.length) return authorStep(options,source,canonical,contextIssues.join("\n"));
  if (source.request || canonical.plan.source_dispositions.some(entry => entry.status === "deferred")) {
    const decisionPath = join(executionPlanPaths(options.artifactsDir).directory, "owner-decision.json");
    const rawDecision = await readOptionalJsonFile<unknown>(decisionPath);
    const decision = z.object({ revision_sha256: z.string(), confirmed_by: z.literal("host"), approved_unit_ids: z.array(z.string()), declined_units: z.array(z.object({ id: z.string(), reason: z.string().min(1) }).strict()), deferred_findings: z.array(z.object({ finding_id:z.string(), reason:z.string().min(1) }).strict()).default([]) }).strict().safeParse(rawDecision);
    const ids = canonical.plan.units.map(unit => unit.id);
    const covered = decision.success ? [...decision.data.approved_unit_ids, ...decision.data.declined_units.map(unit => unit.id)] : [];
    if (!decision.success || decision.data.revision_sha256 !== canonical.revision_sha256 || new Set(covered).size !== ids.length || covered.length !== ids.length || covered.some(id => !ids.includes(id)) || canonical.plan.source_dispositions.filter(entry => entry.status === "deferred").some(entry => !decision.data.deferred_findings.some(chosen => chosen.finding_id === entry.finding_id))) {
      return emit(options, `# Confirm the requested change plan\n\nPresent the concrete execution units, affected boundaries and unresolved choices in ${executionPlanPaths(options.artifactsDir).canonical}. Batch scope/behavior questions now. Preserve the operator's existing intent and permissions; never silently discard requested work. Record the operator's unit choices in ${decisionPath}:\n${JSON.stringify({revision_sha256:canonical.revision_sha256,confirmed_by:"host",approved_unit_ids:ids,declined_units:[],deferred_findings:canonical.plan.source_dispositions.filter(entry=>entry.status==="deferred").map(entry=>({finding_id:entry.finding_id,reason:entry.reason}))},null,2)}\nA declined unit requires {id,reason}. Proposed finding deferrals require explicit operator confirmation in deferred_findings; an author or judge cannot silently opt out of approved work. For an empty plan, explicitly confirm its evidence-backed request disposition. A material plan revision requires a new decision.`, "blocked");
    }
  }
  const pendingRepair = await readPlanReviewHistory(options.artifactsDir);
  if (pendingRepair.repair_revision === canonical.revision_sha256) return authorStep(options, source, canonical, pendingRepair.repair_reason);
  for (const role of PLAN_REVIEW_ROLES) {
    const result = await reviewStep(options, canonical, role);
    if ("step_kind" in result) return result;
    if (role === "critique") {
      const critique = CritiqueSchema.parse(result.result);
      if (critique.verdict !== "approved" || critique.issues.some(issue => issue.blocking)) {
        const history=await readPlanReviewHistory(options.artifactsDir);
        if(history.repair_rounds>=8) return repairBoundSpent(options,"Conceptual review","design issues",critique.issues);
        await writeJsonFile(executionPlanPaths(options.artifactsDir).history,{...history,repair_rounds:history.repair_rounds+1,repair_revision:canonical.revision_sha256,repair_reason:JSON.stringify(critique)});
        return authorStep(options,source,canonical,JSON.stringify(critique,null,2));
      }
    }
    if (role === "judge") {
      const judge = PlanJudgeSchema.parse(result.result);
      const history = await readPlanReviewHistory(options.artifactsDir);
      if (judge.verdict !== "approved") {
        const critic = CriticSchema.parse((await readPlanReview(options.artifactsDir, "critic", canonical.revision_sha256))?.result);
        const counterexamples = new Map(history.counterexamples.map(entry => [entry.id, entry]));
        for (const example of critic.counterexamples) counterexamples.set(example.id, example);
        const acceptedIds = judge.classifications.filter(entry => entry.classification === "accepted").map(entry => entry.counterexample_id);
        if (history.repair_rounds >= 8) return repairBoundSpent(options, "Plan review", "judge-accepted counterexamples", acceptedIds.map(id => counterexamples.get(id) ?? { id }));
        await writeJsonFile(executionPlanPaths(options.artifactsDir).history, { counterexamples: [...counterexamples.values()], accepted_ids: acceptedIds, repair_rounds: history.repair_rounds + 1, repair_revision: canonical.revision_sha256, repair_reason: JSON.stringify(judge) });
        return authorStep(options, source, canonical, JSON.stringify(judge, null, 2));
      }
      const residuals = judge.classifications.filter(entry => entry.classification === "residual_risk");
      if (residuals.length) {
        const riskPath = join(executionPlanPaths(options.artifactsDir).directory, "risk-decisions.json");
        const risk = PlanRiskDecisionSchema.safeParse(await readOptionalJsonFile<unknown>(riskPath));
        if (!risk.success || risk.data.revision_sha256 !== canonical.revision_sha256 || residuals.some(entry => !risk.data.accepted_counterexample_ids.includes(entry.counterexample_id))) return emit(options, `# Accept or repair remaining risks\n\nThe independent judge proposes these residual risks, which remain the operator's choice:\n${JSON.stringify(residuals,null,2)}\nAsk the operator to accept them or revise the plan. Explicit acceptance is recorded at ${riskPath}: ${JSON.stringify({revision_sha256:canonical.revision_sha256,confirmed_by:"host",accepted_counterexample_ids:residuals.map(entry=>entry.counterexample_id)})}. Never infer risk acceptance from the judge's classification.`, "blocked");
      }
      const finalCritic = CriticSchema.parse((await readPlanReview(options.artifactsDir, "critic", canonical.revision_sha256))?.result);
      const finalExamples = new Map(history.counterexamples.map(entry => [entry.id,entry]));
      for (const entry of finalCritic.counterexamples) finalExamples.set(entry.id,entry);
      // Approval closes this review cycle: the repair bound is per cycle, so a later revision of the approved plan starts at zero.
      await writeJsonFile(executionPlanPaths(options.artifactsDir).history,{counterexamples:[...finalExamples.values()],accepted_ids:[],repair_rounds:0});
      const paths=executionPlanPaths(options.artifactsDir);
      const reviews=Object.fromEntries(await Promise.all(PLAN_REVIEW_ROLES.map(async role=>[role,hashContent(stableStringify(await readPlanReview(options.artifactsDir,role,canonical.revision_sha256)))])));
      await writeJsonFile(paths.approval, { revision_sha256: canonical.revision_sha256, judge_input_sha256: result.input_sha256,
        owner_decision_sha256: hashContent(stableStringify(await readOptionalJsonFile<unknown>(join(paths.directory,"owner-decision.json")) ?? null)),
        risk_decision_sha256: hashContent(stableStringify(await readOptionalJsonFile<unknown>(join(paths.directory,"risk-decisions.json")) ?? null)),
        history_sha256: hashContent(stableStringify(await readPlanReviewHistory(options.artifactsDir))),review_sha256:reviews });
    }
  }
  return null;
}

