// sites-pinned: tests/audit/result-submit.test.ts, tests/audit/rollover-legacy-archive.test.ts, tests/audit/next-step-question-workload.test.ts
// sites-pinned: tests/audit/result-submit.test.ts, tests/audit/next-step-question-workload.test.ts
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { assertSubmissionRunId, isFileMissingError, readJsonFile, writeJsonFile } from "audit-tools/shared";
import { z } from "zod";

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
