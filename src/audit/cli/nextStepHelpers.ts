/**
 * Extracted helpers for the next-step command.
 *
 * Splitting these out of nextStepCommand.ts reduces that file to just the
 * top-level cmdNextStep dispatcher, keeping each module focused on a single
 * concern.
 */

import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  advance,
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  type ObligationDef,
  type ObligationOutcome,
} from "audit-tools/shared";
import type {
  AnalyzerSetting,
  GraphEdge,
  SessionConfig,
  SynthesisNarrative,
} from "audit-tools/shared";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  promoteFinalAuditReport,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import {
  artifactTreeLockPath,
  auditReportPath,
  promotedAuditReportPath,
  withFileLock,
} from "audit-tools/shared";
import type { AuditState } from "../types/auditState.js";
import type { Finding } from "../types.js";
import { advanceAudit, type AdvanceAuditResult } from "../orchestrator/advance.js";
import { groundDesignFindings } from "../validation/designFindingGrounding.js";
import {
  captureDesignReviewSnapshot,
  isDesignReviewStale,
  type DesignReviewPass,
} from "../orchestrator/designReviewSnapshot.js";
import { computeArtifactStateSignature } from "../orchestrator/artifactMetadata.js";
import { decideNextStep, PRIORITY, decideAuditFrictionCloseout } from "../orchestrator/nextStep.js";
import { isHostDelegationExecutor } from "../orchestrator/executors.js";
import { deriveAuditState } from "../orchestrator/state.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import {
  collectLowConfidenceEdges,
  type EdgeReasoningResults,
} from "../orchestrator/edgeReasoning.js";
import { buildPathLookup } from "../extractors/graph.js";
import { buildDispositionMap } from "../extractors/disposition.js";
import {
  resolveAnalyzerPlan,
  needsInstallDecision,
} from "../extractors/analyzers/registry.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import {
  persistAnalyzerSettings,
} from "../supervisor/sessionConfig.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "../providers/constants.js";
import { clearDispatchFiles } from "../io/runArtifacts.js";
import { runAuditStep } from "./auditStep.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRun,
  materializeReviewRun,
} from "./reviewRun.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import {
  driveRollingAuditDispatch,
  resolveAuditRollingEngineEnabled,
  resolvesToInProcessDispatchProvider,
} from "./rollingAuditDispatch.js";
import {
  buildAuditSourcePools,
  isInProcessAuditPool,
  auditNodeClaimRegistry,
  auditHybridSettledPath,
} from "./hybridDispatch.js";
import { planHybridDispatch, readSettledPools, addSettledPool } from "audit-tools/shared";

// ── Incoming-artifact helper ──────────────────────────────────────────────────

/**
 * Read a JSON file from the `incoming/` subdirectory of `artifactsDir`.
 * Returns `{ value, path }` when the file exists and parses successfully.
 * Returns `undefined` when the file is absent (ENOENT-family errors).
 * Re-throws all other IO errors unchanged.
 */
export async function tryConsumeIncoming<T>(
  artifactsDir: string,
  filename: string,
): Promise<{ value: T; path: string } | undefined> {
  const filePath = join(artifactsDir, "incoming", filename);
  try {
    const value = await readJsonFile<T>(filePath);
    return { value, path: filePath };
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
    throw error;
  }
}

// ── Parameters type shared across all nextStep helpers ──────────────────────

export type NextStepParams = {
  root: string;
  artifactsDir: string;
  selfCliPath: string;
  timeoutMs: number;
  narrativeEnabled?: boolean;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
  /**
   * Active session config. Threaded so the semantic-review dispatch obligation can
   * route to the in-process rolling driver (A8(a)) when the rolling engine is
   * enabled AND an explicit backend provider is configured.
   */
  sessionConfig?: SessionConfig;
};

export type TerminalStepResult =
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string; triage?: import("audit-tools/shared").FrictionTriageDecision }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

/**
 * The host-actionable outcome of one `next-step` deterministic fold — the
 * discriminated union `runDeterministicForNextStep` returns and `cmdNextStep`
 * renders (one branch per kind). Each audit `ObligationDef.execute` returns this
 * inside an `emit` outcome (or a `transition` carrying the reloaded bundle when
 * the fold continues).
 */
export type NextStepResult =
  | { kind: "semantic_review"; state: AuditState; bundle: ArtifactBundle; activeReviewRun: ActiveReviewRun; selectedExecutor?: string | null }
  | { kind: "design_review"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "confirm_intent"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] }
  | { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] }
  | { kind: "synthesis_narrative"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string; triage?: import("audit-tools/shared").FrictionTriageDecision }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

/**
 * Finalization thrashing tolerance (ARC-b8fed771 / the finalization-cycle guard).
 * The deterministic fold may legitimately revisit a prior artifact state a bounded
 * number of times (e.g. a runtime_validation <-> synthesis ping-pong, or
 * filesystem-retry revision churn) before the canonical report is rendered; only
 * outrunning distinct states by THIS many revisits is a non-converging cycle. Kept
 * a single named constant — never inline the literal (HANDOFF approach-B mandate:
 * no magic numbers).
 */
export const FINALIZATION_CYCLE_TOLERANCE = 16;

// ── Extracted helpers ─────────────────────────────────────────────────────────

/**
 * Build the terminal step for a deterministic fold that has stopped advancing
 * (no actionable obligation, or a cycle guard fired). A rendered report is the
 * deliverable: if synthesis already produced one — or the state is formally
 * complete — present it instead of reporting the stopped fold as a bare
 * "blocked" failure. A completed audit must never surface as blocked just
 * because finalization kept churning (e.g. a runtime_validation <-> synthesis
 * ping-pong, or revision churn from filesystem retries) after the report was
 * written. With no report yet, the stop is a genuine block.
 */
export async function buildTerminalStep(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  blockedReason: string,
): Promise<TerminalStepResult> {
  const reportRendered =
    state.status === "complete" || Boolean(bundle.audit_report);
  await writeHandoffOnly({
    root: params.root,
    artifactsDir: params.artifactsDir,
    bundle,
    audit_state: state,
    progress_summary:
      reportRendered && state.status !== "complete"
        ? `Audit report already rendered; ending run. ${blockedReason}`
        : blockedReason,
    providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
  });
  if (!reportRendered) {
    return { kind: "blocked", state, bundle, reason: blockedReason };
  }
  const promoted = await promoteFinalAuditReport({
    artifactsDir: params.artifactsDir,
  });
  const triage = await decideAuditFrictionCloseout(params.artifactsDir, "run");
  return {
    kind: "complete",
    state,
    bundle,
    finalReportPath: promoted.promoted
      ? promotedAuditReportPath(params.artifactsDir)
      : auditReportPath(params.artifactsDir),
    triage,
  };
}

