// sites-pinned: tests/remediate/decision-consumption-recovery.test.ts, tests/remediate/clarification-round-contract.test.ts
import { open, rename, link, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { compareCodeUnits, hashContent, stableStringify, withFsRetry, writeJsonFile } from "audit-tools/shared";
import type { RemediationPlan, RemediationItemState } from "./types.js";
interface DecisionState {
  plan?: RemediationPlan;
  items?: Record<string, RemediationItemState>;
  started_at?: string;
  decision_applications?: DecisionApplicationReceipt[];
}

const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
export const DecisionApplicationReceiptSchema = z.object({
  input: z.enum(["clarification_resolution.json", "triage_resolution.json"]),
  input_sha256: Digest,
  input_identity_sha256: Digest,
  context_sha256: Digest,
  run_id: z.string().min(1),
  revision_sha256: Digest,
  applied_at: z.string().datetime(),
  cleanup_complete: z.boolean().optional(),
  retry_results: z.array(z.object({ path: z.string().min(1).refine(path => !isAbsolute(path) && !path.split(/[\\/]/u).includes("..")), sha256: Digest, identity_sha256: Digest }).strict()),
  outcome: z.object({ resolved_at: z.string().datetime(), items: z.array(z.object({ unit_id: z.string(), action: z.string() }).strict()) }).strict().optional(),
}).strict();
export type DecisionApplicationReceipt = z.infer<typeof DecisionApplicationReceiptSchema>;

/** Hash and parse consumers use the same open-file snapshot, even if its path is replaced. */
export async function readDecisionSnapshot(path: string): Promise<{ bytes: string; sha256: string; identity_sha256: string } | undefined> {
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = await handle.stat();
    const data = await handle.readFile();
    const bytes = data.toString("utf8");
    const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Operator input changed while reading; retry without accepting it.");
    const inputDigest = hashContent(data);
    const identity_sha256 = hashContent(stableStringify({
      sha256: inputDigest, dev: after.dev, ino: after.ino, birthtime: after.birthtimeMs, mtime: after.mtimeMs, size: after.size,
    }));
    return { bytes, sha256: inputDigest, identity_sha256 };
  } finally { await handle.close(); }
}

async function archiveCommittedSnapshot(path: string, expected: { sha256: string; identity_sha256: string }, archive: string): Promise<void> {
  const staged = `${archive}.pending-cleanup`;
  // A crash after rename resumes from this deterministic path before examining a replacement at the live path.
  if (!(await readDecisionSnapshot(staged))) {
    try { await withFsRetry(() => rename(path, staged)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  const snapshot = await readDecisionSnapshot(staged);
  if (!snapshot) return;
  if (snapshot.sha256 === expected.sha256 && snapshot.identity_sha256 === expected.identity_sha256) {
    await withFsRetry(() => rename(staged, archive));
    return;
  }
  // Hard-link restoration cannot overwrite a newer file that landed after staging.
  // When a newer live file exists, retain the unmatched staged evidence alongside it.
  try { await link(staged, path); await unlink(staged); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await withFsRetry(() => rename(staged, `${archive}.replacement-preserved`));
  }
}

export function decisionContextDigest(state: DecisionState): string {
  return hashContent(stableStringify({
    plan_id: state.plan?.plan_id, revision: state.plan?.review_revision_sha256,
    started_at: state.started_at,
    items: Object.values(state.items ?? {}).map(item => ({
      unit_id: item.unit_id, status: item.status, rework_count: item.rework_count ?? 0,
      question: item.clarification_question, failure_reason: item.failure_reason,
      last_successful_step: item.last_successful_step,
    })).sort((a, b) => compareCodeUnits(a.unit_id, b.unit_id)),
  }));
}

/** Only a durably committed receipt may authorize cleanup; mismatching replacement bytes survive. */
export async function reconcileDecisionCleanup(state: DecisionState, artifactsDir: string): Promise<boolean> {
  let changed = false;
  for (const receipt of state.decision_applications ?? []) {
    try {
    if (receipt.cleanup_complete) {
      const input = join(artifactsDir, receipt.input);
      const archive = `${input}.stale-${receipt.context_sha256}-${receipt.input_identity_sha256}`;
      const staged = await readDecisionSnapshot(`${archive}.pending-cleanup`);
      const snapshot = await readDecisionSnapshot(input);
      if (staged || (snapshot?.sha256 === receipt.input_sha256 && snapshot.identity_sha256 === receipt.input_identity_sha256)) {
        await archiveCommittedSnapshot(input, { sha256: receipt.input_sha256, identity_sha256: receipt.input_identity_sha256 }, archive);
      }
      continue;
    }
      if (receipt.outcome) await writeJsonFile(join(artifactsDir, "triage-outcome.json"), receipt.outcome);
      for (const result of receipt.retry_results) {
        const path = join(artifactsDir, result.path);
        await archiveCommittedSnapshot(path, result, `${path}.stale-${receipt.context_sha256}-${result.identity_sha256}`);
      }
      const input = join(artifactsDir, receipt.input);
      await archiveCommittedSnapshot(input, { sha256: receipt.input_sha256, identity_sha256: receipt.input_identity_sha256 },
        `${input}.consumed-${receipt.context_sha256}-${receipt.input_identity_sha256}`);
      receipt.cleanup_complete = true;
      changed = true;
    } catch (error) {
      throw new Error(`Operator decision is committed; pending cleanup for ${receipt.input}. Resume to reconcile cleanup before continuing.`, { cause: error });
    }
  }
  return changed;
}
