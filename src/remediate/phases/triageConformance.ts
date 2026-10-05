// sites-pinned: tests/remediate/phase-triage.test.ts, tests/remediate/host-handoff-corroboration-obligations.test.ts
import { join, relative } from "node:path";
import { z } from "zod";
import { readFile, readdir, lstat, readlink } from "node:fs/promises";
import { hashContent } from "../../shared/hash.js";
import { stableStringify } from "../../shared/stableStringify.js";
import { headCommit } from "../../shared/git.js";
import { AUDIT_TOOLS_DIRNAME, readOptionalJsonFile, writeJsonFile, parseCommandString, resolveWithinRoot } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import { worktreeContentId } from "../steps/gateCommands.js";
import { checkConformanceSubject, conformanceReviewPaths, type ConformanceReviewCheck } from "../steps/dispatch/contractConformanceReview.js";
import { readSubmissionDocument } from "../../shared/submission/submissionClassifier.js";

const digest = (value: unknown): string => hashContent(stableStringify(value));

/** Historical evidence only; admission continues to use the run's live request and state. */
export async function archiveConformanceSubjects(artifactsDir: string, outputDir: string): Promise<void> {
  const sourceDir = join(artifactsDir, "conformance-review", "subjects");
  let names: string[];
  try { names = await readdir(sourceDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}(?:\.review)?\.json$/.test(name)) throw new Error(`Unexpected conformance subject filename: ${name}`);
    const document = JSON.parse(await readFile(join(sourceDir, name), "utf8")) as unknown;
    await writeJsonFile(join(outputDir, "remediation-conformance", name), document);
  }
}
const ObservationSchema = z.object({
  schema_version: z.literal("triage-verification/v1"), producer: z.literal("triage_required_tests"),
  context: z.unknown(), verification: z.array(z.object({ command: z.string().min(1), outcome: z.literal("passed"), exit_code: z.literal(0) }).strict()).min(1),
}).strict();

/** The full nonignored tree plus declared files, including ignored deliverables. */
export async function triageEvidenceContext(root: string, state: RemediationState, itemId: string): Promise<unknown | null> {
  const unit = state.plan?.units.find(entry => entry.id === itemId);
  if (!unit || !state.plan) return null;
  const tree = await worktreeContentId(root);
  const head = await headCommit(root);
  if (!tree || !head) return null;
  const files: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (normalized === ".git" || normalized.startsWith(".git/") || normalized === AUDIT_TOOLS_DIRNAME || normalized.startsWith(AUDIT_TOOLS_DIRNAME + "/")) return;
    const stats = await lstat(join(root, relative));
    if (stats.isSymbolicLink()) files[relative] = digest({ symlink: await readlink(join(root, relative)), target_hash: hashContent(await readFile(join(root, relative))) });
    else if (stats.isDirectory()) {
      files[relative] = "directory";
      for (const child of (await readdir(join(root, relative))).sort()) await visit(join(relative, child));
    } else files[relative] = hashContent(await readFile(join(root, relative)));
  };
  try { for (const path of [...new Set([...unit.allowed_files, ...unit.read_paths])].sort()) await visit(path); }
  catch { return null; }
  // Explicit test scripts can live in ignored scratch; bind their bytes too.
  for (const command of unit.required_tests) for (const argument of parseCommandString(command).slice(1)) {
    if (argument.startsWith("-")) continue;
    const path = resolveWithinRoot(root, argument);
    if (!path) continue;
    const rel = relative(root, path);
    try {
      const stats = await lstat(path);
      if (stats.isFile() || stats.isSymbolicLink()) files[`test:${rel}`] = hashContent(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return {
    repository_root: root, run_id: state.plan.plan_id, work_item_id: itemId,
    verified_head: head, verified_worktree: tree, declared_file_hashes: files,
    requirements: state.plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id)),
    unit, review_revision_sha256: state.plan.review_revision_sha256,
    accepted_counterexamples: (state.plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id)),
  };
}

function triageObservationPath(artifactsDir: string, runId: string, itemId: string): string {
  return join(artifactsDir, "conformance-review", `${digest({ run_id: runId, work_item_id: itemId })}.observation.json`);
}

export async function readTriageObservation(artifactsDir: string, runId: string, itemId: string, context: unknown): Promise<unknown | null> {
  const document = await readSubmissionDocument(triageObservationPath(artifactsDir, runId, itemId));
  const parsed = ObservationSchema.safeParse(document.kind === "value" ? document.value : null);
  if (!parsed.success || stableStringify(parsed.data.context) !== stableStringify(context)) return null;
  const commands = (context as { unit: { required_tests: string[] } }).unit.required_tests;
  return stableStringify(parsed.data.verification.map(entry => entry.command)) === stableStringify(commands) ? parsed.data : null;
}

