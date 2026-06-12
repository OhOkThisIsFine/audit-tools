import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
} from "@audit-tools/shared";
import type {
  AnalyzerSetting,
  GraphEdge,
  SessionConfig,
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
  buildEdgeReasoningPrompt,
  collectLowConfidenceEdges,
  edgeReasoningContentHash,
  type EdgeReasoningResults,
} from "../orchestrator/edgeReasoning.js";
import {
  renderDesignReviewPrompt,
  renderContractReviewPrompt,
} from "../orchestrator/designReviewPrompt.js";
import {
  prepareConceptualDispatch,
  resolveConceptualReviewSettings,
} from "./conceptualDispatch.js";
import { computeScopePreDigest } from "../orchestrator/intentCheckpointExecutor.js";
import { renderSynthesisNarrativePrompt } from "../reporting/synthesisNarrativePrompt.js";
import { buildPathLookup } from "../extractors/graph.js";
import { buildDispositionMap } from "../extractors/disposition.js";
import {
  resolveAnalyzerPlan,
  needsInstallDecision,
} from "../extractors/analyzers/registry.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import {
  loadSessionConfig,
  persistAnalyzerSettings,
} from "../supervisor/sessionConfig.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "../providers/constants.js";
import { clearDispatchFiles, ensureSupervisorDirs } from "../io/runArtifacts.js";
import { runAuditStep } from "./auditStep.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRun,
  persistConfigErrorHandoff,
} from "./reviewRun.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import { renderSemanticReviewStep } from "./semanticReviewStep.js";
import { renderConfirmIntentPrompt } from "./confirmIntentStep.js";
import { writeCurrentStep } from "./steps.js";
import {
  nextStepCommand,
  renderAnalyzerInstallPrompt,
  renderBlockedStepPrompt,
  renderEdgeReasoningDispatchPrompt,
  renderEdgeReasoningStepPrompt,
  renderPresentReportPrompt,
} from "./prompts.js";
import {
  getArtifactsDir,
  getFlag,
  getHostContextTokens,
  getHostMaxActiveSubagents,
  getHostModelId,
  getHostModelRoster,
  getHostOutputTokens,
  getMaxRuns,
  getOptionalBooleanFlag,
  getRootDir,
  getTimeoutMs,
  resolveHostDispatchCapability,
  warnIfNotGitRepo,
} from "./args.js";

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

type NextStepParams = {
  root: string;
  artifactsDir: string;
  selfCliPath: string;
  timeoutMs: number;
  maxRuns: number;
  opentoken?: boolean;
  narrativeEnabled?: boolean;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
};

