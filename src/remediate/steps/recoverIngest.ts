// sites-pinned: tests/remediate/recover-verb-branches.test.ts, tests/remediate/host-handoff-corroboration-recovery.test.ts, tests/remediate/host-handoff-corroboration-lock-phases.test.ts
import { resolve } from "node:path";
import { callerWorkingDirectory, discoverRepoRoot, resolveRepoRoot } from "../../shared/io/repoRoot.js";
import { remediationArtifactsDir, headCommit, SKIP_WRITE, invalidateStepContracts } from "audit-tools/shared";
import { StateStore } from "../state/store.js";
import { currentHostBoundaryState } from "../state/runIdentity.js";
import { workloadBindingIdentity, precomputeRecoveryTestVerdicts, ingestRemediationHostResults } from "./dispatch/hostHandoff.js";
import { type RemediationHostIngestSummary } from "./dispatch/hostContracts.js";

/**
 * The `recover-ingest` verb's whole body: ingest the host's landed results in
 * RECOVERY mode and persist through the same file-locked, atomically-writing
 * store, with the same `contract_version` strip.
 *
 * It is a separate verb rather than a flag on `next-step` because the
 * relaxation it enables must be an operator's explicit act — see
 * `ingestRemediationHostResults`, which states what is waived and the residual
 * risk. Nothing else here differs from the normal ingestion: the same workload,
 * the same contract gates, the same eligibility frontier.
 *
 * ## Why this runs in two phases
 *
 * A required-test rerun is `spawnSync`, which blocks the event loop for its
 * whole duration. Run inside the state lock, it would starve the lock's own
 * heartbeat timer (`setInterval` in the shared fileLock) — the held lock's mtime
 * would stop being refreshed, a second acquirer would classify it as stale at
 * ~30s and steal it, and mutual exclusion would be gone precisely during the
 * longest critical section in the codebase. Holding a lock across a blocking
 * spawn is therefore not merely slow; it is unsound.
 *
 * So:
 *
 * - **Phase 1, UNLOCKED.** Snapshot the state, capture HEAD and the workload
 *   binding, and run every distinct required-test command exactly once
 *   (`precomputeRecoveryTestVerdicts`). Both identities are captured BEFORE the
 *   spawns, not after, because a host-authored command that MOVES HEAD would
 *   otherwise produce verdicts of mixed provenance and go undetected. (The HEAD
 *   guard compares commit shas: it sees HEAD movement, not worktree dirt — a
 *   command that only dirties files is invisible to it, which is acceptable
 *   because phase 2's corroboration is commit-based.)
 * - **Phase 2, LOCKED.** Re-read both identities and abort the whole recovery if
 *   either moved — `tree_moved_between_phases` for HEAD,
 *   `state_moved_between_phases` for the binding — because the phase-1 verdicts
 *   would describe a tree or a frontier that no longer exists, and nothing is
 *   accepted or appended. Otherwise ingest with the pre-computed verdicts, which
 *   the ingest only READS: in recovery mode it never spawns, and a command
 *   missing from the table fails closed.
 *
 * What remains inside the lock is git plumbing (ancestry, ref scan, diff-tree),
 * the ledger append, and the state write — sub-second work, comfortably inside
 * heartbeat coverage. The two unchanged-identity guards close the gap the phase
 * split opens; the operational protocol is still one writer at a time, now
 * enforced by a lock that cannot be stolen mid-hold instead of by convention.
 *
 * A recovery that changes nothing writes nothing: phase 2 returns the locked
 * store's `SKIP_WRITE` sentinel, which `StateStore.mutate` now honors, so the
 * retry loop of a genuinely-empty recovery no longer replaces `state.json` with
 * byte-identical content on every pass.
 */