type GraphEnrichmentBranchResult =
  | { action: "continue" }
  | { action: "return"; result: { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] } }
  | { action: "return"; result: { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] } }
  | { action: "fallthrough" };

/**
 * Handle the `graph_enrichment_executor` incoming-artifact polling block.
 * Checks for pending analyzer install decisions and edge-reasoning results.
 * Returns an action object:
 *   - `continue`    → caller should keep folding (already consumed an artifact).
 *   - `return`      → caller should emit the embedded result to cmdNextStep.
 *   - `fallthrough` → no incoming artifacts; run the deterministic executor.
 */
export async function handleGraphEnrichmentBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since">,
  bundle: ArtifactBundle,
  state: AuditState,
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined },
): Promise<GraphEnrichmentBranchResult> {
  const includedFiles = bundle.repo_manifest
    ? [
        ...new Set(
          buildPathLookup(
            bundle.repo_manifest,
            buildDispositionMap(bundle.file_disposition),
          ).values(),
        ),
      ]
    : [];
  const plan = resolveAnalyzerPlan(params.root, analyzersRef.value, includedFiles);
  const unresolved = plan.filter(needsInstallDecision);
  if (unresolved.length > 0) {
    const incoming = await tryConsumeIncoming<Record<string, unknown>>(
      params.artifactsDir,
      "analyzer-decisions.json",
    );
    if (incoming && incoming.value !== null && typeof incoming.value === "object") {
      const settings: Record<string, AnalyzerSetting> = {};
      for (const [id, value] of Object.entries(incoming.value)) {
        if (
          value === "ephemeral" ||
          value === "permanent" ||
          value === "skip" ||
          value === "repo" ||
          value === "auto"
        ) {
          settings[id] = value;
        }
      }
      if (Object.keys(settings).length > 0) {
        const merged = await persistAnalyzerSettings(
          params.artifactsDir,
          settings,
        );
        analyzersRef.value = merged.analyzers;
      } else {
        // All entries in analyzer-decisions.json failed the recognized-value
        // check (ephemeral|permanent|skip|repo|auto). Emit a diagnostic so the
        // operator knows why no settings were applied (COR-03418a9f fix).
        const invalidEntries = Object.keys(incoming.value).join(", ") || "(none)";
        process.stderr.write(
          `[audit-code] analyzer-decisions.json ignored: no recognized values (got: ${invalidEntries}). ` +
            `Valid values are: ephemeral, permanent, skip, repo, auto.\n`,
        );
      }
      await unlink(incoming.path).catch(() => {});
      return { action: "continue" };
    }
    return { action: "return", result: { kind: "analyzer_install", state, bundle, unresolved } };
  }

  // Phase 4B — optional edge-reasoning producing turn. Once analyzer installs
  // are resolved, if the flag is on and the floor carries low-confidence
  // (< 0.65) edges, emit one bounded host turn (subagent dispatch or a single
  // host step) to produce reason rewrites, then re-run. The enrichment
  // executor applies the host-supplied rewrites in the SAME advanceAudit call
  // that merges analyzer edges and writes analyzer_capability, so graph_bundle
  // and its marker stay revision-consistent (no staleness loop). Flag off or
  // no candidates → fall through and run the executor with no rewrites.
  if (params.graphLlmEdgeReasoning === true && bundle.graph_bundle) {
    const candidates = collectLowConfidenceEdges(bundle.graph_bundle);
    if (candidates.length > 0) {
      const edgeReasoningIncoming = await tryConsumeIncoming<EdgeReasoningResults>(
        params.artifactsDir,
        "edge-reasoning.json",
      );
      if (edgeReasoningIncoming) {
        await runAuditStep({
          root: params.root,
          artifactsDir: params.artifactsDir,
          analyzers: analyzersRef.value,
          graphLlmEdgeReasoning: true,
          edgeReasoningResultsPath: edgeReasoningIncoming.path,
          since: params.since,
        });
        await unlink(edgeReasoningIncoming.path).catch(() => {});
        return { action: "continue" };
      }
      return { action: "return", result: { kind: "edge_reasoning", state, bundle, candidates } };
    }
  }
  // No undecided installs (and no pending edge reasoning): fall through to run
  // the executor below (it installs for ephemeral/permanent, uses repo/cache,
  // skips the rest).
  return { action: "fallthrough" };
}

type BranchActionResult =
  | { action: "continue" }
  | { action: "return"; result: { kind: "design_review"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle } };

/**
 * Handle the `design_review_contract` or `design_review_conceptual` incoming-artifact
 * polling blocks. Checks for contract and/or conceptual findings files independently.
 *
 * Returns:
 *   - `continue`               → one or both incoming files were consumed; keep folding.
 *   - `design_review_parallel` → both passes still needed; dispatch two subagents.
 *   - `design_review_contract` → only contract pass still needed.
 *   - `design_review_conceptual` → only conceptual pass still needed.
 *
 * Also handles legacy `design-review-findings.json` for backward compatibility.
 */
/** Whether a completed design-review pass has gone stale vs. its snapshot. */
function passIsStale(bundle: ArtifactBundle, pass: DesignReviewPass): boolean {
  const snapshot = bundle.design_review_snapshots?.[pass];
  return snapshot ? isDesignReviewStale(snapshot, bundle) : false;
}

