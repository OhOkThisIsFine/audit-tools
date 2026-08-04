import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionConfig, RepoSessionIntent } from "audit-tools/shared";
import {
  resolveSessionConfig,
  applyGuidanceFile,
  runWithBlockedStepBackstop,
  writeBlockedStepContract,
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
import { deriveIntentEquivalenceStatus } from "../orchestrator/intentEquivalenceExecutor.js";
import { unresolvedConstraintClauses } from "../orchestrator/intentInterpreter.js";
import { renderSynthesisNarrativePrompt } from "../reporting/synthesisNarrativePrompt.js";
import { renderCriticalFlowFallbackPrompt } from "../reporting/criticalFlowFallbackPrompt.js";
import { renderCharterExtractionPrompt } from "./charterExtractionPrompt.js";
import { renderCharterDeltaPrompt } from "./charterDeltaPrompt.js";
import { renderCharterClarificationPrompt } from "./charterClarificationPrompt.js";
import { renderSecondOrderAdversaryPrompt } from "../systemic/secondOrderAdversaryPrompt.js";
import { aggregateMetricsDigest } from "../systemic/aggregateMetricsDigest.js";
import { resolveCharterCeiling } from "../orchestrator/charterExtractionExecutor.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { ensureSupervisorDirs } from "../io/runArtifacts.js";
import {
  persistConfigErrorHandoff,
} from "./reviewRun.js";
import { renderSemanticReviewStep } from "./semanticReviewStep.js";
import type { HostFanoutFamily, HostFanoutUnit } from "./dispatch/hostFanoutGate.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { renderConfirmIntentPrompt } from "./confirmIntentStep.js";
import { writeCurrentStep, STEP_CONTRACT_VERSION } from "./steps.js";
import {
  nextStepCommand,
  renderAnalyzerInstallPrompt,
  renderEdgeReasoningDispatchPrompt,
  renderEdgeReasoningStepPrompt,
  renderPresentReportPrompt,
} from "./prompts.js";
import type { AuditorDescriptor } from "audit-tools/shared";
import {
  getArtifactsDir,
  getFlag,
  getAuditorDescriptor,
  getHostProvider,
  getRootDir,
  getTimeoutMs,
  resolveHostDispatchCapability,
  warnIfNotGitRepo,
} from "./args.js";
import { resolveCurrentWorkPartitionRuntime } from "./workPartitionRuntime.js";

// Re-export helpers from nextStepHelpers so existing imports remain valid.
export {
  tryConsumeIncoming,
  consumeArrayIncoming,
  consumeObjectIncoming,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
  buildTerminalStep,
  handleGraphEnrichmentBranch,
  handleDesignReviewBranch,
  handleSynthesisNarrativeBranch,
  executeAndRecord,
  checkFinalizationCycle,
  checkNoProgressBeforeDispatch,
  runDeterministicForNextStep,
} from "./nextStepHelpers.js";

import {
  runDeterministicForNextStep,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
} from "./nextStepHelpers.js";

/**
 * Host-owned fan-out hand-off. The helper remains at the call sites so the
 * obligation shape stays stable, but execution policy belongs to the host and
 * llm-relay; audit-tools never meters, leases, caps, or pauses these panels.
 */
async function gateHostFanoutOrPause(params: {
  root: string;
  artifactsDir: string;
  sessionConfig: SessionConfig;
  hostDescriptor: AuditorDescriptor;
  continueCommand: string;
  family: HostFanoutFamily;
  units: HostFanoutUnit[];
  bundle: ArtifactBundle;
}): Promise<boolean> {
  // Host/relay own this fan-out. audit-tools must not meter, lease, cap, or pause
  // a host-owned design/systemic panel; returning false lets the existing caller
  // emit its normal host prompt. Keep the helper boundary for persisted runs and
  // low-level tests, but make the conversation path a pure hand-off.
  void params;
  return false;

}

/**
 * The dispatch pieces for the adversarial contract-review pass. Mirrors
 * `ConceptualDispatch` — the two passes contribute the same kinds of pieces to
 * whichever branch emits them (packet + results in `artifactPaths`, the access
 * grants, and one fan-out unit for the quota gate).
 */
interface ContractDispatch {
  /** Host-facing line describing how to run the contract pass. */
  instructionLine: string;
  artifactPaths: Record<string, string>;
  readPaths: string[];
  writePaths: string[];
  fanoutUnit: HostFanoutUnit;
}

/**
 * Write the contract-review worker packet and return the dispatch pieces —
 * single-sourced so the parallel branch (both passes outstanding) and the solo
 * branch (only the contract pass left) cannot drift into two shapes.
 *
 * Two properties ride on this being one function rather than two mirrored
 * blocks. (1) INDEPENDENCE: the adversarial pass is always dispatched to a
 * subagent, never rendered into the host's own step prompt — the host drove the
 * artifacts under review, and an author grading their own work misses exactly
 * what this pass exists to catch. (2) ADVANCE-FREE: the packet carries no
 * `next-step` command, because a worker that runs it becomes a SECOND driver of
 * the orchestrator; the advance belongs solely to the host's dispatch prompt.
 */
async function prepareContractDispatch(opts: {
  artifactsDir: string;
  bundle: ArtifactBundle;
  maxUnits: number | undefined;
}): Promise<ContractDispatch> {
  const incoming = join(opts.artifactsDir, "incoming");
  await mkdir(incoming, { recursive: true });
  const promptPath = join(incoming, "design-review-contract-prompt.md");
  const resultsPath = join(incoming, "design-review-contract-findings.json");
  const reReview = await buildDesignReReviewSection(
    opts.artifactsDir,
    opts.bundle,
    "contract",
  );
  const rejectionNotice = renderDesignReviewRejectionNotice(opts.bundle, [
    "legacy",
    "contract",
  ]);
  const promptText = [
    renderContractReviewPrompt(opts.bundle, { max_units: opts.maxUnits }),
    "## Results path",
    "",
    'Write the JSON object ({ "findings": [ ... ] }) of contract-review findings to:',
    "",
    `  ${resultsPath}`,
    ...(reReview ? ["", reReview] : []),
    ...(rejectionNotice ? ["", rejectionNotice] : []),
  ].join("\n");
  await writeFile(promptPath, promptText, "utf8");

  return {
    instructionLine:
      "**Contract review** (adversarial): dispatch a subagent that reads the prompt at the contract prompt path and writes findings to the contract results path.",
    artifactPaths: {
      contract_prompt: promptPath,
      contract_results: resultsPath,
    },
    readPaths: [promptPath],
    writePaths: [resultsPath],
    fanoutUnit: {
      id: "contract",
      estInputBytes: Buffer.byteLength(promptText, "utf8"),
    },
  };
}

export async function cmdNextStep(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  // Terminal-exit backstop (backlog: abnormal-exit no-step-contract): ANY throw
  // out of the body — a quota-wall abort, the engine's `exceeded maxTransitions`
  // cycle throw, a mis-shaped-submission parse crash — writes a blocked step
  // naming the cause before propagating, so a consumer can never read the
  // PREVIOUS current-step.json as a live instruction after a fatal exit. Exit
  // semantics are unchanged (cli.ts still reports the error and exits nonzero);
  // only the on-disk step contract is guaranteed fresh.
  await runWithBlockedStepBackstop(
    () => cmdNextStepBody(argv, root, artifactsDir),
    (reason) =>
      writeBlockedStepContract({
        tool: "audit-code",
        contractVersion: STEP_CONTRACT_VERSION,
        artifactsDir,
        repoRoot: root,
        runId: null,
        reason,
      }),
  );
}

async function cmdNextStepBody(
  argv: string[],
  root: string,
  artifactsDir: string,
): Promise<void> {
  // Inside the backstop (AGY review catch): a supervisor-dir IO failure must
  // yield a blocked step too. The backstop's own writer needs no pre-created
  // dirs — writeStepContract mkdirs recursively.
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);
  // Single-step bootstrap: fold an optional guidance file into
  // intake/conversation-start.md in this same invocation, then decide the step —
  // no separate write-then-call dance for the host to remember.
  const guidanceFile = getFlag(argv, "--guidance-file");
  if (guidanceFile) {
    applyGuidanceFile(artifactsDir, guidanceFile);
  }

  // G1: the whole driver handshake arrives as ONE `--auditor <json>` descriptor;
  // the flat locals below are derived from `descriptor.self` (minimal downstream
  // churn — renderSemanticReviewStep / gate still take the individual fields).
  const auditorDescriptor = getAuditorDescriptor(argv);
  const auditorSelf = auditorDescriptor?.self ?? {};
  const hostCanDispatchSubagents = auditorSelf.can_dispatch_subagents;
  const hostCanRestrictSubagentTools = auditorSelf.can_restrict_subagent_tools ?? false;
  const hostCanSelectSubagentModel = auditorSelf.can_select_subagent_model ?? false;
  const hostMaxActiveSubagents = auditorSelf.max_active_subagents ?? null;
  const hostContextTokens = auditorSelf.context_tokens ?? null;
  const hostOutputTokens = auditorSelf.output_tokens ?? null;
  const hostModelRoster = auditorSelf.roster ?? null;
  const hostModelId = auditorSelf.model_id ?? null;
  const hostSources = auditorDescriptor?.sources;
  // G2: the driver's provider identity rides `descriptor.self.provider`; the standalone
  // `--host-provider` flag (retained) overrides it. Folded onto the forward descriptor
  // below and applied by `resolveSessionConfig` — no disk persistence (`persistHostProvider`
  // retired: the provider is per-auditor capability, never written back to the repo config).
  const hostProvider = getHostProvider(argv) ?? auditorSelf.provider ?? null;
  let intent: RepoSessionIntent;
  try {
    intent = await loadSessionConfig(artifactsDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: reason,
    });
    // Shared blocked-step assembly: the step JSON says WHY on its own via
    // progress.summary — a headless consumer (release smoke, CI) sees only this
    // contract, not the prompt file.
    const step = await writeBlockedStepContract({
      tool: "audit-code",
      contractVersion: STEP_CONTRACT_VERSION,
      artifactsDir,
      repoRoot: root,
      runId: null,
      reason,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const hostCanDispatch = resolveHostDispatchCapability({
    explicit: hostCanDispatchSubagents,
    sessionConfig: intent,
  });

  // The current driver's RESOLVED descriptor, built once from this invocation's
  // `--auditor` handshake (+ the retained `--host-provider` override). It RIDES every
  // continue-command this step emits so a bare re-invocation preserves the driver's
  // capability + provider + reachable sources instead of falling back to the stored
  // config — the founding-bug robustness fix (a *different* driver entering through its
  // own loader overrides with its own `--auditor`).
  const hostDescriptor: AuditorDescriptor = {
    self: {
      // Provider + host/IDE launch blocks: the driver's identity + own launch transport.
      ...(hostProvider != null ? { provider: hostProvider } : {}),
      ...(auditorSelf.claude_code ? { claude_code: auditorSelf.claude_code } : {}),
      ...(auditorSelf.vscode_task ? { vscode_task: auditorSelf.vscode_task } : {}),
      ...(auditorSelf.antigravity ? { antigravity: auditorSelf.antigravity } : {}),
      // The RESOLVED capability rides forward (not the raw handshake bit), so a
      // bare resume preserves it — the founding-bug robustness fix.
      can_dispatch_subagents: hostCanDispatch,
      // restrict/select default false; carry only when true so the descriptor stays
      // minimal and round-trips to the same resolved value (absence ⇒ false).
      ...(hostCanRestrictSubagentTools ? { can_restrict_subagent_tools: true } : {}),
      ...(hostCanSelectSubagentModel ? { can_select_subagent_model: true } : {}),
      ...(hostMaxActiveSubagents != null ? { max_active_subagents: hostMaxActiveSubagents } : {}),
      ...(hostContextTokens != null ? { context_tokens: hostContextTokens } : {}),
      ...(hostOutputTokens != null ? { output_tokens: hostOutputTokens } : {}),
      ...(hostModelRoster != null ? { roster: hostModelRoster } : {}),
      ...(hostModelId != null ? { model_id: hostModelId } : {}),
    },
    ...(hostSources !== undefined ? { sources: hostSources } : {}),
  };

  // G2: the EFFECTIVE dispatch config every dispatch/provider consumer reads — the
  // per-auditor descriptor (`self.provider` + launch blocks + `sources[]`) resolved over
  // the repo INTENT (`resolveSessionConfig`, spec/unified-dispatch-worker-model.md). The
  // repo intent carries NO dispatch fields, so the backend/launch set comes wholly from
  // the descriptor — never inherited across auditors. Intent fields (synthesis/analyzers/
  // graph/quota/…) are preserved identically; only the DISPATCH consumers switch to the
  // effective config. Persistence is untouched — the store reads/writes intent only, so an
  // in-memory resolve can never write dispatch inventory back into the repo config.
  const effectiveConfig = resolveSessionConfig(intent, hostDescriptor);
  const workPartition = resolveCurrentWorkPartitionRuntime(
    effectiveConfig,
    hostDescriptor.self,
  ) ?? undefined;

  const result = await runDeterministicForNextStep({
    root,
    artifactsDir,
    selfCliPath: resolve(argv[1] ?? process.argv[1] ?? ""),
    timeoutMs: getTimeoutMs(argv, intent),
    narrativeEnabled: intent.synthesis?.narrative !== false,
    analyzers: intent.analyzers,
    graphLlmEdgeReasoning: intent.graph?.llm_edge_reasoning,
    // Slice D: enable external-analyzer acquisition on the real CLI path (default-on;
    // session config can opt out). The executor builds its own global-`fetch`
    // adapter when no fetcher is injected. The unit/integration suite never reaches
    // here, so acquisition stays a hermetic no-op in tests.
    externalAcquisition: {
      enabled: intent.external_acquisition?.enabled !== false,
      consentToken: intent.external_acquisition?.consent_token,
      analyzers: intent.analyzers,
    },
    since: getFlag(argv, "--since"),
    // G2: the fold's dispatch reads (buildAuditSourcePools / driveRollingAuditDispatch
    // / planHybridDispatch / resolveHostDispatchProviderName) key off this, so they
    // see the per-auditor descriptor's resolved backends, not the repo config. Intent
    // reads folded in here are identical either way (resolve preserves every intent field).
    sessionConfig: effectiveConfig,
    workPartition,
    // The resolved attended/headless discriminator (H2+H4 collapse): attended ⇒ the
    // host reviews the coverage-driven complement of the one fan-out; headless ⇒ no
    // attended host in the eligible set, the engine drives the whole frontier.
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
      // INV-READY-STEP-CONTINUATION (COR-f6a36670): a ready step whose
      // stop_condition instructs calling next-step again must carry the
      // executable continuation command — never leave the host to reconstruct
      // the invocation from prose.
      allowedCommands: frictionPending
        ? [nextStepCommand(root, artifactsDir, hostDescriptor)]
        : [],
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
    // Same diagnosability contract as the config-blocked step above.
    const step = await writeBlockedStepContract({
      tool: "audit-code",
      contractVersion: STEP_CONTRACT_VERSION,
      artifactsDir,
      repoRoot: root,
      runId: null,
      reason: result.reason,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
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
      max_units: intent.design_review?.max_units,
    });
    const legacyRejectionNotice = renderDesignReviewRejectionNotice(result.bundle, ["legacy"]);
    const fullPrompt = [
      prompt,
      "## Results path",
      "",
      `Write the JSON object ({ "findings": [ ... ] }) to:`,
      "",
      `  ${designReviewResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
      ...(legacyRejectionNotice ? ["", legacyRejectionNotice] : []),
    ].join("\n");
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "design_review",
        units: [
          { id: "design_review", estInputBytes: Buffer.byteLength(fullPrompt, "utf8") },
        ],
      })
    ) {
      return;
    }
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);

    const conceptualSettings = resolveConceptualReviewSettings(
      result.bundle,
      intent,
    );
    const contract = await prepareContractDispatch({
      artifactsDir,
      bundle: result.bundle,
      maxUnits: conceptualSettings.max_units,
    });
    const conceptualReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "conceptual",
    );
    const conceptualRejectionNotice = renderDesignReviewRejectionNotice(result.bundle, [
      "legacy",
      "conceptual",
    ]);
    const conceptualNotesSection = [conceptualReReview, conceptualRejectionNotice]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
      reReviewSection: conceptualNotesSection || undefined,
    });

    const dispatchPrompt = [
      "# Design review — parallel dispatch",
      "",
      "Run the two design-review passes concurrently. Do not wait for one before starting the other.",
      "",
      `1. ${contract.instructionLine}`,
      `2. ${conceptual.instructionLines.join("\n   ")}`,
      "",
      "When the contract results and the conceptual results have both been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    // The parallel step dispatches BOTH panels (contract + conceptual) in one host
    // turn, so the gate leases them together and pauses if EITHER can't be granted.
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "design_review",
        units: [contract.fanoutUnit, ...conceptual.fanoutUnits],
      })
    ) {
      return;
    }

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
        ...contract.artifactPaths,
        ...conceptual.artifactPaths,
      },
      prompt: dispatchPrompt,
      access: {
        read_paths: [...contract.readPaths, ...conceptual.readPaths],
        write_paths: [...contract.writePaths, ...conceptual.writePaths],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review_contract") {
    // Only the contract pass remains — dispatched exactly as in the parallel
    // branch. This branch is reached whenever the conceptual pass is already
    // done, i.e. late in a run the host itself drove, which is precisely when
    // rendering the adversarial review into the host's own prompt would have it
    // grade its own work (see prepareContractDispatch).
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const contract = await prepareContractDispatch({
      artifactsDir,
      bundle: result.bundle,
      maxUnits: intent.design_review?.max_units,
    });

    const dispatchPrompt = [
      "# Design review — contract pass",
      "",
      contract.instructionLine,
      "",
      "When the contract results have been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "design_review",
        units: [contract.fanoutUnit],
      })
    ) {
      return;
    }
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review_contract",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Dispatch the contract review subagent, then run next-step once the contract results are written.",
      repoRoot: root,
      artifactPaths: contract.artifactPaths,
      prompt: dispatchPrompt,
      access: {
        read_paths: contract.readPaths,
        write_paths: contract.writePaths,
      },
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
      intent,
    );
    const conceptualReReview = await buildDesignReReviewSection(
      artifactsDir,
      result.bundle,
      "conceptual",
    );
    const conceptualRejectionNotice = renderDesignReviewRejectionNotice(result.bundle, [
      "legacy",
      "conceptual",
    ]);
    const conceptualNotesSection = [conceptualReReview, conceptualRejectionNotice]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");
    const conceptual = await prepareConceptualDispatch({
      artifactsDir,
      bundle: result.bundle,
      settings: conceptualSettings,
      hostCanSelectSubagentModel,
      reReviewSection: conceptualNotesSection || undefined,
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

    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "design_review",
        units: conceptual.fanoutUnits,
      })
    ) {
      return;
    }

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

  if (result.kind === "charter_extraction") {
    // Phase C charter layer (conceptual, teleological): the host extracts the four
    // charter families per confident subsystem + the deltas it sees; the tool gates
    // + routes them at ingest. Only reached at a deep+ ceiling (shallow omits
    // deterministically without a host turn).
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const submissionPath = join(artifactsDir, "incoming", "charter-extraction.json");
    const ceiling = resolveCharterCeiling(result.bundle.intent_checkpoint);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "charter_extraction",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the charter families per subsystem to the submission path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        charter_extraction_submission: submissionPath,
      },
      prompt: renderCharterExtractionPrompt(result.bundle, {
        submissionPath,
        continueCommand,
        ceiling,
      }),
      access: {
        read_paths: [join(artifactsDir, "structure_decomposition.json")],
        write_paths: [submissionPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "charter_delta") {
    // Phase C.2 charter delta-mining (conceptual, teleological): an INDEPENDENT
    // delta-miner reads the assembled charters (authored by a different pass, blind
    // to the gaps) and mines the pairwise deltas + the goal DAG; the tool routes +
    // gates them at ingest. Only reached at a deep+ ceiling whose extraction pass
    // produced ≥1 subsystem (charter_register.deltas_pending).
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const submissionPath = join(artifactsDir, "incoming", "charter-delta.json");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "charter_delta",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the mined charter deltas + goal graph to the submission path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        charter_delta_submission: submissionPath,
      },
      prompt: renderCharterDeltaPrompt(result.bundle, {
        submissionPath,
        continueCommand,
      }),
      access: {
        read_paths: [join(artifactsDir, "charter_register.json")],
        write_paths: [submissionPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "charter_clarification") {
    // Phase D triangulation loop: the tool has already run the deterministic loop
    // (partition → VOI-rank → risk-gate → split by attention) and surfaces the
    // interactive queue here. The host relays each SYMMETRIC question and writes the
    // answers back; the executor applies them + re-splits (interruptible: unanswered
    // questions leave-open). Only reached at a deep+ ceiling with attention > 0 and
    // ≥1 open interactive question.
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const answersPath = join(artifactsDir, "incoming", "charter-clarification.json");
    const ceiling = resolveCharterCeiling(result.bundle.intent_checkpoint);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "charter_clarification",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Relay each charter-alignment question to the user, write the answers to the answers path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        charter_clarification_answers: answersPath,
      },
      prompt: renderCharterClarificationPrompt(result.bundle, {
        answersPath,
        continueCommand,
        ceiling,
      }),
      access: {
        read_paths: [join(artifactsDir, "charter_clarification.json")],
        write_paths: [answersPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "systemic_challenge") {
    // Phase E second-order adversary (loop-until-dry): the tool has opened the loop
    // and computed the language-neutral aggregate-metrics digest. The host dispatches
    // a SEPARATE adversary agent whose mandate is optimization/better-way; it writes
    // the round's improvement findings (true-lens) back, and the executor folds them
    // + decides convergence. An empty submission converges the loop.
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const submissionPath = join(artifactsDir, "incoming", "systemic-challenge.json");
    const metrics =
      result.bundle.systemic_challenge?.metrics ?? aggregateMetricsDigest(result.bundle);
    const adversaryPrompt = renderSecondOrderAdversaryPrompt({
      round: (result.bundle.systemic_challenge?.rounds.length ?? 0) + 1,
      priorFindingCount: result.bundle.systemic_challenge?.findings.length ?? 0,
      metrics,
      submissionPath,
      continueCommand,
    });
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "systemic_challenge",
        units: [
          {
            id: "adversary",
            estInputBytes: Buffer.byteLength(adversaryPrompt, "utf8"),
          },
        ],
      })
    ) {
      return;
    }
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "systemic_challenge",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Run a separate second-order-adversary agent (optimization/better-way mandate), write its findings to the submission path, then run next-step. An empty findings array converges the loop.",
      repoRoot: root,
      artifactPaths: {
        systemic_challenge_submission: submissionPath,
      },
      prompt: adversaryPrompt,
      access: {
        read_paths: [join(artifactsDir, "systemic_challenge.json")],
        write_paths: [submissionPath],
      },
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
    // A prior malformed submission was quarantined (not silently destroyed) —
    // name it and the shape error in the re-emitted prompt so the producer
    // fixes the shape instead of resubmitting the same honest mistake forever.
    const rejectionNotice = await renderEdgeReasoningRejectionNotice(artifactsDir);

    if (hostCanDispatch) {
      // Dispatch path: isolate the (potentially large) edge-list prompt in a file
      // and have the host fan it out to one subagent, mirroring the packet review
      // dispatch contract. The subagent writes the rewrites file; next-step applies.
      const edgeReasoningPromptPath = join(
        artifactsDir,
        "incoming",
        "edge-reasoning-prompt.md",
      );
      await writeFile(
        edgeReasoningPromptPath,
        rejectionNotice ? `${basePrompt}\n\n${rejectionNotice}` : basePrompt,
        "utf8",
      );
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
        rejectionNotice,
      }),
      access: {
        read_paths: [],
        write_paths: [edgeReasoningResultsPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "intent_equivalence") {
    const verdictPath = join(
      artifactsDir,
      "incoming",
      "intent-equivalence-verdict.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const status = deriveIntentEquivalenceStatus(result.bundle);
    const pending =
      status.kind === "prose_judgment_pending" ? status : undefined;
    const fullPrompt = [
      "# Intent-equivalence judgment (bounded)",
      "",
      "The intent checkpoint's PROSE changed since the planning artifacts derived",
      "(structured fields are identical — this is wording only). Judge whether the",
      "two prose forms express the SAME audit intent. Judge STRICTLY: any change",
      "in scope, emphasis, constraint, or goal — however small — is `changed`.",
      "Only pure rephrasing (wording, ordering, formatting) is `equivalent`.",
      "An `equivalent` verdict keeps every planning artifact fresh; `changed`",
      "re-derives the planning cascade against the new intent.",
      "",
      "## Prior prose normal form (what planning derived against)",
      "",
      "```json",
      pending?.prior_prose ?? "(unavailable — re-run next-step)",
      "```",
      "",
      "## Current prose normal form",
      "",
      "```json",
      pending?.current_prose ?? "(unavailable — re-run next-step)",
      "```",
      "",
      "## Verdict contract",
      "",
      "Write EXACTLY this JSON object (no extra fields) to:",
      "",
      `  ${verdictPath}`,
      "",
      "```json",
      JSON.stringify(
        {
          verdict: "equivalent | changed",
          judged_pair: {
            prior_hash: pending?.prior_hash ?? "",
            new_hash: pending?.new_hash ?? "",
          },
        },
        null,
        2,
      ),
      "```",
      "",
      "`judged_pair` must carry the two hashes shown above verbatim — they bind",
      "the verdict to this exact pair; a checkpoint edited again mid-judgment is",
      "detected and re-judged.",
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "intent_equivalence",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the equivalence verdict to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        intent_equivalence_verdict: verdictPath,
      },
      prompt: fullPrompt,
      access: {
        read_paths: [],
        write_paths: [verdictPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "critical_flow_fallback") {
    const fallbackResultsPath = join(
      artifactsDir,
      "incoming",
      "critical-flow-fallback.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const basePrompt = result.bundle.critical_flows
      ? renderCriticalFlowFallbackPrompt(result.bundle.critical_flows)
      : "# Critical-flow fallback\n\nNo critical_flows manifest is available; write an empty flows array.";
    const fullPrompt = [
      basePrompt,
      "## Results path",
      "",
      "Write the CriticalFlowFallbackResult JSON object to:",
      "",
      `  ${fallbackResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "critical_flow_fallback",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the critical-flow fallback enrichment to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        critical_flow_fallback_results: fallbackResultsPath,
      },
      prompt: fullPrompt,
      access: {
        read_paths: [],
        write_paths: [fallbackResultsPath],
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
    inProcessMadeProgress: result.inProcessMadeProgress,
    // G2: the RESOLVED descriptor. renderSemanticReviewStep loads the repo INTENT from
    // disk (fail-closed re-validated) and resolves THIS descriptor over it for its
    // host-review dispatch — and rides it on the continue-command it emits so a bare
    // resume preserves the driver's provider + sources.
    descriptor: hostDescriptor,
  });
  console.log(JSON.stringify(step, null, 2));
}

