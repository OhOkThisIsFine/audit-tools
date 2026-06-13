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
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
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
import { computeArtifactStateSignature } from "../orchestrator/artifactMetadata.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
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
  maxRuns: number;
  narrativeEnabled?: boolean;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
};

export type TerminalStepResult =
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

// ── Extracted helpers ─────────────────────────────────────────────────────────

/**
 * Build the terminal step for a deterministic loop that has stopped advancing
 * (hit the run backstop or the finalization cycle guard). A rendered report is
 * the deliverable: if synthesis already produced one — or the state is formally
 * complete — present it instead of reporting the stopped loop as a bare
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
 *   - `continue`    → caller should `continue` the for-loop (already consumed an artifact).
 *   - `return`      → caller should return the embedded result to cmdNextStep.
 *   - `fallthrough` → no incoming artifacts; fall through to the deterministic executor.
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
 *   - `continue`               → one or both incoming files were consumed; advance loop.
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
      existing.review_findings = legacyIncoming.value;
      existing.reviewed = true;
      await writeJsonFile(
        join(params.artifactsDir, "design_assessment.json"),
        existing,
      );
      return { action: "continue" };
    }
    // File consumed (deleted) but no target to merge into — loop again.
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
      existing.contract_findings = contractIncoming.value;
      existing.contract_reviewed = true;
      consumed = true;
    }
  }

  if (conceptualIncoming) {
    await unlink(conceptualIncoming.path).catch(() => {});
    if (Array.isArray(conceptualIncoming.value) && existing) {
      existing.conceptual_findings = conceptualIncoming.value;
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
 */
export async function executeAndRecord(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since" | "maxRuns">,
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
      max_runs: params.maxRuns,
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
      max_runs: params.maxRuns,
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
      iteration: index + 1,
      max_runs: params.maxRuns,
      last_executor: decision.selected_executor,
      last_obligation: decision.selected_obligation,
      prior_summary: lastSummary || null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic executor ${decision.selected_executor} failed on obligation ${decision.selected_obligation} (iteration ${index + 1}/${params.maxRuns}, prior progress: ${lastSummary || "none"}): ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Check for a finalization cycle: when iterations outrun distinct artifact
 * states by FINALIZATION_CYCLE_TOLERANCE, the deterministic executors are
 * revisiting states rather than progressing. Returns a terminal-step result
 * when a cycle is detected, or undefined when the run is still progressing.
 */
export async function checkFinalizationCycle(ctx: {
  index: number;
  obligationTrail: string[];
  seenStateSignatures: Set<string>;
  tolerance: number;
  params: Pick<NextStepParams, "artifactsDir" | "maxRuns" | "root">;
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
      max_runs: ctx.params.maxRuns,
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

// ── Coordinator ───────────────────────────────────────────────────────────────

export async function runDeterministicForNextStep(params: NextStepParams): Promise<
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
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string }
> {
  let lastSummary = "";
  const analyzersRef: { value: Record<string, AnalyzerSetting> | undefined } = {
    value: params.analyzers,
  };
  // Finalization thrashing guard — see checkFinalizationCycle for details.
  const FINALIZATION_CYCLE_TOLERANCE = 16;
  const seenStateSignatures = new Set<string>();
  const obligationTrail: string[] = [];

  for (let index = 0; index < params.maxRuns; index++) {
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

    if (index === 0 && bundle.repo_manifest) {
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
          continue;
        }
      }
    }

    if (decision.selected_executor === "graph_enrichment_executor") {
      const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
      if (branch.action === "continue") continue;
      if (branch.action === "return") return branch.result;
      // fallthrough: run the executor below
    }

    // Host-delegation executors (design_review_contract, design_review_conceptual,
    // agent) exit the deterministic loop entirely — they pause the pipeline and
    // hand control to the LLM agent.
    if (
      decision.selected_executor === "design_review_contract" ||
      decision.selected_executor === "design_review_conceptual" ||
      decision.selected_executor === "design_review"
    ) {
      const branch = await handleDesignReviewBranch(params, bundle, state);
      if (branch.action === "continue") continue;
      return branch.result;
    }

    if (decision.selected_executor === "synthesis_narrative_executor") {
      const branch = await handleSynthesisNarrativeBranch(params, bundle, state);
      if (branch.action === "continue") continue;
      return branch.result;
    }

    // Provider confirmation gate: auto-complete headlessly and continue the loop.
    // The provider gate is session-level; it fires once at the start of a run and
    // writes a default provider_confirmation.json immediately — no host step needed.
    if (decision.selected_executor === "provider_confirmation_executor") {
      const provResult = await executeAndRecord(params, analyzersRef.value, decision, index, lastSummary);
      lastSummary = provResult.progress_summary;
      await clearDispatchFiles(params.artifactsDir);
      continue;
    }

    // Confirm-intent host step: when the checkpoint is missing, hand control to
    // the host to confirm scope/intent. The host writes intent_checkpoint.json
    // (detected by deriveAuditState on re-invocation), so there is no incoming
    // artifact to consume — emit the step directly.
    if (decision.selected_executor === "intent_checkpoint_executor") {
      return { kind: "confirm_intent", state, bundle };
    }

    if (isHostDelegationExecutor(decision.selected_executor ?? "")) {
      return {
        kind: "semantic_review",
        selectedExecutor: decision.selected_executor,
        ...(await ensureSemanticReviewRun({
          root: params.root,
          artifactsDir: params.artifactsDir,
          bundle,
          state,
          obligationId: decision.selected_obligation,
          selfCliPath: params.selfCliPath,
          timeoutMs: params.timeoutMs,
        })),
      };
    }

    if (!decision.selected_executor) {
      await writeHandoffOnly({
        root: params.root,
        artifactsDir: params.artifactsDir,
        bundle,
        audit_state: state,
        progress_summary: lastSummary || decision.reason,
        providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
      });
      return {
        kind: "blocked",
        state,
        bundle,
        reason: lastSummary || decision.reason,
      };
    }

    const result = await executeAndRecord(params, analyzersRef.value, decision, index, lastSummary);
    lastSummary = result.progress_summary;
    if (!isHostDelegationExecutor(result.selected_executor ?? "")) {
      await clearDispatchFiles(params.artifactsDir);
    }
    if (!result.progress_made) {
      return {
        kind: "blocked",
        state: result.audit_state,
        bundle: result.updated_bundle,
        reason: result.progress_summary,
      };
    }

    // Finalization cycle guard. If this iteration returned the audit to an
    // artifact state already produced this run, the deterministic loop is
    // thrashing (no net progress) rather than converging. The canonical outputs
    // are already rendered, so stop and surface the cycling obligations instead
    // of spinning to maxRuns and crashing.
    const cycleResult = await checkFinalizationCycle({
      index,
      obligationTrail,
      seenStateSignatures,
      tolerance: FINALIZATION_CYCLE_TOLERANCE,
      params,
      bundle,
      state,
      result,
      selectedObligation: decision.selected_obligation,
    });
    if (cycleResult !== undefined) return cycleResult;
  }

  const bundle = await loadArtifactBundle(params.artifactsDir);
  const state = deriveAuditState(bundle);
  return buildTerminalStep(
    params,
    bundle,
    state,
    `Reached max run limit (${params.maxRuns}) before a review, report, or blocker step was ready.`,
  );
}
