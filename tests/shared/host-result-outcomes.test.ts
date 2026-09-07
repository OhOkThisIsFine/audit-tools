import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendSubmissionEvent,
  enrichMissingSubmissionIssues,
  readTrailingSubmissionRefusals,
  readSubmissionLedger,
  recordHostResultOutcomes,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
} from "../../src/shared/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(
  runId: string,
  submissionId: string,
  kind: "rejected" | "accepted_via_recovery" | "removed_by_operator",
  issueCode?: string,
) {
  return {
    contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
    run_id: runId,
    submission_id: submissionId,
    lane: submissionId,
    kind,
    ...(issueCode === undefined ? {} : { issue_code: issueCode, message: `original ${issueCode} reason` }),
    recorded_at: new Date().toISOString(),
  } as const;
}

describe("shared host-result outcome history", () => {
  it("keeps substantive refusal history, scopes remediation runs, and preserves recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-result-outcomes-"));
    roots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await appendSubmissionEvent(artifactsDir, event("run-a", "item-a", "rejected", "submission_malformed"));
    await recordHostResultOutcomes(
      artifactsDir,
      "run-a",
      { issues: [{ code: "submission_missing", message: "missing now", work_item_id: "item-a" }], acceptedIds: [] },
      { scopeToRunId: "run-a" },
    );
    expect(await readSubmissionLedger(artifactsDir)).toHaveLength(1);
    const refusal = await readTrailingSubmissionRefusals(artifactsDir, ["item-a"], { runId: "run-a" });
    expect(refusal.get("item-a")?.issue_code).toBe("submission_malformed");
    expect((await readTrailingSubmissionRefusals(artifactsDir, ["item-a"], { runId: "run-b" })).size).toBe(0);

    await appendSubmissionEvent(artifactsDir, event("run-a", "item-a", "accepted_via_recovery"));
    expect((await readTrailingSubmissionRefusals(artifactsDir, ["item-a"], { runId: "run-a" })).size).toBe(0);
    await recordHostResultOutcomes(
      artifactsDir,
      "run-a",
      { issues: [], acceptedIds: ["item-a"] },
      { scopeToRunId: "run-a" },
    );
    expect((await readSubmissionLedger(artifactsDir)).map((row) => row.kind)).toEqual([
      "rejected", "accepted_via_recovery",
    ]);
    await appendSubmissionEvent(artifactsDir, event("run-a", "item-a", "removed_by_operator"));
    await recordHostResultOutcomes(
      artifactsDir,
      "run-a",
      { issues: [], acceptedIds: ["item-a"] },
      { scopeToRunId: "run-a" },
    );
    expect((await readSubmissionLedger(artifactsDir)).map((row) => row.kind)).toEqual([
      "rejected", "accepted_via_recovery", "removed_by_operator", "accepted",
    ]);
    const decorated = enrichMissingSubmissionIssues(
      [{ code: "submission_missing", message: "item-a missing", work_item_id: "item-a" }],
      refusal,
      "submission_rejected",
    );
    expect(decorated[0]!.code).toBe("submission_rejected");
    expect(decorated[0]!.message).toContain("submission_malformed");
  });
});