export async function recoverIngestHostResults(options: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
}): Promise<RemediationHostIngestSummary> {
  const root = options.root === undefined ? discoverRepoRoot(callerWorkingDirectory()) : resolveRepoRoot(options.root);
  const artifactsDir = options.artifactsDir ? resolve(options.artifactsDir) : remediationArtifactsDir(root);
  const store = new StateStore(artifactsDir);
  await store.assertOperatorActive();

  // ── Phase 1: unlocked ────────────────────────────────────────────────────
  const snapshot = await store.loadState();
  if (!snapshot) {
    throw new Error(
      `No remediation state at ${artifactsDir} — there is nothing to ingest.`,
    );
  }
  const headBeforeTests = await headCommit(root);
  const bindingBeforeTests = workloadBindingIdentity(currentHostBoundaryState(snapshot));
  const requiredTestVerdicts = await precomputeRecoveryTestVerdicts({
    root,
    artifactsDir,
    runId: options.runId,
    state: currentHostBoundaryState(snapshot),
  });
  if (requiredTestVerdicts === "unsupported_retired_state") {
    throw new Error(
      "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
    );
  }

  // ── Phase 2: locked; children are async + deadline-bounded only ──────────
  // The long-running required tests were precomputed in Phase 1, outside the
  // lock. What still spawns under the hold is the corroboration git probes —
  // async on the tracked twin with the shared deadline (INV-SSF), so the
  // hold's heartbeat keeps beating through every probe.
  let ingested!: RemediationHostIngestSummary;
  await store.withActiveOperator(async () => {
  await store.mutate(async (state) => {
    if (!state) {
      throw new Error(
        `No remediation state at ${artifactsDir} — there is nothing to ingest.`,
      );
    }
    const headNow = await headCommit(root);
    const bindingNow = workloadBindingIdentity(currentHostBoundaryState(state));
    // TWO identities, because they catch different writers. HEAD moves when the
    // tree does; the workload binding moves when a concurrent state writer
    // settles items or re-mints the workload without committing anything. The
    // verdict table describes the frontier as it was at phase 1, so either
    // change invalidates it — and a stale table is not merely imprecise: the
    // commands it no longer covers read as `required_test_failed`, which
    // attributes a bookkeeping race to the host's work.
    const moved =
      headNow !== headBeforeTests
        ? "tree"
        : bindingNow !== bindingBeforeTests
          ? "state"
          : null;
    if (moved !== null) {
      ingested = {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
        // This verdict aborts the whole recovery BEFORE any item is read, so
        // there is no per-item observation to report — an empty map is the
        // honest statement of that, not a missing field.
        work_item_outcomes: new Map(),
        issues: [
          moved === "tree"
            ? {
                code: "tree_moved_between_phases",
                message:
                  `HEAD moved from ${headBeforeTests ?? "(none)"} to ${headNow ?? "(none)"} ` +
                  "while the required tests were running, so their verdicts no longer describe " +
                  "this tree. Nothing was accepted; re-run recover-ingest on a settled tree.",
              }
            : {
                code: "state_moved_between_phases",
                message:
                  "the run's workload binding changed while the required tests were running, " +
                  "so their verdicts no longer describe the pending frontier. Nothing was " +
                  "accepted; re-run recover-ingest once no other writer is advancing this run.",
              },
        ],
        state_changed: false,
        state: currentHostBoundaryState(state),
      };
      // The lock was taken to WRITE. Nothing changed, so write nothing: the
      // no-op sentinel is what keeps a settled recovery from replacing
      // state.json with byte-identical content on every retry.
      return SKIP_WRITE;
    }
    const outcome = await ingestRemediationHostResults({
      root,
      artifactsDir,
      runId: options.runId,
      state: currentHostBoundaryState(state),
      recovery: { requiredTestVerdicts },
    });
    if (outcome === "unsupported_retired_state") {
      throw new Error(
        "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
      );
    }
    ingested = outcome;
    // A nothing-to-recover pass returns the sentinel, not the state it read: the
    // mutation is a no-op and must not rewrite the file (see StateStore.mutate).
    if (!outcome.state_changed) return SKIP_WRITE;
    // No `contract_version` strip. The boundary helper below stamps the version
    // onto the state it hands the host handoff, and this used to peel it back
    // off on the way to disk so `state.json` matched what was written before.
    // The STORE now owns that field end to end — it stamps it on read and the
    // write hook validates it — so peeling it here would persist a state
    // without the identity the store just established, and the next read would
    // have to re-invent it.
    return outcome.state;
  });
  // The run moved, so the persisted step contract no longer describes it: it
  // names work this ingest just resolved, against a workload binding this ingest
  // may have cleared. Invalidate it — but only when something actually changed,
  // because a no-op recovery must leave the tree byte-identical (which is the
  // same reason the mutation above writes nothing).
  if (ingested.state_changed) {
    await invalidateStepContracts(artifactsDir);
  }
  });
  return ingested;
}
