/**
 * `remediate-code submit --work-item <id> --from <file>` — the remediate twin of
 * `audit-code submit` (decision 4, 2026-11-06).
 *
 * The implementer hands the tool its result and the tool writes the bound path.
 * Only an id and a path pass the shell, so evidence text that holds a backslash
 * reaches the bound path byte-exact. The tool judges the document with the
 * per-result contract ingestion applies (envelope and identity) BEFORE it
 * writes: a refused result never lands. The commit corroboration, the write
 * scope and the required-test rerun stay at ingestion, because they read the
 * tree at ingest time.
 *
 * This is the NORMAL lane, so it records no `recovered_by_hand` event: that
 * record belongs to `recover-submission`, the operator's rescue.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { deriveResultId } from "audit-tools/shared";

import { submitRemediationWorkItemResult } from "../../src/remediate/steps/submitResult.js";
import { prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../src/remediate/state/store.js";
import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import { writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";

const harness = createNextStepHarness(".test-result-submit");
const { REPO_DIR, ARTIFACTS_DIR, saveState, resetTestRepo, cleanupTestRepo } = harness;

beforeEach(async () => {
  await resetTestRepo();
});

afterEach(async () => {
  await cleanupTestRepo();
});

function git(args: string[]): string {
  const result = spawnSyncHidden("git", args, { cwd: REPO_DIR, encoding: "utf8" }) as { stdout?: string };
  return (result.stdout ?? "").trim();
}

interface BoundItem {
  readonly id: string;
  readonly result_path: string;
  readonly obligation_ids: readonly string[];
  readonly prompt: { readonly sha256: string };
}

/** A persisted run whose workload the production handoff minted. */
async function persistRunnableState(): Promise<BoundItem> {
  const state = makePlanningState({
    contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    status: "implementing",
    plan: { ...makePlanningState().plan!, plan_id: "RUN-1" },
  });
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  for (const file of ["src/a.ts", "src/b.ts"]) await writeFile(join(REPO_DIR, file), "// reviewed fixture source\n");
  git(["add", "src"]);
  git(["commit", "-m", "reviewed fixture baseline"]);
  await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
  const prepared = await prepareRemediationHostHandoff({
    root: REPO_DIR,
    artifactsDir: ARTIFACTS_DIR,
    runId: "RUN-1",
    baselineCommit: git(["rev-parse", "HEAD"]),
    state,
  });
  if (prepared === "unsupported_retired_state") throw new Error("fixture state unexpectedly rejected");
  await saveState({ ...state, host_handoff: prepared.handoff_record });
  return prepared.workload.work_items[0]!;
}

function landedResult(item: BoundItem, promptSha256: string): Record<string, unknown> {
  return {
    contract_version: RESULT_VERSION,
    result_id: deriveResultId(item.id, item.prompt.sha256),
    run_id: "RUN-1",
    work_item_id: item.id,
    prompt_sha256: promptSha256,
    landed_commit: git(["rev-parse", "HEAD"]),
    obligation_evidence: item.obligation_ids.map((obligation_id) => ({
      obligation_id,
      // One backslash in the evidence: the regular expression `\s+`.
      evidence: ["The guard now rejects /\\s+/ before the length check in src/a.ts"],
    })),
  };
}

test("submit writes a judged result to its bound path byte-exact, and refuses one the contract refuses", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const item = await persistRunnableState();
  const boundPath = join(REPO_DIR, item.result_path);

  // Refused: a wrong prompt digest fails the identity check ingestion applies.
  const refused = await submitRemediationWorkItemResult({
    root: REPO_DIR,
    artifactsDir: ARTIFACTS_DIR,
    workItemId: item.id,
    source: JSON.stringify(landedResult(item, "0".repeat(64))),
  });
  expect(refused.written).toBe(false);
  expect(refused.issues.map((issue) => issue.message).join("\n")).toMatch(/prompt/u);
  expect(existsSync(boundPath)).toBe(false);

  // Accepted: the bound path holds the submitted bytes, backslash intact.
  const bytes = JSON.stringify(landedResult(item, item.prompt.sha256), null, 2);
  expect(bytes).toContain("\\\\s+");
  const accepted = await submitRemediationWorkItemResult({
    root: REPO_DIR,
    artifactsDir: ARTIFACTS_DIR,
    workItemId: item.id,
    source: bytes,
  });
  expect(accepted.issues).toEqual([]);
  expect(accepted.written).toBe(true);
  expect(accepted.result_path).toBe(item.result_path);
  expect(await readFile(boundPath, "utf8")).toBe(bytes);
});

test("submit refuses a work item the current run does not publish, and writes nothing", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await persistRunnableState();
  await expect(
    submitRemediationWorkItemResult({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      workItemId: "no-such-item",
      source: "{}",
    }),
  ).rejects.toThrow(/no-such-item.*not a work item/u);
});
