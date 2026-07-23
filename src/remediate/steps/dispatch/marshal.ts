import { mkdir, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OwnershipRegistry } from "../../dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../../dispatch/amendmentClaim.js";
import { fromBlockId } from "../../contractPipeline/idRegistry.js";
import { readContractArtifact } from "../../contractPipeline/artifactStore.js";
import { verifyPairingForFinding } from "../../contractPipeline/changeClassification.js";
import { StateStore, type RemediationState } from "../../state/store.js";
import { deriveRemediationAccessMemory } from "../../state/accessMemory.js";
import {
  REMEDIATION_STEP,
  isClarificationCategory,
  type RemediationBlock,
} from "../../state/types.js";
import type { SessionConfig, HostModelRosterEntry } from "audit-tools/shared";
import { captureStepBoundaryFriction, emitBlindDispatchFrictionIfBlind } from "audit-tools/shared";
import { readConfirmedCostPositions, readConfirmedDispatchBias, readConfirmedCapabilityRanks } from "audit-tools/shared";
import {
  AGENT_FEEDBACK_FILENAME,
  readJsonFile,
  readOptionalJsonFile,
  writeJsonFile,
  writeTextFile,
  withFsRetry,
  formatValidationIssues,
  toPromptPathToken,
} from "audit-tools/shared";
import { validateImplementWorkerResult } from "../../validation/artifacts.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  type DispatchPlanItem,
  type ImplementWorkerResult,
  type RemediationDispatchPlan,
} from "../types.js";
import {
  specIndicatesNoChange,
  hasExecutableEvidence,
  dependencyVerifiedComplete,
} from "../stepUtils.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
  isSkipStatus,
} from "../../state/itemStatus.js";
import { resnapshotAffectedFileHashes } from "../../utils/fileIntegrity.js";
import { reconcileAdmissionLeasesFromQuotaFile } from "audit-tools/shared";
import {
  DispatchOptions,
  runDir,
  dispatchPlanPath,
  getCachedConventions,
  estimateImplementSlotTokens,
  worktreeBranchForBlock,
  gitBranchExists,
  gitEditedFilesForBranch,
  gitHunksForBranch,
  gitCommitIsAncestor,
  toRepoRelative,
} from "./common.js";
import {
  worktreePath,
  ensureRemediationBranchCheckedOut,
  quarantineCommitByOid,
} from "./worktreeLifecycle.js";
import { scheduleWave, buildDispatchQuota } from "./waveScheduling.js";
import {
  buildBlockAliasMap,
  collapseItemResults,
  buildNodeDisposition,
  attributeSiblingRed,
  detectOverlappingEdits,
  type BlockEditedFiles,
} from "./writeScope.js";
import {
  buildImplementDispatchItem,
  blockReadFiles,
  detectPackageRoot,
  buildTestFileIndex,
  collectReferencingTests,
  implementPrompt,
} from "./implementPrompt.js";
import { loadNodeAcceptOutcome } from "./acceptNode.js";

// Re-exported so callers importing DispatchOptions from the barrel keep working.
export type { DispatchOptions } from "./common.js";

// ---------------------------------------------------------------------------
// Marshalling helpers
// ---------------------------------------------------------------------------

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function markStarted(item: { started_at?: string; completed_at?: string }): void {
  item.started_at ??= new Date().toISOString();
  delete item.completed_at;
}

function markTerminal(item: { started_at?: string; completed_at?: string }): void {
  const now = new Date().toISOString();
  item.started_at ??= now;
  item.completed_at = now;
}

/**
 * Load a worker's already-written implement result, distinguishing an ABSENT
 * file (the worker hasn't run yet → re-dispatch from scratch) from a PRESENT but
 * INVALID one (the worker ran but emitted malformed/unparseable JSON or a result
 * that fails the contract). A bare `catch → undefined` conflated the two: a
 * written-but-invalid file looked identical to "never produced", so the merge
 * loop silently `continue`d past the block (the missing-file branch never fires
 * because the file DOES exist) and the node could neither converge nor surface
 * the corruption. We now archive the invalid file (so a clean re-dispatch can
 * write a fresh one) and report it loudly, returning `undefined` only for the
 * genuinely-absent case.
 */
async function tryLoadExistingImplementResult(
  resultPath: string,
): Promise<ImplementWorkerResult | undefined> {
  if (!existsSync(resultPath)) return undefined;
  try {
    const result = await readJsonFile<unknown>(resultPath);
    assertImplementWorkerResult(result, resultPath);
    return result;
  } catch (err) {
    // Present but invalid: do NOT treat it as absent (which would let the block
    // be silently dropped from the merge). Archive the corrupt file and surface
    // the reason so a clean re-dispatch produces a valid result.
    process.stderr.write(
      `[remediate-code] dispatch: existing implement result ${resultPath} is present but ` +
        `invalid (${err instanceof Error ? err.message : String(err)}); archiving and re-dispatching\n`,
    );
    await archiveIncompleteImplementResult(resultPath);
    return undefined;
  }
}

function pendingOrDocumentedFindingIdsForBlock(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  return block.items.filter((findingId) => {
    const item = state.items?.[findingId];
    return item?.status === "pending" && !isTerminalStatus(item.status);
  });
}

/**
 * Bound on incomplete-coverage re-dispatch (E2): after this many merges observe a
 * worker silently omitting an assigned finding from its `item_results`, the finding
 * is blocked (→ triage) so the run converges instead of re-dispatching the same
 * worker indefinitely. Mirrors the other small convergence caps (DAG/cyclic-seam = 2).
 */
const MAX_INCOMPLETE_COVERAGE_ATTEMPTS = 2;

/**
 * Resolve the set of finding ids a worker result actually covers, alias-aware:
 * a worker may legitimately report a finding by its block id or an obligation
 * alias (the exact resolution `collapseItemResults` applies). Coverage/completeness
 * decisions MUST use this — a raw `finding_id` set would treat an alias-using-but-
 * complete result as incomplete and re-dispatch it forever.
 */
function resolveCoveredFindingIds(
  result: ImplementWorkerResult,
  block: RemediationBlock,
  state: RemediationState,
): Set<string> {
  const knownFindingIds = new Set(Object.keys(state.items ?? {}));
  const aliasMap = buildBlockAliasMap(block, state);
  const covered = new Set<string>();
  for (const entry of result.item_results) {
    let targetId = entry.finding_id;
    if (!knownFindingIds.has(targetId)) {
      const nodeId = fromBlockId(targetId);
      if (nodeId && knownFindingIds.has(nodeId)) {
        targetId = nodeId;
      } else {
        const remapped = aliasMap.get(targetId);
        if (!remapped) continue;
        targetId = remapped;
      }
    }
    covered.add(targetId);
  }
  return covered;
}

function implementResultCoversFindings(
  result: ImplementWorkerResult,
  findingIds: string[],
  block: RemediationBlock,
  state: RemediationState,
): boolean {
  const covered = resolveCoveredFindingIds(result, block, state);
  return findingIds.every((findingId) => covered.has(findingId));
}

async function archiveIncompleteImplementResult(resultPath: string): Promise<void> {
  if (!existsSync(resultPath)) return;
  const archivedPath = `${resultPath}.stale-${Date.now()}`;
  await withFsRetry(() => rename(resultPath, archivedPath));
}

/**
 * Admission refusal reasons that are TRANSIENT — the condition can change
 * between waves (a budget resets, a concurrent wave's ledger hold frees, a
 * window calibrates), so a refused-but-never-dispatched node stays PENDING for
 * the next grant instead of terminal-blocking its subtree. `no_capable_pool` is
 * deliberately absent: it is structural (the packet fits no pool at all —
 * waiting changes nothing), per `classifyEmptyGrantCause` in
 * audit-tools/shared hostDispatchWall.
 */
const TRANSIENT_REFUSAL_REASONS = new Set([
  "budget_exhausted",
  "cap_reached",
  "window_uncalibrated",
]);

/** Waves a transiently-refused node may sit undispatched before it blocks. */
const MAX_UNDISPATCHED_TRANSIENT_ATTEMPTS = 3;

async function loadStateOrThrow(
  artifactsDir: string,
): Promise<RemediationState> {
  const state = await new StateStore(artifactsDir).loadState();
  if (!state) {
    throw new Error(`No remediation state found at ${join(artifactsDir, "state.json")}.`);
  }
  return state;
}

