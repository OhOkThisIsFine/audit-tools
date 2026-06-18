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
} from "@audit-tools/shared";
import type {
  AnalyzerSetting,
  GraphEdge,
  SynthesisNarrative,
} from "@audit-tools/shared";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  promoteFinalAuditReport,
  writeCoreArtifacts,
  AUDIT_REPORT_FILENAME,
} from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import type { Finding } from "../types.js";
import { advanceAudit, type AdvanceAuditResult } from "../orchestrator/advance.js";
import { groundDesignFindings } from "../validation/designFindingGrounding.js";
import { computeArtifactStateSignature } from "../orchestrator/artifactMetadata.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import { isHostDelegationExecutor } from "../orchestrator/executors.js";
import { PRIORITY } from "../orchestrator/nextStep.js";
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
} from "./reviewRun.js";
import { buildPendingAuditTasks } from "./dispatch.js";

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
};

export type TerminalStepResult =
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

/**
 * The host-actionable outcome of one `next-step` deterministic fold — the
 * discriminated union `runDeterministicForNextStep` returns and `cmdNextStep`
 * renders (one branch per kind; the seam test pins the union ↔ handler set).
 * Each audit `ObligationDef.execute` returns this inside an `emit` outcome (or a
 * `transition` carrying the reloaded bundle when the fold continues).
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
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

// ── Extracted helpers ─────────────────────────────────────────────────────────

/**
 * Build the terminal step for a deterministic fold that has stopped advancing
 * (no actionable obligation, or the cycle guard fired). A rendered report is
 * the deliverable: if synthesis already produced one — or the state is formally
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
  return {
    kind: "complete",
    state,
    bundle,
    finalReportPath: promoted.promoted
      ? join(dirname(params.artifactsDir), AUDIT_REPORT_FILENAME)
      : join(params.artifactsDir, AUDIT_REPORT_FILENAME),
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
    return { action: "continue" };
  }

  // Determine which passes still need to run.
  const contractDone = existing?.contract_reviewed === true;
  const conceptualDone = existing?.conceptual_reviewed === true;

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
  | { action: "return"; result: { kind: "synthesis_narrative"; state: AuditState; bundle: ArtifactBundle } };

/**
 * Handle the `synthesis_narrative_executor` incoming-artifact polling block.
 * Returns `continue` if an incoming narrative file was consumed, or `return`
 * with a synthesis_narrative kind when the host turn is still needed (and
 * narrative is enabled), or `continue` when narrative is disabled (so the
 * deterministic omit runs below).
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
  // Narrative disabled: fall through so the deterministic omit runs below.
  return { action: "continue" };
}

/**
 * Execute one deterministic audit step and record its progress. Throws (with
 * cause) if the executor fails, preserving the existing throw-with-cause pattern.
 * `iteration` is the 1-based fold position (the transition counter), surfaced in
 * the `deterministic-progress.json` marker a filesystem-watching host reads.
 */