export async function handleDesignReviewBranch(
  params: Pick<NextStepParams, "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
): Promise<BranchActionResult> {
  const existing = bundle.design_assessment;

  // Legacy: consume old combined findings file. Always unlink when present to
  // prevent accumulation, even when design_assessment is absent (COR-68f07c3e).
  const legacyIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-findings.json",
  );
  if (legacyIncoming) {
    await unlink(legacyIncoming.path).catch(() => {});
    if (Array.isArray(legacyIncoming.value) && existing) {
      existing.review_findings = groundDesignFindings(legacyIncoming.value, bundle.repo_manifest);
      existing.reviewed = true;
      await writeJsonFile(
        join(params.artifactsDir, "design_assessment.json"),
        existing,
      );
      return { action: "continue" };
    }
    // File consumed (deleted) but no target to merge into — keep folding.
    return { action: "continue" };
  }

  // New: consume contract-findings and/or conceptual-findings independently.
  const contractIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-contract-findings.json",
  );
  const conceptualIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-conceptual-findings.json",
  );

  let consumed = false;

  // Always delete incoming files when present; only merge data when existing
  // design_assessment is present (COR-68f07c3e).
  if (contractIncoming) {
    await unlink(contractIncoming.path).catch(() => {});
    if (Array.isArray(contractIncoming.value) && existing) {
      existing.contract_findings = groundDesignFindings(contractIncoming.value, bundle.repo_manifest);
      existing.contract_reviewed = true;
      consumed = true;
    }
  }

  if (conceptualIncoming) {
    await unlink(conceptualIncoming.path).catch(() => {});
    if (Array.isArray(conceptualIncoming.value) && existing) {
      existing.conceptual_findings = groundDesignFindings(conceptualIncoming.value, bundle.repo_manifest);
      existing.conceptual_reviewed = true;
      consumed = true;
    }
  }

  if (consumed && existing) {
    await writeJsonFile(
      join(params.artifactsDir, "design_assessment.json"),
      existing,
    );
    // Snapshot each just-completed pass (B2 parity port): record the verdict +
    // the semantic projection of the structural inputs it reviewed, so a later
    // upstream change re-stales the pass and the re-emit can be diff-scoped
    // rather than a blind full re-run. Capture after the design_assessment write
    // so the projection reflects the persisted findings.
    const reviewedAt = new Date().toISOString();
    if (contractIncoming) {
      await captureDesignReviewSnapshot(
        params.artifactsDir,
        "contract",
        existing.contract_findings ?? [],
        bundle,
        reviewedAt,
      );
    }
    if (conceptualIncoming) {
      await captureDesignReviewSnapshot(
        params.artifactsDir,
        "conceptual",
        existing.conceptual_findings ?? [],
        bundle,
        reviewedAt,
      );
    }
    return { action: "continue" };
  }

  // Determine which passes still need to run. A completed pass whose snapshot has
  // gone stale (a structural input changed in projection) is NOT done — it must
  // re-run as a diff-based re-review. This mirrors the obligation staleness in
  // `designReviewPassState`.
  const contractDone =
    existing?.contract_reviewed === true && !passIsStale(bundle, "contract");
  const conceptualDone =
    existing?.conceptual_reviewed === true && !passIsStale(bundle, "conceptual");

  if (!contractDone && !conceptualDone) {
    return { action: "return", result: { kind: "design_review_parallel", state, bundle } };
  }
  if (!contractDone) {
    return { action: "return", result: { kind: "design_review_contract", state, bundle } };
  }
  if (!conceptualDone) {
    return { action: "return", result: { kind: "design_review_conceptual", state, bundle } };
  }

  // Both done — should not normally reach here (obligations would be satisfied).
  return { action: "continue" };
}

type SynthesisNarrativeBranchResult =
  | { action: "continue" }
  | { action: "run_omit" }
  | { action: "return"; result: { kind: "synthesis_narrative"; state: AuditState; bundle: ArtifactBundle } };

/**
 * Handle the `synthesis_narrative_executor` incoming-artifact polling block.
 * Returns:
 *   - `continue`  → an incoming narrative file was consumed + applied (progress
 *     made); re-scan on the reloaded bundle.
 *   - `return`    → a host turn is still needed (narrative enabled, none supplied
 *     yet); emit the synthesis_narrative step.
 *   - `run_omit`  → narrative disabled; run the deterministic omit executor (it
 *     writes the `status:omitted` marker, satisfying synthesis_narrative_current).
 *     This MUST make progress, never a no-op reload — otherwise the obligation
 *     stays actionable and the fold spins (the guards do not cover this branch).
 */
export async function handleSynthesisNarrativeBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "narrativeEnabled">,
  bundle: ArtifactBundle,
  state: AuditState,
): Promise<SynthesisNarrativeBranchResult> {
  const narrativeIncoming = await tryConsumeIncoming<SynthesisNarrative>(
    params.artifactsDir,
    "synthesis-narrative.json",
  );
  if (narrativeIncoming) {
    await runAuditStep({
      root: params.root,
      artifactsDir: params.artifactsDir,
      preferredExecutor: "synthesis_narrative_executor",
      narrativeResultsPath: narrativeIncoming.path,
    });
    await unlink(narrativeIncoming.path).catch(() => {});
    return { action: "continue" };
  }
  if (params.narrativeEnabled) {
    return { action: "return", result: { kind: "synthesis_narrative", state, bundle } };
  }
  // Narrative disabled: run the deterministic omit executor below.
  return { action: "run_omit" };
}

/**
 * Execute one deterministic audit step and record its progress. Throws (with
 * cause) if the executor fails, preserving the existing throw-with-cause pattern.
 * `index` is the 0-based fold position (the transition counter), surfaced as the
 * 1-based `iteration` in the `deterministic-progress.json` marker a
 * filesystem-watching host reads.
 */
export async function executeAndRecord(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since">,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  decision: ReturnType<typeof decideNextStep>,
  index: number,
  lastSummary: string,
): Promise<AdvanceAuditResult> {
  try {
    // Write a "started" marker before execution so a host watching the filesystem
    // can tell which executor is active during a long-running step (OBS-0d4c2311).
    const startedAt = new Date().toISOString();
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      executor: decision.selected_executor,
      obligation: decision.selected_obligation,
      status: "running",
      started_at: startedAt,
    });
    const result = await runAuditStep({
      root: params.root,
      artifactsDir: params.artifactsDir,
      analyzers,
      graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
      since: params.since,
    });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      last_executor: result.selected_executor,
      last_obligation: decision.selected_obligation,
      progress_made: result.progress_made,
      summary: result.progress_summary,
      status: "complete",
      started_at: startedAt,
      timestamp: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    // O2: error-recovery is itself a load→modify→persist artifact-tree mutation
    // (runAuditStep has already released its lock by the time we reach this
    // catch), so hold the artifact-tree lock across the whole RMW.
    await withFileLock(artifactTreeLockPath(params.artifactsDir), async () => {
      const current = await loadArtifactBundle(params.artifactsDir);
      const currentState = deriveAuditState(current);
      currentState.last_executor = decision.selected_executor ?? undefined;
      currentState.last_obligation = decision.selected_obligation ?? undefined;
      await writeCoreArtifacts(params.artifactsDir, { ...current, audit_state: currentState });
    });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      last_executor: decision.selected_executor,
      last_obligation: decision.selected_obligation,
      prior_summary: lastSummary || null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic executor ${decision.selected_executor} failed on obligation ${decision.selected_obligation} (iteration ${index + 1}, prior progress: ${lastSummary || "none"}): ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