export async function prepareImplementDispatch(
  options: DispatchOptions,
  runId: string,
  onlyBlockId?: string,
  waveOptions?: {
    hostMaxConcurrent?: number;
    sessionConfig?: SessionConfig | null;
    hostContextTokens?: number | null;
    hostOutputTokens?: number | null;
    hostModels?: HostModelRosterEntry[] | null;
    hostModelId?: string | null;
    /**
     * Root each node's prompt at its isolated worktree (the deterministic
     * `worktreePath(root, block_id, runId)`) rather than the main checkout. Set by
     * the rolling engine (`driveRollingImplementDispatch`) so a worker told its
     * repository root is the worktree edits there, not the shared main tree.
     */
    worktreeRootedPrompts?: boolean;
    /**
     * Lease the granted admitted set against the shared reservation ledger. The
     * host-subagent rolling path leaves this unset (defaults true — it dispatches the
     * grant across processes and reconciles at accept-node); the in-process rolling
     * engine passes `false` (it admits + leases per-packet itself, so a host grant
     * here would double-count). Threaded into `buildDispatchQuota`.
     */
    grantLeases?: boolean;
  },
): Promise<RemediationDispatchPlan> {
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.plan || !state.items) {
    throw new Error("Cannot prepare implement dispatch without plan and items.");
  }

  const dir = runDir(options.artifactsDir, runId, "implement");
  await mkdir(dir, { recursive: true });

  // Use the module-level cache so repeated calls within the same process do not
  // re-scan the filesystem for repo conventions.
  const conventions = getCachedConventions(options.root);

  const seenBlockIds = new Set<string>();
  const eligibleBlocks = state.plan.blocks.filter((block) => {
    if (onlyBlockId && block.block_id !== onlyBlockId) return false;
    if (seenBlockIds.has(block.block_id)) return false;
    // Rolling eligibility (INV-RS-01): a dependent node is dispatched only once
    // every prerequisite reached a VERIFIED-COMPLETE disposition
    // (resolved / resolved_no_change). A skipped or blocked prerequisite never
    // satisfies the edge, so the dependent is held back rather than racing the
    // main tree against an upstream surface that never landed.
    if (!dependencyVerifiedComplete(block, state)) return false;
    const hasWork = block.items.some((findingId) => {
      const item = state.items?.[findingId];
      return item?.status === "pending";
    });
    if (hasWork) {
      seenBlockIds.add(block.block_id);
      return true;
    }
    return false;
  });

  // Dispatch-boundary empty-scope guard (anti-cascade retry spec): a node with
  // no declared surface AND no finding-cited files has nothing a worker may
  // write — dispatching it wastes a slot, and silently excluding it would leave
  // its items pending forever (a livelock). Refuse it HERE, terminally and
  // loudly, so the structural case is impossible to enqueue rather than merely
  // detectable afterwards.
  const emptyScopeBlocks = eligibleBlocks.filter(
    (block) =>
      (block.touched_files ?? []).length === 0 &&
      block.items.every(
        (findingId) =>
          (state.plan?.findings.find((f) => f.id === findingId)?.affected_files ?? [])
            .length === 0,
      ),
  );
  if (emptyScopeBlocks.length > 0) {
    const store = new StateStore(options.artifactsDir);
    await store.mutate(async (current) => {
      const s = current ?? state;
      for (const block of emptyScopeBlocks) {
        for (const findingId of block.items) {
          const stateItem = s.items?.[findingId];
          if (!stateItem || isTerminalStatus(stateItem.status)) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Empty dispatch scope: block ${block.block_id} declares no touched_files ` +
            `and its finding(s) cite no affected_files — there is nothing a worker ` +
            `could be scoped to write, so the node was refused at the dispatch ` +
            `boundary (structural, never retried).`;
        }
        process.stderr.write(
          `[remediate-code] dispatch: refusing empty-scope block ${block.block_id} ` +
            `at the dispatch boundary (no touched_files, no affected_files).\n`,
        );
      }
      return s;
    });
  }
  const emptyScopeIds = new Set(emptyScopeBlocks.map((b) => b.block_id));
  const candidateBlocks = eligibleBlocks.filter((b) => !emptyScopeIds.has(b.block_id));

  // Before any node is dispatched (and therefore before any accepted commit is
  // cherry-picked into the main tree), switch the main checkout onto the dedicated
  // remediation branch so all landed work accumulates there and the base branch is
  // never modified. Idempotent across waves; only when there is work to land.
  if (candidateBlocks.length > 0 && options.root) {
    ensureRemediationBranchCheckedOut(options.root, runId, options.artifactsDir);
  }

  // Walk the repo for test files ONCE per dispatch (not once per block) and cache
  // their contents; collectReferencingTests then matches in memory.
  const testIndex = buildTestFileIndex(options.root);

  const items: DispatchPlanItem[] = [];
  const itemReadFileLists: string[][] = [];
  let reconciledCount = 0;
  for (const block of candidateBlocks) {
    const item = buildImplementDispatchItem(block, state, dir);
    const readFiles = blockReadFiles(block, state);

    // Detect the package root from this block's source files: walk up from the
    // first source file to the nearest ancestor with a package.json (stop at root).
    const packageRoot = detectPackageRoot(readFiles, options.root);

    // Pull test files that reference this block's source into its access, so the
    // worker that changes or removes a symbol also fixes the tests that assert it
    // (otherwise their breakage is orphaned for a separate central mop-up).
    // Scoped to the block's package to avoid pulling in unrelated package tests.
    const referencingTests = collectReferencingTests(testIndex, readFiles, packageRoot);
    if (referencingTests.length > 0 && item.access) {
      item.access.read_paths = [
        ...new Set([...item.access.read_paths, ...referencingTests]),
      ];
      item.access.write_paths = [
        ...new Set([...item.access.write_paths, ...referencingTests]),
      ];
    }

    // Reconcile an already-produced result regardless of wave packing.
    const pendingFindingIds = pendingOrDocumentedFindingIdsForBlock(block, state);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    if (existingResult) {
      if (implementResultCoversFindings(existingResult, pendingFindingIds, block, state)) {
        reconciledCount++;
        continue;
      }
      process.stderr.write(
        `[remediate-code] dispatch: existing implement result for block ${block.block_id} ` +
          `does not cover ${pendingFindingIds.length} still-pending item(s); re-dispatching\n`,
      );
      await archiveIncompleteImplementResult(item.result_path);
    }

    // No wave-time file-conflict deferral heuristic: parallel blocks with
    // overlapping files are both dispatched. Parallel safety comes from the planner
    // (mergeBlocksSharingFiles) and rolling verified-complete dependency ordering
    // (dependencyVerifiedComplete). Workers operate in isolated worktrees;
    // verification prevents bad merges from dirtying the main tree.

    await writeTextFile(
      item.prompt_path,
      implementPrompt(
        block,
        state,
        item.result_path,
        conventions,
        options.root,
        toPromptPathToken(join(options.artifactsDir, AGENT_FEEDBACK_FILENAME)),
        waveOptions?.worktreeRootedPrompts
          ? worktreePath(options.root, block.block_id, runId)
          : undefined,
      ),
    );
    items.push(item);
    itemReadFileLists.push([...readFiles, ...referencingTests]);
  }
  if (reconciledCount > 0) {
    console.log(`Reconciliation: reused ${reconciledCount} existing implement results.`);
  }

  const plan: RemediationDispatchPlan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: runId,
    // Normalize to forward slashes so hosts running bash-like shells on Windows
    // receive paths that survive shell expansion (backslash is an escape char).
    repo_root: toPromptPathToken(options.root),
    artifacts_dir: toPromptPathToken(options.artifactsDir),
    items,
  };
  await writeJsonFile(dispatchPlanPath(options.artifactsDir, runId, "implement"), plan);

  const estimatedSlotTokens = itemReadFileLists.map((files) =>
    estimateImplementSlotTokens(files, options.root),
  );
  // The persisted host handshake (state.host_capabilities, written at the
  // decideNextStep seam) is the fallback for every capability field the wave
  // scheduler reads: a caller that passes no waveOptions — the bare
  // `prepare-implement-dispatch` CLI, a triage re-drive — still sizes pools to
  // the host's real windows instead of the conservative floor. Explicit
  // waveOptions (the next-step branch, which already folded persisted values)
  // win per field.
  const persistedCaps = state.host_capabilities;
  const schedule = await scheduleWave({
    hostMaxConcurrent: waveOptions?.hostMaxConcurrent ?? persistedCaps?.max_concurrent,
    sessionConfig: waveOptions?.sessionConfig ?? null,
    hostContextTokens: waveOptions?.hostContextTokens ?? persistedCaps?.context_tokens ?? null,
    hostOutputTokens: waveOptions?.hostOutputTokens ?? persistedCaps?.output_tokens ?? null,
    hostModels:
      waveOptions?.hostModels ??
      (persistedCaps?.models as HostModelRosterEntry[] | undefined) ??
      null,
    hostModelId: waveOptions?.hostModelId ?? persistedCaps?.model_id ?? null,
    itemCount: items.length,
    estimatedSlotTokens,
    // The capability floor bands against THESE pools (this schedule's `capacity_pools`
    // feed `buildDispatchQuota` below), so the ranks must be stamped here or every pool
    // bands `null` and every `deep` packet admits everywhere. Read from the same root
    // as the sibling cost/bias reads a few lines down — one confirmation, three fields.
    capabilityRanks: await readConfirmedCapabilityRanks(options.root),
  });
  // Admission packets in plan order: id = the node's block id (what
  // `admission.granted_packet_ids` references and the host matches to nodes),
  // inputTokens = its estimated slot cost, complexity = the remediate default 0.5.
  // Keyed by block_id (same filter the frontier builder uses), so a granted id always
  // resolves to a frontier node.
  const admissionPackets = items
    .map((item, i) => ({ item, inputTokens: estimatedSlotTokens[i] ?? 0 }))
    .filter((p): p is { item: DispatchPlanItem & { block_id: string }; inputTokens: number } =>
      typeof p.item.block_id === "string",
    )
    .map((p) => ({
      id: p.item.block_id,
      inputTokens: p.inputTokens,
      complexity: 0.5,
      // F4: the node's capability floor rides into admission — the same tier the
      // dispatch plan item already carries (`buildImplementModelHint`).
      ...(p.item.model_hint ? { requiredTier: p.item.model_hint.tier } : {}),
    }));
  process.stderr.write(
    `[remediate-code] dispatch: implement ${items.length} item(s) ` +
      `source=${schedule.source} cap=${schedule.binding_cap ?? "none"}\n`,
  );
  // Fail loud when self-quota monitoring is blind (no live snapshot ⇒ unpaced wave).
  // Single-sourced with audit so both orchestrators emit the identical stderr +
  // run-ledger friction signal — the uncapped-but-LOUD half of the always-on track.
  await emitBlindDispatchFrictionIfBlind({
    artifactsDir: options.artifactsDir,
    runId,
    schedule,
    itemCount: items.length,
    waveKind: "implement",
    toolName: "remediate-code",
  });
  // Cost-first routing rung 1: honor the operator-confirmed cost ordering from the
  // shared Gate-0 confirmation (spec/cost-first-routing.md). Best-effort — an absent
  // or unreadable confirmation ⇒ costRank falls to real price then tier. G3: the
  // ordering is POLICY and is no longer discarded when reach shifts.
  const confirmedCostPositions = await readConfirmedCostPositions(options.root);
  // Cost↔speed dial: the operator's durable operating point from the same Gate-0
  // confirmation (spec/dispatch-cost-speed-dial.md). Absent ⇒ 0 (cost-first default).
  const dispatchBias = await readConfirmedDispatchBias(options.root);
  const quota = await buildDispatchQuota(
    runId,
    "implement",
    schedule,
    admissionPackets,
    waveOptions?.grantLeases ?? true,
    null,
    confirmedCostPositions,
    dispatchBias,
  );
  await writeJsonFile(join(dir, "dispatch-quota.json"), quota);

  return plan;
}

function assertImplementWorkerResult(value: unknown, path: string): asserts value is ImplementWorkerResult {
  const issues = validateImplementWorkerResult(value, path).filter((i) => i.severity === "error");
  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }
}

/**
 * The contract-pipeline obligation ids a finding covers — the union of its
 * `contract_obligation_ids` (satisfied) and `verification_obligation_ids`
 * (verified). Empty for audit-findings intake (no contract overlay), so the DC-5
 * verify gate is inert there.
 */
function obligationIdsForFinding(
  state: RemediationState,
  findingId: string,
): string[] {
  const finding = state.plan?.findings.find((f) => f.id === findingId);
  if (!finding) return [];
  return [
    ...(finding.contract_obligation_ids ?? []),
    ...(finding.verification_obligation_ids ?? []),
  ];
}

/**
 * Diagnose WHY a planned block produced no result file, so the merge's `blocked`
 * failure_reason carries a cause instead of an opaque "no result file". The
 * per-node dispatcher (`makeProviderNodeDispatcher`) writes `<block>.task.json`
 * BEFORE it launches the provider, so the task file's presence is a reliable
 * discriminator:
 *   • NO task.json  ⇒ the block was in the dispatch plan but the rolling engine
 *     NEVER dispatched it (a plan-vs-drive eligibility inconsistency — an ENGINE
 *     bug, not a worker failure). This is the dangerous case: one un-dispatched
 *     node terminal-blocks its whole dependent subtree (INV-RS-01 cascade), so
 *     naming it explicitly is what makes the strand diagnosable.
 *   • task.json present ⇒ the worker WAS dispatched but wrote no result; surface
 *     the captured stderr tail (the provider's own error text) as the cause.
 * Pure/read-only: reads sidecar files, never mutates state.
 */
async function diagnoseMissingResultCause(
  dir: string,
  blockId: string | undefined,
): Promise<{ dispatched: boolean; logSuffix: string; reasonDetail: string }> {
  if (!blockId) {
    return {
      dispatched: false,
      logSuffix: "marking items blocked (no block id to diagnose).",
      reasonDetail: "",
    };
  }
  const dispatched = existsSync(join(dir, `${blockId}.task.json`));
  let stderrTail = "";
  const stderrPath = join(dir, `${blockId}.stderr.txt`);
  if (existsSync(stderrPath)) {
    try {
      stderrTail = (await readFile(stderrPath, "utf8")).trim().slice(-600);
    } catch {
      /* unreadable stderr degrades to none */
    }
  }
  if (!dispatched) {
    return {
      dispatched: false,
      logSuffix:
        "the block was NEVER dispatched (no task.json) — a rolling-engine plan/drive inconsistency, not a worker failure.",
      reasonDetail:
        ` Root cause: the block was in the dispatch plan but no worker was ever dispatched for it ` +
        `(no ${blockId}.task.json) — a rolling-engine plan-vs-drive eligibility inconsistency, NOT a worker ` +
        `failure. A dependent cascade from here means one un-dispatched node stranded its whole subtree.`,
    };
  }
  return {
    dispatched: true,
    logSuffix: `the worker WAS dispatched but wrote no result${stderrTail ? " (stderr captured)" : " and left no stderr"}.`,
    reasonDetail: stderrTail
      ? ` The worker WAS dispatched (task.json present) but wrote no result; stderr tail: ${stderrTail}`
      : ` The worker WAS dispatched (task.json present) but wrote no result and left no stderr.`,
  };
}

export async function mergeImplementResults(
  options: DispatchOptions,
  runId: string,
): Promise<RemediationState> {
  const quotaFilePath = join(
    runDir(options.artifactsDir, runId, "implement"),
    "dispatch-quota.json",
  );
  // Free the grant's reservation-ledger leases now that the host has reported the
  // granted set's results — returns the reserved budget for the next grant.
  await reconcileAdmissionLeasesFromQuotaFile(quotaFilePath);

  // The admission record for this wave: a node with no result file because
  // admission REFUSED its packet must carry that refusal in its disposition —
  // the refusal reason otherwise sits unread in explains[] while the merge
  // misattributes the strand to "a rolling-engine plan-vs-drive eligibility
  // inconsistency" (the 2026-07-22 dogfood false-signal).
  const waveQuota = await readOptionalJsonFile<{
    resolved_limits?: { context_tokens?: number | null };
    admission?: {
      explains?: Array<{
        packet_id?: string;
        reason?: string;
        admitted?: boolean;
        cost?: number;
      }>;
    };
  }>(quotaFilePath);
  const admissionRefusals = new Map<string, { reason: string; cost?: number }>();
  for (const explain of waveQuota?.admission?.explains ?? []) {
    if (explain.admitted !== true && typeof explain.packet_id === "string" && explain.reason) {
      admissionRefusals.set(explain.packet_id, {
        reason: explain.reason,
        ...(typeof explain.cost === "number" ? { cost: explain.cost } : {}),
      });
    }
  }
  const capabilityFloor = waveQuota?.resolved_limits?.context_tokens ?? null;

  const plan = await readJsonFile<RemediationDispatchPlan>(
    dispatchPlanPath(options.artifactsDir, runId, "implement"),
  );
  if (
    plan.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION ||
    plan.phase !== "implement"
  ) {
    throw new Error("Implement dispatch plan has an unsupported contract.");
  }

  const store = new StateStore(options.artifactsDir);

  // OBL-INV-RSD-02 / OBL-SEAM-RSD-04: the entire read-modify-write of state.json
  // is performed under a single held lock via StateStore.mutate, and committed
  // exactly once after the full item loop. No partial state.json write happens
  // mid-loop — a malformed/unknown finding_id no longer leaves a half-applied
  // state (and never throws past the loop; see OBL-INV-RSD-01 below). Evidence
  // artifacts (result_<id>_verify_code_against_documentation.json, the orphan
  // diagnostic) are separate sidecar files, not state.json, so writing them
  // inside the loop does not violate the single-state-commit invariant.
  return store.mutate(async (loaded) => {
    if (!loaded) {
      throw new Error(
        `No remediation state found at ${join(options.artifactsDir, "state.json")}.`,
      );
    }
    const state = loaded;
    if (!state.items) {
      throw new Error("Cannot merge implement results without items.");
    }

    return mergeImplementResultsIntoState(options, runId, plan, state, {
      admissionRefusals,
      capabilityFloor,
    });
  });
}

/**
 * Apply every dispatched implement worker result to `state` (mutated in place)
 * and return it. Runs inside the StateStore.mutate lock so the caller commits
 * the result exactly once (OBL-INV-RSD-02 / OBL-SEAM-RSD-04). Pure with respect
 * to state.json: it mutates the in-memory `state` and writes only sidecar
 * evidence/diagnostic artifacts.
 */
async function mergeImplementResultsIntoState(
  options: DispatchOptions,
  runId: string,
  plan: RemediationDispatchPlan,
  state: RemediationState,
  admissionEvidence?: {
    /** block_id → this wave's admission refusal, from dispatch-quota explains[]. */
    admissionRefusals: ReadonlyMap<string, { reason: string; cost?: number }>;
    /** The wave's resolved capability window, for the refusal's honest message. */
    capabilityFloor: number | null;
  },
): Promise<RemediationState> {
  if (!state.items) {
    throw new Error("Cannot merge implement results without items.");
  }
  const dir = runDir(options.artifactsDir, runId, "implement");

  // Piece D — quota-paused strand set: block_ids stranded by a `quota_paused`
  // partial-completion terminal (their worker rate-limited on a host session
  // limit). Their result files are legitimately absent, but they are a RETRYABLE
  // pause, NOT a failure — a later step redispatches them clean (worktrees were
  // preserved). The merge must therefore LEAVE their items pending instead of
  // marking them blocked on the missing result. Only the quota_paused reason is
  // treated this way; `empty_pool` nodes are genuine failures and block as before.
  const quotaPausedStrandedBlocks =
    state.partial_completion_terminal?.reason === "quota_paused"
      ? new Set(state.partial_completion_terminal.stranded_ids)
      : new Set<string>();

  // DC-5 verify gate: load the obligation_ledger + test_validator_plan once so a
  // resolved finding that covers a behavior-CHANGE obligation can be re-blocked
  // when its test specs are only one polarity (a positive without a scoped
  // negative, or a negative-only set). Absent for non-contract-pipeline runs
  // (audit-findings intake), where the gate is inert. Read defensively: the
  // payloads are the validated artifact bodies, or `undefined` when missing.
  const obligationLedgerPayload =
    (await readContractArtifact(options.artifactsDir, "obligation_ledger"))?.payload;
  const testValidatorPlanPayload =
    (await readContractArtifact(options.artifactsDir, "test_validator_plan"))?.payload;

  const plannedBlockIds = new Set(
    plan.items.map((item) => item.block_id).filter((id): id is string => typeof id === "string"),
  );
  const itemsToMerge = [...plan.items];
  for (const block of state.plan?.blocks ?? []) {
    if (plannedBlockIds.has(block.block_id)) {
      continue;
    }
    const hasDocumentedWork = block.items.some((findingId) => {
      const stateItem = state.items?.[findingId];
      return stateItem?.status === "pending";
    });
    if (!hasDocumentedWork) {
      continue;
    }

    const item = buildImplementDispatchItem(block, state, dir);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    const pendingFindingIds = pendingOrDocumentedFindingIdsForBlock(block, state);
    if (
      !existingResult ||
      !implementResultCoversFindings(existingResult, pendingFindingIds, block, state)
    ) {
      continue;
    }

    itemsToMerge.push(item);
  }

  // Build a lightweight ownership registry seeded from each block's declared
  // write_paths so amended_files checks are correct even when no rolling-dispatch
  // registry was persisted (interim path, until rollingDispatch replaces this).
  const mergeRegistry = new OwnershipRegistry();
  const dagNodes = itemsToMerge.flatMap((item) => {
    if (!item.block_id || !item.access) return [];
    return [{ node_id: item.block_id, write_paths: item.access.write_paths }];
  });
  mergeRegistry.initialize(dagNodes);

  // OBL-INV-RSD-01: a worker result whose finding_id is not in state.items is
  // never silently dropped and never throws past the loop. Each such id is
  // recorded here; if it belongs to a known block (via the result's owning
  // task block_id) that block's non-terminal items are blocked, otherwise it is
  // a true orphan recorded in the diagnostic artifact below. Either way the run
  // cannot advance past an unaccounted result.
  const orphanResults: Array<{
    finding_id: string;
    result_path: string;
    owning_block_id: string | null;
    disposition: "blocked_owning_block" | "orphan";
    worker_status: string;
  }> = [];

  // Per-block ACTUAL edited file sets (resolved from each block's worktree
  // branch), collected for post-loop lost-update / overlapping-edit detection
  // (ARC-f378135d-2 / ARC-c1693139). Only blocks dispatched through an isolated
  // worktree (their branch exists) contribute; the interim main-tree path has no
  // per-worker diff to attribute, so it cannot be checked for cross-block overlap.
  const editedByBlock: BlockEditedFiles[] = [];

  // Union of files every ACCEPTED (tool-verified-and-merged) node this pass
  // actually cherry-picked into the main tree — the close phase's staging
  // manifest ground truth (`state.applied_edit_surface`; see
  // `AcceptNodeWorktreeResult.editedFiles` and `collectStagingFiles` in
  // src/remediate/phases/close.ts). Populated below, only from
  // `acceptOutcome.merged === true` (never a worker's self-report), and merged
  // into `state.applied_edit_surface` after the loop.
  const appliedEditSurfaceThisPass = new Set<string>();

  for (const item of itemsToMerge) {
    if (!existsSync(item.result_path)) {
      // Piece D: a node stranded by a quota_paused terminal has no result file
      // because its worker paused on a host session limit — leave its items
      // PENDING so a later step (after the reset) redispatches them clean; never
      // mark them blocked here.
      if (item.block_id && quotaPausedStrandedBlocks.has(item.block_id)) {
        continue;
      }
      // Capture WHY there is no result (dispatched-but-silent vs never-dispatched)
      // so the `blocked` reason is diagnosable instead of opaque — the opacity here
      // is what made a one-node strand cascade-blocking the whole DAG impossible to
      // root-cause after the fact.
      const cause = await diagnoseMissingResultCause(dir, item.block_id);
      // A never-dispatched node with an admission refusal on record was refused
      // DELIBERATELY — carry the admission reason instead of misreporting an
      // engine plan-vs-drive inconsistency (false-signal family).
      const refusal =
        !cause.dispatched && item.block_id
          ? admissionEvidence?.admissionRefusals.get(item.block_id)
          : undefined;
      // Transient-vs-structural non-dispatch (anti-cascade retry spec): a node
      // refused because no pool had capacity AT THAT MOMENT is retryable —
      // conditions change between waves — so leave its items PENDING for the
      // next grant, bounded by `undispatched_attempts` so a misclassified
      // reason can never livelock the run. Only structural refusals
      // (`no_capable_pool`: fits no pool at all — waiting changes nothing) fall
      // through to the terminal-blocking path below.
      if (refusal && TRANSIENT_REFUSAL_REASONS.has(refusal.reason)) {
        const block = item.block_id
          ? state.plan?.blocks.find((b) => b.block_id === item.block_id)
          : undefined;
        let exhausted = false;
        for (const findingId of block?.items ?? []) {
          const stateItem = state.items[findingId];
          if (!stateItem || isTerminalStatus(stateItem.status)) continue;
          const attempts = (stateItem.undispatched_attempts ?? 0) + 1;
          stateItem.undispatched_attempts = attempts;
          if (attempts <= MAX_UNDISPATCHED_TRANSIENT_ATTEMPTS) continue;
          exhausted = true;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Transient non-dispatch retry budget exhausted: admission refused this ` +
            `block ${attempts} wave(s) running (${refusal.reason}) without a worker ` +
            `ever launching. The condition was classified retryable but is not ` +
            `clearing — treat as structural (free capacity, or split/shrink the node).`;
        }
        console.warn(
          `Missing implement worker result: ${item.result_path} — admission refused ` +
            `transiently (${refusal.reason}); ${exhausted ? "retry budget exhausted, blocking." : "items left PENDING for the next grant."}`,
        );
        continue;
      }
      if (refusal) {
        const floor = admissionEvidence?.capabilityFloor;
        cause.reasonDetail =
          ` Root cause: admission refused the packet (${refusal.reason}` +
          (refusal.cost != null ? `; packet cost ${refusal.cost} tokens` : "") +
          (floor != null ? ` vs resolved capability window ${floor} tokens` : "") +
          `) — the worker was never launched, by design. Supply host capability ` +
          `(--host-context-tokens/--host-models), free a larger pool, or split the node.`;
        cause.logSuffix = `admission refused the packet (${refusal.reason}) — never dispatched, by design.`;
      }
      console.warn(
        `Missing implement worker result: ${item.result_path} — ${cause.logSuffix}`,
      );
      const block = item.block_id
        ? state.plan?.blocks.find((b) => b.block_id === item.block_id)
        : undefined;
      for (const findingId of block?.items ?? []) {
        const stateItem = state.items[findingId];
        // Don't flip a terminal item (resolved, or user-skipped
        // deemed_inappropriate/ignored) to blocked — only items that were
        // actually awaiting this worker's result.
        if (!stateItem || isTerminalStatus(stateItem.status)) continue;
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          `Implementation worker did not produce a result file: ${item.result_path}.${cause.reasonDetail}`;
      }
      continue;
    }
    const result = await readJsonFile<unknown>(item.result_path);
    assertImplementWorkerResult(result, item.result_path);

    // Gate amended_files through the ownership registry (N-R22).
    // Unowned amended paths are granted and added to this block's effective scope
    // for verification; owned/contended paths block the item with a seam conflict.
    const blockId = item.block_id ?? "";
    if (result.amended_files && result.amended_files.length > 0) {
      const { granted, seam_routed } = routeAmendmentRequest(
        mergeRegistry,
        blockId,
        result.amended_files,
      );
      if (granted.length > 0 && item.access) {
        // Expand the block's effective write scope for downstream verification.
        item.access.write_paths = uniquePaths([...item.access.write_paths, ...granted]);
      }
      if (seam_routed.length > 0) {
        // Mark all non-terminal items in this block as blocked with seam conflict detail.
        const block = state.plan?.blocks.find((b) => b.block_id === blockId);
        for (const findingId of block?.items ?? []) {
          const stateItem = state.items[findingId];
          if (!stateItem || isTerminalStatus(stateItem.status)) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Seam conflict on amended_files: ${seam_routed
              .map((r) => {
                const reason = r.reason;
                if (reason.outcome === "owned") {
                  return `${r.path} owned by ${reason.owner_node_id}`;
                } else if (reason.outcome === "contended") {
                  return `${r.path} contended by ${reason.sibling_node_id}`;
                }
                return r.path;
              })
              .join("; ")}`;
        }
        // Release any grants we just made before moving on (best-effort cleanup).
        mergeRegistry.releaseAmendments(blockId);
        continue;
      }
    }

    // Tolerant seam: remap an obligation/node-alias finding_id to the owning
    // node's finding, and collapse multi-entry results onto one entry per
    // finding (blocked dominates), before applying any status. A mislabel can
    // only ever resolve to a finding that belongs to THIS block.
    const owningBlock = blockId
      ? state.plan?.blocks.find((b) => b.block_id === blockId)
      : undefined;
    const aliasMap = owningBlock
      ? buildBlockAliasMap(owningBlock, state)
      : new Map<string, string>();
    const knownFindingIds = new Set(Object.keys(state.items));
    const { collapsed, unresolved } = collapseItemResults(
      result.item_results,
      aliasMap,
      knownFindingIds,
    );

    // Track which findings in this block this worker flipped to a resolved
    // status, so the write-scope gate below can re-block them if the worker's
    // ACTUAL git edits fall outside the declared scope.
    const resolvedFindingIds: string[] = [];

    // The recorded per-node accept outcome is the ground truth (never the worker's
    // result file). Absent on the interim main-tree path (which writes none) → the
    // gates below stay inert there. A HARD accept failure (outcome=error|timeout with
    // merged=false) means the node's committed edits were QUARANTINED and are NOT in the
    // main tree; the worker's own status is then untrustworthy (proven 2026-07-03: a
    // node whose accept failed on a dirty-main-tree collision reported resolved_no_change
    // and silently stranded, because the resolvedFindingIds gate below only re-blocks
    // actual-change `resolved` items). When hard-failed, the collapsed loop's resolve
    // branch blocks the item outright so no dependent builds on missing code.
    const acceptOutcome = await loadNodeAcceptOutcome(options.artifactsDir, runId, blockId);
    const acceptHardFailed =
      !!acceptOutcome &&
      !acceptOutcome.merged &&
      (acceptOutcome.outcome === "error" || acceptOutcome.outcome === "timeout");

    // Accumulate this node's actually-landed files (ground truth: only ever from
    // a `merged: true` accept, never a worker's self-report — a `notLanded` /
    // `ancestryLost` re-block below never un-lands a REAL cherry-pick, it only
    // flips the finding's status; the files stay in this pass's union, which is
    // harmless — a rolled-back file is no longer dirty, so the close phase's
    // `manifest ∩ actually-dirty` staging formula naturally excludes it anyway).
    if (acceptOutcome?.merged && acceptOutcome.editedFiles?.length) {
      for (const f of acceptOutcome.editedFiles) appliedEditSurfaceThisPass.add(f);
    }

    // M-FRICTION (node_quarantine): a node that committed real edits but hard-failed
    // the tool's verify/scope/merge had its work QUARANTINED under a durable ref and
    // NOT landed — a backend-observed step-boundary fact the per-category friction walk
    // must account for (recovery is a `reverify-node` re-drive). A hard-fail carries a
    // captured `diagnostic` ONLY on the quarantine paths; a plain worker error/timeout
    // that never committed sets none, so guarding on it excludes the non-quarantine
    // failures. Routed through the single CE-005 chokepoint keyed on the node id (one
    // event per node, deduped across its findings). Best-effort / non-fatal.
    if (acceptHardFailed && acceptOutcome.diagnostic) {
      await captureStepBoundaryFriction(
        options.artifactsDir,
        runId,
        {
          eventType: "node_quarantine",
          discriminator: blockId,
          note:
            `Node ${blockId} committed edits but hard-failed the tool's verify/scope/merge ` +
            `(outcome=${acceptOutcome.outcome}); work quarantined and NOT landed — re-drive ` +
            `with \`remediate-code reverify-node --id ${blockId} --run-id ${runId}\` once the ` +
            `cause is fixed.`,
          category: "bug",
        },
        "remediate-code",
      );
    }

    for (const itemResult of unresolved) {
      // OBL-INV-RSD-01: do NOT throw on an unknown finding_id that did not remap
      // to a known node alias. Block the owning block's non-terminal items so the
      // run cannot advance past an unaccounted result; record a diagnostic.
      if (owningBlock) {
        for (const findingId of owningBlock.items) {
          const owningItem = state.items[findingId];
          if (!owningItem || isTerminalStatus(owningItem.status)) continue;
          owningItem.status = "blocked";
          markTerminal(owningItem);
          owningItem.failure_reason =
            `Implementation worker for block ${blockId} reported an unknown ` +
            `finding_id "${itemResult.finding_id}" not present in this plan ` +
            `(and not a known obligation/node alias of this block); blocking the ` +
            `block's items so the run does not advance past an unaccounted result.`;
        }
        orphanResults.push({
          finding_id: itemResult.finding_id,
          result_path: item.result_path,
          owning_block_id: blockId,
          disposition: "blocked_owning_block",
          worker_status: itemResult.status,
        });
      } else {
        orphanResults.push({
          finding_id: itemResult.finding_id,
          result_path: item.result_path,
          owning_block_id: null,
          disposition: "orphan",
          worker_status: itemResult.status,
        });
      }
    }

    for (const itemResult of collapsed) {
      const stateItem = state.items[itemResult.finding_id];
      if (!stateItem) continue;
      // A worker may report a finding that is already terminal (user-skipped, or
      // resolved in a prior wave) — never let a result resurrect or overwrite it.
      if (isTerminalStatus(stateItem.status)) {
        continue;
      }
      if (itemResult.status === "resolved" || itemResult.status === "resolved_no_change") {
        if (acceptHardFailed) {
          // The tool-owned accept hard-failed (quarantined, not in the main tree), so
          // this worker's resolved/resolved_no_change claim can't be trusted — block it
          // regardless of label so a mislabeled no-change can't strand and no dependent
          // builds on missing code. Routed to triage with the failing output.
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Node ${blockId} reported finding ${itemResult.finding_id} ` +
            `${itemResult.status}, but its tool-owned accept failed ` +
            `(outcome=${acceptOutcome!.outcome}, merged=false); the edits were quarantined ` +
            `and are NOT in the main tree. Routed to triage so dependents never build on ` +
            `missing code.` +
            (acceptOutcome!.diagnostic
              ? `\nFailing command output:\n${acceptOutcome!.diagnostic}`
              : "");
          continue;
        }
        // INV-WTS-7: a resolved_no_change is genuine ONLY when the node captured NO
        // commit OID and git ground truth confirms an empty branch. A node that DID
        // capture a commit OID but whose branch now reads empty is a CLOBBER (a
        // concurrent sweep/accept reset its ref toward base) — an ancestry mismatch,
        // NOT a genuine no-change: re-block to triage and recover its committed work
        // from quarantine, never flip it terminal on a race-corrupted live read. A
        // worker-claimed no-change whose branch actually HAS edits is likewise
        // re-blocked (git ground truth over the self-report). Only fires on the
        // rolling path (an accept-outcome exists); the interim main-tree path has no
        // git ground truth and is unaffected.
        if (itemResult.status === "resolved_no_change" && acceptOutcome) {
          const noChangeBranch = worktreeBranchForBlock(blockId, runId);
          const branchPresent = gitBranchExists(options.root, noChangeBranch);
          const branchEdits = branchPresent
            ? gitEditedFilesForBranch(options.root, noChangeBranch)
            : null;
          const branchHasEdits =
            !!branchEdits && branchEdits.available && branchEdits.files.size > 0;
          const branchEmpty =
            !branchPresent ||
            (!!branchEdits && branchEdits.available && branchEdits.files.size === 0);
          const capturedOid = acceptOutcome.committedOid;
          if (capturedOid && branchEmpty) {
            quarantineCommitByOid(options.root, runId, blockId, capturedOid);
            stateItem.status = "blocked";
            markTerminal(stateItem);
            stateItem.failure_reason =
              `Node ${blockId} reported finding ${itemResult.finding_id} ` +
              `resolved_no_change, but it had captured commit ${capturedOid.slice(0, 8)} and ` +
              `its branch now reads empty — a concurrent sweep/accept clobbered its ref toward ` +
              `base (ancestry mismatch, not a genuine no-change). Its committed work is ` +
              `preserved under quarantine and the finding is routed to triage.`;
            continue;
          }
          if (branchHasEdits) {
            stateItem.status = "blocked";
            markTerminal(stateItem);
            const sample = [...branchEdits!.files].slice(0, 5).join(", ");
            stateItem.failure_reason =
              `Node ${blockId} reported finding ${itemResult.finding_id} ` +
              `resolved_no_change, but its worktree branch actually has edits ` +
              `(${sample}${branchEdits!.files.size > 5 ? ", …" : ""}); git ground truth ` +
              `contradicts the no-change claim. Routed to triage.`;
            continue;
          }
        }
        const spec = stateItem.item_spec;
        // The worker's explicit `resolved_no_change` is a no-change signal in its
        // own right; the spec heuristic is the fallback for a plain `resolved`.
        const isNoChange =
          itemResult.status === "resolved_no_change" || specIndicatesNoChange(spec);
        // DC-5 verify gate: an actual-change closure for a finding that covers a
        // behavior-CHANGE obligation must have a paired positive+scoped-negative
        // test spec; only-one-polarity (or an unscoped repo-wide negative) is
        // blocked, never silently resolved. The same single-source pairing/scoping
        // evaluation the test-plan derivation gate uses. A no-change closure makes
        // no edits, so it is exempt (the closure path above already proves it).
        const pairingBlockReason = isNoChange
          ? null
          : verifyPairingForFinding(
              obligationIdsForFinding(state, itemResult.finding_id),
              obligationLedgerPayload,
              testValidatorPlanPayload,
            );
        if (isNoChange && !hasExecutableEvidence(itemResult.evidence)) {
          // No-prose closure: a "verified-already-satisfied" (no-change) claim must
          // be backed by an executable assertion (a test/build/check command +
          // result), not prose — otherwise a real requirement silently no-ops.
          // Route an unproven no-change claim to triage instead of closing it.
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            "verified-already-satisfied requires an executable regression test proving " +
            "the behavior (a test/build/check command + result in evidence), not prose.";
        } else if (pairingBlockReason) {
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason = pairingBlockReason;
        } else {
          stateItem.status = isNoChange ? "resolved_no_change" : "resolved";
          markTerminal(stateItem);
          // A no-change closure makes no edits, so it is exempt from the
          // git-diff write-scope gate; an actual fix is subject to it.
          if (!isNoChange) {
            resolvedFindingIds.push(itemResult.finding_id);
          } else {
            // M-FRICTION (no_change_merge): a resolved_no_change node merged with
            // no diff is a backend-observed step-boundary fact. Route it through
            // the single CE-005 chokepoint with the pinned discriminator
            // (node/block id + finding id) so the de-dup id is collision-free and
            // re-recording the same fact is a guaranteed no-op (CE-006). Best-effort
            // and non-fatal — capture never throws into the merge loop.
            await captureStepBoundaryFriction(
              options.artifactsDir,
              runId,
              {
                eventType: "no_change_merge",
                discriminator: `${blockId}:${itemResult.finding_id}`,
                note:
                  `Node ${blockId} merged finding ${itemResult.finding_id} as ` +
                  `resolved_no_change (no diff landed).`,
                category: "trap",
              },
              "remediate-code",
            );
          }
          // OBL-INV-RSD-06 / OBL-SEAM-RSD-03: use the shared REMEDIATION_STEP
          // constant, never the bare string literal, so this path and any other
          // verify-against-documentation writer agree on one source of truth.
          stateItem.last_successful_step =
            REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION;
          if (itemResult.evidence?.length) {
            await writeJsonFile(
              join(
                options.artifactsDir,
                `result_${itemResult.finding_id}_verify_code_against_documentation.json`,
              ),
              {
                finding_id: itemResult.finding_id,
                passed: true,
                reason: itemResult.evidence,
              },
            );
          }
        }
      } else if (itemResult.status === "needs_clarification") {
        // Mid-run escape hatch (note 3, part B): the worker hit scoping/judgment
        // ambiguity. Route it to a clarification round (a real user question), not
        // to triage's retry/ignore/halt. NOT terminal — the answer re-opens it.
        stateItem.status = "needs_clarification";
        const question =
          itemResult.clarification_question ??
          itemResult.failure_reason ??
          "The worker reported unresolved scoping/judgment ambiguity.";
        stateItem.failure_reason = question;
        const category = isClarificationCategory(itemResult.clarification_category)
          ? itemResult.clarification_category
          : "scope_of_fix";
        const clarifications = state.clarifications ?? [];
        if (!clarifications.some((c) => c.finding_id === itemResult.finding_id)) {
          clarifications.push({
            finding_id: itemResult.finding_id,
            category,
            description: question,
          });
        }
        state.clarifications = clarifications;
        // The run is paused for the batched clarification round at the single
        // post-loop status decision below (a needs_clarification item outranks
        // implementing/triage), so the answer is applied before any more work.
      } else {
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          itemResult.failure_reason ?? "Implementation worker blocked.";
      }
    }

    // E2 convergence: a worker may silently OMIT an assigned finding (return no
    // item_results entry for it) — distinct from reporting it blocked or returning
    // an unknown id (both handled above). The collapsed loop leaves an omitted
    // finding untouched (still pending), so without accounting it re-dispatches
    // forever. Bound it: count each omission and, at the cap, block the finding
    // (→ triage) so a no-human run converges instead of looping (T2 termination).
    if (owningBlock) {
      const coveredFindingIds = new Set(collapsed.map((entry) => entry.finding_id));
      for (const findingId of owningBlock.items) {
        if (coveredFindingIds.has(findingId)) continue;
        const stateItem = state.items[findingId];
        // Only a still-`pending` item is genuinely awaiting this worker's result;
        // terminal / needs_clarification / in-flight states are not "omitted".
        if (!stateItem || stateItem.status !== "pending") continue;
        const attempts = (stateItem.incomplete_coverage_attempts ?? 0) + 1;
        stateItem.incomplete_coverage_attempts = attempts;
        if (attempts >= MAX_INCOMPLETE_COVERAGE_ATTEMPTS) {
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason =
            `Implementation worker for block ${blockId} omitted this finding from its ` +
            `item_results across ${attempts} dispatch(es) (no entry returned, neither ` +
            `resolved nor blocked); blocking to converge instead of re-dispatching indefinitely.`;
        }
      }
    }

    // Per-block ACTUAL worktree-branch edits, collected for the post-loop
    // lost-update / overlapping-edit detection (a file edited by more than one
    // merged block). The write-scope gate itself is NOT applied here: it runs at
    // ACCEPT time (`acceptNodeWorktree` → `enforceAcceptWriteScope`), BEFORE the
    // cherry-pick, so an out-of-scope edit is prevented from landing rather than
    // reported once already merged — and a node it blocks reaches the merge as
    // `merged:false`, routed to triage by the merge-state gate below (with the
    // write-scope reason carried in its diagnostic). A missing branch means the
    // interim main-tree path was used (no per-worker diff): nothing to collect.
    const worktreeBranch = worktreeBranchForBlock(blockId, runId);
    const branchEdited = gitBranchExists(options.root, worktreeBranch)
      ? gitEditedFilesForBranch(options.root, worktreeBranch)
      : null;
    if (branchEdited?.available) {
      // Resolve the block's ACTUAL edited hunks too, so overlap detection can
      // spare same-file blocks whose real line-ranges are disjoint. Unavailable
      // hunks fail closed inside detectOverlappingEdits (still flagged).
      const branchHunks = gitHunksForBranch(options.root, worktreeBranch);
      editedByBlock.push({
        block_id: blockId,
        files: branchEdited.files,
        hunks: branchHunks,
      });
    }

    // Merge-state gate (authoritative, OBL-DS-06): a node that self-reported a
    // finding "resolved" but whose tool-owned verify/merge did NOT land its edits
    // (acceptNodeWorktree returned merged:false — verify failed, a cherry-pick
    // conflict, or no actual edit) must never stand as resolved: its fix is not in
    // the main tree. Keyed on resolvedFindingIds, so a legitimate no-change closure
    // (which makes no edits by design, and is not in that set) stays exempt. This
    // covers the outcome=success/merged:false case (worker reported an actual-change
    // "resolved" but committed nothing); the hard-failure case (outcome=error|timeout)
    // is caught earlier, in the collapsed loop's resolve branch, so a mislabeled
    // `resolved_no_change` can't slip past this resolvedFindingIds keying.
    if (resolvedFindingIds.length > 0 && acceptOutcome) {
      const notLanded = !acceptOutcome.merged;
      // INV-WTS-3: node-IDENTITY ancestry reconcile. A merged:true accept is only
      // trusted after confirming THIS node's own landed cherry-pick commit is still
      // reachable from the remediation HEAD (`git merge-base --is-ancestor`). A bare
      // path-existence probe (`cat-file -e HEAD:<path>`) would false-PASS when a
      // sibling or a pre-existing file sits at the same path (CE-001); the captured
      // commit OID cannot. If the landing was rolled back / clobbered after accept,
      // the OID is no longer an ancestor → re-block + recover from quarantine.
      const ancestryLost =
        acceptOutcome.merged &&
        !!acceptOutcome.landedHeadOid &&
        !gitCommitIsAncestor(options.root, acceptOutcome.landedHeadOid);
      if (notLanded || ancestryLost) {
        if (ancestryLost && acceptOutcome.committedOid) {
          quarantineCommitByOid(options.root, runId, blockId, acceptOutcome.committedOid);
        }
        for (const findingId of resolvedFindingIds) {
          const stateItem = state.items[findingId];
          // These findings were just set to `resolved` by THIS merge pass, so the
          // re-block must be allowed to flip resolved→blocked. Only a user-SKIP
          // terminal (deemed_inappropriate / ignored) is protected — never a bare
          // `isTerminalStatus` guard, which would (wrongly) skip the resolved item
          // this gate exists to override (INV-WTS-5).
          if (!stateItem || isSkipStatus(stateItem.status)) continue;
          stateItem.status = "blocked";
          markTerminal(stateItem);
          stateItem.failure_reason = notLanded
            ? `Node ${blockId} reported finding ${findingId} resolved, but its tool-owned ` +
              `verify/merge did not land the edits (outcome=${acceptOutcome.outcome}, ` +
              `verify_passed=${acceptOutcome.verifyPassed}, merged=false); the fix is not in ` +
              `the main tree. Routed to triage.` +
              (acceptOutcome.diagnostic
                ? `\nFailing command output:\n${acceptOutcome.diagnostic}`
                : "")
            : `Node ${blockId} reported finding ${findingId} resolved and merged, but its ` +
              `landed commit ${acceptOutcome.landedHeadOid!.slice(0, 8)} is no longer an ` +
              `ancestor of the remediation HEAD — a concurrent sweep/accept rolled its landing ` +
              `back (ancestry mismatch, closing the CE-001 path-existence false-close). Its ` +
              `committed work is preserved under quarantine and the finding is routed to triage.`;
        }
      }
    }

    // Release this block's amendment claims after it has been merged or blocked.
    mergeRegistry.releaseAmendments(blockId);
  }

  // OBL-INV-RSD-01: persist a deterministic diagnostic for every unmatched
  // worker result so an orphan is auditable and never silently dropped. This is
  // a sidecar artifact (not state.json), so it does not affect the single
  // state-commit invariant (RSD-02).
  if (orphanResults.length > 0) {
    await writeJsonFile(join(dir, "orphaned-implement-results.json"), {
      schema_version: "remediate-code-implement/orphaned-results/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      orphans: orphanResults,
    });
    process.stderr.write(
      `[remediate-code] dispatch: ${orphanResults.length} unmatched implement ` +
        `result finding_id(s) recorded as orphan dispositions (not dropped): ` +
        `${orphanResults.map((o) => o.finding_id).join(", ")}\n`,
    );
    // M-FRICTION (artifact_rejected): each unmatched worker result is an artifact
    // rejected from the merge (referential-integrity reject). Route each through
    // the single CE-005 chokepoint with the pinned discriminator (artifact id +
    // cause token = the orphan disposition) so the de-dup id is collision-free
    // (CE-006). Best-effort / non-fatal — capture never throws into the merge.
    for (const orphan of orphanResults) {
      await captureStepBoundaryFriction(
        options.artifactsDir,
        runId,
        {
          eventType: "artifact_rejected",
          discriminator: `${orphan.finding_id}:${orphan.disposition}`,
          note:
            `Implement worker result for finding ${orphan.finding_id} was rejected ` +
            `from the merge (disposition=${orphan.disposition}, ` +
            `worker_status=${orphan.worker_status}).`,
          category: "trap",
        },
        "remediate-code",
      );
    }
  }

  // Lost-update / overlapping-edit detection (ARC-f378135d-2 / ARC-c1693139):
  // when the rolling engine had multiple nodes in flight, two workers can each
  // edit the SAME file in their own worktree; cherry-picking both would silently
  // drop one change. Any file edited by more than one merged block is a
  // lost-update hazard — block every involved block's still-non-terminal items
  // and route them to triage so the conflict is reconciled, never lost. Recorded
  // as a sidecar diagnostic. Single-block runs (the proven host-wave path)
  // produce zero overlaps, so this is inert on the current default path.
  const overlappingEdits = detectOverlappingEdits(editedByBlock);
  if (overlappingEdits.length > 0) {
    const involvedBlockIds = new Set(
      overlappingEdits.flatMap((o) => o.block_ids),
    );
    for (const blockId of involvedBlockIds) {
      const block = state.plan?.blocks.find((b) => b.block_id === blockId);
      const conflictPaths = overlappingEdits
        .filter((o) => o.block_ids.includes(blockId))
        .map((o) => o.path);
      for (const findingId of block?.items ?? []) {
        const stateItem = state.items[findingId];
        if (!stateItem || isTerminalStatus(stateItem.status)) continue;
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          `Lost-update hazard: this block's worker edited file(s) also edited by ` +
          `another concurrently-dispatched block (${conflictPaths.join(", ")}). ` +
          `Blocking both so the overlapping change is reconciled in triage rather ` +
          `than silently dropped by a cherry-pick.`;
      }
    }
    await writeJsonFile(join(dir, "overlapping-edits.json"), {
      schema_version: "remediate-code-implement/overlapping-edits/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      overlaps: overlappingEdits,
    });
    process.stderr.write(
      `[remediate-code] dispatch: ${overlappingEdits.length} overlapping-edit ` +
        `conflict(s) across concurrently-merged blocks; involved blocks routed to ` +
        `triage: ${[...involvedBlockIds].join(", ")}\n`,
    );
  }

  // Re-baseline affected-file hashes: the implement phase legitimately rewrites
  // these files, so a later integrity check must not flag the run's own edits as
  // a stale plan when re-attempting any remaining blocked findings.
  if (state.plan?.findings?.length) {
    resnapshotAffectedFileHashes(options.root, state.plan.findings);
  }

  // Per-node dispositions (INV-DS-15). One disposition per merged block/node; a
  // SKIP disposition is never reported as verified_complete. This is a sidecar
  // artifact (not state.json).
  const mergedBlocks = itemsToMerge.flatMap((item) => {
    if (!item.block_id) return [];
    const block = state.plan?.blocks.find((b) => b.block_id === item.block_id);
    return block ? [{ block, item }] : [];
  });
  const dispositions = mergedBlocks.map(({ block }) =>
    buildNodeDisposition(block, state),
  );

  // Sibling-red routing (INV-DS-14). For each merged block that ended red
  // (blocked), attribute the failure against the OTHER merged blocks' write
  // scopes: an attributable red (exactly one sibling owns the implicated
  // surface) routes that sibling to triage; an unattributable red is deferred to
  // the rolling-scheduler's coarse backstop. The state already advances to
  // triage below; this records the attribution decision deterministically.
  const siblingRedRoutes: Array<{
    red_block_id: string;
    implicated_files: string[];
    routed_to_triage_block_id: string | null;
    backstop: "rolling_scheduler_coarse" | null;
  }> = [];
  for (const { block, item } of mergedBlocks) {
    const disposition = dispositions.find((d) => d.block_id === block.block_id);
    if (!disposition || disposition.disposition !== "blocked") continue;
    // The files implicated by this red node = its declared write scope.
    const implicatedFiles = item.access?.write_paths ?? [];
    const siblingScopes = mergedBlocks
      .filter((m) => m.block.block_id !== block.block_id)
      .map((m) => ({
        block_id: m.block.block_id,
        write_paths: m.item.access?.write_paths ?? [],
      }));
    const attributed = attributeSiblingRed(implicatedFiles, siblingScopes, options.root);
    siblingRedRoutes.push({
      red_block_id: block.block_id,
      implicated_files: implicatedFiles.map((p) => toRepoRelative(p, options.root)),
      routed_to_triage_block_id: attributed,
      backstop: attributed ? null : "rolling_scheduler_coarse",
    });
  }
  if (dispositions.length > 0) {
    await writeJsonFile(join(dir, "node-dispositions.json"), {
      schema_version: "remediate-code-implement/node-dispositions/v1alpha1",
      run_id: runId,
      created_at: new Date().toISOString(),
      dispositions,
      sibling_red_routes: siblingRedRoutes,
    });
  }

  const mergedFindingIds = new Set(
    itemsToMerge.flatMap((item) => {
      if (!item.block_id) return [];
      const block = state.plan?.blocks.find((b) => b.block_id === item.block_id);
      return block?.items ?? [];
    }),
  );
  let implementResolved = 0;
  let implementRejected = 0;
  for (const findingId of mergedFindingIds) {
    const status = state.items[findingId]?.status;
    if (isVerifiedCompleteStatus(status)) implementResolved++;
    else if (status === "blocked") implementRejected++;
  }
  process.stderr.write(
    `[remediate-code] dispatch: merged ${implementResolved} implement result(s), ` +
      `${implementRejected} rejected\n`,
  );

  // A worker that reported needs_clarification (note 3, part B) outranks both
  // implementing and triage: pause the run for the batched clarification round so
  // the user's answer is applied before any more work is dispatched or triaged.
  // Otherwise route back to implementing while pending work remains (later
  // dependency waves, or blocks deferred this wave because a prerequisite was
  // still running); else advance to triage.
  const needsClarification = Object.values(state.items).some(
    (it) => it.status === "needs_clarification",
  );
  const moreToImplement = Object.values(state.items).some(
    (it) => it.status === "pending",
  );
  state.status = needsClarification
    ? "waiting_for_clarification"
    : moreToImplement
      ? "implementing"
      : "triage";

  // Persist this pass's actually-landed files into the run-wide staging manifest
  // (state.applied_edit_surface — see its doc comment in state/store.ts and
  // `collectStagingFiles` in phases/close.ts). Union with whatever prior passes
  // already recorded (a rolling multi-wave run calls this repeatedly), then
  // re-sort/de-dup deterministically.
  if (appliedEditSurfaceThisPass.size > 0) {
    const combined = new Set([
      ...(state.applied_edit_surface ?? []),
      ...appliedEditSurfaceThisPass,
    ]);
    state.applied_edit_surface = [...combined].sort();
  }

  // Access-memory parity (context-efficiency increment 2c): harvest which files
  // remediation has edited into `.audit-tools/remediation/access_memory.json` —
  // the remediate analog of audit's covered-file harvest, populating edited_count.
  // Re-derived deterministically from the merged state (declared surface of
  // resolved items); written at the artifacts root so a future continuity consumer
  // finds it without a runId. Under the state lock already. This write precedes the
  // mutate-callback's own state.json commit, so a crash in that window can leave
  // access_memory.json one merge ahead of state.json — harmless: it's advisory and
  // re-derived from the authoritative state on the next merge (self-healing).
  await writeJsonFile(
    join(options.artifactsDir, "access_memory.json"),
    deriveRemediationAccessMemory(state),
  );

  // Single commit: StateStore.mutate writes the returned state once, under the
  // lock it already holds (OBL-INV-RSD-02 / OBL-SEAM-RSD-04). No saveState here.
  return state;
}

export async function readExtractedPlanIfPresent(
  artifactsDir: string,
): Promise<unknown | undefined> {
  return readOptionalJsonFile(join(artifactsDir, "extracted-plan.json"));
}

export async function readDispatchPlan(
  artifactsDir: string,
  runId: string,
  phase: "implement",
): Promise<RemediationDispatchPlan> {
  return readJsonFile(dispatchPlanPath(artifactsDir, runId, phase));
}
