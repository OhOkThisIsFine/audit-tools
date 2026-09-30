// sites-pinned: tests/remediate/executable-plan-identity.test.ts, tests/remediate/executable-plan-context.test.ts, tests/remediate/executable-plan-safety.test.ts, tests/remediate/execution-unit-runtime.test.ts
import { join } from "node:path";
import type { Stats } from "node:fs";
import { mkdir, rename, readFile, lstat, readdir } from "node:fs/promises";
import { z } from "zod";
import { hashContent, stableStringify, readOptionalJsonFile, writeJsonFile, repoRelativePath, toPosixPath, commandLeavesDeclaredShape, FindingSchema, AuditReadSchema, readIntentCheckpoint, fileExclusionReason, pathMatchesPrefix, EXCLUDED_OVERRIDE_STATUSES, AUDIT_TOOLS_DIRNAME, compareCodeUnits } from "audit-tools/shared";
import { IntentCheckpointSchema } from "../../shared/types/intentCheckpoint.js";
import { ExecutableChangePlanSchema, type ExecutableChangePlan, ExecutionRequestSchema, executionPlanReferenceIssues } from "../../shared/types/executionPlan.js";
import { ContractReviewProvenanceSchema, reviewIndependenceIssue } from "../../shared/types/reviewIndependence.js";
import { runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "../../shared/tooling/exec.js";

const text = z.string().trim().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const ExecutionIntentSchema=IntentCheckpointSchema.omit({confirmed_at:true,closing_action:true,closing_custom_command:true,conformance_review:true});
export const PlanSourceSchema = z.object({
  plan_id: text,
  findings: z.array(FindingSchema),
  request: ExecutionRequestSchema.optional(),
  audit_read: AuditReadSchema.nullable(),
  sources: z.array(z.object({ path: text, sha256: digest }).strict()),
  intent: ExecutionIntentSchema.optional(),
}).strict();
export type PlanSource = z.infer<typeof PlanSourceSchema>;

export async function readExecutionIntent(artifactsDir:string):Promise<PlanSource["intent"]>{
  const checkpoint=await readIntentCheckpoint(join(artifactsDir,"intent_checkpoint.json"));
  if(!checkpoint)return undefined;
  const {confirmed_at:_timestamp,closing_action:_closing,closing_custom_command:_command,conformance_review:_conformance,...intent}=checkpoint;
  return ExecutionIntentSchema.parse(intent);
}

export const PlanSubmissionSchema = z.object({
  base_revision_sha256: digest.nullable(),
  plan: ExecutableChangePlanSchema,
  retired_requirements: z.array(z.object({ id: text, reason: text, replaced_by: z.array(text) }).strict()).default([]),
}).strict();

export const CanonicalPlanSchema = z.object({
  contract_version: z.literal("remediate-code-executable-plan/v1"),
  revision_sha256: digest,
  source_sha256: digest,
  context_files: z.array(z.object({ path: text, sha256: digest.nullable() }).strict()),
  plan: ExecutableChangePlanSchema,
}).strict();
export type CanonicalPlan = z.infer<typeof CanonicalPlanSchema>;

export const ReviewIssueSchema = z.object({
  id: text,
  description: text,
  requirement_ids: z.array(text),
  unit_ids: z.array(text),
  blocking: z.boolean(),
}).strict();
export const CritiqueSchema = z.object({
  verdict: z.enum(["approved", "needs_repair"]),
  issues: z.array(ReviewIssueSchema),
}).strict();
export const PlanCounterexampleSchema = z.object({
  id: text,
  claim: text,
  reproduction_steps: z.array(text).min(1),
  expected: text,
  actual: text,
  requirement_ids: z.array(text),
  unit_ids: z.array(text),
}).strict();
export const CriticSchema = z.object({ counterexamples: z.array(PlanCounterexampleSchema) }).strict();
export const PlanJudgeSchema = z.object({
  verdict: z.enum(["approved", "needs_repair"]),
  classifications: z.array(z.object({
    counterexample_id: text,
    classification: z.enum(["accepted", "repaired", "invalid", "out_of_scope", "duplicate", "residual_risk"]),
    rationale: text,
  }).strict()),
  requirement_assessments: z.array(z.object({
    requirement_id: text,
    verdict: z.enum(["satisfied", "insufficient"]),
    evidence: z.array(text).min(1),
  }).strict()),
  disposition_assessments: z.array(z.object({
    finding_id: text,
    verdict: z.enum(["satisfied", "insufficient"]),
    evidence: z.array(text).min(1),
  }).strict()),
  request_disposition_assessment: z.object({ verdict: z.enum(["satisfied", "insufficient"]), evidence: z.array(text).min(1) }).strict().optional(),
}).strict();
export const PlanRiskDecisionSchema = z.object({
  revision_sha256: digest,
  confirmed_by: z.literal("host"),
  accepted_counterexample_ids: z.array(text),
}).strict();
export type PlanCounterexample = z.infer<typeof PlanCounterexampleSchema>;
export type PlanReviewRole = "critique" | "critic" | "judge";
export const PLAN_REVIEW_ROLES: readonly PlanReviewRole[] = ["critique", "critic", "judge"];
export const PlanReviewReceiptSchema = z.object({
  revision_sha256: digest,
  role: z.enum(["critique", "critic", "judge"]),
  input_sha256: digest,
  provenance: ContractReviewProvenanceSchema,
  result: z.unknown(),
}).strict();
export type PlanReviewReceipt = z.infer<typeof PlanReviewReceiptSchema>;

export interface PlanReviewHistory {
  counterexamples: PlanCounterexample[];
  accepted_ids: string[];
  repair_rounds: number;
  repair_revision?: string;
  repair_reason?: string;
}

export function executionPlanPaths(artifactsDir: string) {
  const directory = join(artifactsDir, "intake", "plan");
  return {
    directory,
    source: join(directory, "source.json"),
    canonical: join(directory, "plan.json"),
    submission: join(directory, "plan.input.json"),
    history: join(directory, "review-history.json"),
    approval: join(directory, "approval.json"),
    review: (role: PlanReviewRole) => ({
      request: join(directory, `${role}.request.json`),
      submission: join(directory, `${role}.input.json`),
      accepted: join(directory, `${role}.json`),
    }),
  };
}

/** Canonical order ignores unrelated insert/reorder, but command order is semantic. */
export function executionPlanRevision(plan: ExecutableChangePlan, sourceSha256: string, contextFiles: CanonicalPlan["context_files"] = []): string {
  const byId = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => compareCodeUnits(a.id,b.id));
  return hashContent(stableStringify({ source_sha256: sourceSha256, context_files: [...contextFiles].sort((a,b)=>compareCodeUnits(a.path,b.path)), plan: {
    ...plan,
    requirements: byId(plan.requirements),
    units: byId(plan.units).map(unit => ({ ...unit, dependencies: [...unit.dependencies].sort(), requirement_ids: [...unit.requirement_ids].sort(), source_finding_ids: [...unit.source_finding_ids].sort() })),
  } }));
}

