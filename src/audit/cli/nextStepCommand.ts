import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionConfig, RepoSessionIntent } from "audit-tools/shared";
import {
  resolveSessionConfig,
  applyGuidanceFile,
  runWithBlockedStepBackstop,
  writeBlockedStepContract,
  renderFanoutExecutionLines,
  writeTextFile,
} from "audit-tools/shared";
import { materializeFanoutLanes } from "./fanoutLanes.js";
import { materializeCharterPacket } from "../orchestrator/charterPackets.js";
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
import type {
  ConceptualDispatch,
  ConceptualReviewSettings,
} from "./conceptualDispatch.js";
import { buildDesignReReviewSection } from "../orchestrator/designReviewSnapshot.js";
import type { DesignReviewPass } from "../orchestrator/designReviewSnapshot.js";
import { computeScopePreDigest } from "../orchestrator/intentCheckpointExecutor.js";
import { deriveIntentEquivalenceStatus } from "../orchestrator/intentEquivalenceExecutor.js";
import { unresolvedConstraintClauses } from "../orchestrator/intentInterpreter.js";
import { renderSynthesisNarrativePrompt } from "../reporting/synthesisNarrativePrompt.js";
import { renderCriticalFlowFallbackPrompt } from "../reporting/criticalFlowFallbackPrompt.js";
import {
  charterExtractionKindsForCeiling,
  renderCharterKindLanePrompt,
} from "./charterExtractionPrompt.js";
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
  persistAuditorHandshake,
  renderAnalyzerConsentPrompt,
  renderAnalyzerInstallPrompt,
  renderEdgeReasoningDispatchPrompt,
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

// Import the helpers used locally, then re-export the full helper surface so
// existing imports remain valid (an `export … from` clause creates no local
// bindings, so the locally-used names must be imported explicitly).
import {
  runDeterministicForNextStep,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
} from "./nextStepHelpers.js";
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

/**
 * Host-owned fan-out hand-off. The helper remains at the call sites so the
 * obligation shape stays stable, but execution policy belongs to the host; audit-tools never meters, leases, caps, or pauses these panels.
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
 * The two host-facing notices every design-review pass prepends to its prompt:
 * the diff-based re-review section (present only on a genuine re-review) and the
 * prior-submission rejection notice (present only when a submission was
 * quarantined). Both are per-pass and both are optional, so the join has to drop
 * absent ones rather than emit blank runs.
 *
 * Single-sourced across all THREE pass preparations — contract, and the
 * conceptual pass in each of its two branches. Previously each site rebuilt the
 * pair and composed it its own way, which is how the two conceptual branches
 * came to hold byte-identical scaffolds: a notice added for one pass would have
 * had to be remembered in three places to reach them all.
 */
async function designReviewNotesSection(
  artifactsDir: string,
  bundle: ArtifactBundle,
  pass: DesignReviewPass,
): Promise<string> {
  const reReview = await buildDesignReReviewSection(artifactsDir, bundle, pass);
  const rejectionNotice = renderDesignReviewRejectionNotice(bundle, [
    "legacy",
    pass,
  ]);
  return [reReview, rejectionNotice]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
}

/**
 * Prepare the conceptual pass end to end: derive its notices, then write its
 * dispatch artifacts.
 *
 * Both conceptual branches — the parallel one (contract still outstanding) and
 * the conceptual-only one — need exactly this, and their settings are resolved
 * separately because the parallel branch also feeds `max_units` to the contract
 * packet it prepares first. Settings therefore stay an INPUT here rather than
 * being resolved inside, which keeps each branch's write ordering unchanged.
 */