// ── Cycle guards (kept in audit's Ctx; NOT routed through advance) ─────────────
//
// HANDOFF approach-B: the shared `advance` engine is inherently 0-tolerance (it
// signs `current` at the top of every loop and stops on the FIRST revisit), so it
// cannot express the finalization-cycle tolerance window or the no-metadata-skip
// the hand loop relied on. Approach A collapsed both guards into advance's
// `stateSignature` and false-tripped on a fresh-Linux floor-only chain. So the two
// guards stay HERE, invoked from inside the deterministic-executor obligation, and
// `advance` runs with no `stateSignature` (its `maxTransitions` is the pure
// runaway backstop only).

/**
 * Pre-dispatch no-progress guard (ARC-b8fed771).
 *
 * Runs BEFORE a deterministic executor is dispatched. If the fold is about to
 * re-dispatch the SAME executor for the SAME obligation from an artifact-state
 * signature it has ALREADY dispatched that exact (executor, obligation) pair
 * from this run, the prior dispatch left the content-state unchanged (same
 * signature) — so dispatching it again cannot make progress and would spin.
 * Stop the fold with a terminal step instead of re-dispatching.
 *
 * The dispatch IDENTITY (signature + executor + obligation), not the signature
 * alone, is the recurrence key. A recurring signature across DIFFERENT executors
 * is legitimate: no-op-but-satisfying steps (auto-fix with nothing to fix,
 * syntax-resolution with no errors) leave the artifact content unchanged while
 * still advancing the obligation chain — those must NOT trip the guard. Only a
 * literal re-entry of the same executor on the same unchanged state is the
 * infinite loop this catches.
 *
 * This is the immediate-recurrence complement to `checkFinalizationCycle` (the
 * post-dispatch tolerance-based thrash detector across many executors): this
 * guard refuses to re-enter the SAME executor on a state it already failed to
 * advance, rather than waiting for the tolerance window to fill. Returns a
 * terminal-step result when the guard fires, or undefined to proceed.
 *
 * `dispatchedSignatures` is mutated: the current dispatch identity is recorded
 * so a later iteration that returns to this exact (state, executor, obligation)
 * trips the guard.
 */
export async function checkNoProgressBeforeDispatch(ctx: {
  index: number;
  dispatchedSignatures: Set<string>;
  params: Pick<NextStepParams, "artifactsDir" | "root">;
  bundle: ArtifactBundle;
  state: AuditState;
  selectedObligation: string | null | undefined;
  selectedExecutor: string | null | undefined;
}): Promise<TerminalStepResult | undefined> {
  const signature = computeArtifactStateSignature(ctx.bundle);
  const dispatchKey = `${signature}|${ctx.selectedExecutor ?? ""}|${ctx.selectedObligation ?? ""}`;
  // "no-metadata" is the pre-artifact bootstrap state (no artifact_metadata yet
  // — e.g. before the first executor stamps any metadata). Many early
  // deterministic steps legitimately dispatch from it before metadata exists, so
  // it is not a no-progress signal; only a real, metadata-bearing signature
  // recurring for the SAME executor means an executor already ran here without
  // changing content.
  if (signature !== "no-metadata" && ctx.dispatchedSignatures.has(dispatchKey)) {
    await writeJsonFile(
      join(ctx.params.artifactsDir, "steps", "deterministic-progress.json"),
      {
        iteration: ctx.index + 1,
        no_progress_detected: true,
        repeated_obligation: ctx.selectedObligation ?? "unknown",
        repeated_executor: ctx.selectedExecutor ?? "unknown",
        summary:
          "Pre-dispatch no-progress guard: about to re-dispatch " +
          `${ctx.selectedExecutor ?? "an executor"} for obligation ` +
          `${ctx.selectedObligation ?? "unknown"} from an artifact state already ` +
          "dispatched this run without net progress; stopping instead of looping.",
        timestamp: new Date().toISOString(),
      },
    );
    return buildTerminalStep(
      ctx.params,
      ctx.bundle,
      ctx.state,
      "No-progress guard: a deterministic executor was about to re-run on an " +
        "artifact state it already processed this run without changing it " +
        `(obligation ${ctx.selectedObligation ?? "unknown"}, executor ` +
        `${ctx.selectedExecutor ?? "unknown"}). Stopping to avoid an infinite ` +
        "no-progress loop.",
    );
  }
  ctx.dispatchedSignatures.add(dispatchKey);
  return undefined;
}

/**
 * Check for a finalization cycle: when fold transitions outrun distinct artifact
 * states by FINALIZATION_CYCLE_TOLERANCE, the deterministic executors are
 * revisiting states rather than progressing. Returns a terminal-step result
 * when a cycle is detected, or undefined when the run is still progressing.
 */
export async function checkFinalizationCycle(ctx: {
  index: number;
  obligationTrail: string[];
  seenStateSignatures: Set<string>;
  tolerance: number;
  params: Pick<NextStepParams, "artifactsDir" | "root">;
  bundle: ArtifactBundle;
  state: AuditState;
  result: AdvanceAuditResult;
  selectedObligation: string | null | undefined;
}): Promise<TerminalStepResult | undefined> {
  ctx.obligationTrail.push(ctx.selectedObligation ?? "unknown");
  ctx.seenStateSignatures.add(computeArtifactStateSignature(ctx.result.updated_bundle));
  if (ctx.index + 1 - ctx.seenStateSignatures.size < ctx.tolerance) {
    return undefined;
  }
  const cycle = Array.from(
    new Set(ctx.obligationTrail.slice(-ctx.tolerance)),
  );
  await writeJsonFile(
    join(ctx.params.artifactsDir, "steps", "deterministic-progress.json"),
    {
      iteration: ctx.index + 1,
      cycle_detected: true,
      cycling_obligations: cycle,
      summary:
        "Finalization kept revisiting prior artifact states without net " +
        `progress; stopping. Cycling obligations: ${cycle.join(" -> ")}.`,
      timestamp: new Date().toISOString(),
    },
  );
  return buildTerminalStep(
    ctx.params,
    ctx.result.updated_bundle,
    ctx.result.audit_state,
    "Finalization is not converging: deterministic executors kept revisiting " +
      `prior artifact states (${cycle.join(" -> ")}). Review whether these ` +
      "obligations are erroneously invalidating each other.",
  );
}

