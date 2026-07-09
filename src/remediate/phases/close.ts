import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import {
  remediationBranchName,
  listQuarantinedCommits,
  readRemediationBaseBranch,
} from "../steps/dispatch.js";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  AGENT_FEEDBACK_FILENAME,
  normalizeRepoPath,
  parseReflectionsNdjson,
  readOptionalJsonFile,
  readOptionalTextFile,
  renderProcessFeedbackSection,
  stagedAndUntracked,
  writeJsonFile,
  writeTextFile,
  RemediationOutcomeStatusSchema,
  countBy,
} from "audit-tools/shared";
import type {
  AgentReflection,
  RemediationOutcome,
  RemediationOutcomeStatus,
  RemediationOutcomesReport,
  RunLogger,
  VerificationReport,
  FindingVerificationTrace,
  VerificationTraceEntry,
} from "audit-tools/shared";
import { CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION } from "audit-tools/shared";
import { runTracked } from "audit-tools/shared";
import { FAILURE_OUTPUT_TAIL_CHARS } from "./constants.js";
import type { ClosingAction } from "../state/closingActions.js";
import type {
  CoverageLedgerEntry,
  Finding,
  ItemSpec,
  ItemSpecSummary,
  NeverPlannedDropReason,
  OutcomeCoverageEntry,
  OutcomeCoverageLedger,
  RemediationItemState,
  RemediationOutcomeFinalStatus,
  RemediationOutcomeItem,
} from "../state/types.js";
import { intakePaths, type IntakeSourceManifest } from "../intake.js";
import { isAuditFindingsReport } from "./plan.js";
import {
  dispositionToOutcomeStatus,
  isInProgressStatus,
  isSkipStatus,
  isVerifiedCompleteStatus,
  statusToDisposition,
} from "../state/itemStatus.js";

// Derived from the single source so the key list can never drift from the
// RemediationOutcomeStatus contract (A6).
const OUTCOME_KEYS: RemediationOutcomeStatus[] = [
  ...RemediationOutcomeStatusSchema.options,
];

/** Retry-oriented final status per outcome (see RemediationOutcomeFinalStatus). */
const FINAL_STATUS_BY_OUTCOME: Record<
  RemediationOutcomeStatus,
  RemediationOutcomeFinalStatus
> = {
  resolved: "fixed",
  verified_no_change: "fixed",
  inappropriate: "skipped",
  ignored: "ignored",
  blocked: "failed",
};

// Skipped and ignored outcomes must always carry a non-empty reason in the
// outcomes contract; these defaults cover items whose state lost the rationale.
const DEFAULT_REASON_BY_OUTCOME: Partial<
  Record<RemediationOutcomeStatus, string>
> = {
  inappropriate: "Deemed inappropriate during remediation.",
  ignored: "Ignored by user.",
};

/** Project the documented ItemSpec onto the outcomes contract's summary shape. */
function summarizeItemSpec(spec: ItemSpec): ItemSpecSummary {
  return {
    concrete_change: spec.concrete_change,
    ...(spec.no_change !== undefined ? { no_change: spec.no_change } : {}),
    ...(spec.touched_files ? { touched_files: spec.touched_files } : {}),
    tests_to_write: (spec.tests_to_write ?? []).map((test) => test.name),
  };
}

/**
 * Phase 7B — capture one outcome per finding (lens, affected file types, how it
 * landed, rework count, closing status). Surface only: the auditor does not
 * consume this automatically.
 */
function closingStatusReason(closingResult: ClosingResult): string | undefined {
  if (closingResult.status === "skipped" && closingResult.action === "none") {
    return "closing action is 'none' — no commit/push/publish configured";
  }
  if (closingResult.status === "failed") {
    return `closing action '${closingResult.action}' failed`;
  }
  return undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function durationBetweenMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  const started = parseTimestamp(startedAt);
  const completed = parseTimestamp(completedAt);
  if (started === undefined || completed === undefined || completed < started) {
    return undefined;
  }
  return completed - started;
}

