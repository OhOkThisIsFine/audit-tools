import { mkdir, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SessionConfig,
} from "audit-tools/shared";
import {
  buildSharedProviderConfirmation,
  PROVIDER_CONFIRMATION_INPUT_FILENAME,
} from "audit-tools/shared";
import {
  buildEdgeReasoningPrompt,
  edgeReasoningContentHash,
} from "../orchestrator/edgeReasoning.js";
import {
  renderDesignReviewPrompt,
  renderContractReviewPrompt,
} from "../orchestrator/designReviewPrompt.js";
import {
  prepareConceptualDispatch,
  resolveConceptualReviewSettings,
} from "./conceptualDispatch.js";
import { buildDesignReReviewSection } from "../orchestrator/designReviewSnapshot.js";
import { computeScopePreDigest } from "../orchestrator/intentCheckpointExecutor.js";
import { unresolvedConstraintClauses } from "../orchestrator/intentInterpreter.js";
import { renderSynthesisNarrativePrompt } from "../reporting/synthesisNarrativePrompt.js";
import {
  loadSessionConfig,
} from "../supervisor/sessionConfig.js";
import { ensureSupervisorDirs } from "../io/runArtifacts.js";
import {
  persistConfigErrorHandoff,
} from "./reviewRun.js";
import { renderSemanticReviewStep } from "./semanticReviewStep.js";
import { renderConfirmIntentPrompt } from "./confirmIntentStep.js";
import { renderProviderConfirmationPrompt } from "./providerConfirmationStep.js";
import { writeCurrentStep } from "./steps.js";
import {
  nextStepCommand,
  renderAnalyzerInstallPrompt,
  renderBlockedStepPrompt,
  renderEdgeReasoningDispatchPrompt,
  renderEdgeReasoningStepPrompt,
  renderPresentReportPrompt,
  type HostDispatchDescriptor,
} from "./prompts.js";
import {
  getArtifactsDir,
  getFlag,
  getHostContextTokens,
  getHostMaxActiveSubagents,
  getHostModelId,
  getHostModelRoster,
  getHostOutputTokens,
  getOptionalBooleanFlag,
  getRootDir,
  getTimeoutMs,
  resolveHostDispatchCapability,
  warnIfNotGitRepo,
} from "./args.js";

// Re-export helpers from nextStepHelpers so existing imports remain valid.
export {
  tryConsumeIncoming,
  buildTerminalStep,
  handleGraphEnrichmentBranch,
  handleDesignReviewBranch,
  handleSynthesisNarrativeBranch,
  executeAndRecord,
  checkFinalizationCycle,
  checkNoProgressBeforeDispatch,
  runDeterministicForNextStep,
} from "./nextStepHelpers.js";

import { runDeterministicForNextStep } from "./nextStepHelpers.js";