export async function checkTriageConformance(root: string, artifactsDir: string, state: RemediationState, itemId: string, context: unknown | null): Promise<ConformanceReviewCheck> {
  const unit = state.plan!.units.find(entry => entry.id === itemId)!;
  const observation = context ? await readTriageObservation(artifactsDir, state.plan!.plan_id, itemId, context) : null;
  const checked = await checkConformanceSubject({ artifactsDir, runId: state.plan!.plan_id, itemId,
    obligationIds: unit.requirement_ids, content: { context, observation },
    evidenceInstruction: "This is a tool-owned observation, not a host implementation result. Inspect the current working tree identified by verified_worktree and declared_file_hashes, including the required tests and contract. HEAD alone does not identify the reviewed uncommitted source. Explain why the observed tests and source satisfy every obligation. The full tree identity omits ignored files and run scratch; declared deliverables are also hashed explicitly.",
  });
  if (!observation || stableStringify(await triageEvidenceContext(root, state, itemId)) !== stableStringify(context)) {
    const paths = conformanceReviewPaths(artifactsDir, state.plan!.plan_id, itemId);
    return { ok: false, issue: { code: "conformance_review_required", work_item_id: itemId, result_path: paths.response, review_request_path: paths.request, message: "The working-tree verification context is unavailable or changed. Keep this unit blocked; resume against stable readable source before obtaining conformance review." } };
  }
  return checked;
}

export async function writeTriageObservation(artifactsDir: string, runId: string, itemId: string, context: unknown, commands: readonly string[]): Promise<void> {
  await writeJsonFile(triageObservationPath(artifactsDir, runId, itemId), { schema_version: "triage-verification/v1", producer: "triage_required_tests", context,
    verification: commands.map(command => ({ command, outcome: "passed", exit_code: 0 })),
  });
}

/** Successful terminal units must retain the receipt for their current review subject. */
export async function assertSuccessfulConformance(root: string, artifactsDir: string, state: RemediationState): Promise<void> {
  if (!state.conformance_review?.enabled || !state.plan) return;
  for (const unit of state.plan.units) {
    const item = state.items?.[unit.id];
    if (!item || (item.status !== "resolved" && item.status !== "resolved_no_change")) continue;
    const fail = (): never => { throw new Error(`conformance_review_required: ${unit.id} lacks a current independently reviewed success receipt.`); };
    const receipt = item.conformance_review;
    if (!receipt || receipt.review.mode !== "independent") fail();
    const paths = conformanceReviewPaths(artifactsDir, state.plan.plan_id, unit.id);
    const request = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(paths.request);
    if (!request || request.binding !== receipt!.binding || digest(request.content) !== receipt!.binding) fail();
    const content = request!.content;
    if ("observation" in content) {
      const context = await triageEvidenceContext(root, state, unit.id);
      const observation = context && await readTriageObservation(artifactsDir, state.plan.plan_id, unit.id, context);
      if (!observation || digest({ context, observation }) !== receipt!.binding) fail();
    } else {
      const requirements = state.plan.requirements.filter(requirement => unit.requirement_ids.includes(requirement.id));
      const examples = (state.plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id));
      if (content.run_id !== state.plan.plan_id || content.work_item_id !== unit.id || content.review_revision_sha256 !== state.plan.review_revision_sha256 ||
        stableStringify(content.unit) !== stableStringify(unit) || stableStringify(content.requirements) !== stableStringify(requirements) ||
        stableStringify(content.accepted_counterexamples) !== stableStringify(examples)) fail();
      // Host success is a review of immutable committed evidence; later units may land.
    }
  }
}

/** Refresh mutable-tree successes through ordinary triage; retain their historical receipts. */
export async function reopenStaleTriageSuccesses(root: string, artifactsDir: string, state: RemediationState): Promise<boolean> {
  if (!state.conformance_review?.enabled || !state.plan) return false;
  let reopened = false;
  for (const unit of state.plan.units) {
    const item = state.items?.[unit.id];
    if (item?.status !== "resolved_no_change" || !item.conformance_review) continue;
    const request = await readOptionalJsonFile<{ binding: string; content: Record<string, unknown> }>(conformanceReviewPaths(artifactsDir, state.plan.plan_id, unit.id).request);
    if (!request || !("observation" in request.content)) continue;
    const context = await triageEvidenceContext(root, state, unit.id);
    const observation = context && await readTriageObservation(artifactsDir, state.plan.plan_id, unit.id, context);
    if (!observation || digest({ context, observation }) !== item.conformance_review.binding) {
      item.status = "blocked";
      item.failure_reason = "The working tree changed since this tool-owned success observation was reviewed. Reverify and obtain a current bound review.";
      delete item.completed_at;
      reopened = true;
    }
  }
  if (reopened) state.status = "triage";
  return reopened;
}