async function prepareConceptualPass(
  artifactsDir: string,
  bundle: ArtifactBundle,
  settings: ConceptualReviewSettings,
): Promise<ConceptualDispatch> {
  const notesSection = await designReviewNotesSection(
    artifactsDir,
    bundle,
    "conceptual",
  );
  return prepareConceptualDispatch({
    artifactsDir,
    bundle,
    settings,
    reReviewSection: notesSection || undefined,
  });
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
  const notesSection = await designReviewNotesSection(
    opts.artifactsDir,
    opts.bundle,
    "contract",
  );
  const promptText = [
    renderContractReviewPrompt(opts.bundle, { max_units: opts.maxUnits }),
    "## Results path",
    "",
    'Write the JSON object ({ "findings": [ ... ] }) of contract-review findings to:',
    "",
    `  ${resultsPath}`,
    ...(notesSection ? ["", notesSection] : []),
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

  // au-1 (2026-08-05 friction): persist the resolved handshake once (write-if-
  // changed) so every continue-command below references it as `--auditor @<file>`
  // instead of re-echoing the full JSON into every step prompt.
  persistAuditorHandshake(artifactsDir, hostDescriptor);

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
      // Item B: recorded consent decisions ride into admission (granted admits
      // without a token) and into the consent fold's pending computation.
      analyzerConsent: intent.analyzer_consent,
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
    const conceptual = await prepareConceptualPass(
      artifactsDir,
      result.bundle,
      conceptualSettings,
    );

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
    const conceptual = await prepareConceptualPass(
      artifactsDir,
      result.bundle,
      conceptualSettings,
    );

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
    // Phase C charter layer (conceptual, teleological): one blind, materialized
    // LANE per charter kind (design resolution 2 — independence is the shape of
    // the artifacts, not a merge instruction); the tool merges the per-kind
    // submissions and gates + routes them at ingest. Only reached at a deep+
    // ceiling (shallow omits deterministically without a host turn).
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const ceiling = resolveCharterCeiling(result.bundle.intent_checkpoint);
    const kinds = charterExtractionKindsForCeiling(ceiling);
    // Channel purity is a property of the INPUT (design resolution 4): each
    // lane gets a tool-materialized evidence packet holding only its channel's
    // material. Packets are (re)written on every emission — they derive from
    // the bundle + disk, so re-materializing is idempotent and keeps a resumed
    // lane's evidence current.
    const packetPaths: string[] = [];
    const laneSpecs = await Promise.all(
      kinds.map(async (kind) => {
        const submissionPath = join(
          artifactsDir,
          "incoming",
          `charter-extraction-${kind}.json`,
        );
        const packetPath = join(
          artifactsDir,
          "incoming",
          `charter-extraction-${kind}-packet.md`,
        );
        await writeTextFile(
          packetPath,
          await materializeCharterPacket({ root, bundle: result.bundle, kind }),
        );
        packetPaths.push(packetPath);
        return {
          id: `charter_extraction_${kind}`,
          label: `Charter ${kind} author (blind lane)`,
          promptFilename: `charter-extraction-${kind}-prompt.md`,
          resultFilename: `charter-extraction-${kind}.json`,
          promptText: renderCharterKindLanePrompt(result.bundle, {
            kind,
            submissionPath,
            packetPath,
          }),
        };
      }),
    );
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: laneSpecs,
    });
    const pendingIds = new Set(fanout.pendingLanes.map((lane) => lane.id));
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "charter_extraction",
        units: laneSpecs
          .filter((spec) => pendingIds.has(spec.id))
          .map((spec) => ({
            id: spec.id,
            estInputBytes: Buffer.byteLength(spec.promptText, "utf8"),
          })),
      })
    ) {
      return;
    }
    const completedLanes = fanout.lanes.filter((lane) => lane.resultExists);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "charter_extraction",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute each pending charter lane prompt (one blind agent per kind — subagents if available, else sequentially), write each lane's submission to its results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        "# audit-code charter extraction (per-kind blind lanes)",
        "",
        "Each charter kind is authored by its OWN blind lane: a lane must not see another lane's prompt or output, so the later stated↔revealed delta is genuine disagreement rather than one author's self-consistent story. The tool merges the per-kind submissions at ingest.",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
            resultPath: lane.resultPath,
          })),
          concurrencyHint: hostMaxActiveSubagents,
        }),
        "",
        ...(completedLanes.length > 0
          ? [
              `Already complete (results on disk — do NOT redo these lanes): ${completedLanes
                .map((lane) => lane.label)
                .join(", ")}.`,
              "",
            ]
          : []),
        "When every pending lane's result file exists, run:",
        "",
        `  ${continueCommand}`,
        "",
        "Read and follow only the new step prompt returned by that command.",
        "",
      ].join("\n"),
      access: {
        // Prompts + packets only: the lanes' whole input is materialized, so no
        // repo/artifact read grant exists to leak another channel's evidence.
        read_paths: [...fanout.readPaths, ...packetPaths],
        write_paths: fanout.writePaths,
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
    // Always-materialized (design resolution 2): the miner prompt is a lane FILE.
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const submissionPath = join(artifactsDir, "incoming", "charter-delta.json");
    const lanePrompt = renderCharterDeltaPrompt(result.bundle, { submissionPath });
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: [
        {
          id: "charter_delta",
          label: "Independent charter delta-miner",
          promptFilename: "charter-delta-prompt.md",
          resultFilename: "charter-delta.json",
          promptText: lanePrompt,
        },
      ],
    });
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "charter_delta",
        units: [
          {
            id: "charter_delta",
            estInputBytes: Buffer.byteLength(lanePrompt, "utf8"),
          },
        ],
      })
    ) {
      return;
    }
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "charter_delta",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the delta-miner lane prompt (subagent if available, else yourself), write the mined deltas + goal graph to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        "# audit-code charter delta-mining",
        "",
        "The assembled charters are ready for the INDEPENDENT delta-miner (it did not author them).",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
          })),
        }),
        "",
        "The executor must write its CharterDeltaSubmission JSON to:",
        "",
        `  ${submissionPath}`,
        "",
        "When the result file exists, run:",
        "",
        `  ${continueCommand}`,
        "",
        "Read and follow only the new step prompt returned by that command.",
        "",
      ].join("\n"),
      access: {
        read_paths: [
          ...fanout.readPaths,
          join(artifactsDir, "charter_register.json"),
        ],
        write_paths: fanout.writePaths,
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const submissionPath = join(artifactsDir, "incoming", "systemic-challenge.json");
    const metrics =
      result.bundle.systemic_challenge?.metrics ?? aggregateMetricsDigest(result.bundle);
    const adversaryPrompt = renderSecondOrderAdversaryPrompt({
      round: (result.bundle.systemic_challenge?.rounds.length ?? 0) + 1,
      priorFindingCount: result.bundle.systemic_challenge?.findings.length ?? 0,
      metrics,
      submissionPath,
    });
    // Always-materialized (design resolution 2): the adversary prompt is a lane
    // FILE — the adversary is a SEPARATE agent by lane class, on every host.
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: [
        {
          id: "systemic_challenge",
          label: "Second-order adversary (improvement-seeking challenge)",
          promptFilename: "systemic-challenge-prompt.md",
          resultFilename: "systemic-challenge.json",
          promptText: adversaryPrompt,
        },
      ],
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
        "Execute the second-order-adversary lane prompt (a separate agent from the one that drove this audit), write its findings to the results path, then run next-step. An empty findings array converges the loop.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        "# audit-code systemic challenge (second-order adversary)",
        "",
        "This round's adversary lane challenges the audit process itself (optimization/better-way mandate). The adversary must NOT be the agent that drove this audit.",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
          })),
        }),
        "",
        "The executor must write its findings JSON to:",
        "",
        `  ${submissionPath}`,
        "",
        "An EMPTY findings array is the deliberate loop terminator (this round found nothing new).",
        "",
        "When the result file exists, run:",
        "",
        `  ${continueCommand}`,
        "",
        "Read and follow only the new step prompt returned by that command.",
        "",
      ].join("\n"),
      access: {
        read_paths: [
          ...fanout.readPaths,
          join(artifactsDir, "systemic_challenge.json"),
        ],
        write_paths: fanout.writePaths,
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

  if (result.kind === "analyzer_consent") {
    const decisionsPath = join(
      artifactsDir,
      "incoming",
      "analyzer-consent-decisions.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "analyzer_consent",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Present the consent offer to the operator, write their decisions to the decisions path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        analyzer_consent_decisions: decisionsPath,
      },
      prompt: renderAnalyzerConsentPrompt({
        pending: result.pending,
        decisionsPath,
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

    // Always-materialized (design resolution 2): the (potentially large)
    // edge-list prompt lives in a lane file on every host — a subagent-capable
    // host fans it out, any other host reads and follows the same file itself.
    // The retired inline `edge_reasoning` step kind was this branch's other
    // arm. Routed through the same lane materializer as every other fan-out
    // step so the K-of-N/result-exists semantics stay single-sourced.
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: [
        {
          id: "edge_reasoning",
          label: "Edge-reasoning rewrites",
          promptFilename: "edge-reasoning-prompt.md",
          resultFilename: "edge-reasoning.json",
          promptText: rejectionNotice
            ? `${basePrompt}\n\n${rejectionNotice}`
            : basePrompt,
        },
      ],
    });
    const edgeReasoningPromptPath = fanout.lanes[0]!.promptPath;
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "edge_reasoning_dispatch",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the edge-reasoning lane prompt (subagent if available, else yourself), write the rewrites to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const basePrompt = result.bundle.critical_flows
      ? renderCriticalFlowFallbackPrompt(result.bundle.critical_flows)
      : "# Critical-flow fallback\n\nNo critical_flows manifest is available; write an empty flows array.";
    // Always-materialized (design resolution 2): the (potentially ~340-line)
    // flow-stub prompt is a lane FILE, never inlined into the step prompt.
    const lanePrompt = [
      basePrompt,
      "## Results path",
      "",
      "Write the CriticalFlowFallbackResult JSON object to:",
      "",
      `  ${fallbackResultsPath}`,
      "",
    ].join("\n");
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: [
        {
          id: "critical_flow_fallback",
          label: "Critical-flow fallback enrichment",
          promptFilename: "critical-flow-fallback-prompt.md",
          resultFilename: "critical-flow-fallback.json",
          promptText: lanePrompt,
        },
      ],
    });
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "critical_flow_fallback",
        units: [
          {
            id: "critical_flow_fallback",
            estInputBytes: Buffer.byteLength(lanePrompt, "utf8"),
          },
        ],
      })
    ) {
      return;
    }
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "critical_flow_fallback",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the critical-flow lane prompt (subagent if available, else yourself), write the enrichment to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        "# audit-code critical-flow fallback",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
          })),
        }),
        "",
        "The executor must write the CriticalFlowFallbackResult JSON object to:",
        "",
        `  ${fallbackResultsPath}`,
        "",
        "When the result file exists, run:",
        "",
        `  ${continueCommand}`,
        "",
        "Read and follow only the new step prompt returned by that command.",
        "",
      ].join("\n"),
      access: {
        read_paths: fanout.readPaths,
        write_paths: fanout.writePaths,
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
    const continueCommand = nextStepCommand(root, artifactsDir, hostDescriptor);
    const basePrompt = result.bundle.audit_findings
      ? renderSynthesisNarrativePrompt(result.bundle.audit_findings)
      : "# Synthesis narrative\n\nNo findings report is available; write an empty themes array.";
    // Always-materialized (design resolution 2): the findings digest (up to 120
    // findings) is a lane FILE, never inlined into the step prompt. This step
    // previously carried no access block at all — the lane form declares one.
    const lanePrompt = [
      basePrompt,
      "## Results path",
      "",
      "Write the SynthesisNarrative JSON object to:",
      "",
      `  ${narrativeResultsPath}`,
      "",
    ].join("\n");
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      lanes: [
        {
          id: "synthesis_narrative",
          label: "Synthesis narrative (themes / exec summary / top risks)",
          promptFilename: "synthesis-narrative-prompt.md",
          resultFilename: "synthesis-narrative.json",
          promptText: lanePrompt,
        },
      ],
    });
    if (
      await gateHostFanoutOrPause({
        root,
        artifactsDir,
        sessionConfig: effectiveConfig,
        hostDescriptor,
        continueCommand,
        bundle: result.bundle,
        family: "synthesis_narrative",
        units: [
          {
            id: "synthesis_narrative",
            estInputBytes: Buffer.byteLength(lanePrompt, "utf8"),
          },
        ],
      })
    ) {
      return;
    }
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "synthesis_narrative",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the synthesis-narrative lane prompt (subagent if available, else yourself), write the narrative to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        "# audit-code synthesis narrative",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
          })),
        }),
        "",
        "The executor must write the SynthesisNarrative JSON object to:",
        "",
        `  ${narrativeResultsPath}`,
        "",
        "When the result file exists, run:",
        "",
        `  ${continueCommand}`,
        "",
        "Read and follow only the new step prompt returned by that command.",
        "",
      ].join("\n"),
      access: {
        read_paths: fanout.readPaths,
        write_paths: fanout.writePaths,
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const step = await renderSemanticReviewStep({
    root,
    artifactsDir,
    activeReviewRun: result.activeReviewRun,
    hostMaxActiveSubagents,
    hostContextTokens,
    hostOutputTokens,
    hostModelRoster,
    hostModelId,
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

