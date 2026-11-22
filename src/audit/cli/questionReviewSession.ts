// sites-pinned: tests/audit/result-submit.test.ts, tests/audit/rollover-legacy-archive.test.ts, tests/audit/next-step-question-workload.test.ts
// sites-pinned: tests/audit/result-submit.test.ts, tests/audit/next-step-question-workload.test.ts
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { assertSubmissionRunId, contentSha256, isFileMissingError, readJsonFile, readOptionalJsonFile, readOptionalTextFile, stableStringify, writeJsonFile } from "audit-tools/shared";
import { z } from "zod";
import { auditFindingsPath } from "../../shared/io/auditToolsPaths.js";
import { ReviewReopenEventSchema, type ReviewToolingQualification, type ReviewToolingTransition } from "../../shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";

import { hashArtifactValue } from "../../shared/artifactFreshness.js";
import type { ToolingManifest } from "../types/toolingManifest.js";

const schemaVersion = "audit-tools/question-review-session/v1";
const Session = z.strictObject({
  schema_version: z.literal(schemaVersion),
  run_id: z.string().startsWith("question-review-"),
});
const sessionPath = (artifactsDir: string) => join(artifactsDir, "review_session.json");

export async function readQuestionReviewRunId(
  artifactsDir: string, options: { includeEnded?: boolean } = {},
): Promise<string | undefined> {
  if (!options.includeEnded) {
    try {
      await access(join(artifactsDir, "run-ended.json"));
      return undefined;
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
    }
  }
  try {
    const record = Session.parse(await readJsonFile<unknown>(sessionPath(artifactsDir)));
    assertSubmissionRunId(record.run_id);
    return record.run_id;
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
    throw error;
  }
}

/** The next-step fold already holds the artifact-tree lock. Reuse this run
 * across plan revisions; ordinary finished-run rollover removes the pointer. */
export async function ensureQuestionReviewRunIdUnlocked(artifactsDir: string): Promise<string> {
  const existing = await readQuestionReviewRunId(artifactsDir);
  if (existing) return existing;
  const run_id = `question-review-${randomUUID()}`;
  await writeJsonFile(sessionPath(artifactsDir), { schema_version: schemaVersion, run_id });
  return run_id;
}

/** A reopen changes report currency in the same atomic write as the event.
 * A still-present working JSON or its Markdown mirror must not feed remediation. */
export async function hasStaleReopenedWorkingReport(artifactsDir: string): Promise<boolean> {
  const runId = await readQuestionReviewRunId(artifactsDir);
  if (!runId) return false;
  const reopens = await readReviewReopens(artifactsDir, runId);
  if (reopens.length === 0) return false;
  const report = QuestionAuditFindingsReportSchema.safeParse(await readOptionalJsonFile<unknown>(auditFindingsPath(artifactsDir)));
  return !report.success || stableStringify(report.data.question_review.reopens ?? []) !== stableStringify(reopens);
}

async function readReviewReopens(artifactsDir: string, runId: string) {
  const raw = await readOptionalJsonFile<{ reopens?: unknown }>(
    join(artifactsDir, "runs", runId, "host-accepted-results-ledger.json"));
  return z.array(ReviewReopenEventSchema).parse(raw?.reopens ?? []);
}

/** These are the accepted inputs to an already planned review. Report and
 * answer state can still advance; frozen source, scope and evidence cannot. */
const protectedReviewInputs = [
  "run-snapshot.json", "run-consent.json", "scope.json", "intent_checkpoint.json",
  "repo_manifest.json", "file_disposition.json", "external_analyzer_acquisition.json",
  "external_analyzer_results.json", "analyzer_capability.json", "syntax_resolution_status.json", "review_plan.json",
] as const;

export async function qualifyQuestionReviewTooling(params: {
  artifactsDir: string;
  snapshotId?: string;
  prior?: ToolingManifest;
  current: ToolingManifest;
  recordedToolingHash?: string;
  requested?: ReviewToolingTransition;
  allowQualifiedReview: boolean;
}): Promise<ReviewToolingQualification | undefined> {
  const { artifactsDir, snapshotId, prior, current, requested, recordedToolingHash } = params;
  const run_id = await readQuestionReviewRunId(artifactsDir);
  if (!run_id) {
    if (requested) throw new Error("Tooling qualification requires an active question review.");
    return undefined;
  }
  const events = await readReviewReopens(artifactsDir, run_id);
  const saved = [...events].reverse().find(event => event.tooling_qualification)?.tooling_qualification;
  if (!requested && !saved) return undefined;
  if (!params.allowQualifiedReview) {
    throw new Error("Qualified question review supports only review submission and next-step, not standalone analysis.");
  }

  const toolingHash = (manifest: ToolingManifest) => hashArtifactValue("tooling_manifest.json", manifest);
  if (!snapshotId || !prior || toolingHash(prior) !== recordedToolingHash ||
      prior.implementation_hash === current.implementation_hash ||
      (requested && (requested.prior_implementation_hash !== prior.implementation_hash ||
        requested.current_implementation_hash !== current.implementation_hash))) {
    throw new Error("Tooling qualification must name the exact historical and current implementation of an active review.");
  }
  if (saved && (saved.run_id !== run_id || saved.snapshot_id !== snapshotId ||
      toolingHash(saved.prior) !== toolingHash(prior) || toolingHash(saved.current) !== toolingHash(current))) {
    throw new Error("Qualified review tooling no longer matches its run, snapshot or implementation.");
  }
  const input_hashes = Object.fromEntries(await Promise.all(protectedReviewInputs.map(async name => {
    const input = await readOptionalJsonFile<unknown>(join(artifactsDir, name));
    return [name, input === undefined ? null : contentSha256(input)] as const;
  })));
  const guidance = await readOptionalTextFile(join(artifactsDir, "intake", "conversation-start.md"));
  input_hashes["intake/conversation-start.md"] = guidance === undefined ? null : contentSha256(guidance);
  if (!input_hashes["run-snapshot.json"] || !input_hashes["repo_manifest.json"] || !input_hashes["review_plan.json"] ||
      (saved && stableStringify(saved.input_hashes) !== stableStringify(input_hashes))) {
    throw new Error("The qualified review tooling inputs changed or are missing.");
  }
  return saved ?? { policy: "source-stable-question-review/v1", run_id, snapshot_id: snapshotId, prior, current, input_hashes };
}