// ── advance engine binding ────────────────────────────────────────────────────

/**
 * Per-call execution dependencies threaded to every audit obligation executor.
 * Mirrors remediate-code's `RemediateCtx`: the shared engine stays agnostic;
 * audit-code picks its own `Ctx`. The refs carry the fold-local mutable state the
 * hand-rolled `for` loop kept in closures — the analyzer settings a decisions
 * file can update mid-fold, the last progress summary surfaced in the terminal
 * block, and the cycle-guard bookkeeping (transition counter + the no-progress /
 * finalization-cycle sets the two guards mutate).
 */
interface AuditNextStepCtx {
  params: NextStepParams;
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined };
  lastSummaryRef: { value: string };
  /**
   * 0-based fold position == the hand loop's `index`. Incremented AFTER each
   * `transition` outcome (see `countTransitions`), so during any `execute` it
   * holds the index of the current iteration. The two guards read it as `index`.
   */
  iterationRef: { value: number };
  /** Pre-dispatch no-progress guard state (ARC-b8fed771): dispatched identities. */
  dispatchedSignatures: Set<string>;
  /** Finalization-cycle guard state: distinct post-execute artifact signatures. */
  seenStateSignatures: Set<string>;
  /** Finalization-cycle guard state: obligation order, for the cycle report. */
  obligationTrail: string[];
}

/** The engine state audit folds on: the in-memory bundle (reloaded per transition). */
type AuditEngineState = ArtifactBundle;

type AuditObligationDef = ObligationDef<
  AuditEngineState,
  AuditNextStepCtx,
  NextStepResult
>;

type AuditOutcome = ObligationOutcome<AuditEngineState, NextStepResult>;

/**
 * A deterministic-executor `emit` of a blocked step — the `!progress_made`
 * dead-end the hand loop returned directly from `executeAndRecord`.
 */
function blockedFromResult(result: AdvanceAuditResult): AuditOutcome {
  return {
    kind: "emit",
    step: {
      kind: "blocked",
      state: result.audit_state,
      bundle: result.updated_bundle,
      reason: result.progress_summary,
    },
  };
}

/**
 * Run one deterministic executor for the selected obligation, reproducing the
 * hand loop's normal-path arm: the pre-dispatch no-progress guard, then
 * record + dispatch, then the post-dispatch finalization-cycle guard. A guard
 * that fires `emit`s its terminal step (so `advance` returns it); a
 * `!progress_made` dead-end emits a blocked step; otherwise clear dispatch
 * staging and `transition` on the reloaded bundle so the fold continues.
 *
 * The two guards stay HERE (not in `advance.opts.stateSignature`) so the
 * no-metadata-skip and the FINALIZATION_CYCLE_TOLERANCE window are preserved —
 * see the cycle-guard section comment.
 */
async function runDeterministicExecutor(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const decision = decideNextStep(bundle);

  const noProgress = await checkNoProgressBeforeDispatch({
    index: ctx.iterationRef.value,
    dispatchedSignatures: ctx.dispatchedSignatures,
    params: ctx.params,
    bundle,
    state: decision.state,
    selectedObligation: decision.selected_obligation,
    selectedExecutor: decision.selected_executor,
  });
  if (noProgress !== undefined) return { kind: "emit", step: noProgress };

  const result = await executeAndRecord(
    ctx.params,
    ctx.analyzersRef.value,
    decision,
    ctx.iterationRef.value,
    ctx.lastSummaryRef.value,
  );
  ctx.lastSummaryRef.value = result.progress_summary;
  if (!isHostDelegationExecutor(result.selected_executor ?? "")) {
    await clearDispatchFiles(ctx.params.artifactsDir);
  }
  if (!result.progress_made) {
    return blockedFromResult(result);
  }

  const cycle = await checkFinalizationCycle({
    index: ctx.iterationRef.value,
    obligationTrail: ctx.obligationTrail,
    seenStateSignatures: ctx.seenStateSignatures,
    tolerance: FINALIZATION_CYCLE_TOLERANCE,
    params: ctx.params,
    bundle,
    state: decision.state,
    result,
    selectedObligation: decision.selected_obligation,
  });
  if (cycle !== undefined) return { kind: "emit", step: cycle };

  return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
}

/**
 * `derive` for an audit obligation: look up its precomputed satisfaction state
 * from `deriveAuditState` — the holistic content-hash staleness pass that
 * computes EVERY obligation's state in one scan (`state.ts`). A pruned/absent
 * obligation is satisfied. `decideNextStep`'s persisted-`complete` short-circuit
 * yields an all-satisfied scan (no actionable obligation), which `advance`
 * surfaces as `step === null` → the post-fold terminal.
 */
function deriveObligationState(
  id: string,
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    const state = deriveAuditState(bundle);
    const found = state.obligations.find((o) => o.id === id);
    if (!found) return "satisfied";
    return found.state === "missing" || found.state === "stale"
      ? found.state
      : "satisfied";
  };
}

/**
 * Build the audit obligation definitions in `PRIORITY` order. Each `execute`
 * relocates the corresponding arm of the hand-rolled `for` loop:
 * deterministic executors `transition` (fold), host-delegation / dispatch /
 * terminal points `emit` the host-actionable step. Selection stays single-sourced
 * (`deriveObligationState` reads `deriveAuditState`, and `decideNextStep` resolves
 * the executor for the selected id), so the obligation list cannot drift from the
 * priority scan it mirrors.
 */