export async function cmdNextStep(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);

  // Single-step bootstrap: fold an optional guidance file into
  // intake/conversation-start.md in this same invocation, then decide the step —
  // no separate write-then-call dance for the host to remember.
  const guidanceFile = getFlag(argv, "--guidance-file");
  if (guidanceFile) {
    applyGuidanceFile(artifactsDir, guidanceFile);
  }

  const hostCanDispatchSubagents = parseHostBooleanFlag(
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

  // The current driver's capability handshake, built once from this invocation's
  // parsed `--host-*` flags. It RIDES every continue-command this step emits so a
  // bare re-invocation preserves the handshake instead of falling back to the
  // stored session config — the founding-bug robustness fix (a *different* driver
  // entering through its own loader overrides with its own flags).
  const hostDescriptor: HostDispatchDescriptor = {
    canDispatchSubagents: hostCanDispatch,
    canRestrictSubagentTools: hostCanRestrictSubagentTools,
    canSelectSubagentModel: hostCanSelectSubagentModel,
    maxActiveSubagents: hostMaxActiveSubagents,
    contextTokens: hostContextTokens,
    outputTokens: hostOutputTokens,
    modelRoster: hostModelRoster,
    modelId: hostModelId,
  };

  const result = await runDeterministicForNextStep({
    root,
    artifactsDir,
    selfCliPath: resolve(argv[1] ?? process.argv[1] ?? ""),
    timeoutMs: getTimeoutMs(argv, sessionConfig),
    narrativeEnabled: sessionConfig.synthesis?.narrative !== false,
    analyzers: sessionConfig.analyzers,
    graphLlmEdgeReasoning: sessionConfig.graph?.llm_edge_reasoning,
    // Slice D: enable external-analyzer acquisition on the real CLI path (default-on;
    // session config can opt out). The executor builds its own global-`fetch`
    // adapter when no fetcher is injected. The unit/integration suite never reaches
    // here, so acquisition stays a hermetic no-op in tests.
    externalAcquisition: {
      enabled: sessionConfig.external_acquisition?.enabled !== false,
      consentToken: sessionConfig.external_acquisition?.consent_token,
      analyzers: sessionConfig.analyzers,
    },
    since: getFlag(argv, "--since"),
    sessionConfig,
    // Defect-1: the resolved attended/headless discriminator, so the fold demotes a
    // configured in-process backend to a source pool (attended) rather than letting it
    // monopolize the frontier — or self-drives it (headless).
    hostCanDispatch,
  });

  if (result.kind === "complete") {
    const triage = result.triage;
    const frictionPending = triage?.action === "dispose";
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "present_report",
      status: frictionPending ? "ready" : "complete",
      runId: null,
      allowedCommands: [],
      stopCondition: frictionPending
        ? "Complete friction triage (write open_observations and any dispositions), then call next-step again."
        : "Present the final audit report and stop.",
      repoRoot: root,
      artifactPaths: {
        final_report: result.finalReportPath,
        ...(triage ? { friction_record: triage.recordPath } : {}),
      },
      prompt: renderPresentReportPrompt(result.finalReportPath, triage),
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const contractResultsPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");

    const conceptualSettings = resolveConceptualReviewSettings(
      result.bundle,
      sessionConfig,
    );
    const contractReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "contract",
    );
    const conceptualReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "conceptual",
    );
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
      reReviewSection: conceptualReReview,
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
      ...(contractReReview ? ["", contractReReview] : []),
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
        "Dispatch the contract and conceptual review subagents in parallel, then run next-step once both results are written.",
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const contractResultsPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    const contractReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "contract",
    );
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
      ...(contractReReview ? ["", contractReReview] : []),
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const conceptualSettings = resolveConceptualReviewSettings(
      result.bundle,
      sessionConfig,
    );
    const conceptualReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "conceptual",
    );
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
      reReviewSection: conceptualReReview,
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

  if (result.kind === "provider_confirmation") {
    const inputPath = join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME);
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    // The tool's suggested pool (price-ascending). Built from the SAME discovery +
    // annotation the executor will use, so what the operator sees is what routes
    // if they accept it verbatim.
    const suggested = buildSharedProviderConfirmation(sessionConfig);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "provider_confirmation",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Confirm or reorder the provider cost ordering by writing provider-confirmation.input.json, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        provider_confirmation_input: inputPath,
      },
      prompt: renderProviderConfirmationPrompt({
        providerPool: suggested.provider_pool,
        inputPath,
        continueCommand,
      }),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "confirm_intent") {
    const intentCheckpointPath = join(artifactsDir, "intent_checkpoint.json");
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
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
        unresolvedConstraintClauses: unresolvedConstraintClauses(
          result.bundle.intent_checkpoint,
        ),
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
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

/**
 * Scan argv for a TRUE boolean flag (parity with remediate-code's commander
 * boolean). A bare `<flag>` resolves true and NEVER swallows the next token; the
 * `--no-<flag>` form and the `<flag>=false` spelling resolve false; `<flag>=true`
 * resolves true; absence stays `undefined` so the tristate reaches
 * resolveHostDispatchCapability intact. A non-boolean `<flag>=<other>` value
 * fails loudly. When the flag appears more than once, the last occurrence wins.
 */
export function parseHostBooleanFlag(
  argv: string[],
  flag: string,
): boolean | undefined {
  const negated = `--no-${flag.replace(/^--/, "")}`;
  let value: boolean | undefined;
  for (const token of argv) {
    if (token === flag) {
      value = true;
    } else if (token === negated) {
      value = false;
    } else if (token === `${flag}=true`) {
      value = true;
    } else if (token === `${flag}=false`) {
      value = false;
    } else if (token.startsWith(`${flag}=`)) {
      throw new Error(`${flag} must be either true or false.`);
    }
  }
  return value;
}

/**
 * Single-step bootstrap writer for `intake/conversation-start.md`.
 *
 * Sole writer + idempotent-on-target (INV-CC-03): re-applying the identical
 * guidance is a byte-identical no-op (the existing file is left untouched, never
 * appended to), and a pre-existing file with DIFFERING content is never silently
 * clobbered — that case fails loudly so host/conversation-authored guidance can't
 * be lost. The guidance file's bytes are written verbatim.
 */
export function applyGuidanceFile(
  artifactsDir: string,
  guidanceFilePath: string,
): string {
  const target = join(artifactsDir, "intake", "conversation-start.md");
  const resolvedSource = resolve(guidanceFilePath);
  if (resolve(target) === resolvedSource) {
    // The guidance file already IS the target — nothing to copy.
    return target;
  }
  const incoming = readFileSync(resolvedSource);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.equals(incoming)) {
      // Identical re-apply: byte-identical no-op, no rewrite, no append.
      return target;
    }
    throw new Error(
      `Refusing to overwrite existing ${target} with differing guidance from ${resolvedSource}. ` +
        `Remove or reconcile the existing conversation-start.md before re-bootstrapping.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, incoming);
  return target;
}

/**
 * Provider-agnostic headless audit-dispatch driver for the gated provider-matrix
 * live e2e (`tests/audit/provider-matrix-dispatch-e2e.test.mjs`). With
 * `rolling_engine` ON and any in-process dispatch provider
 * (`IN_PROCESS_DISPATCH_PROVIDERS`: openai-compatible / codex / opencode),
 * `runDeterministicForNextStep` routes the `audit_tasks_completed` review through
 * the in-process rolling engine (`driveRollingAuditDispatch`), which launches the
 * real backend per packet. One bounded review result landing in
 * `audit_results.jsonl` (blocked terminal) or the promoted `audit-findings.json`
 * (complete terminal) is proof the dispatch round-tripped real data through
 * ingestion — regardless of which provider drove it.
 *
 * The caller passes the provider's `sessionConfig` and must have advanced the
 * audit to planning (so the next obligation is the host-delegation dispatch).
 * This driver owns only the rolling dispatch + the result-landing check;
 * fixture/planning setup belongs to the gated test, keeping this production
 * helper free of test-fixture deps and free of any per-provider branching.
 */
export async function runInProcessAuditDispatch(params: {
  root: string;
  sessionConfig: SessionConfig;
  timeoutMs?: number;
}): Promise<{ dispatched: boolean }> {
  const { root, sessionConfig } = params;
  const timeoutMs = params.timeoutMs ?? sessionConfig.timeout_ms ?? 120_000;
  const artifactsDir = join(root, ".audit-tools", "audit");

  // Review results land in one of two places depending on how far the fold gets:
  // the cumulative `audit_results.jsonl` store (run blocks) or the promoted
  // parent `audit-findings.json` machine contract (run completes — which removes
  // the artifacts dir and promotes the synthesized findings). Either is proof.
  const storePath = join(artifactsDir, "audit_results.jsonl");
  const promotedFindingsPath = join(root, ".audit-tools", "audit-findings.json");
  const landed = (): boolean => {
    if (existsSync(promotedFindingsPath)) return true;
    if (!existsSync(storePath)) return false;
    return readFileSync(storePath, "utf8")
      .split("\n")
      .some((line) => line.trim().length > 0);
  };

  // One next-step drives the whole review frontier through the provider
  // in-process; a rare first-pass total-invalid blocks cleanly with nothing
  // ingested, so a bounded retry re-dispatches still-pending tasks.
  for (let attempt = 0; attempt < 3 && !landed(); attempt += 1) {
    const result = await runDeterministicForNextStep({
      root,
      artifactsDir,
      selfCliPath: "audit-code",
      timeoutMs,
      narrativeEnabled: false,
      analyzers: {
        typescript: "skip",
        python: "skip",
        css: "skip",
        html: "skip",
        sql: "skip",
      },
      graphLlmEdgeReasoning: false,
      sessionConfig,
    });
    // The in-process driver consumed the dispatch obligation itself, so it must
    // never fall through to a host-subagent `semantic_review` dispatch step.
    if (result.kind === "semantic_review") {
      throw new Error(
        `${sessionConfig.provider} rolling dispatch must drive review in-process, ` +
          "not emit a host semantic_review step",
      );
    }
  }

  return { dispatched: landed() };
}
