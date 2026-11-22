import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuestionReviewRunId } from "../../src/audit/cli/questionReviewSession.js";

test("a custom question session rejects unsafe and unreadable pointers without rebinding", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-question-session-"));
  try {
    const artifactsDir = join(root, "custom-audit");
    await mkdir(artifactsDir);
    const pointer = join(artifactsDir, "review_session.json");
    const record = { schema_version: "audit-tools/question-review-session/v1", run_id: "question-review-active" };
    expect(await readQuestionReviewRunId(artifactsDir)).toBeUndefined();
    await writeFile(pointer, JSON.stringify(record));
    expect(await readQuestionReviewRunId(artifactsDir)).toBe(record.run_id);
    await writeFile(pointer, JSON.stringify({ ...record, run_id: "question-review-../outside" }));
    await expect(readQuestionReviewRunId(artifactsDir)).rejects.toThrow();
    await rm(pointer);
    await mkdir(pointer);
    await expect(readQuestionReviewRunId(artifactsDir)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