function buildAuditObligations(): AuditObligationDef[] {
  const deterministic = (id: string): AuditObligationDef => ({
    id,
    derive: deriveObligationState(id),
    execute: (bundle, ctx) => runDeterministicExecutor(bundle, ctx),
  });

  return [
    // Provider confirmation gate: a session-level deterministic auto-complete
    // (writes a default provider_confirmation.json) — folds on like any other
    // deterministic executor.
    deterministic("provider_confirmation"),
    deterministic("repo_manifest"),
    deterministic("file_disposition"),
    deterministic("auto_fixes_applied"),
    deterministic("syntax_resolved"),
    deterministic("structure_artifacts"),
    {
      // Graph enrichment: poll the analyzer-decision / edge-reasoning incoming
      // artifacts first (emit a host step when one is needed), otherwise run the
      // deterministic enrichment executor.
      id: "graph_enrichment_current",
      derive: deriveObligationState("graph_enrichment_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleGraphEnrichmentBranch(
          ctx.params,
          bundle,
          state,
          ctx.analyzersRef,
        );
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "continue") {
          // A decisions/edge file was consumed (and possibly applied): re-scan on
          // the reloaded bundle without running the executor this turn.
          return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
        }
        // fallthrough: run the deterministic enrichment executor.
        return runDeterministicExecutor(bundle, ctx);
      },
    },
    deterministic("design_assessment_current"),
    {
      // Confirm-intent host step: the host writes intent_checkpoint.json (read by
      // deriveAuditState on re-invocation), so there is no incoming artifact to
      // consume — emit the step directly.
      id: "intent_checkpoint_current",
      derive: deriveObligationState("intent_checkpoint_current"),
      execute: async (bundle): Promise<AuditOutcome> => ({
        kind: "emit",
        step: { kind: "confirm_intent", state: deriveAuditState(bundle), bundle },
      }),
    },
    {
      // Contract design-review pass: poll incoming contract/conceptual findings;
      // emit the dispatch step when a pass still needs to run.
      id: "design_review_contract_completed",
      derive: deriveObligationState("design_review_contract_completed"),
      execute: (bundle, ctx) => runDesignReviewObligation(bundle, ctx),
    },
    {
      // Conceptual design-review pass: same incoming-poll handler (it resolves
      // which pass remains).
      id: "design_review_conceptual_completed",
      derive: deriveObligationState("design_review_conceptual_completed"),
      execute: (bundle, ctx) => runDesignReviewObligation(bundle, ctx),
    },
    deterministic("planning_artifacts"),
    {
      // The audit-task dispatch obligation maps to the host-delegation
      // rolling_dispatch_executor (no deterministic runner) → semantic review.
      id: "audit_tasks_completed",
      derive: deriveObligationState("audit_tasks_completed"),
      execute: (bundle, ctx) => runHostDelegationObligation(bundle, ctx),
    },
    deterministic("audit_results_ingested"),
    deterministic("runtime_validation_current"),
    deterministic("synthesis_current"),
    {
      // Synthesis narrative: poll the incoming narrative; emit the host step when
      // narrative is enabled and not yet supplied, otherwise the deterministic
      // omit runs (fold on).
      id: "synthesis_narrative_current",
      derive: deriveObligationState("synthesis_narrative_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleSynthesisNarrativeBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          // Narrative disabled: run the deterministic omit executor so the
          // status:omitted marker is written and the obligation is satisfied.
          // (A bare reload here would leave it actionable and spin the fold.)
          return runDeterministicExecutor(bundle, ctx);
        }
        // continue: an incoming narrative was consumed + applied — re-scan.
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
  ];
}

/** Shared design-review-pass executor (both pass obligations route here). */
async function runDesignReviewObligation(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const state = deriveAuditState(bundle);
  const branch = await handleDesignReviewBranch(ctx.params, bundle, state);
  if (branch.action === "return") {
    return { kind: "emit", step: branch.result };
  }
  return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
}

/**
 * Host-delegation dispatch obligation (`audit_tasks_completed` →
 * rolling_dispatch_executor, no deterministic runner): materialize the semantic
 * review run and emit it. Guards on the executor actually being host-delegation,
 * mirroring the hand loop's `isHostDelegationExecutor` branch; a missing/non-
 * delegation executor emits the same blocked step the no-executor branch did.
 */