export async function readPlanSource(artifactsDir: string): Promise<PlanSource | undefined> {
  const raw = await readOptionalJsonFile<unknown>(executionPlanPaths(artifactsDir).source);
  return raw === undefined ? undefined : PlanSourceSchema.parse(raw);
}

export async function readCanonicalPlan(artifactsDir: string): Promise<CanonicalPlan | undefined> {
  const raw = await readOptionalJsonFile<unknown>(executionPlanPaths(artifactsDir).canonical);
  if (raw === undefined) return undefined;
  const canonical = CanonicalPlanSchema.parse(raw);
  if (executionPlanRevision(canonical.plan, canonical.source_sha256, canonical.context_files) !== canonical.revision_sha256) throw new Error("Canonical executable plan content does not match its revision binding.");
  return canonical;
}

export async function readPlanReviewHistory(artifactsDir: string): Promise<PlanReviewHistory> {
  const raw = await readOptionalJsonFile<unknown>(executionPlanPaths(artifactsDir).history);
  return raw === undefined ? { counterexamples: [], accepted_ids: [], repair_rounds: 0 } : z.object({
    counterexamples: z.array(PlanCounterexampleSchema), accepted_ids: z.array(text), repair_rounds: z.number().int().nonnegative(), repair_revision: digest.optional(), repair_reason: text.optional(),
  }).strict().parse(raw);
}

