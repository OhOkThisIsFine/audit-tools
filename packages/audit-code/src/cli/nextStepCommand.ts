import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { decideNextStep } from "../orchestrator/nextStep.js";
import { deriveAuditState } from "../orchestrator/state.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import {
  buildEdgeReasoningPrompt,
  collectLowConfidenceEdges,
  edgeReasoningContentHash,
  type EdgeReasoningResults,
} from "../orchestrator/edgeReasoning.js";
import { renderDesignReviewPrompt } from "../orchestrator/designReviewPrompt.js";
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
  getHostMaxActiveSubagents,
  getMaxRuns,
  getOptionalBooleanFlag,
  getRootDir,
  getTimeoutMs,
  resolveHostDispatchCapability,
  warnIfNotGitRepo,
} from "./args.js";

async function runDeterministicForNextStep(params: {
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
}): Promise<
  | {
      kind: "semantic_review";
      state: AuditState;
      bundle: ArtifactBundle;
      activeReviewRun: ActiveReviewRun;
    }
  | {
      kind: "design_review";
      state: AuditState;
      bundle: ArtifactBundle;
    }
  | {
      kind: "analyzer_install";
      state: AuditState;
      bundle: ArtifactBundle;
      unresolved: AnalyzerPlanEntry[];
    }
  | {
      kind: "edge_reasoning";
      state: AuditState;
      bundle: ArtifactBundle;
      candidates: GraphEdge[];
    }
  | {
      kind: "synthesis_narrative";
      state: AuditState;
      bundle: ArtifactBundle;
    }
  | {
      kind: "complete";
      state: AuditState;
      bundle: ArtifactBundle;
      finalReportPath: string;
    }
  | {
      kind: "blocked";
      state: AuditState;
      bundle: ArtifactBundle;
      reason: string;
    }
> {
  let lastSummary = "";
  let analyzers = params.analyzers;
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
        repoRoot: params.root,
      });
      return {
        kind: "complete",
        state,
        bundle,
        finalReportPath: promoted.promoted
          ? join(params.root, AUDIT_REPORT_FILENAME)
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
          console.log(
            `File integrity check: ${integrity.changed_files.length} changed, ${integrity.missing_files.length} missing — re-running intake.`,
          );
          await advanceAudit(bundle, { root: params.root, preferredExecutor: "intake_executor", opentoken: params.opentoken });
          continue;
        }
      }
    }

    if (decision.selected_executor === "graph_enrichment_executor") {
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
      const plan = resolveAnalyzerPlan(params.root, analyzers, includedFiles);
      const unresolved = plan.filter(needsInstallDecision);
      if (unresolved.length > 0) {
        const decisionsPath = join(
          params.artifactsDir,
          "incoming",
          "analyzer-decisions.json",
        );
        let decisions: Record<string, unknown> | undefined;
        try {
          decisions = await readJsonFile<Record<string, unknown>>(decisionsPath);
        } catch (error) {
          if (!isFileMissingError(error)) throw error;
        }
        if (decisions && typeof decisions === "object") {
          const settings: Record<string, AnalyzerSetting> = {};
          for (const [id, value] of Object.entries(decisions)) {
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
            analyzers = merged.analyzers;
          }
          await unlink(decisionsPath).catch(() => {});
          continue;
        }
        return {
          kind: "analyzer_install",
          state,
          bundle,
          unresolved,
        };
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
          const edgeReasoningResultsPath = join(
            params.artifactsDir,
            "incoming",
            "edge-reasoning.json",
          );
          let edgeReasoningResults: EdgeReasoningResults | undefined;
          try {
            edgeReasoningResults = await readJsonFile<EdgeReasoningResults>(
              edgeReasoningResultsPath,
            );
          } catch (error) {
            if (!isFileMissingError(error)) throw error;
          }
          if (edgeReasoningResults) {
            await runAuditStep({
              root: params.root,
              artifactsDir: params.artifactsDir,
              analyzers,
              graphLlmEdgeReasoning: true,
              edgeReasoningResultsPath,
              since: params.since,
              opentoken: params.opentoken,
            });
            await unlink(edgeReasoningResultsPath).catch(() => {});
            continue;
          }
          return { kind: "edge_reasoning", state, bundle, candidates };
        }
      }
      // No undecided installs (and no pending edge reasoning): fall through to run
      // the executor below (it installs for ephemeral/permanent, uses repo/cache,
      // skips the rest).
    }

    if (decision.selected_executor === "design_review") {
      const findingsPath = join(
        params.artifactsDir,
        "incoming",
        "design-review-findings.json",
      );
      let reviewFindings: Finding[] | undefined;
      try {
        reviewFindings = await readJsonFile<Finding[]>(findingsPath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      if (reviewFindings && Array.isArray(reviewFindings)) {
        const existing = bundle.design_assessment;
        if (existing) {
          existing.review_findings = reviewFindings;
          existing.reviewed = true;
          await writeJsonFile(
            join(params.artifactsDir, "design_assessment.json"),
            existing,
          );
          await unlink(findingsPath).catch(() => {});
          continue;
        }
      }
      return {
        kind: "design_review",
        state,
        bundle,
      };
    }

    if (decision.selected_executor === "synthesis_narrative_executor") {
      const narrativePath = join(
        params.artifactsDir,
        "incoming",
        "synthesis-narrative.json",
      );
      let narrativeResults: SynthesisNarrative | undefined;
      try {
        narrativeResults = await readJsonFile<SynthesisNarrative>(narrativePath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      if (narrativeResults) {
        await runAuditStep({
          root: params.root,
          artifactsDir: params.artifactsDir,
          preferredExecutor: "synthesis_narrative_executor",
          narrativeResultsPath: narrativePath,
          opentoken: params.opentoken,
        });
        await unlink(narrativePath).catch(() => {});
        continue;
      }
      if (params.narrativeEnabled) {
        return {
          kind: "synthesis_narrative",
          state,
          bundle,
        };
      }
      // Narrative disabled: fall through so the deterministic omit runs below.
    }

    if (decision.selected_executor === "agent") {
      return {
        kind: "semantic_review",
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

    let result: AdvanceAuditResult;
    try {
      result = await runAuditStep({
        root: params.root,
        artifactsDir: params.artifactsDir,
        analyzers,
        graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
        since: params.since,
        opentoken: params.opentoken,
      });
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
    lastSummary = result.progress_summary;
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      max_runs: params.maxRuns,
      last_executor: result.selected_executor,
      last_obligation: decision.selected_obligation,
      progress_made: result.progress_made,
      summary: result.progress_summary,
      timestamp: new Date().toISOString(),
    });
    if (result.selected_executor !== "agent") {
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
  }

  const bundle = await loadArtifactBundle(params.artifactsDir);
  const state = deriveAuditState(bundle);
  return {
    kind: "blocked",
    state,
    bundle,
    reason: `Reached max run limit (${params.maxRuns}) before a review, report, or blocker step was ready.`,
  };
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
    const designReviewResultsPath = join(
      artifactsDir,
      "incoming",
      "design-review-findings.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const prompt = renderDesignReviewPrompt(result.bundle);
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
    hostCanRestrictSubagentTools,
    hostCanSelectSubagentModel,
  });
  console.log(JSON.stringify(step, null, 2));
}