async function runHostDelegationObligation(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const decision = decideNextStep(bundle);
  const state = decision.state;
  if (!decision.selected_executor) {
    return emitNoExecutorBlocked(bundle, ctx, decision);
  }
  if (!isHostDelegationExecutor(decision.selected_executor)) {
    // Not host-delegation and no deterministic graph_enrichment/design-review
    // handler claimed it: fall back to the deterministic executor path (which
    // emits blocked when the runner is absent / makes no progress).
    return runDeterministicExecutor(bundle, ctx);
  }

  // A8(a) in-process provider driver: when the rolling engine is enabled AND the
  // operator EXPLICITLY configured a programmatic backend provider
  // (openai-compatible / codex / opencode), the orchestrator drives the WHOLE
  // semantic-review dispatch ITSELF — the provider is the per-packet worker —
  // instead of emitting a host-subagent dispatch step. It `transition`s once the
  // results are ingested so the fold re-derives state (the obligation-engine analog
  // of the hand loop's `continue`), mirroring remediate's decideNextStep transition
  // after driveRollingImplementDispatch.
  const sessionConfig = ctx.params.sessionConfig;
  if (
    resolveAuditRollingEngineEnabled({ sessionConfig }) &&
    resolvesToInProcessDispatchProvider(sessionConfig)
  ) {
    const { activeReviewRun } = await materializeReviewRun({
      root: ctx.params.root,
      artifactsDir: ctx.params.artifactsDir,
      bundle,
      obligationId: decision.selected_obligation,
      selfCliPath: ctx.params.selfCliPath,
      timeoutMs: ctx.params.timeoutMs,
    });
    const driven = await driveRollingAuditDispatch({
      root: ctx.params.root,
      artifactsDir: ctx.params.artifactsDir,
      activeReviewRun,
      sessionConfig: sessionConfig!,
      timeoutMs: ctx.params.timeoutMs,
    });
    await clearDispatchFiles(ctx.params.artifactsDir);
    // Resumable pause (DC-4): the pool exhausted after spill and the run is paused
    // on a `waiting_for_provider` state, persisted on the active-dispatch artifact.
    // Emit a resumable blocked handoff — re-invoking `next-step` re-discovers
    // capacity and `advancePausedState` resumes or, after the pause limit, promotes
    // to a partial-completion terminal. This is NOT a no-progress spin: the paused
    // state advances each pass toward resume-or-livelock.
    if (driven.status === "paused") {
      const paused = driven.paused_state;
      const pauseCount = paused?.lifecycle.pause_count ?? 0;
      return {
        kind: "emit",
        step: {
          kind: "blocked",
          state,
          bundle,
          reason:
            `In-process rolling dispatch paused waiting for provider capacity: ` +
            `${driven.stranded_ids.length} review packet(s) are stranded on an exhausted ` +
            `provider pool (provider '${sessionConfig?.provider}', pause ${pauseCount + 1}). ` +
            "The run is resumable — re-run next-step once provider capacity returns; " +
            "it will resume automatically, or yield to synthesis on partial coverage after the pause limit.",
        },
      };
    }
    // Convergence guard: a pass that ingested NO new results and stranded nothing
    // (every packet errored at the provider) made no net progress, and
    // re-dispatching the same unchanged state would loop to the maxTransitions
    // backstop. Emit the block rather than spin. Progress (ingest ran, or a strand
    // terminal was recorded) `transition`s so the fold re-derives normally.
    if (!driven.ingest && driven.stranded_ids.length === 0) {
      return {
        kind: "emit",
        step: {
          kind: "blocked",
          state,
          bundle,
          reason:
            `In-process rolling dispatch produced no results for ${driven.packet_count} ` +
            `review packet(s) (provider '${sessionConfig?.provider}' errored on every packet); ` +
            "stopping to avoid a no-progress loop.",
        },
      };
    }
    return {
      kind: "transition",
      state: await loadArtifactBundle(ctx.params.artifactsDir),
    };
  }

  // A-8 hybrid: when the rolling engine is enabled AND a backend (NIM) pool is
  // configured alongside the conversation host, split the pending review tasks via the
  // SAME shared coordinator remediate drives — review the NIM partition IN-PROCESS this
  // cycle (claimed, exactly-one-claimant), then materialize the host review over the
  // COMPLEMENT so the two never review the same task (coverage folds both by task_id).
  // When NIM covers the whole frontier, transition to the fold; otherwise fall through
  // to the host-review emit below over the freshly-ingested coverage. Inert when no NIM
  // pool is confirmed (the existing host-review path is unchanged).
  let reviewBundle = bundle;
  let reviewState = state;
  const hybridCfg = sessionConfig ?? ({} as SessionConfig);
  const auditSourcePools = await buildAuditSourcePools(hybridCfg);
  if (resolveAuditRollingEngineEnabled({ sessionConfig }) && auditSourcePools.length > 0) {
    const pending = buildPendingAuditTasks(bundle);
    if (pending.length > 0) {
      // DC-4: read the cross-cycle settled-pool set; a NIM pool exhausted on a prior
      // cycle is excluded from this split, so its stranded tasks route to the host.
      const settledPath = auditHybridSettledPath(ctx.params.artifactsDir);
      const settled = await readSettledPools(settledPath);
      const partition = await planHybridDispatch({
        // Flat estimate: the coordinator bounds NIM by SLOTS, so uniform is sufficient.
        frontier: pending.map((t) => ({ id: t.task_id, estimatedTokens: 2000 })),
        // Audit passes ONLY the NIM pool(s): the coordinator bounds NIM to its capacity
        // and claims those tasks; the rest stay pending for the batch host review.
        pools: auditSourcePools,
        sessionConfig: hybridCfg,
        claimRegistry: auditNodeClaimRegistry(ctx.params.artifactsDir),
        readSettled: () => settled,
        onSettle: async (id) => {
          settled.add(id);
          await addSettledPool(settledPath, id);
        },
        isInProcess: isInProcessAuditPool,
      });
      if (partition.inProcess.length > 0) {
        const nimIds = new Set(partition.inProcess.map((a) => a.nodeId));
        const nimTasks = pending.filter((t) => nimIds.has(t.task_id));
        const complement = pending.filter((t) => !nimIds.has(t.task_id));
        // Materialize the in-process review run over the NIM PARTITION — its
        // `pending-audit-tasks.json` is what `driveRollingAuditDispatch`'s mergeAndIngest
        // reads to know which results to fold, so it MUST list the NIM tasks (else the
        // NIM results are reviewed but never ingested). The host then reviews the
        // coverage-driven complement below: once these NIM tasks are ingested+covered,
        // `buildPendingAuditTasks` excludes them, so `ensureSemanticReviewRun` re-derives
        // exactly the complement. (`complement` is computed only for the skip-host guard.)
        const { activeReviewRun } = await materializeReviewRun({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          bundle,
          obligationId: decision.selected_obligation,
          selfCliPath: ctx.params.selfCliPath,
          timeoutMs: ctx.params.timeoutMs,
          tasksOverride: nimTasks,
          // This in-process run is EPHEMERAL — it must not own the host-facing dispatch
          // pointer, or `ensureSemanticReviewRun` below would reuse this NIM partition's
          // task set instead of re-deriving the full coverage-driven host complement.
          updateDispatch: false,
        });
        // Review the NIM partition in-process into the SAME run's task-results/ + ingest.
        const driven = await driveRollingAuditDispatch({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          activeReviewRun,
          sessionConfig: hybridCfg,
          timeoutMs: ctx.params.timeoutMs,
          tasksOverride: nimTasks,
          poolsOverride: auditSourcePools,
        });
        // Terminal accept for each in-process task → free its coordinator claim.
        for (const a of partition.inProcess) {
          await partition.coordinator.release(a);
        }
        // DC-4: the NIM pool exhausted (paused / livelock-partial) and could not carry
        // its partition → settle it (cross-cycle) so the next cycle excludes it and the
        // stranded review tasks fall back to the batch host review instead of re-looping.
        if (driven.status !== "complete") {
          for (const pool of auditSourcePools) {
            await partition.coordinator.settlePool(pool.id);
          }
        }
        if (complement.length === 0) {
          // NIM reviewed the whole frontier — nothing left for the host this obligation.
          await clearDispatchFiles(ctx.params.artifactsDir);
          return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
        }
        // Reload so the host-review emits over coverage that now reflects the NIM results
        // (and never writes the stale pre-NIM bundle back over them).
        reviewBundle = await loadArtifactBundle(ctx.params.artifactsDir);
        reviewState = deriveAuditState(reviewBundle);
      }
    }
  }

  const review = await ensureSemanticReviewRun({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle: reviewBundle,
    state: reviewState,
    obligationId: decision.selected_obligation,
    selfCliPath: ctx.params.selfCliPath,
    timeoutMs: ctx.params.timeoutMs,
  });
  return {
    kind: "emit",
    step: {
      kind: "semantic_review",
      selectedExecutor: decision.selected_executor,
      ...review,
    },
  };
}