/** Normalize spelling before review; the canonical grant remains the reviewed grant. */
function normalizeExecutionPlanPaths(root: string, plan: ExecutableChangePlan): ExecutableChangePlan {
  const normalize = (path: string, label: string): string => {
    const portable = toPosixPath(path);
    // Normalize separators BEFORE containment so a Windows-style escape cannot
    // be interpreted as a harmless filename on a POSIX host.
    const relative = repoRelativePath(root, portable, label);
    return portable.endsWith("/") ? `${relative}/` : relative;
  };
  return {
    ...plan,
    requirements: plan.requirements.map(requirement => ({
      ...requirement,
      assertions: requirement.assertions.map(assertion => ({ ...assertion,
        scope_paths: assertion.scope_paths.map(path => normalize(path, `Requirement ${requirement.id} assertion`)),
      })),
    })),
    units: plan.units.map(unit => ({
      ...unit,
      read_paths: unit.read_paths.map(path => normalize(path, `Unit ${unit.id} read scope`)),
      allowed_files: unit.allowed_files.map(path => normalize(path, `Unit ${unit.id} write scope`)),
    })),
  };
}

/** Cross-reference and executable-boundary validation, not semantic self-certification. */
export function executionPlanIssues(root: string, source: PlanSource, plan: ExecutableChangePlan): string[] {
  const issues = executionPlanReferenceIssues(plan, source.findings.map(finding => finding.id));
  if (plan.plan_id !== source.plan_id) issues.push("plan_id must match the tool-owned source identity.");
  if (source.request && !plan.units.length && !plan.request_disposition) issues.push("A request needs executable work or an explicit evidence-backed request disposition.");
  if (plan.request_disposition && (!source.request || plan.units.length > 0)) issues.push("A request disposition is only valid for a request with no execution units.");
  const validatePaths = (paths: string[], label: string) => {
    for (const path of paths) { try { repoRelativePath(root,path,label); } catch { issues.push(`${label}: ${path} escapes the repository.`); } }
  };
  for (const requirement of plan.requirements) {
    for (const assertion of requirement.assertions) validatePaths(assertion.scope_paths, `Requirement ${requirement.id} assertion`);
    if (!plan.units.some(unit=>unit.requirement_ids.includes(requirement.id))) issues.push(`Requirement ${requirement.id} has no execution unit.`);
    if (requirement.change_kind === "structural" && !requirement.assertions.length && !requirement.inapplicable_reason && !plan.units.some(unit => unit.requirement_ids.includes(requirement.id) && unit.required_tests.length)) issues.push(`Structural requirement ${requirement.id} needs executable verification or a reviewed inapplicability reason.`);
  }
  for (const unit of plan.units) {
    validatePaths(unit.read_paths,`Unit ${unit.id} read scope`); validatePaths(unit.allowed_files,`Unit ${unit.id} write scope`);
    if(source.intent){
      const checkpoint={...source.intent,confirmed_at:"bound"};
      for(const path of unit.allowed_files){
        const reason=fileExclusionReason(path,checkpoint);
        if(reason)issues.push(`Unit ${unit.id} writes forbidden scope ${path}: ${reason}`);
        if(path.endsWith("/")){
          const forbidden=[...(source.intent.excluded_scope??[]).map(entry=>entry.path),
            ...(source.intent.disposition_overrides??[]).filter(entry=>EXCLUDED_OVERRIDE_STATUSES.has(entry.status)).map(entry=>entry.path),
            ...(source.intent.must_not_touch??[])];
          for(const glob of forbidden){const prefix=glob.split(/[?*]/u,1)[0]!.replace(/\/$/u,"");if(!prefix || pathMatchesPrefix(prefix,path) || pathMatchesPrefix(path,prefix))issues.push(`Unit ${unit.id} directory grant ${path} can include forbidden ${glob}; enumerate permitted files instead.`);}
        }
      }
    }
    for (const command of unit.required_tests) if (commandLeavesDeclaredShape(command)) issues.push(`Unit ${unit.id} command must be one invocation: ${command}`);
    for (const requirement of plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id))) for (const id of requirement.source_finding_ids) if (!unit.source_finding_ids.includes(id)) issues.push(`Unit ${unit.id} drops requirement source finding ${id}.`);
    for (const dependency of unit.dependencies) {
      const prerequisite = plan.units.find(entry=>entry.id===dependency);
      if (prerequisite && (prerequisite.phase_ordinal ?? 0) > (unit.phase_ordinal ?? 0)) issues.push(`Unit ${unit.id} depends on a later integration phase.`);
    }
  }
  for (const finding of source.findings) if (!plan.units.some(unit=>unit.source_finding_ids.includes(finding.id)) && !plan.source_dispositions.some(entry=>entry.finding_id===finding.id)) issues.push(`Source finding ${finding.id} has no execution or explicit disposition.`);
  return issues;
}