type TerminalStepResult =
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
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since" | "opentoken">,
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
    if (incoming && typeof incoming.value === "object") {
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
          opentoken: params.opentoken,
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

  // Legacy: consume old combined findings file.
  const legacyIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-findings.json",
  );
  if (legacyIncoming && Array.isArray(legacyIncoming.value) && existing) {
    existing.review_findings = legacyIncoming.value;
    existing.reviewed = true;
    await writeJsonFile(
      join(params.artifactsDir, "design_assessment.json"),
      existing,
    );
    await unlink(legacyIncoming.path).catch(() => {});
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

  if (contractIncoming && Array.isArray(contractIncoming.value) && existing) {
    existing.contract_findings = contractIncoming.value;
    existing.contract_reviewed = true;
    await unlink(contractIncoming.path).catch(() => {});
    consumed = true;
  }

  if (conceptualIncoming && Array.isArray(conceptualIncoming.value) && existing) {
    existing.conceptual_findings = conceptualIncoming.value;
    existing.conceptual_reviewed = true;
    await unlink(conceptualIncoming.path).catch(() => {});
    consumed = true;
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
  params: Pick<NextStepParams, "root" | "artifactsDir" | "narrativeEnabled" | "opentoken">,
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
      opentoken: params.opentoken,
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
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since" | "opentoken" | "maxRuns">,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  decision: ReturnType<typeof decideNextStep>,
  index: number,
  lastSummary: string,
): Promise<AdvanceAuditResult> {
  try {
    const result = await runAuditStep({
      root: params.root,
      artifactsDir: params.artifactsDir,
      analyzers,
      graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
      since: params.since,
      opentoken: params.opentoken,
    });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      max_runs: params.maxRuns,
      last_executor: result.selected_executor,
      last_obligation: decision.selected_obligation,
      progress_made: result.progress_made,
      summary: result.progress_summary,
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
          await advanceAudit(bundle, { root: params.root, preferredExecutor: "intake_executor", opentoken: params.opentoken });
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

export async function cmdNextStep(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);

  const hostCanDispatchSubagents = getOptionalBooleanFlag(
    argv,
    "--host-can-dispatch-subagents",
  );
  const hostCanRestrictSubagentTools =
    getOptionalBooleanFlag(argv, "--host-can-restrict-subagent-tools") ??
    false;
  const hostCanSelectSubagentModel =
    getOptionalBooleanFlag(argv, "--host-can-select-subagent-model") ?? false;
  const hostMaxActiveSubagents = getHostMaxActiveSubagents(argv);
  const hostContextTokens = getHostContextTokens(argv);
  const hostOutputTokens = getHostOutputTokens(argv);
  const hostModelRoster = getHostModelRoster(argv);
  const hostModelId = getHostModelId(argv);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: reason,
    });
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "Report the configuration blocker and stop.",
      repoRoot: root,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
      prompt: renderBlockedStepPrompt(reason),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const hostCanDispatch = resolveHostDispatchCapability({
    explicit: hostCanDispatchSubagents,
    sessionConfig,
  });

  const result = await runDeterministicForNextStep({
    root,
    artifactsDir,
    selfCliPath: resolve(argv[1] ?? process.argv[1] ?? ""),
    timeoutMs: getTimeoutMs(argv, sessionConfig),
    maxRuns: getMaxRuns(argv),
    opentoken: sessionConfig.opentoken?.enabled,
    narrativeEnabled: sessionConfig.synthesis?.narrative !== false,
    analyzers: sessionConfig.analyzers,
    graphLlmEdgeReasoning: sessionConfig.graph?.llm_edge_reasoning,
    since: getFlag(argv, "--since"),
  });

  if (result.kind === "complete") {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "present_report",
      status: "complete",
      runId: null,
      allowedCommands: [],
      stopCondition: "Present the final report and stop.",
      repoRoot: root,
      artifactPaths: {
        final_report: result.finalReportPath,
      },
      prompt: renderPresentReportPrompt(result.finalReportPath),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "blocked") {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "Report the blocker and stop.",
      repoRoot: root,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
      prompt: renderBlockedStepPrompt(result.reason),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review") {
    // Legacy combined fallback (only fires when selected_executor === "design_review" which
    // no longer exists in EXECUTOR_REGISTRY; kept for safety in case an old artifact references it).
    const designReviewResultsPath = join(
      artifactsDir,
      "incoming",
      "design-review-findings.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const prompt = renderDesignReviewPrompt(result.bundle, {
      max_units: sessionConfig.design_review?.max_units,
    });
    const fullPrompt = [
      prompt,
      "## Results path",
      "",
      `Write the JSON array of findings to:`,
      "",
      `  ${designReviewResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write design review findings to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        design_review_results: designReviewResultsPath,
      },
      prompt: fullPrompt,
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review_parallel") {
    // Both passes are unsatisfied — dispatch the contract pass and the
    // conceptual pass simultaneously. The conceptual pass is shallow (one agent)
    // or deep (N independent perspective subagents + an independent judge),
    // resolved JIT from the user-confirmed checkpoint / session config.
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const contractResultsPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");

    const conceptualSettings = resolveConceptualReviewSettings(
      result.bundle,
      sessionConfig,
    );
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
    });

    const contractPromptText = [
      renderContractReviewPrompt(result.bundle, {
        max_units: conceptualSettings.max_units,
      }),
      "## Results path",
      "",
      "Write the JSON array of contract-review findings to:",
      "",
      `  ${contractResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");

    const contractPromptPath = join(artifactsDir, "incoming", "design-review-contract-prompt.md");
    await writeFile(contractPromptPath, contractPromptText, "utf8");

    const dispatchPrompt = [
      "# Design review — parallel dispatch",
      "",
      "Run the two design-review passes concurrently. Do not wait for one before starting the other.",
      "",
      "1. **Contract review** (adversarial): dispatch a subagent that reads the prompt at the contract prompt path and writes findings to the contract results path.",
      `2. ${conceptual.instructionLines.join("\n   ")}`,
      "",
      "When the contract results and the conceptual results have both been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review_parallel",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Dispatch the contract and conceptual review passes in parallel, then run next-step when both the contract results and the (judged) conceptual results have been written.",
      repoRoot: root,
      artifactPaths: {
        contract_prompt: contractPromptPath,
        contract_results: contractResultsPath,
        ...conceptual.artifactPaths,
      },
      prompt: dispatchPrompt,
      access: {
        read_paths: [contractPromptPath, ...conceptual.readPaths],
        write_paths: [contractResultsPath, ...conceptual.writePaths],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review_contract") {
    // Only the contract pass remains.
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const contractResultsPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    const prompt = [
      renderContractReviewPrompt(result.bundle, { max_units: sessionConfig.design_review?.max_units }),
      "## Results path",
      "",
      "Write the JSON array of contract-review findings to:",
      "",
      `  ${contractResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review_contract",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write contract review findings to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        design_review_contract_results: contractResultsPath,
      },
      prompt,
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review_conceptual") {
    // Only the conceptual pass remains — shallow (one agent) or deep (N
    // independent perspective subagents + an independent judge), resolved JIT
    // from the user-confirmed checkpoint / session config.
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const conceptualSettings = resolveConceptualReviewSettings(
      result.bundle,
      sessionConfig,
    );
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
    });

    const prompt = [
      "# Design review — conceptual pass",
      "",
      conceptual.instructionLines.join("\n"),
      "",
      "When the conceptual results have been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review_conceptual",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition: conceptual.deep
        ? "Dispatch the conceptual perspective subagents in parallel, then the independent judge, then run next-step once the merged conceptual results are written."
        : "Write conceptual review findings to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        design_review_conceptual_results: conceptual.conceptualResultsPath,
        ...conceptual.artifactPaths,
      },
      prompt,
      access: {
        read_paths: conceptual.readPaths,
        write_paths: conceptual.writePaths,
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "confirm_intent") {
    const intentCheckpointPath = join(artifactsDir, "intent_checkpoint.json");
    const continueCommand = nextStepCommand(root, artifactsDir);
    const preDigest = computeScopePreDigest(
      result.bundle,
      root,
      getFlag(argv, "--since"),
    );
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "confirm_intent",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write intent_checkpoint.json with the confirmed scope and intent, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        intent_checkpoint: intentCheckpointPath,
      },
      prompt: renderConfirmIntentPrompt(preDigest, {
        intentCheckpointPath,
        continueCommand,
      }),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "analyzer_install") {
    const decisionsPath = join(
      artifactsDir,
      "incoming",
      "analyzer-decisions.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "analyzer_install",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write analyzer install decisions to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        analyzer_decisions: decisionsPath,
      },
      prompt: renderAnalyzerInstallPrompt({
        unresolved: result.unresolved,
        decisionsPath,
        continueCommand,
      }),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "edge_reasoning") {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const edgeReasoningResultsPath = join(
      artifactsDir,
      "incoming",
      "edge-reasoning.json",
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = buildEdgeReasoningPrompt(result.candidates);
    const contentHash = edgeReasoningContentHash(result.candidates);

    if (hostCanDispatch) {
      // Dispatch path: isolate the (potentially large) edge-list prompt in a file
      // and have the host fan it out to one subagent, mirroring the packet review
      // dispatch contract. The subagent writes the rewrites file; next-step applies.
      const edgeReasoningPromptPath = join(
        artifactsDir,
        "incoming",
        "edge-reasoning-prompt.md",
      );
      await writeFile(edgeReasoningPromptPath, basePrompt, "utf8");
      const step = await writeCurrentStep({
        artifactsDir,
        stepKind: "edge_reasoning_dispatch",
        status: "ready",
        runId: null,
        allowedCommands: [continueCommand],
        stopCondition:
          "Dispatch one subagent to write the edge-reasoning rewrites, then run next-step.",
        repoRoot: root,
        artifactPaths: {
          edge_reasoning_prompt: edgeReasoningPromptPath,
          edge_reasoning_results: edgeReasoningResultsPath,
        },
        prompt: renderEdgeReasoningDispatchPrompt({
          promptPath: edgeReasoningPromptPath,
          resultsPath: edgeReasoningResultsPath,
          continueCommand,
          contentHash,
          candidateCount: result.candidates.length,
        }),
        access: {
          read_paths: [edgeReasoningPromptPath],
          write_paths: [edgeReasoningResultsPath],
        },
      });
      console.log(JSON.stringify(step, null, 2));
      return;
    }

    // One-step fallback (no callable subagent facility): the host produces the
    // rewrites itself in a single bounded turn, mirroring the narrative step.
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "edge_reasoning",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the edge-reasoning rewrites to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        edge_reasoning_results: edgeReasoningResultsPath,
      },
      prompt: renderEdgeReasoningStepPrompt({
        basePrompt,
        resultsPath: edgeReasoningResultsPath,
        continueCommand,
        contentHash,
      }),
      access: {
        read_paths: [],
        write_paths: [edgeReasoningResultsPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "synthesis_narrative") {
    const narrativeResultsPath = join(
      artifactsDir,
      "incoming",
      "synthesis-narrative.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = result.bundle.audit_findings
      ? renderSynthesisNarrativePrompt(result.bundle.audit_findings)
      : "# Synthesis narrative\n\nNo findings report is available; write an empty themes array.";
    const fullPrompt = [
      basePrompt,
      "## Results path",
      "",
      "Write the SynthesisNarrative JSON object to:",
      "",
      `  ${narrativeResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "synthesis_narrative",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the synthesis narrative to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        synthesis_narrative_results: narrativeResultsPath,
      },
      prompt: fullPrompt,
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const step = await renderSemanticReviewStep({
    root,
    artifactsDir,
    activeReviewRun: result.activeReviewRun,
    hostCanDispatch,
    hostMaxActiveSubagents,
    hostContextTokens,
    hostOutputTokens,
    hostModelRoster,
    hostModelId,
    hostCanRestrictSubagentTools,
    hostCanSelectSubagentModel,
    selectedExecutor: result.selectedExecutor,
  });
  console.log(JSON.stringify(step, null, 2));
}