/** Emit the no-executor blocked step (the hand loop's `!selected_executor` arm). */
async function emitNoExecutorBlocked(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
  decision: ReturnType<typeof decideNextStep>,
): Promise<AuditOutcome> {
  const state = decision.state;
  const reason = ctx.lastSummaryRef.value || decision.reason;
  await writeHandoffOnly({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle,
    audit_state: state,
    progress_summary: reason,
    providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
  });
  return { kind: "emit", step: { kind: "blocked", state, bundle, reason } };
}

/**
 * Wrap each obligation so the transition counter advances exactly once per fold
 * iteration — the analog of the hand loop's `index++`. Incrementing AFTER a
 * `transition` (and never on an `emit`, which exits the fold) means during any
 * `execute` the counter holds the current iteration's 0-based index, which the
 * two cycle guards read as `index`. Single point of truth so a new obligation
 * cannot forget to count.
 */
function countTransitions(obligations: AuditObligationDef[]): AuditObligationDef[] {
  return obligations.map((obligation) => ({
    ...obligation,
    execute: async (bundle: ArtifactBundle, ctx: AuditNextStepCtx) => {
      const outcome = await obligation.execute(bundle, ctx);
      if (outcome.kind === "transition") ctx.iterationRef.value += 1;
      return outcome;
    },
  }));
}

// ── Coordinator ───────────────────────────────────────────────────────────────

/**
 * Drive the deterministic fold for one `next-step` call.
 *
 * Structure mirrors remediate-code's `decideNextStepLoop` (the proven engine
 * consumer): a PREAMBLE (the `index===0` file-integrity re-intake, the analog of
 * remediate's `forceReplan`) then the shared `advance` running audit's `PRIORITY`
 * obligations. Each deterministic executor `transition`s (folding the whole chain
 * into one host round-trip); host-delegation / dispatch / terminal obligations
 * `emit` the host-actionable step.
 *
 * Cycle detection stays in audit's `Ctx` (the pre-dispatch no-progress guard +
 * the FINALIZATION_CYCLE_TOLERANCE finalization-cycle guard, both invoked from
 * inside `runDeterministicExecutor`), NOT in `advance.opts.stateSignature` — the
 * shared engine is inherently 0-tolerance and cannot express the tolerance window
 * or the no-metadata-skip (HANDOFF approach B). `advance`'s `maxTransitions` is
 * left as its pure runaway backstop. A `step === null` result (no actionable
 * obligation, e.g. synthesis flipped the state to complete) resolves to the
 * terminal step (present_report when a report is rendered, else blocked).
 */
export async function runDeterministicForNextStep(
  params: NextStepParams,
): Promise<NextStepResult> {
  const analyzersRef: { value: Record<string, AnalyzerSetting> | undefined } = {
    value: params.analyzers,
  };

  // PREAMBLE — file-integrity re-intake (runs once, like remediate's
  // forceReplan). When pending audit-task files have changed/vanished since the
  // manifest was built, re-run intake so planning re-grounds. advanceAudit does
  // not persist (only runAuditStep does), so this is the same diagnostic-then-
  // reload the hand loop performed on its first iteration: the warning fires and
  // the fold below starts from the freshly-loaded disk bundle.
  {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    if (bundle.audit_state?.status !== "complete" && bundle.repo_manifest) {
      const pendingTasks = buildPendingAuditTasks(bundle);
      const taskFiles = new Set<string>();
      for (const task of pendingTasks) {
        for (const fp of Object.keys(task.file_line_counts ?? {})) taskFiles.add(fp);
      }
      if (taskFiles.size > 0) {
        const integrity = await checkFileIntegrity(params.root, bundle.repo_manifest, [...taskFiles]);
        if (!integrity.is_clean) {
          // Route this diagnostic OFF stdout: cmdNextStep emits the step
          // contract as the sole stdout payload via console.log(JSON.stringify),
          // so a console.log here would corrupt the JSON-on-stdout contract.
          process.stderr.write(
            `[audit-code] nextStep: integrity check — ${integrity.changed_files.length} changed, ` +
              `${integrity.missing_files.length} missing, ${integrity.io_errors.length} io-error(s); re-running intake.\n`,
          );
          await advanceAudit(bundle, {
            root: params.root,
            artifactsDir: params.artifactsDir,
            preferredExecutor: "intake_executor",
          });
        }
      }
    }
  }

  const ctx: AuditNextStepCtx = {
    params,
    analyzersRef,
    lastSummaryRef: { value: "" },
    iterationRef: { value: 0 },
    dispatchedSignatures: new Set<string>(),
    seenStateSignatures: new Set<string>(),
    obligationTrail: [],
  };

  const startBundle = await loadArtifactBundle(params.artifactsDir);
  const outcome = await advance(
    { priority: PRIORITY, obligations: countTransitions(buildAuditObligations()) },
    startBundle,
    ctx,
  );

  if (outcome.step) return outcome.step;

  // No actionable obligation: the fold reached completion (e.g. synthesis flipped
  // the state to complete and every obligation is now satisfied). Build the
  // terminal: present_report when the state is complete / a report is rendered,
  // else blocked.
  const bundle = await loadArtifactBundle(params.artifactsDir);
  const decision = decideNextStep(bundle);
  const state = decision.state;

  if (state.status === "complete") {
    await writeHandoffOnly({
      root: params.root,
      artifactsDir: params.artifactsDir,
      bundle,
      audit_state: state,
      progress_summary: decision.reason,
      providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
    });
    const promoted = await promoteFinalAuditReport({
      artifactsDir: params.artifactsDir,
    });
    const finalReportPath = promoted.promoted
      ? promotedAuditReportPath(params.artifactsDir)
      : auditReportPath(params.artifactsDir);
    // Fold friction triage into the terminal step — same pattern as remediate.
    // Blocks with status "ready" until ≥1 open observation is written; "complete"
    // once all subjects disposed and open_observations ≥1.
    const triage = await decideAuditFrictionCloseout(
      params.artifactsDir,
      "run",
    );
    return {
      kind: "complete",
      state,
      bundle,
      finalReportPath,
      triage,
    };
  }

  return buildTerminalStep(
    params,
    bundle,
    state,
    ctx.lastSummaryRef.value || decision.reason,
  );
}