export async function ingestExecutionPlan(params: {
  root: string; artifactsDir: string;
  acceptedUnits?: ReadonlyMap<string, unknown>;
}): Promise<{ changed: boolean; issues: string[] }> {
  const paths = executionPlanPaths(params.artifactsDir);
  const raw = await readOptionalJsonFile<unknown>(paths.submission);
  if (raw === undefined) return { changed: false, issues: [] };
  const parsed = PlanSubmissionSchema.safeParse(raw);
  if (!parsed.success) return { changed: false, issues: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) };
  const source = await readPlanSource(params.artifactsDir);
  if (!source) return { changed: false, issues: ["No tool-owned source record exists."] };
  if(stableStringify(source.intent??null)!==stableStringify(await readExecutionIntent(params.artifactsDir)??null))return {changed:false,issues:["Confirmed intent changed. Refresh the tool-owned input and review the plan under the new scope before proceeding."]};
  let next: ExecutableChangePlan;
  try { next = normalizeExecutionPlanPaths(params.root, parsed.data.plan); }
  catch (error) { return { changed: false, issues: [error instanceof Error ? error.message : String(error)] }; }
  const previous = await readCanonicalPlan(params.artifactsDir);
  if (parsed.data.base_revision_sha256 !== (previous?.revision_sha256 ?? null)) {
    // A crash after the canonical write but before consuming its input must be
    // resumable. Identical accepted semantics are replay, never a new revision.
    if (previous && executionPlanRevision(next, hashContent(stableStringify(source)), previous.context_files) === previous.revision_sha256) {
      await mkdir(join(paths.directory,"submissions"),{recursive:true});
      await rename(paths.submission,join(paths.directory,"submissions",`${previous.revision_sha256}-${hashContent(stableStringify(raw))}.json`));
      return { changed:false,issues:[] };
    }
    return { changed: false, issues: ["The submission's base revision is stale. Read the current plan and revise that version."] };
  }
  const issues = executionPlanIssues(params.root, source, next);
  const retired = new Map(parsed.data.retired_requirements.map(entry => [entry.id, entry]));
  for (const requirement of previous?.plan.requirements ?? []) {
    if (next.requirements.some(entry => entry.id === requirement.id)) continue;
    const decision = retired.get(requirement.id);
    if (!decision) issues.push(`Requirement ${requirement.id} disappeared. Preserve its ID or state an explicit retirement/supersession reason.`);
    else for (const id of decision.replaced_by) if (!next.requirements.some(entry => entry.id === id)) issues.push(`Requirement ${requirement.id} supersedes to missing requirement ${id}.`);
  }
  for (const [id, accepted] of params.acceptedUnits ?? []) {
    const nextUnit = next.units.find(unit => unit.id === id);
    if (stableStringify(nextUnit) !== stableStringify(accepted)) issues.push(`Accepted unit ${id} is immutable. Preserve it and add a follow-up unit for additional work.`);
    const priorUnit = previous?.plan.units.find(unit => unit.id === id);
    for (const requirementId of priorUnit?.requirement_ids ?? []) {
      if (stableStringify(previous?.plan.requirements.find(requirement => requirement.id === requirementId)) !== stableStringify(next.requirements.find(requirement => requirement.id === requirementId))) issues.push(`Requirement ${requirementId} is already evidenced by accepted unit ${id}; preserve it and add a new requirement/follow-up unit.`);
    }
  }
  for (const unit of next.units) for (const path of unit.read_paths) {
    try { if (!(await inspectContextPath(params.root,path)).info) issues.push(`Unit ${unit.id} read context ${path} does not exist.`); } catch (error) { issues.push(String(error)); }
  }
  const history = await readPlanReviewHistory(params.artifactsDir);
  for (const id of history.accepted_ids) if (!next.units.some(unit => unit.addresses_counterexample_ids.includes(id))) issues.push(`Accepted counterexample ${id} must remain addressed by an execution unit.`);
  if (issues.length) return { changed: false, issues };
  const sourceSha = hashContent(stableStringify(source));
  let contextFiles: CanonicalPlan["context_files"];
  try { contextFiles = await captureExecutionContext(params.root,next); }
  catch (error) { return { changed: false, issues: [error instanceof Error ? error.message : String(error)] }; }
  const revision = executionPlanRevision(next, sourceSha, contextFiles);
  const canonical: CanonicalPlan = { contract_version: "remediate-code-executable-plan/v1", revision_sha256: revision, source_sha256: sourceSha, context_files: contextFiles, plan: next };
  if (previous) await writeJsonFile(join(paths.directory, "history", `${previous.revision_sha256}.json`), previous);
  await writeJsonFile(paths.canonical, canonical);
  // Keep the semantic amendment itself, including explicit retirement decisions.
  await mkdir(join(paths.directory, "submissions"), { recursive: true });
  await rename(paths.submission, join(paths.directory, "submissions", `${revision}-${Date.now()}.json`));
  return { changed: previous?.revision_sha256 !== revision, issues: [] };
}

