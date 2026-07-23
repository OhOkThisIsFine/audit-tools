/**
 * inv-8 — accept-outcome reconciliation (CE-201): bind the THREE durable
 * records of a node's landing before any force-close mapping runs.
 *
 * The accept lifecycle has two unavoidable kill windows:
 *
 *   window 1 — the process dies BETWEEN `mergeWorktree`'s cherry-pick and
 *     `recordNodeAcceptOutcome`: the commit IS on the base branch, but the
 *     sidecar on disk is a PRIOR attempt's stale `merged:false` (or absent);
 *   window 2 — the process dies BETWEEN `recordNodeAcceptOutcome` and the
 *     state merge: the sidecar says `merged:true`, but the item statuses are
 *     still in-progress.
 *
 * In both windows the run's durable records DISAGREE about a landed block. A
 * force-close that trusts only the state (invariant 9's blocked mapping) then
 * reports a LANDED fix as blocked and omits its files from the staging
 * manifest. This module reconciles the disagreement from git ground truth:
 *
 *   1. git — the base-reachable tool-owned commits: `commitWorktree` stamps
 *      the exact subject `remediate <blockId> (<runId>)`, so a `git log
 *      --fixed-strings --grep` over HEAD ancestry, filtered to EXACT-subject
 *      matches, is the authoritative landed-evidence probe (a cherry-pick
 *      rewrites the OID but preserves the subject — the sidecar's
 *      `committed_oid` is the BRANCH tip, never the landed commit, which is
 *      why detection is disagreement-keyed rather than OID-equality-keyed,
 *      and never keyed on sidecar absence alone);
 *   2. the sidecar (`accept-outcome-<block>.json`) — repaired to
 *      `merged:true` with the landed OID + files when git disproves it;
 *   3. the state — in-progress items of a landed block are reconciled to
 *      `resolved`, and the landed files are unioned into
 *      `applied_edit_surface` (the close phase's staging manifest source).
 *
 * A block with NO landed evidence is left untouched — invariant 9's
 * force-close blocked mapping stays valid exactly when reconciliation ran and
 * found nothing (its precondition, pinned by the no-evidence control test).
 */

import { spawnSyncHidden } from "audit-tools/shared";
import type { RemediationState } from "../../state/store.js";
import { isInProgressStatus } from "../../state/itemStatus.js";
import { loadNodeAcceptOutcome, recordNodeAcceptOutcome } from "./acceptNode.js";

/** One repaired block's landed evidence. */
export interface ReconciledBlock {
  block_id: string;
  /** The base-reachable commit OIDs whose subject is this block's exact tool subject. */
  landed_oids: string[];
  /** Repo-relative files those commits touched (path-sorted, de-duplicated). */
  landed_files: string[];
}

export interface AcceptReconcileResult {
  /** True when any sidecar/state repair was applied. */
  changed: boolean;
  reconciled: ReconciledBlock[];
}

/** The exact tool-owned commit subject `commitWorktree` stamps for a block. */
function acceptCommitSubject(blockId: string, runId: string): string {
  return `remediate ${blockId} (${runId})`;
}

/**
 * Base-reachable commits whose subject EXACTLY equals the block's tool subject.
 * `--grep` is a substring match even with `--fixed-strings`, so the results are
 * filtered to exact-subject equality — a human commit that merely mentions the
 * subject can never count as landed evidence.
 */
function landedCommitsForBlock(
  root: string,
  blockId: string,
  runId: string,
): Array<{ oid: string; subject: string }> {
  const subject = acceptCommitSubject(blockId, runId);
  const log = spawnSyncHidden(
    "git",
    ["log", "--format=%H%x1f%s", "--fixed-strings", `--grep=${subject}`, "HEAD"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (log.error || log.status !== 0) return [];
  const out: Array<{ oid: string; subject: string }> = [];
  for (const line of (log.stdout ?? "").split("\n")) {
    const [oid, s] = line.split("\x1f");
    if (oid && s === subject) out.push({ oid, subject: s });
  }
  return out;
}

/** Repo-relative files a commit touched. */
function filesOfCommit(root: string, oid: string): string[] {
  const show = spawnSyncHidden(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", oid],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (show.error || show.status !== 0) return [];
  return (show.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Reconcile every block's three durable records against git ground truth.
 * MUTATES `state` in place (items + applied_edit_surface) and repairs stale
 * sidecars via {@link recordNodeAcceptOutcome} (whose merged:true guard makes
 * the repair monotonic). Call BEFORE any force-close mapping — the close
 * phase wires it at the top of `runClosePhase`.
 *
 * Never throws: a git failure degrades to "no landed evidence" (the
 * conservative reading — nothing is force-resolved without proof).
 */
export async function reconcileAcceptOutcomes(args: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
}): Promise<AcceptReconcileResult> {
  const { root, artifactsDir, state } = args;
  const runId = state.plan?.plan_id;
  const blocks = state.plan?.blocks ?? [];
  const result: AcceptReconcileResult = { changed: false, reconciled: [] };
  if (!runId || blocks.length === 0) return result;

  for (const block of blocks) {
    const items = block.items
      .map((id) => state.items?.[id])
      .filter((it): it is NonNullable<typeof it> => it !== undefined);
    const sidecar = await loadNodeAcceptOutcome(artifactsDir, runId, block.block_id);
    const anyInProgress = items.some((it) => isInProgressStatus(it.status));
    const sidecarDisagrees = sidecar !== null && sidecar.merged !== true;

    // Only probe git when a record disagrees with "cleanly landed and merged
    // into state": an in-progress item (window 1 or 2) or a merged:false /
    // absent sidecar alongside them. Fully-terminal blocks with a merged:true
    // sidecar have nothing to reconcile.
    if (!anyInProgress && !sidecarDisagrees) continue;

    const landed = landedCommitsForBlock(root, block.block_id, runId);
    if (landed.length === 0) {
      // No landed evidence: leave the records as they are — invariant 9's
      // force-close blocked mapping is now justified for this block.
      continue;
    }

    const landedFiles = [
      ...new Set(landed.flatMap((c) => filesOfCommit(root, c.oid))),
    ].sort();
    const landedOids = landed.map((c) => c.oid);

    // Record 2 — repair a stale sidecar to the git truth (monotonic: the
    // recordNodeAcceptOutcome guard never regresses merged:true→false).
    if (sidecar === null || sidecar.merged !== true) {
      await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, {
        outcome: "success",
        verifyPassed: sidecar?.verifyPassed ?? true,
        merged: true,
        ...(sidecar?.committedOid !== undefined
          ? { committedOid: sidecar.committedOid }
          : {}),
        landedHeadOid: landedOids[0]!,
        editedFiles: landedFiles,
      });
      result.changed = true;
    }

    // Record 3 — reconcile in-progress items of the landed block to resolved
    // and union the landed files into the staging manifest.
    for (const item of items) {
      if (!isInProgressStatus(item.status)) continue;
      const now = new Date().toISOString();
      item.status = "resolved";
      item.started_at ??= now;
      item.completed_at = now;
      item.failure_reason = undefined;
      result.changed = true;
    }
    if (landedFiles.length > 0) {
      state.applied_edit_surface = [
        ...new Set([...(state.applied_edit_surface ?? []), ...landedFiles]),
      ].sort();
      result.changed = true;
    }
    result.reconciled.push({
      block_id: block.block_id,
      landed_oids: landedOids,
      landed_files: landedFiles,
    });
  }
  return result;
}