export function buildRemediationOutcomesReport(
  state: RemediationState,
  closingResult: ClosingResult,
): RemediationOutcomesReport {
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const blocksById = new Map(
    (state.plan?.blocks ?? []).map((block) => [block.block_id, block]),
  );
  const outcomes: RemediationOutcome[] = [];
  const closeReason = closingStatusReason(closingResult);
  for (const item of Object.values(state.items ?? {})) {
    // Derive the outcome from the single status→disposition→outcome authority.
    // An in-progress status means the run was force-closed while the item was
    // still mid-flight: record it as a failed (`blocked`) outcome — never drop
    // it — and preserve the original state so a retry sees where it stood.
    let outcome: RemediationOutcomeStatus;
    let originalState: RemediationItemState["status"] | undefined;
    if (isInProgressStatus(item.status)) {
      outcome = "blocked";
      originalState = item.status;
    } else {
      outcome = dispositionToOutcomeStatus(statusToDisposition(item.status));
    }
    const finding = findingsById.get(item.finding_id);
    const fileExts = [
      ...new Set(
        (finding?.affected_files ?? [])
          .map((file) => extname(file.path).toLowerCase())
          .filter((ext) => ext.length > 0),
      ),
    ].sort();
    const durationMs = durationBetweenMs(item.started_at, item.completed_at);
    const isNonResolved = outcome !== "resolved" && outcome !== "verified_no_change";
    let reason = isNonResolved ? item.failure_reason : undefined;
    if (originalState) {
      reason = `Force-closed while non-terminal (original state '${originalState}').${
        item.failure_reason ? ` ${item.failure_reason}` : ""
      }`;
    } else if (isNonResolved && !reason) {
      reason = DEFAULT_REASON_BY_OUTCOME[outcome];
    }
    const base: RemediationOutcome = {
      finding_id: item.finding_id,
      lens: finding?.lens ?? "unknown",
      file_exts: fileExts,
      outcome,
      rework_count: item.rework_count ?? 0,
      closing_status: closingResult.status,
      ...(closeReason ? { closing_status_reason: closeReason } : {}),
      ...(reason ? { reason } : {}),
      ...(item.started_at ? { started_at: item.started_at } : {}),
      ...(item.completed_at ? { completed_at: item.completed_at } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    };
    if (!finding) {
      // Degenerate (corrupt state): without the plan finding there is no payload
      // to carry — emit the lean per-finding outcome rather than inventing one.
      outcomes.push(base);
      continue;
    }
    const enriched: RemediationOutcomeItem = {
      ...base,
      finding,
      ...(item.item_spec ? { item_spec: summarizeItemSpec(item.item_spec) } : {}),
      block_id: item.block_id,
      block_dependencies: [...(blocksById.get(item.block_id)?.dependencies ?? [])],
      final_status: FINAL_STATUS_BY_OUTCOME[outcome],
      ...(originalState ? { original_state: originalState } : {}),
    };
    outcomes.push(enriched);
  }
  outcomes.sort((a, b) => a.finding_id.localeCompare(b.finding_id));

  // Zero-filled so every outcome status appears even when unused (byOutcome),
  // countBy(...) supplies the actual counts on top. Spreading the zero-filled
  // base first, then counts, preserves OUTCOME_KEYS insertion order — spread
  // only overwrites an existing key's value, never reorders or appends
  // (outcome is a closed enum, so counts can't introduce an unseen key).
  const byOutcome = {
    ...(Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])) as Record<
      RemediationOutcomeStatus,
      number
    >),
    ...countBy(outcomes, (entry) => entry.outcome),
  } as Record<RemediationOutcomeStatus, number>;

  // Group outcomes by lens (preserving first-appearance order), then countBy
  // outcome status within each group — same per-lens/per-status counts and
  // insertion order as the original single-pass nested reduce, since
  // `by_lens` is only ever consumed key-sorted downstream (renderOutcomesSummary).
  const lensGroups = new Map<string, typeof outcomes>();
  for (const entry of outcomes) {
    const group = lensGroups.get(entry.lens);
    if (group) {
      group.push(entry);
    } else {
      lensGroups.set(entry.lens, [entry]);
    }
  }
  const byLens: Record<
    string,
    Partial<Record<RemediationOutcomeStatus, number>>
  > = {};
  for (const [lens, group] of lensGroups) {
    byLens[lens] = countBy(group, (entry) => entry.outcome) as Partial<
      Record<RemediationOutcomeStatus, number>
    >;
  }

  const startedEntries = outcomes
    .map((outcome) => ({
      value: outcome.started_at,
      timestamp: parseTimestamp(outcome.started_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const completedEntries = outcomes
    .map((outcome) => ({
      value: outcome.completed_at,
      timestamp: parseTimestamp(outcome.completed_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const aggregateStarted = startedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (earliest, entry) =>
      !earliest || entry.timestamp < earliest.timestamp ? entry : earliest,
    undefined,
  );
  const aggregateCompleted = completedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (latest, entry) =>
      !latest || entry.timestamp > latest.timestamp ? entry : latest,
    undefined,
  );
  const aggregateDuration =
    aggregateStarted && aggregateCompleted
      ? durationBetweenMs(aggregateStarted.value, aggregateCompleted.value)
      : undefined;

  return {
    contract_version: "remediate-code-outcomes/v1alpha1",
    total: outcomes.length,
    by_outcome: byOutcome,
    by_lens: byLens,
    ...(aggregateStarted ? { started_at: aggregateStarted.value } : {}),
    ...(aggregateCompleted ? { completed_at: aggregateCompleted.value } : {}),
    ...(aggregateDuration !== undefined ? { duration_ms: aggregateDuration } : {}),
    outcomes,
  };
}

/** Drop-reason discriminator per never-planned coverage disposition. */
const DROP_REASON_BY_DISPOSITION: Partial<
  Record<CoverageLedgerEntry["disposition"], NeverPlannedDropReason>
> = {
  folded_into: "cross_lens_dedup",
  dropped_by_checkpoint: "intent_checkpoint",
  dropped_no_evidence: "no_evidence",
  dropped_phantom_paths: "phantom_paths",
  declined_by_review: "review_gate",
};

/**
 * Best-effort recovery of full Finding payloads for never-planned findings:
 * re-read the run's structured-audit intake source(s) (recorded in
 * intake/source-manifest.json) and index their findings by id. Never-planned
 * findings were removed from the plan before state.json was written, so the
 * intake source is the remaining payload authority for them. Any failure
 * (missing manifest, moved input, free-form source) degrades to an empty map —
 * the coverage entry then keeps its id/title without a payload.
 */
async function loadStructuredSourceFindingsById(
  options: OrchestratorOptions,
): Promise<Map<string, Finding>> {
  const findingsById = new Map<string, Finding>();
  let manifest: IntakeSourceManifest | undefined;
  try {
    manifest = await readOptionalJsonFile<IntakeSourceManifest>(
      intakePaths(options.artifactsDir).sourceManifest,
    );
  } catch {
    return findingsById;
  }
  for (const source of manifest?.sources ?? []) {
    if (source.type !== "structured_audit") continue;
    const sourcePath = isAbsolute(source.path)
      ? source.path
      : join(options.root, source.path);
    try {
      const parsed: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      if (!isAuditFindingsReport(parsed)) continue;
      for (const finding of parsed.findings) {
        if (finding && typeof finding.id === "string" && !findingsById.has(finding.id)) {
          findingsById.set(finding.id, finding);
        }
      }
    } catch {
      // Best-effort: an unreadable source just means no payload recovery.
    }
  }
  return findingsById;
}

/**
 * Build the outcomes file's coverage-ledger section: the plan's coverage ledger
 * with every never-planned entry (cross-lens-deduped, checkpoint-dropped,
 * no-evidence, phantom-paths) enriched with a `drop_reason` discriminator and
 * its full `Finding` payload. Payloads resolve from, in order: the ledger entry
 * itself (when the plan recorded one), the live plan findings, and the
 * structured-audit intake source. Must run BEFORE close deletes state.json /
 * the artifacts dir — they are the only payload sources.
 */
export async function buildOutcomeCoverageLedger(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<OutcomeCoverageLedger | undefined> {
  const ledger = state.plan_coverage;
  if (!ledger) return undefined;
  const plannedById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const needsSourcePayloads = ledger.entries.some(
    (entry) =>
      DROP_REASON_BY_DISPOSITION[entry.disposition] !== undefined &&
      !entry.finding &&
      !plannedById.has(entry.finding_id),
  );
  const sourceById = needsSourcePayloads
    ? await loadStructuredSourceFindingsById(options)
    : new Map<string, Finding>();
  const entries: OutcomeCoverageEntry[] = ledger.entries.map((entry) => {
    const dropReason = DROP_REASON_BY_DISPOSITION[entry.disposition];
    if (!dropReason) return entry;
    const finding =
      entry.finding ??
      plannedById.get(entry.finding_id) ??
      sourceById.get(entry.finding_id);
    return {
      ...entry,
      ...(finding ? { finding } : {}),
      drop_reason: dropReason,
    };
  });
  return { ...ledger, entries };
}

export interface ClosingCommandResult {
  command: string[];
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ClosingResult {
  contract_version: "remediate-code-closing-result/v1alpha1";
  action: ClosingAction;
  status: "success" | "failed" | "skipped";
  commands: ClosingCommandResult[];
  /** See `ClosingActionPreviewSchema.leftover_files` — same untouched-dirt set, at execute time. */
  leftover_files?: string[];
}

function trimOutput(value: unknown): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString() : String(value ?? "");
  const trimmed = text.trim().slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return trimmed.length > 0 ? trimmed : undefined;
}

function commandResult(
  command: string[],
  result: ReturnType<typeof runTracked>,
): ClosingCommandResult {
  return {
    command,
    exit_code: result.status,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function runTrackedCommand(
  root: string,
  command: string,
  args: string[],
): ClosingCommandResult {
  const result = runTracked([command, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return commandResult([command, ...args], result);
}

function isSuccess(result: ClosingCommandResult): boolean {
  return result.exit_code === 0;
}

// .env* is an absolute hard-exclude: never stageable under any circumstance
// (secrets safety net), regardless of manifest or deliverable membership.
const ENV_EXCLUDE_PATTERN = /^\.env($|\.)/;
// .audit-tools/ scratch (state.json, locks, per-run steps/results, quarantine
// refs) is excluded UNLESS the exact path is one of this run's own tool
// deliverables (see `toolDeliverablePaths`) — those are eligible for staging
// like any other manifest file.
const AUDIT_TOOLS_EXCLUDE_PATTERN = /^\.audit-tools\//;

/**
 * The run's authoritative edit-surface manifest — the ONLY files
 * `collectStagingFiles` may stage (invariant: "remediation close must never
 * commit files the run didn't touch").
 *
 * Two sources, UNION'd (never priority-fallback — see below for why):
 *
 * 1. `state.applied_edit_surface` — ground truth. The union of files every
 *    accepted node ACTUALLY cherry-picked into the main tree, captured
 *    pre-merge from the node's own git branch diff in `acceptNodeWorktree`
 *    (never the worker's self-report) and persisted by
 *    `mergeImplementResultsIntoState` (src/remediate/steps/dispatch/marshal.ts).
 *    Only populated by the isolated-worktree accept lifecycle (the in-process
 *    and host-subagent rolling drivers, `accept-node` / `executeNodeInWorktree`).
 *
 * 2. Each `resolved` item's DECLARED surface — `item_spec.touched_files`
 *    unioned with the finding's `affected_files` — for items whose real edit
 *    was never captured as git ground truth. This is the only option for the
 *    conversation-first hand-driven flow (`remediate-code
 *    merge-implement-results` — a FIRST-CLASS dispatch mode, not legacy: the
 *    host edits directly in the main tree with no per-node worktree/commit to
 *    diff, so `acceptNodeWorktree` never runs and `applied_edit_surface` is
 *    never populated for that block).
 *
 * Why UNION and not "prefer (1), fall back to (2) only when (1) is entirely
 * absent": a single run can mix dispatch modes across blocks (one block landed
 * via worktree-accept, a sibling landed via a conversation-first hand-applied
 * edit in the same close). Priority-fallback keyed on whether (1) is non-empty
 * would silently drop the OTHER mode's real edits from the close commit the
 * moment either mode contributed anything — under-staging the tool's own work,
 * which is exactly the failure class this manifest exists to prevent, just in
 * the opposite direction. Only items with `status === "resolved"` (a real
 * edit, never `resolved_no_change`) contribute to source (2) — a `blocked`
 * item's partial/reverted edits must never be treated as a legitimate surface.
 *
 * RUN-START-DIRTY GUARD on source (2) ONLY: declared surfaces are plan-time
 * DECLARATIONS (write-access grants) / audit evidence — never verified against
 * an actual diff. A declared file that was ALREADY dirty when the run started
 * (`state.run_start_dirty`, captured in `runPlanPhase` before any remediation
 * edit exists) cannot be the run's edit, so it is excluded here — otherwise a
 * resolved item declaring a file the run never actually touched would sweep
 * pre-existing user WIP into the closing commit (the exact over-inclusion class
 * this manifest exists to close). Ground-truth entries from source (1) are
 * NEVER excluded by the snapshot: git proved the run landed those paths, and a
 * tool-merged edit to a file the user ALSO had dirty at run start is a path the
 * tool legitimately owns. A state without `run_start_dirty` (pre-field, or a
 * plan flow that bypasses `runPlanPhase`) means no exclusions.
 *
 * Both sources empty is legitimate (e.g. a run that only produced
 * `resolved_no_change` / skipped items) and correctly yields an empty
 * manifest: nothing but tool deliverables gets staged.
 *
 * Membership semantics: entries are compared via the canonical
 * `normalizeRepoPath` key (forward-slash, `./`-stripped, lowercased — the
 * repo's single path normalizer), so a declared `./Src/Foo.ts` matches git's
 * `Src/Foo.ts`. The RETURNED strings keep their original casing; the
 * normalized form is only ever a comparison key (see `collectStagingFiles`).
 */
function resolveEditSurfaceManifest(state: RemediationState): string[] {
  const files = new Set<string>(state.applied_edit_surface ?? []);
  const runStartDirtyKeys = new Set(
    (state.run_start_dirty ?? []).map(normalizeRepoPath),
  );
  const addUnlessPreexistingDirt = (path: string): void => {
    if (!runStartDirtyKeys.has(normalizeRepoPath(path))) files.add(path);
  };
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  for (const item of Object.values(state.items ?? {})) {
    if (item.status !== "resolved") continue;
    for (const f of item.item_spec?.touched_files ?? []) {
      addUnlessPreexistingDirt(f);
    }
    const finding = findingsById.get(item.finding_id);
    for (const affected of finding?.affected_files ?? []) {
      addUnlessPreexistingDirt(affected.path);
    }
  }
  return [...files];
}

/**
 * Repo-relative paths of the tool-emitted root deliverables `.gitignore`
 * re-includes for tracking (`!.audit-tools/remediation-report.md`,
 * `!.audit-tools/remediation-outcomes.json`) — the two files this close phase
 * itself writes (see the end of `runClosePhase`) that are meant to be
 * committed. Computed from `options` (never a hardcoded `.audit-tools/…`
 * literal) so a non-default `--artifacts-dir` resolves correctly.
 *
 * Deliberately excludes `verification_report.json` / `remediation-state.
 * complete.json`: `.gitignore` does NOT re-include those, so they are never
 * visible to `stagedAndUntracked` (which honours `--exclude-standard`) and
 * need no carve-out here.
 *
 * KNOWN ORDERING NOTE: `runClosePhase` calls `executeClosingAction` (which is
 * where `collectStagingFiles` actually runs) BEFORE it writes these two
 * deliverables to disk — their own content describes THIS closing action's
 * outcome (status/commands), so they cannot exist yet at commit time without
 * describing a commit that hasn't happened. Carving them out of the exclude
 * pattern here does not retroactively stage them into the SAME commit; it
 * means that if they are already dirty for any other reason when
 * `collectStagingFiles` runs (re-included per `.gitignore`, tracked from a
 * prior run, hand-edited, etc.), they are correctly treated as legitimate
 * tool output rather than swept out by the blanket `.audit-tools/` exclude.
 */
function toolDeliverablePaths(options: OrchestratorOptions): string[] {
  const outputDir = dirname(options.artifactsDir);
  return ["remediation-report.md", "remediation-outcomes.json"].map((name) =>
    relative(options.root, join(outputDir, name)).replace(/\\/g, "/"),
  );
}

/** `collectStagingFiles`'s manifest-scoped result. */
export interface StagingSelection {
  /** Manifest (or deliverable) files that are currently dirty — safe to stage. */
  files: string[];
  /**
   * Currently-dirty files that are NEITHER in `manifest` nor a deliverable —
   * pre-existing/unrelated dirt the run never touched. Never staged; surfaced
   * so the host/user can see what was deliberately left alone.
   */
  leftover: string[];
}

/**
 * INVARIANT (V2 fix): remediation close must never commit files the run
 * didn't touch. This is the single chokepoint both the preview
 * (`checkClosingPreview`) and the execute path (`executeClosingAction`) stage
 * through — never a repo-wide `git diff`/`ls-files` sweep.
 *
 * Formula: `files = manifest ∩ currently-dirty` (plus `deliverables`, which
 * are unioned into the effective manifest so they stage like any other
 * manifest entry — see `toolDeliverablePaths`). Any currently-dirty path
 * outside that set is `leftover`: reported, never staged, never committed —
 * committing LESS than a dirty tree is always safe, so a leftover never blocks
 * or aborts the close (a full-abort-on-unrelated-dirt policy would make the
 * tool unusable against a routinely-dirty working tree).
 *
 * TOCTOU note: this recomputes "currently-dirty" fresh on every call (by
 * design — a file the user touched between preview and execute must be
 * re-observed). What it can NEVER do is widen `files` beyond `manifest ∪
 * deliverables`: a newly-dirtied path outside the manifest can only ever land
 * in `leftover`, never `files`. `pre_authorized: true` (see
 * `checkClosingPreview`) only skips the interactive preview step; it does not
 * — and structurally cannot — enlarge what this function is willing to stage.
 *
 * `.env*` is excluded even from an explicit manifest entry (defense-in-depth
 * against ever committing a secret); `.audit-tools/` scratch is excluded
 * unless the path is exactly a caller-supplied deliverable.
 *
 * Path comparison is TWO-TIER: an exact case-preserving key first
 * (`repoPathExactKey` — forward-slash, `./`-stripped), then the canonical
 * lowercased `normalizeRepoPath` key as a fallback ONLY when unambiguous
 * (exactly one dirty path folds to it). The fold tier is what makes a
 * declared `./Src/Foo.ts` match git's `src/Foo.ts` on win32; the exact tier +
 * ambiguity guard is what stops a case-SIBLING pair on a case-sensitive
 * checkout (`Foo.ts` real, `foo.ts` also real and user-dirty) from sweeping
 * the user's file in through the fold. The STAGED output is always git's
 * original-cased path string (never a normalized key — `git add` needs the
 * real on-disk case), and the exclude regexes are tested against the folded
 * key so `.ENV` / `.Audit-Tools/` casing games cannot bypass them.
 *
 * ACCEPTED RESIDUAL (inherent to declared surfaces): in the conversation-first
 * flow a declared-but-never-edited file that the USER dirties DURING the run
 * window (post-plan, pre-close) is indistinguishable from the run's own
 * hand-applied edit — `run_start_dirty` only fences dirt that predates the
 * run. Closing it fully requires per-edit git ground truth, which that flow
 * does not have.
 */
export function collectStagingFiles(
  root: string,
  manifest: string[],
  deliverables: string[] = [],
): StagingSelection {
  const entries = [...manifest, ...deliverables];
  // Two-tier membership: EXACT (case-preserving) match first; the lowercased
  // normalizeRepoPath key only as a fallback, and only when it is UNAMBIGUOUS —
  // i.e. exactly one currently-dirty path folds to that key. On a
  // case-sensitive checkout two REAL files can differ only by case
  // (Foo.ts / foo.ts); a fold-only match would admit the user's case-sibling
  // of a manifest file into the commit — the exact over-inclusion this
  // function exists to prevent. An ambiguous fold therefore stages only the
  // exact-cased match (or none), never both.
  const exactKeys = new Set(entries.map(repoPathExactKey));
  const foldedKeys = new Set(entries.map(normalizeRepoPath));
  const exactDeliverableKeys = new Set(deliverables.map(repoPathExactKey));
  const foldedDeliverableKeys = new Set(deliverables.map(normalizeRepoPath));
  const dirty = [...stagedAndUntracked(root)];
  const foldedDirtyCount = new Map<string, number>();
  for (const f of dirty) {
    const k = normalizeRepoPath(f);
    foldedDirtyCount.set(k, (foldedDirtyCount.get(k) ?? 0) + 1);
  }
  const unambiguous = (foldedKey: string): boolean =>
    (foldedDirtyCount.get(foldedKey) ?? 0) === 1;
  const files: string[] = [];
  const leftover: string[] = [];
  for (const f of dirty) {
    const exact = repoPathExactKey(f);
    const folded = normalizeRepoPath(f);
    if (ENV_EXCLUDE_PATTERN.test(folded)) continue;
    const isDeliverable =
      exactDeliverableKeys.has(exact) ||
      (foldedDeliverableKeys.has(folded) && unambiguous(folded));
    if (AUDIT_TOOLS_EXCLUDE_PATTERN.test(folded) && !isDeliverable) continue;
    const inManifest =
      exactKeys.has(exact) || (foldedKeys.has(folded) && unambiguous(folded));
    if (inManifest) {
      files.push(f); // original-cased git path — never a normalized key
    } else {
      leftover.push(f);
    }
  }
  return { files: files.sort(), leftover: leftover.sort() };
}

/**
 * Case-PRESERVING repo-path comparison key (forward slashes, `./` stripped) —
 * the exact-match tier of `collectStagingFiles`'s two-tier membership. The
 * lowercased `normalizeRepoPath` remains the fold-fallback tier.
 */
function repoPathExactKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Generate a commit message derived from item summaries and finding titles.
 * Falls back to a generic message when there are no findings to summarize.
 */
function generateCommitMessage(state: RemediationState): string {
  const findings = state.plan?.findings ?? [];
  const items = Object.values(state.items ?? {});
  const resolvedFindingIds = new Set(
    items
      .filter((i) => isVerifiedCompleteStatus(i.status))
      .map((i) => i.finding_id),
  );
  const resolved = findings.filter((f) => resolvedFindingIds.has(f.id));
  if (resolved.length === 0) {
    return "Remediation complete";
  }
  if (resolved.length === 1) {
    return `Fix: ${resolved[0]!.title ?? resolved[0]!.id}`;
  }
  const titles = resolved
    .slice(0, 3)
    .map((f) => f.title ?? f.id)
    .join(", ");
  const suffix = resolved.length > 3 ? ` (+${resolved.length - 3} more)` : "";
  return `Fix: ${titles}${suffix}`;
}

/** Actions that require user confirmation before executing. */
const PREVIEW_ACTIONS = new Set<string>(["commit", "push", "open-pr", "publish"]);

/**
 * Check whether the closing action needs a confirmation preview. Returns the
 * preview data if confirmation is needed, or undefined if the action may
 * proceed immediately (pre_authorized, action === 'none'/'tag'/'custom', or
 * no files to stage).
 */
function checkClosingPreview(
  state: RemediationState,
  options: OrchestratorOptions,
): { files: string[]; commit_message: string; leftover_files?: string[] } | undefined {
  const closingPlan = state.closing_plan!;
  if (closingPlan.pre_authorized === true) return undefined;
  if (!PREVIEW_ACTIONS.has(closingPlan.action)) return undefined;
  const { files, leftover } = collectStagingFiles(
    options.root,
    resolveEditSurfaceManifest(state),
    toolDeliverablePaths(options),
  );
  const commitMessage = generateCommitMessage(state);
  return {
    files,
    commit_message: commitMessage,
    ...(leftover.length > 0 ? { leftover_files: leftover } : {}),
  };
}

export function executeClosingAction(
  state: RemediationState,
  options: OrchestratorOptions,
): ClosingResult {
  const action = state.closing_plan!.action;
  if (action === "none") {
    return {
      contract_version: "remediate-code-closing-result/v1alpha1",
      action,
      status: "skipped",
      commands: [],
    };
  }

  const commands: ClosingCommandResult[] = [];
  const run = (command: string, args: string[]): boolean => {
    const result = runTrackedCommand(options.root, command, args);
    commands.push(result);
    return isSuccess(result);
  };
  // Populated only on the commit/push/open-pr branch below; threaded into
  // every return of this function so the caller always sees the same
  // untouched-user-dirt set the preview (checkClosingPreview) computed.
  let leftoverFiles: string[] = [];

  if (action === "commit" || action === "push" || action === "open-pr") {
    // Recomputed here (not reused from the preview) so a file the user
    // touched between preview and execute is re-observed — but ONLY within
    // the same manifest ∪ deliverables the preview used, never a wider sweep
    // (see collectStagingFiles's doc comment: this is the TOCTOU fix, not a
    // TOCTOU reintroduction).
    const staging = collectStagingFiles(
      options.root,
      resolveEditSurfaceManifest(state),
      toolDeliverablePaths(options),
    );
    leftoverFiles = staging.leftover;
    const files = staging.files;
    // Nothing to stage → vacuous success: no commit, push, or PR is attempted,
    // so `commands` stays empty and the status is success.
    if (files.length === 0) {
      console.warn("No modified files to stage — skipping commit.");
      return {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action,
        status: "success",
        commands: [],
        ...(leftoverFiles.length > 0 ? { leftover_files: leftoverFiles } : {}),
      };
    }
    const commitMessage = state.closing_plan!.closing_action_preview?.commit_message
      ?? generateCommitMessage(state);
    const committed =
      run("git", ["add", "--", ...files]) &&
      run("git", ["commit", "-m", commitMessage]);
    if (committed && action === "push") {
      run("git", ["push"]);
    } else if (committed && action === "open-pr") {
      run("git", ["push"]) && run("gh", ["pr", "create", "--fill"]);
    }
  } else if (action === "publish") {
    run("npm", ["publish"]);
  } else if (action === "tag") {
    run("git", ["tag", "auto-remediation"]);
  } else if (action === "merge-to-base") {
    const runId = state.plan?.plan_id ?? "";
    const branch = remediationBranchName(runId);
    const base = readRemediationBaseBranch(options.artifactsDir);
    // No recorded base (detached HEAD at launch, or a branch from a prior run):
    // never guess a merge target — leave everything untouched and tell the host.
    if (!base) {
      return {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action,
        status: "skipped",
        commands: [
          {
            command: ["git", "merge", "--no-ff", branch],
            exit_code: 1,
            stderr: `No recorded base branch for this run — merge \`${branch}\` into your base branch manually.`,
          },
        ],
      };
    }
    // Check out the base and attempt a no-ff merge so the run lands as one
    // revertable merge commit. On any conflict, abort and restore the
    // remediation branch — the base branch is left exactly as it was.
    if (run("git", ["checkout", base])) {
      const merged = run("git", [
        "merge",
        "--no-ff",
        branch,
        "-m",
        `Merge remediation run ${runId}`,
      ]);
      if (!merged) {
        run("git", ["merge", "--abort"]);
        run("git", ["checkout", branch]);
      }
    }
  } else if (action === "custom" && state.closing_plan!.custom_command?.length) {
    run(state.closing_plan!.custom_command[0], state.closing_plan!.custom_command.slice(1));
  }

  return {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action,
    status: commands.every(isSuccess) ? "success" : "failed",
    commands,
    ...(leftoverFiles.length > 0 ? { leftover_files: leftoverFiles } : {}),
  };
}

interface CombinedTestResult {
  passed: boolean;
  duration_ms: number;
  suite_name?: string;
  /** Tail of combined stdout/stderr captured on failure (empty on pass). */
  output: string;
}

/**
 * Run the plan's combined test suite over the fully merged post-remediation
 * state. Returns pass/fail plus the failure-output tail. No test_command =>
 * vacuously passing.
 */
function runCombinedTestSuite(
  state: RemediationState,
  options: OrchestratorOptions,
): CombinedTestResult {
  console.log("Running full test suite on combined post-remediation state...");
  if (!state.plan?.test_command) {
    return { passed: true, duration_ms: 0, output: "" };
  }
  const suiteName = Array.isArray(state.plan.test_command)
    ? state.plan.test_command.join(" ")
    : state.plan.test_command;
  const startedAt = Date.now();
  // Windows-aware: force-hide the console window a windowless parent would
  // otherwise pop for this shell child (former `runShellCommand` default).
  const result = spawnSync(state.plan.test_command, {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  if (result.status === 0) {
    return { passed: true, suite_name: suiteName, duration_ms: durationMs, output: "" };
  }
  const output = (
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "")
  )
    .trim()
    .slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return { passed: false, suite_name: suiteName, duration_ms: durationMs, output };
}

/**
 * Parse test output to extract implicated file paths. Looks for common test
 * runner patterns (e.g. "FAIL src/foo.ts", "at src/foo.ts:12", "● foo.ts").
 */
function extractImplicatedPaths(testOutput: string): string[] {
  const paths = new Set<string>();
  // Match patterns like: FAIL src/foo.ts, at Object.<anonymous> (src/foo.ts:12),
  // src/foo.ts:12:3, ● src/foo.ts
  const pathPattern = /(?:FAIL\s+|at\s+\S+\s+\(|●\s+)?([^\s()]+\.[a-z]{1,6})(?::\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(testOutput)) !== null) {
    const candidate = match[1]!;
    // Only keep plausible repo-relative paths (contain at least one slash or look like a file)
    if (candidate.includes("/") || candidate.includes("\\") || /\.[a-z]{1,6}$/.test(candidate)) {
      // Normalize backslashes, strip leading ./
      const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!normalized.startsWith("node_modules/")) {
        paths.add(normalized);
      }
    }
  }
  return [...paths];
}

/**
 * On a combined-test failure, selectively re-block items whose touched_files
 * overlap with the failing tests' implicated paths. When attribution is
 * ambiguous (no overlap found), falls back to re-blocking all resolved items.
 * Returns whether any item was blocked — the caller transitions back to triage.
 */
function blockResolvedItemsOnCombinedFailure(
  state: RemediationState,
  testOutput: string,
): boolean {
  const resolvedItems = Object.values(state.items ?? {}).filter(
    (i) => isVerifiedCompleteStatus(i.status),
  );
  if (resolvedItems.length === 0) return false;

  const implicatedPaths = extractImplicatedPaths(testOutput);
  const now = new Date().toISOString();

  // Attempt attribution: find items whose touched_files overlap implicated paths.
  let attributed: typeof resolvedItems = [];
  if (implicatedPaths.length > 0) {
    for (const item of resolvedItems) {
      const touchedFiles = item.item_spec?.touched_files ?? [];
      const overlaps = touchedFiles.some((tf) =>
        implicatedPaths.some(
          (ip) => tf === ip || tf.endsWith(`/${ip}`) || ip.endsWith(`/${tf}`) || tf.endsWith(ip) || ip.endsWith(tf),
        ),
      );
      if (overlaps) attributed.push(item);
    }
  }

  const fallback = attributed.length === 0;
  const toBlock = fallback ? resolvedItems : attributed;
  const attributionNote = fallback
    ? `Attribution attempt found no touched_files overlap with failing paths [${implicatedPaths.slice(0, 5).join(", ")}]; falling back to re-blocking all resolved items.`
    : `Attributed to ${attributed.length} item(s) with overlapping touched_files [${implicatedPaths.slice(0, 5).join(", ")}].`;

  for (const item of toBlock) {
    item.status = "blocked";
    item.completed_at = now;
    item.failure_reason = `Combined test suite failed after remediation. ${attributionNote}${testOutput ? `\n\nTest output:\n${testOutput}` : ""}`;
  }

  return true;
}

interface E2eTestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

/**
 * Run end-to-end tests on the fully merged state. E2e runs once here (not
 * per-block) because interdependent refactors can break e2e flows even when
 * per-item unit tests pass. Returns `{ ran: false }` when no e2e_command is
 * configured. Never throws — failure is returned as `passed: false`.
 */
function runE2eTests(
  state: RemediationState,
  options: OrchestratorOptions,
): E2eTestResult {
  if (!state.plan?.e2e_command) {
    return { ran: false, passed: true, output: "" };
  }
  console.log("Running end-to-end tests on combined post-remediation state...");
  // Windows-aware: force-hide the console window a windowless parent would
  // otherwise pop for this shell child (former `runShellCommand` default).
  const e2eResult = spawnSync(state.plan.e2e_command, {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });
  const e2ePassed = e2eResult.status === 0;
  if (!e2ePassed) {
    const e2eOutput = (
      (e2eResult.stdout?.toString() ?? "") +
      (e2eResult.stderr?.toString() ?? "")
    )
      .trim()
      .slice(-FAILURE_OUTPUT_TAIL_CHARS);
    console.warn("End-to-end tests failed after remediation. Transitioning to triage.");
    return { ran: true, passed: false, output: e2eOutput };
  }
  console.log("End-to-end tests passed.");
  return { ran: true, passed: true, output: "" };
}

interface ResolvedReportEntry {
  finding_id: string;
  summary: string;
  verification_evidence?: string[];
}
interface RationaleReportEntry {
  finding_id: string;
  rationale: string;
}
interface ReportEntries {
  resolved: ResolvedReportEntry[];
  verifiedNoChange: ResolvedReportEntry[];
  inappropriate: RationaleReportEntry[];
  ignored: RationaleReportEntry[];
  blocked: RationaleReportEntry[];
}

/**
 * Partition the terminal items into the report's resolved / verified-no-change
 * / inappropriate / ignored buckets, pulling each resolved item's verification
 * evidence from its `verify_code_against_documentation` result file when present.
 */
function collectReportEntries(
  state: RemediationState,
  options: OrchestratorOptions,
): ReportEntries {
  const entries: ReportEntries = {
    resolved: [],
    verifiedNoChange: [],
    inappropriate: [],
    ignored: [],
    blocked: [],
  };
  for (const item of Object.values(state.items ?? {})) {
    if (isVerifiedCompleteStatus(item.status)) {
      const finding = state.plan?.findings.find((f) => f.id === item.finding_id);
      const title = finding?.title ?? "Unknown";
      let verificationEvidence: string[] | undefined;

      const verificationResultPath = join(
        options.artifactsDir,
        `result_${item.finding_id}_verify_code_against_documentation.json`,
      );
      if (existsSync(verificationResultPath)) {
        try {
          const verRes = JSON.parse(readFileSync(verificationResultPath, "utf8"));
          if (Array.isArray(verRes.reason) && verRes.reason.length > 0) {
            verificationEvidence = verRes.reason;
          }
        } catch (error) {
          console.warn(
            `Failed to parse verification result ${verificationResultPath}.`,
            error,
          );
        }
      }

      const entry: ResolvedReportEntry = {
        finding_id: item.finding_id,
        summary: title,
        verification_evidence: verificationEvidence,
      };
      if (item.status === "resolved_no_change") {
        entries.verifiedNoChange.push(entry);
      } else {
        entries.resolved.push(entry);
      }
    } else if (item.status === "deemed_inappropriate") {
      entries.inappropriate.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Deemed inappropriate",
      });
    } else if (item.status === "ignored") {
      entries.ignored.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Ignored by user",
      });
    } else if (item.status === "blocked") {
      entries.blocked.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Blocked",
      });
    }
  }
  return entries;
}

/**
 * Render `remediation-report.md` from the partitioned entries, closing action,
 * e2e result, and per-finding outcomes. Pure string builder (no I/O).
 */
function buildRemediationReportMarkdown(
  state: RemediationState,
  entries: ReportEntries,
  closingResult: ClosingResult,
  e2ePassed: boolean | undefined,
  outcomesReport: RemediationOutcomesReport,
  combinedTest: CombinedTestResult,
  reflections: AgentReflection[] = [],
  quarantined: Array<{ block: string; ref: string; commit: string }> = [],
): string {
  let reportContent = `# Remediation Report\n\n`;

  // Code changes land on a dedicated remediation branch (the base branch is never
  // modified); surface it so the user can review and merge. Only meaningful when a
  // node actually committed a change — a no-change/skip-only run leaves no commits.
  if (entries.resolved.length > 0) {
    const branch = remediationBranchName(state.plan?.plan_id ?? "");
    const mergedToBase =
      closingResult.action === "merge-to-base" && closingResult.status === "success";
    reportContent += mergedToBase
      ? `## Review\n\nAll code changes were applied on \`${branch}\` and merged into your base branch as one \`--no-ff\` merge commit (\`Merge remediation run ${state.plan?.plan_id ?? ""}\`). Review the diff; revert the whole run with \`git revert -m 1 <merge-commit>\` if needed.\n\n`
      : `## Review\n\nAll code changes were applied on the dedicated branch \`${branch}\` — your base branch was left untouched. Review the diff and merge \`${branch}\` into your base branch (or re-run with the \`merge-to-base\` closing action to land it automatically).\n\n`;
  }

  reportContent += `## Resolved — Changed Files\n\n`;
  if (entries.resolved.length === 0) {
    reportContent += `None.\n`;
  } else {
    for (const entry of entries.resolved) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.verifiedNoChange.length > 0) {
    reportContent += `\n## Verified Already Correct (no changes made)\n\n`;
    for (const entry of entries.verifiedNoChange) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.inappropriate.length > 0) {
    reportContent += `\n## Deemed Inappropriate\n\n`;
    for (const entry of entries.inappropriate) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  if (entries.ignored.length > 0) {
    reportContent += `\n## Ignored\n\n`;
    for (const entry of entries.ignored) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  const skippedByCheckpoint = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "dropped_by_checkpoint",
  );
  if (skippedByCheckpoint.length > 0) {
    reportContent += `\n## Skipped by Intent Checkpoint\n\n`;
    reportContent += `${skippedByCheckpoint.length} finding(s) were excluded from remediation by the intent checkpoint (severity/lens/package/theme filters or excluded scope):\n`;
    for (const entry of skippedByCheckpoint) {
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}\n`;
    }
  }

  const droppedByGrounding = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "dropped_phantom_paths",
  );
  if (droppedByGrounding.length > 0) {
    reportContent += `\n## Dropped by Grounding\n\n`;
    reportContent += `${droppedByGrounding.length} extracted finding(s) were dropped because every cited path was phantom (does not exist in this repository):\n`;
    for (const entry of droppedByGrounding) {
      const phantoms = entry.phantom_paths_removed?.join(", ");
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}${phantoms ? ` (cited: ${phantoms})` : ""}\n`;
    }
  }

  const ungroundedEvidence = (state.plan_coverage?.entries ?? []).filter(
    (e) => e.disposition === "planned" && e.evidence_grounded === false,
  );
  if (ungroundedEvidence.length > 0) {
    reportContent += `\n## Ungrounded Evidence\n\n`;
    reportContent += `${ungroundedEvidence.length} planned finding(s) carried no evidence citing a real repo path and were downgraded to low confidence:\n`;
    for (const entry of ungroundedEvidence) {
      reportContent += `- **${entry.finding_id}**${entry.title ? `: ${entry.title}` : ""}\n`;
    }
  }

  reportContent += `\n## Closing Action\n\nAction: ${state.closing_plan!.action}\n`;
  reportContent += `Status: ${closingResult.status}\n`;

  // V2 staging-manifest fix, finding 3: leftover (untouched user dirt) must be
  // visible in the HUMAN report too — on a pre_authorized/autonomous run there
  // is no interactive preview, so this section is the only place the user sees
  // what the close deliberately did not commit.
  if (closingResult.leftover_files?.length) {
    reportContent += `\n## Files Left Untouched (not part of this run's edit surface)\n\n`;
    reportContent += `${closingResult.leftover_files.length} dirty file(s) were NOT staged or committed because they are outside this run's edit-surface manifest (pre-existing or unrelated changes — yours to keep, commit, or discard):\n\n`;
    for (const f of closingResult.leftover_files) {
      reportContent += `- \`${f}\`\n`;
    }
  }

  if (e2ePassed !== undefined) {
    reportContent += `\n## End-to-End Tests\n\nResult: ${e2ePassed ? "passed" : "failed"}\n`;
  }

  const o = outcomesReport.by_outcome;
  reportContent += `\n## Remediation Outcomes\n\n`;
  reportContent += `Of ${outcomesReport.total} finding(s): ${o.resolved} resolved, ${o.verified_no_change} verified already correct, ${o.inappropriate} deemed inappropriate, ${o.ignored} ignored, ${o.blocked} blocked.\n`;
  const lensNames = Object.keys(outcomesReport.by_lens).sort();
  if (lensNames.length > 0) {
    reportContent += `\nBy lens:\n`;
    for (const lens of lensNames) {
      const counts = outcomesReport.by_lens[lens]!;
      const parts = OUTCOME_KEYS.filter((key) => (counts[key] ?? 0) > 0).map(
        (key) => `${key} ${counts[key]}`,
      );
      reportContent += `- ${lens}: ${parts.join(", ")}\n`;
    }
  }

  if (!combinedTest.passed) {
    reportContent += `\n## Combined Test Suite Failure\n\nThe full test suite failed after remediation. No items with a resolved status were available to re-block, so the run completed, but the following failure was recorded:\n\n`;
    if (combinedTest.output) reportContent += `\`\`\`\n${combinedTest.output}\n\`\`\`\n`;
  }

  if (quarantined.length > 0) {
    const runId = state.plan?.plan_id ?? "";
    reportContent += `\n## Preserved for Recovery\n\n`;
    reportContent += `${quarantined.length} node(s) committed real edits but failed the tool's verify/scope/merge and were NOT landed. Their work is preserved under durable git refs (it survives worktree cleanup). Once the verify-failure cause is fixed, re-drive each node with \`remediate-code reverify-node\` — it replays the preserved commit through the real verify/scope/merge gate, lands it on green, and re-finalizes the run (flipping the item to resolved); a bare \`git cherry-pick\` is the last-resort fallback that skips the gate and leaves the run-state marked failed:\n\n`;
    for (const q of quarantined) {
      reportContent += `- **${q.block}**: \`remediate-code reverify-node --id ${q.block} --run-id ${runId}\`  (fallback: \`git cherry-pick ${q.commit}\`, ref: \`${q.ref}\`)\n`;
    }
  }

  // Opt-in worker reflections, aggregated into the same "Process Feedback"
  // section audit-code renders (parity). Empty → no section.
  const feedbackLines = renderProcessFeedbackSection(reflections);
  if (feedbackLines.length > 0) {
    reportContent += `\n${feedbackLines.join("\n")}`;
  }

  return reportContent;
}

/**
 * Clean up the remediator's temporary git branches and the artifact directory.
 * Branches first, artifact dir last so a crash mid-cleanup leaves a recoverable
 * state. Failures are non-fatal but recorded via structured RunLogger context
 * (OBS-003) rather than a bare console.warn.
 *
 * The artifacts directory is only deleted on a fully-green close (no blocked
 * items, combined + e2e tests passed, and the closing action genuinely
 * completed — succeeded, or was the `action === "none"` no-op). When the run is
 * not fully green — e2e failed, combined test failed, an item is blocked, or the
 * closing action failed OR was skipped without completing (e.g. merge-to-base
 * with no recorded base) — the artifacts directory is preserved for diagnosis.
 */
async function cleanupTempBranchesAndArtifacts(
  options: OrchestratorOptions,
  completeState: RemediationState,
  combinedTest: CombinedTestResult,
  e2eResult: E2eTestResult,
  closingResult: ClosingResult,
  runLogger?: RunLogger,
): Promise<void> {
  try {
    const branchResult = runTracked(["git", "branch"], {
      cwd: options.root,
      encoding: "utf8",
    });
    const branches = (branchResult.stdout?.toString() ?? "").split("\n");
    for (const branch of branches) {
      const b = branch.replace("*", "").trim();
      if (b.startsWith("remediator-block-")) {
        runTracked(["git", "branch", "-D", b], { cwd: options.root });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("Failed to clean up temporary git branches.", error);
    runLogger?.event({
      phase: "close",
      kind: "outcome",
      obligation: "closing",
      note: `Failed to clean up temporary git branches: ${reason}`,
    });
  }

  // Write final state before deleting the artifacts directory so the completion
  // is durable even if cleanup partially fails.
  try {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(options.artifactsDir);
    await store.saveState(completeState);
  } catch {
    // Non-fatal — we still return complete
  }

  // Only delete artifacts on a fully-green close. When any test or closing
  // action failed, preserve the directory for diagnosis.
  //
  // CE-003 force-close guard: a `blocked` terminal item means the run did NOT
  // fully succeed — the tool-owned final gate (INV-RS-10) coarse-re-blocked or
  // the bounded backstop terminated the run as blocked. Such a run must never be
  // "landed green" (artifacts deleted as if complete); a vacuous/unset
  // plan.test_command (combinedTest vacuously passing) cannot mask a blocked
  // item. Preserve the artifacts so the partial outcome is diagnosable.
  const anyBlocked = Object.values(completeState.items ?? {}).some(
    (it) => it.status === "blocked",
  );
  // A closing action genuinely completed only when it succeeded, OR it was a
  // skipped no-op (`action === "none"` — nothing was configured to do). A
  // *skipped non-none* close did NOT complete: e.g. merge-to-base with no
  // recorded base leaves the run unmerged and returns status "skipped". Treating
  // that as green would delete the (gitignored, unrecoverable) artifacts dir for
  // a run that never landed. So skipped is green only for the action=none no-op.
  const closingCompleted =
    closingResult.status === "success" ||
    (closingResult.status === "skipped" && closingResult.action === "none");
  const fullyGreen =
    combinedTest.passed &&
    e2eResult.passed &&
    closingCompleted &&
    !anyBlocked;

  if (!fullyGreen) {
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `Artifacts directory preserved for diagnosis (combinedTest.passed=${combinedTest.passed}, e2e.passed=${e2eResult.passed}, closing=${closingResult.status}, closingAction=${closingResult.action}, anyBlocked=${anyBlocked})`,
    });
    return;
  }

  try {
    const { rm } = await import("node:fs/promises");
    await rm(options.artifactsDir, { recursive: true, force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      "Failed to clean up artifacts directory — manual removal may be needed.",
    );
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `Failed to clean up artifacts directory (manual removal may be needed): ${reason}`,
    });
  }
}

/**
 * Build a VerificationReport from the post-remediation state. One
 * FindingVerificationTrace per terminal finding, with trace entries for:
 *   - combined test suite result (task kind)
 *   - each item's verification evidence from result files (file kind)
 *   - closing action outcome (command kind)
 *
 * Overall status is "passed" when combined tests passed and all resolved
 * items have at least one passing trace. "failed" otherwise.
 */
function buildVerificationReport(
  state: RemediationState,
  options: OrchestratorOptions,
  closingResult: ClosingResult,
  combinedTest: CombinedTestResult,
): VerificationReport {
  const findings: FindingVerificationTrace[] = [];
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((f) => [f.id, f]),
  );

  for (const item of Object.values(state.items ?? {})) {
    const finding = findingsById.get(item.finding_id);
    const isResolved = isVerifiedCompleteStatus(item.status);
    const isSkipped = isSkipStatus(item.status);
    const traces: VerificationTraceEntry[] = [];
    const itemPassed = isResolved && combinedTest.passed;

    if (isSkipped) {
      // Ignored/inappropriate items are excluded from the run verdict — they
      // get a single trace recording the user's settled decision and a
      // first-class overall_status of "skipped" (see FindingVerificationTrace
      // doc comment in src/shared/types/contractPipeline/verification.ts).
      // The trace's own `status` stays "failed" because it did not verify
      // anything (there is no passing evidence); the finding-level
      // "skipped" is what excludes it from the report-level verdict below.
      traces.push({
        trace_id: `${item.finding_id}:skipped`,
        kind: "task",
        label: item.status === "ignored" ? "ignored by user" : "deemed inappropriate",
        evidence: [item.failure_reason ?? item.status],
        status: "failed",
      });
      findings.push({
        finding_id: item.finding_id,
        traces,
        overall_status: "skipped",
      });
      continue;
    }

    // Combined test suite trace.
    const suiteLabel = combinedTest.suite_name ?? "combined test suite";
    traces.push({
      trace_id: `${item.finding_id}:combined-tests`,
      kind: "task",
      label: suiteLabel,
      evidence: combinedTest.passed
        ? [`${suiteLabel} passed`]
        : [`${suiteLabel} failed`, ...(combinedTest.output ? [combinedTest.output.slice(-500)] : [])],
      status: combinedTest.passed ? "passed" : "failed",
    });

    const contractGoalId =
      finding?.contract_goal_id ?? (state.plan as { goal_id?: string } | undefined)?.goal_id;
    if (contractGoalId) {
      traces.push({
        trace_id: `${item.finding_id}:contract-goal`,
        kind: "requirement",
        label: "contract-pipeline goal",
        evidence: [`goal_id=${contractGoalId}`],
        status: itemPassed ? "passed" : "failed",
      });
    }

    if (finding?.contract_obligation_ids?.length) {
      traces.push({
        trace_id: `${item.finding_id}:contract-obligations`,
        kind: "requirement",
        label: "contract-pipeline obligations satisfied by task",
        evidence: finding.contract_obligation_ids,
        status: itemPassed ? "passed" : "failed",
      });
    }

    if (finding?.verification_obligation_ids?.length) {
      traces.push({
        trace_id: `${item.finding_id}:verification-obligations`,
        kind: "invariant",
        label: "contract-pipeline verification obligations",
        evidence: finding.verification_obligation_ids,
        status: itemPassed ? "passed" : "failed",
      });
    }

    for (const [index, command] of (finding?.targeted_commands ?? []).entries()) {
      traces.push({
        trace_id: `${item.finding_id}:targeted-command-${index + 1}`,
        kind: "command",
        label: "implementation DAG targeted command",
        evidence: [`planned command: ${command}`],
        status: itemPassed ? "passed" : "failed",
      });
    }

    // Verification result file evidence (verify_code_against_documentation).
    const verificationResultPath = join(
      options.artifactsDir,
      `result_${item.finding_id}_verify_code_against_documentation.json`,
    );
    if (existsSync(verificationResultPath)) {
      try {
        const verRes = JSON.parse(readFileSync(verificationResultPath, "utf8"));
        const evidence: string[] = Array.isArray(verRes.reason) ? verRes.reason : [];
        traces.push({
          trace_id: `${item.finding_id}:verify-doc`,
          kind: "file",
          label: `verify_code_against_documentation for ${item.finding_id}`,
          evidence,
          status: evidence.length > 0 ? "passed" : "failed",
        });
      } catch {
        // Non-fatal: evidence file malformed
      }
    }

    // Closing action trace (one per finding so the report is self-contained).
    if (closingResult.action !== "none") {
      traces.push({
        trace_id: `${item.finding_id}:closing`,
        kind: "command",
        label: `closing action: ${closingResult.action}`,
        evidence: [`status=${closingResult.status}`],
        status: closingResult.status === "failed" ? "failed" : "passed",
      });
    }

    findings.push({
      finding_id: item.finding_id,
      traces,
      overall_status: itemPassed ? "passed" : "failed",
    });
  }

  // Sort by finding_id for determinism.
  findings.sort((a, b) => a.finding_id.localeCompare(b.finding_id));

  // Overall status: ignored/inappropriate (skipped) items do NOT contribute
  // to failure — only resolved/non-skipped items count.
  const overallPassed =
    combinedTest.passed &&
    findings
      .filter((f) => f.overall_status !== "skipped")
      .every((f) => f.overall_status === "passed");

  // Derive goal_id from the plan if available.
  const goalId = (state.plan as { goal_id?: string } | undefined)?.goal_id;

  return {
    contract_version: CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
    ...(goalId ? { goal_id: goalId } : {}),
    findings,
    overall_status: overallPassed ? "passed" : "failed",
    created_at: new Date().toISOString(),
  };
}

export async function runClosePhase(
  state: RemediationState,
  options: OrchestratorOptions,
  runLogger?: RunLogger,
): Promise<RemediationState> {
  console.log("Running Close Phase...");

  if (!state.plan || !state.items || !state.closing_plan) {
    throw new Error(
      "Cannot run close phase: missing plan, items, or closing_plan from state.",
    );
  }

  // 1. Check whether closing action requires user confirmation (preview).
  // When not pre-authorized and action is confirmable, generate the file list +
  // commit message, attach them to closing_plan.closing_action_preview, and
  // return the updated state so the host can present the preview. The host sets
  // closing_plan.pre_authorized = true before the next next-step call.
  const preview = checkClosingPreview(state, options);
  if (preview) {
    const updatedClosingPlan = { ...state.closing_plan, closing_action_preview: preview };
    return { ...state, closing_plan: updatedClosingPlan };
  }

  // 2. Run the full test suite; on failure re-block resolved items and triage.
  const combinedTest = runCombinedTestSuite(state, options);
  if (!combinedTest.passed) {
    console.log("Full test suite failed. Transitioning back to triage.");
    if (blockResolvedItemsOnCombinedFailure(state, combinedTest.output)) {
      return { ...state, status: "triage" };
    }
    console.warn(
      "Combined test suite failed but no resolved items to re-block — completing with test failure recorded in report.",
    );
  }

  // 3. Run end-to-end tests on the fully merged post-remediation state.
  const e2eResult = runE2eTests(state, options);
  if (!e2eResult.passed) {
    console.log("End-to-end tests failed. Transitioning back to triage.");
    blockResolvedItemsOnCombinedFailure(state, e2eResult.output);
    return { ...state, status: "triage" };
  }

  // 4. Execute the closing action and record exact command outcomes before
  // reporting success.
  console.log(`Executing closing action: ${state.closing_plan.action}`);
  const closingResult = executeClosingAction(state, options);
  await writeJsonFile(
    join(options.artifactsDir, "remediation-closing-result.json"),
    closingResult,
  );

  // 4. Generate remediation-report.md and remediation-report.json
  const entries = collectReportEntries(state, options);

  // Phase 7B: capture per-finding outcomes (surface only).
  const outcomesReport = buildRemediationOutcomesReport(
    state,
    closingResult,
  );
  // One run-log line per outcome, plus a summary line for the artifact write.
  for (const outcome of outcomesReport.outcomes) {
    runLogger?.event({
      phase: "close",
      kind: "outcome",
      obligation: "closing",
      note: `${outcome.finding_id} [${outcome.lens}] → ${outcome.outcome} (rework ${outcome.rework_count})`,
    });
  }

  const endedAt = new Date().toISOString();
  // Workers may have appended opt-in reflections during document/implement
  // dispatch; parse leniently (malformed lines skipped) and surface them in the
  // report. Workers own the file — it is read-only here.
  const feedbackText = await readOptionalTextFile(
    join(options.artifactsDir, AGENT_FEEDBACK_FILENAME),
  );
  // Failed-but-committed nodes whose work was preserved under a durable quarantine
  // ref (a tool-verify false-negative must never destroy a good fix) — surface them
  // so the user can recover the work manually.
  const quarantined = options.root
    ? listQuarantinedCommits(options.root, state.plan?.plan_id ?? "")
    : [];
  const reportContent = buildRemediationReportMarkdown(
    state,
    entries,
    closingResult,
    e2eResult.ran ? e2eResult.passed : undefined,
    outcomesReport,
    combinedTest,
    feedbackText ? parseReflectionsNdjson(feedbackText) : [],
    quarantined,
  );

  // Enrich the coverage ledger with never-planned payloads NOW, from the live
  // state and intake artifacts — both are deleted at the end of close, so this
  // must happen strictly before cleanup.
  const outcomeCoverage = await buildOutcomeCoverageLedger(state, options);

  const outcomesFile: RemediationOutcomesReport & {
    started_at?: string;
    ended_at: string;
    step_count: number;
    combined_test_result: {
      passed: boolean;
      suite_name?: string;
      duration_ms: number;
      failure_summary?: string;
    };
    e2e_result?: { passed: boolean };
    closing_result: {
      action: ClosingAction;
      status: string;
      commands: ClosingCommandResult[];
      leftover_files?: string[];
    };
    plan_coverage?: OutcomeCoverageLedger;
  } = {
    ...outcomesReport,
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ended_at: endedAt,
    step_count: state.step_count ?? 0,
    combined_test_result: {
      passed: combinedTest.passed,
      ...(combinedTest.suite_name ? { suite_name: combinedTest.suite_name } : {}),
      duration_ms: combinedTest.duration_ms,
      ...(combinedTest.output ? { failure_summary: combinedTest.output } : {}),
    },
    ...(e2eResult.ran ? { e2e_result: { passed: e2eResult.passed } } : {}),
    closing_result: {
      action: state.closing_plan.action,
      status: closingResult.status,
      commands: closingResult.commands,
      // Untouched-user-dirt set collectStagingFiles left alone (never staged) —
      // see ClosingResult.leftover_files / ClosingActionPreviewSchema.leftover_files.
      ...(closingResult.leftover_files?.length
        ? { leftover_files: closingResult.leftover_files }
        : {}),
    },
    ...(outcomeCoverage ? { plan_coverage: outcomeCoverage } : {}),
  };

  const outputDir = dirname(options.artifactsDir);

  // 5. Write verification_report.json for the contract pipeline closing phase.
  const verificationReport = buildVerificationReport(state, options, closingResult, combinedTest);
  const verificationReportPath = join(outputDir, "verification_report.json");
  const completeState: RemediationState = { ...state, status: "complete" };

  await Promise.all([
    writeTextFile(join(outputDir, "remediation-report.md"), reportContent),
    writeJsonFile(join(outputDir, "remediation-outcomes.json"), outcomesFile),
    writeJsonFile(verificationReportPath, verificationReport),
    writeJsonFile(join(outputDir, "remediation-state.complete.json"), completeState),
  ]);
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "remediation-outcomes.json",
    note: `${outcomesReport.total} outcome(s)`,
  });
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "verification_report.json",
    note: `overall_status=${verificationReport.overall_status}, findings=${verificationReport.findings.length}`,
  });
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "remediation-state.complete.json",
    note: "complete remediation state preserved for retry/recovery",
  });
  console.log("Remediation report generated.");

  // 6. Clean up temporary branches and artifact directory (only when fully green).
  await cleanupTempBranchesAndArtifacts(options, completeState, combinedTest, e2eResult, closingResult, runLogger);

  return completeState;
}