/**
 * Lexical containment alone cannot authorize reading through a symlinked parent.
 * Inspect every existing component before descending, including for future write
 * targets. The caller-selected root may itself be an alias; interior links must
 * be declared by their contained target instead. This is a fresh path check, not
 * a claim of race-free filesystem isolation against concurrent directory swaps.
 */
async function inspectContextPath(root: string, path: string): Promise<{
  relative: string; absolute: string; info?: Stats;
}> {
  const relative = repoRelativePath(root, path, "review context");
  const parts = relative.split("/");
  let absolute = root;
  let info: Stats | undefined;
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    try { info = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { relative, absolute: join(root, relative) };
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Review context ${relative} traverses a symbolic link at ${parts.slice(0,index + 1).join("/")}; declare its contained target explicitly.`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Review context ${relative} traverses a non-directory path.`);
  }
  if (info && !info.isFile() && !info.isDirectory()) throw new Error(`Review context ${relative} is not a regular file or directory.`);
  return { relative, absolute, info };
}

export async function captureExecutionContext(root:string,plan:ExecutableChangePlan):Promise<CanonicalPlan["context_files"]>{
  const files=new Map<string,string|null>();
  const collect=async(path:string):Promise<void>=>{
    const {relative,absolute,info}=await inspectContextPath(root,path);
    if(!info){files.set(relative,null);return;}
    if(info.isDirectory())for(const name of (await readdir(absolute)).sort().filter(name=>name!==".git"&&name!==AUDIT_TOOLS_DIRNAME))await collect(join(relative,name));
    else files.set(relative,hashContent((await readFile(absolute)).toString("base64")));
  };
  for(const path of new Set(plan.units.flatMap(unit=>[...unit.read_paths,...unit.allowed_files])))await collect(path);
  return [...files].sort(([a],[b])=>compareCodeUnits(a,b)).map(([path,sha256])=>({path,sha256}));
}

/** Preparation checks reviewed premises; result ingestion instead checks its bound baseline. */
export async function executionPlanContextIssues(root: string, canonical: CanonicalPlan,
  accepted: readonly { allowed_files: readonly string[]; landed_commit: string }[] = []): Promise<string[]> {
  const issues: string[] = [];
  let context: CanonicalPlan["context_files"];
  try { context = await captureExecutionContext(root,canonical.plan); }
  catch (error) {
    return [`Reviewed repository context cannot be inspected safely: ${error instanceof Error ? error.message : String(error)} Restore a contained readable context or revise/review the plan before continuing.`];
  }
  const current=new Map(context.map(entry=>[entry.path,entry.sha256]));
  const expected=new Map(canonical.context_files.map(entry=>[entry.path,entry.sha256]));
  for (const path of new Set([...current.keys(),...expected.keys()])) {
    if ((current.get(path)??null) === (expected.get(path)??null)) continue;
    let explained = false;
    for (const unit of accepted) {
      // A commit tree can contain unrelated earlier work. Only THIS commit's
      // actual changed-file set can explain a moved reviewed premise.
      const changed=await runTrackedAsync(["git","diff-tree","--root","--no-commit-id","--name-only","-z","-r",unit.landed_commit,"--",`:(literal)${path}`],{cwd:root,encoding:"utf8",timeout:TRACKED_CHILD_DEADLINE_MS});
      if(changed.status!==0 || !changed.stdout.split("\0").includes(path))continue;
      const diff = await runTrackedAsync(["git","diff","--quiet",unit.landed_commit,"--",`:(literal)${path}`], {cwd:root,encoding:"utf8",timeout:TRACKED_CHILD_DEADLINE_MS});
      const extra = await runTrackedAsync(["git","ls-files","--others","--exclude-standard","-z","--",`:(literal)${path}`], {cwd:root,encoding:"utf8",timeout:TRACKED_CHILD_DEADLINE_MS});
      if (diff.status === 0 && extra.status === 0 && extra.stdout.trim().length === 0) { explained = true; break; }
    }
    if (!explained) issues.push(`Reviewed repository context changed: ${path}. Revise/review the plan against current source before dispatch.`);
  }
  return issues;
}