export async function executeAndRecord(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since">,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  decision: ReturnType<typeof decideNextStep>,
  iteration: number,
  lastSummary: string,
): Promise<AdvanceAuditResult> {
  try {
    // Write a "started" marker before execution so a host watching the filesystem
    // can tell which executor is active during a long-running step (OBS-0d4c2311).
    const startedAt = new Date().toISOString();
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration,
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
      iteration,
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
    const current = await loadArtifactBundle(params.artifactsDir);
    const currentState = deriveAuditState(current);
    currentState.last_executor = decision.selected_executor ?? undefined;
    currentState.last_obligation = decision.selected_obligation ?? undefined;
    await writeCoreArtifacts(params.artifactsDir, { ...current, audit_state: currentState });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration,
      last_executor: decision.selected_executor,
      last_obligation: decision.selected_obligation,
      prior_summary: lastSummary || null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic executor ${decision.selected_executor} failed on obligation ${decision.selected_obligation} (iteration ${iteration}, prior progress: ${lastSummary || "none"}): ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

// ── advance engine binding ────────────────────────────────────────────────────

/**
 * Per-call execution dependencies threaded to every audit obligation executor.
 * Mirrors remediate-code's `RemediateCtx`: the shared engine stays agnostic;
 * audit-code picks its own `Ctx`. The two refs carry the loop-local mutable
 * state the hand-rolled `for` loop kept in closures — the analyzer settings a
 * decisions file can update mid-fold, the last progress summary surfaced in the
 * terminal block, and the 1-based transition counter for the progress marker.
 */
interface AuditNextStepCtx {
  params: NextStepParams;
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined };
  lastSummaryRef: { value: string };
  iterationRef: { value: number };
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
 * Run one deterministic executor for the selected obligation: record + dispatch,
 * surface a `!progress_made` dead-end as an emitted blocked step, otherwise clear
 * dispatch staging and `transition` on the reloaded bundle. Shared by every
 * obligation whose executor is deterministic (the hand loop's
 * executeAndRecord + clearDispatchFiles + `continue` arm, minus the now-deleted
 * pre/post cycle guards — `advance`'s `stateSignature` subsumes them).
 */
async function runDeterministicExecutor(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const decision = decideNextStep(bundle);
  ctx.iterationRef.value += 1;
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
    {
      // Provider confirmation gate: a session-level deterministic auto-complete
      // (writes a default provider_confirmation.json) — no host step. Fold on.
      id: "provider_confirmation",
      derive: deriveObligationState("provider_confirmation"),
      execute: (bundle, ctx) => runDeterministicExecutor(bundle, ctx),
    },
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
  const review = await ensureSemanticReviewRun({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle,
    state,
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

/**
 * The visited-state signature `advance` keys cycle detection on. It is the
 * **dispatch identity** — `artifact-signature | obligation | executor` — NOT the
 * bare artifact signature, because audit legitimately produces an *unchanged*
 * artifact signature across DIFFERENT obligations: no-op-but-satisfying steps
 * (auto-fix with nothing to fix, syntax-resolution with no errors) advance the
 * obligation chain without changing artifact content. Only a literal re-entry of
 * the SAME obligation+executor on the SAME unchanged artifact state is the
 * no-progress cycle the guard must catch — exactly the recurrence key the
 * hand-rolled `checkNoProgressBeforeDispatch` used.
 *
 * The `no-metadata` bootstrap signature (no artifact_metadata yet) is exempted:
 * many early deterministic steps legitimately dispatch from it before any
 * metadata exists, so each scan from it is salted with the monotonic transition
 * counter to stay distinct (never a false revisit) — the analog of the hand
 * guard's explicit `signature !== "no-metadata"` skip. (The finalization-cycle
 * thrash — a *later* return to an already-seen real artifact state — is the same
 * key recurring, so this one signature subsumes both former guards.)
 */
export function nextStepStateSignature(
  bundle: ArtifactBundle,
  iterationRef: { value: number },
): string {
  const signature = computeArtifactStateSignature(bundle);
  const decision = decideNextStep(bundle);
  const identity = `${signature}|${decision.selected_obligation ?? ""}|${decision.selected_executor ?? ""}`;
  if (signature === "no-metadata") {
    // Salt with the transition counter so a bootstrap-state scan is never a
    // revisit of a prior bootstrap-state scan (the hand guard skipped it).
    return `${identity}|boot:${iterationRef.value}`;
  }
  return identity;
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

// ── Coordinator ───────────────────────────────────────────────────────────────

/**
 * Drive the deterministic fold for one `next-step` call.
 *
 * Structure mirrors remediate-code's `decideNextStepLoop` (the proven engine
 * consumer): a PREAMBLE (the `index===0` file-integrity re-intake, the analog of
 * remediate's `forceReplan`) then the shared `advance` running audit's
 * `PRIORITY` obligations. Each deterministic executor `transition`s (folds the
 * whole chain into one host round-trip); host-delegation / dispatch / terminal
 * obligations `emit` the host-actionable step. `advance`'s `stateSignature`
 * (audit's content-hash artifact signature) provides graceful cycle detection —
 * subsuming the deleted `checkNoProgressBeforeDispatch` + `checkFinalizationCycle`
 * + `maxRuns` machinery. A `step === null` result (no actionable obligation, e.g.
 * synthesis flipped the state to complete) or a `stopped: "cycle"` result both
 * resolve to the terminal step (present_report when a report is rendered, else
 * blocked).
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
  // the fold below restarts from the freshly-loaded disk bundle.
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
          await advanceAudit(bundle, { root: params.root, preferredExecutor: "intake_executor" });
        }
      }
    }
  }

  const ctx: AuditNextStepCtx = {
    params,
    analyzersRef,
    lastSummaryRef: { value: "" },
    iterationRef: { value: 0 },
  };

  const startBundle = await loadArtifactBundle(params.artifactsDir);
  const outcome = await advance(
    { priority: PRIORITY, obligations: buildAuditObligations() },
    startBundle,
    ctx,
    { stateSignature: (bundle) => nextStepStateSignature(bundle, ctx.iterationRef) },
  );

  if (outcome.step) return outcome.step;

  // No actionable obligation (the fold reached completion or the cycle guard
  // stopped it). Build the terminal: present_report when a report is rendered or
  // the state is complete, else blocked. The reason mirrors the hand loop's two
  // terminal messages (a clean completion vs. a non-converging cycle).
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
    return {
      kind: "complete",
      state,
      bundle,
      // Promotion copies the report to the artifacts dir's PARENT
      // (.audit-tools/audit-report.md), not the repo root.
      finalReportPath: promoted.promoted
        ? join(dirname(params.artifactsDir), AUDIT_REPORT_FILENAME)
        : join(params.artifactsDir, AUDIT_REPORT_FILENAME),
    };
  }

  const reason =
    outcome.stopped === "cycle"
      ? "Finalization is not converging: deterministic executors kept revisiting " +
        "prior artifact states without net progress. Review whether these " +
        "obligations are erroneously invalidating each other."
      : ctx.lastSummaryRef.value || decision.reason;
  if (outcome.stopped === "cycle") {
    await writeJsonFile(
      join(params.artifactsDir, "steps", "deterministic-progress.json"),
      {
        iteration: ctx.iterationRef.value,
        cycle_detected: true,
        summary: reason,
        timestamp: new Date().toISOString(),
      },
    );
  }
  return buildTerminalStep(params, bundle, state, reason);
}