export async function readPlanReview(artifactsDir: string, role: PlanReviewRole, revision: string): Promise<PlanReviewReceipt | undefined> {
  const raw = await readOptionalJsonFile<unknown>(executionPlanPaths(artifactsDir).review(role).accepted);
  if (raw === undefined) return undefined;
  const receipt = PlanReviewReceiptSchema.parse(raw);
  return receipt.revision_sha256 === revision && receipt.role === role ? receipt : undefined;
}

export async function readApprovedExecutionPlan(artifactsDir: string): Promise<{ canonical: CanonicalPlan; source: PlanSource } | undefined> {
  const canonical = await readCanonicalPlan(artifactsDir);
  const source = await readPlanSource(artifactsDir);
  if (!canonical || !source || canonical.source_sha256 !== hashContent(stableStringify(source))) return undefined;
  if(stableStringify(source.intent??null)!==stableStringify(await readExecutionIntent(artifactsDir)??null))return undefined;
  for (const entry of source.sources) {
    try { if (hashContent(await readFile(entry.path, "utf8")) !== entry.sha256) return undefined; }
    catch { return undefined; }
  }
  const approval = await readOptionalJsonFile<{ revision_sha256?: string; judge_input_sha256?: string; owner_decision_sha256?: string; risk_decision_sha256?:string; history_sha256?:string; review_sha256?:Record<string,string> }>(executionPlanPaths(artifactsDir).approval);
  const paths=executionPlanPaths(artifactsDir);
  const owner = await readOptionalJsonFile<unknown>(join(paths.directory, "owner-decision.json"));
  const risk = await readOptionalJsonFile<unknown>(join(paths.directory, "risk-decisions.json"));
  if (approval?.owner_decision_sha256 !== hashContent(stableStringify(owner ?? null)) || approval.risk_decision_sha256 !== hashContent(stableStringify(risk ?? null))) return undefined;
  // An approved history is evidence, even when empty; absence is only a valid
  // default during initial authoring, never after an approval bound that record.
  if (await readOptionalJsonFile<unknown>(paths.history) === undefined) return undefined;
  const history=await readPlanReviewHistory(artifactsDir);
  if(approval.history_sha256!==hashContent(stableStringify(history)))return undefined;
  const receipts:Partial<Record<PlanReviewRole,PlanReviewReceipt>>={};
  for(const role of PLAN_REVIEW_ROLES){
    const receipt=await readPlanReview(artifactsDir,role,canonical.revision_sha256);
    if(!receipt || receipt.provenance.reviewed_content_hash!==canonical.revision_sha256 || reviewIndependenceIssue(receipt.provenance.requirement,receipt.provenance.review) || approval.review_sha256?.[role]!==hashContent(stableStringify(receipt)))return undefined;
    if(role==="judge" && (receipt.provenance.requirement!=="independent" || receipt.provenance.review.mode!=="independent"))return undefined;
    receipts[role]=receipt;
  }
  const critique=CritiqueSchema.parse(receipts.critique!.result);
  if(critique.verdict!=="approved" || critique.issues.some(issue=>issue.blocking))return undefined;
  const judge=receipts.judge!;
  if(approval.revision_sha256!==canonical.revision_sha256 || approval.judge_input_sha256!==judge.input_sha256)return undefined;
  const verdict=PlanJudgeSchema.parse(judge.result);
  if(verdict.verdict!=="approved" || verdict.classifications.some(entry=>entry.classification==="accepted"))return undefined;
  const covered=verdict.requirement_assessments;
  if(covered.length!==canonical.plan.requirements.length || new Set(covered.map(entry=>entry.requirement_id)).size!==covered.length || canonical.plan.requirements.some(requirement=>!covered.some(entry=>entry.requirement_id===requirement.id && entry.verdict==="satisfied")))return undefined;
  if(canonical.plan.source_dispositions.some(disposition=>!verdict.disposition_assessments.some(entry=>entry.finding_id===disposition.finding_id && entry.verdict==="satisfied")))return undefined;
  if(canonical.plan.request_disposition && verdict.request_disposition_assessment?.verdict!=="satisfied")return undefined;
  const residuals=verdict.classifications.filter(entry=>entry.classification==="residual_risk");
  if(residuals.length){
    const decision=PlanRiskDecisionSchema.safeParse(risk);
    if(!decision.success || decision.data.revision_sha256!==canonical.revision_sha256 || residuals.some(entry=>!decision.data.accepted_counterexample_ids.includes(entry.counterexample_id)))return undefined;
  }
  return { canonical, source };
}
