import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadAnalyzerPolicy,
  loadSessionIntent,
  applyGuidanceFile,
  runWithBlockedStepBackstop,
  writeBlockedStepContract,
  laneAssetsDir,
  renderFanoutExecutionLines,
  writeTextFile,
} from "audit-tools/shared";
import type { AnalyzerPolicy } from "audit-tools/shared";
// The ONE shared table-driven step-emission scaffold. Imported by relative path
// like every other cross-area shared module this area reaches for.
import { createStepEmissionScaffold } from "../../shared/steps/stepEmissionScaffold.js";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";
import { materializeFanoutLanes } from "./fanoutLanes.js";
import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  GATE_LANES,
  charterExtractionLane,
  charterExtractionPacketFilename,
  laneSubmissionPath,
  mergeLaneShortfalls,
  recordExpectedLanes,
  renderLaneShortfallLines,
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";
import { materializeCharterPacket } from "../orchestrator/charterPackets.js";
import {
  buildEdgeReasoningPrompt,
  edgeReasoningContentHash,
} from "../orchestrator/edgeReasoning.js";
import {
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
import { ensureSupervisorDirs } from "../io/runArtifacts.js";
import {
  persistConfigErrorHandoff,
} from "./reviewRun.js";
import { renderSemanticReviewStep } from "./semanticReviewStep.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { renderConfirmIntentPrompt } from "./confirmIntentStep.js";
import { writeCurrentStep, STEP_CONTRACT_VERSION } from "./steps.js";
import {
  nextStepCommand,
  renderAnalyzerConsentPrompt,
  renderAnalyzerInstallPrompt,
  renderEdgeReasoningDispatchPrompt,
  renderPresentReportPrompt,
} from "./prompts.js";
import {
  getArtifactsDir,
  getFlag,
  getRootDir,
  getTimeoutMs,
  warnIfNotGitRepo,
} from "./args.js";

// Import the helpers used locally, then re-export the full helper surface so
// existing imports remain valid (an `export … from` clause creates no local
// bindings, so the locally-used names must be imported explicitly).
import {
  runDeterministicForNextStep,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
} from "./nextStepHelpers.js";
import type { NextStepResult } from "./nextStepHelpers.js";
export {
  tryConsumeSubmission,
  consumeArraySubmission,
  consumeObjectSubmission,
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
 * The dispatch pieces for the adversarial contract-review pass. Mirrors
 * `ConceptualDispatch` — the two passes contribute the same kinds of pieces to
 * whichever branch emits them (packet + results in `artifactPaths`, the access
 * grants).
 */
interface ContractDispatch {
  /** Host-facing line describing how to run the contract pass. */
  instructionLine: string;
  artifactPaths: Record<string, string>;
  readPaths: string[];
  writePaths: string[];
  /** What a previous emission of this pass's lane is still owed. */
  shortfall: LaneSubmissionShortfall;
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
  const notesSection = await designReviewNotesSection(
    opts.artifactsDir,
    opts.bundle,
    "contract",
  );
  // Routed through the lane materializer like every other fan-out: the lane
  // declares an id and a prompt, and the tool derives where the findings go.
  // The prompt body renders that bound path rather than a name the worker could
  // retype — the two used to be the same guessable string.
  const resultsPath = laneSubmissionPath(
    opts.artifactsDir,
    GATE_LANES.design_review_contract,
  );
  const fanout = await materializeFanoutLanes({
    artifactsDir: opts.artifactsDir,
    runId: AUDIT_GATE_SUBMISSION_SCOPE,
    lanes: [
      {
        id: GATE_LANES.design_review_contract,
        label: "Contract review (adversarial)",
        promptFilename: "design-review-contract-prompt.md",
        // No results-path section here: `materializeFanoutLanes` appends the one
        // canonical footer (bound path + the read-only-executor alternative) to
        // every lane prompt it writes.
        promptText: [
          renderContractReviewPrompt(opts.bundle, { max_units: opts.maxUnits }),
          ...(notesSection ? ["", notesSection] : []),
        ].join("\n"),
      },
    ],
  });
  const promptPath = fanout.lanes[0]!.promptPath;

  return {
    instructionLine:
      "**Contract review** (adversarial): dispatch a subagent that reads the prompt at the contract prompt path and writes findings to the contract results path.",
    artifactPaths: {
      contract_prompt: promptPath,
      contract_results: resultsPath,
    },
    readPaths: [promptPath],
    writePaths: [resultsPath],
    shortfall: fanout.shortfall,
  };
}

export async function cmdNextStep(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  // Terminal-exit backstop (backlog: abnormal-exit no-step-contract): ANY throw
  // out of the body — a host-handoff abort, a mis-shaped-submission parse crash,
  // an IO failure — writes a blocked step naming the cause before propagating,
  // so a consumer can never read the PREVIOUS current-step.json as a live
  // instruction after a fatal exit. Exit semantics are unchanged (cli.ts still
  // reports the error and exits nonzero); only the on-disk step contract is
  // guaranteed fresh. A non-convergent obligation fold is NOT in this class:
  // the engine reports its bound as an outcome, so that path emits its own
  // resumable blocked step rather than throwing.
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
  // Pre-run sweep (docs-14): a dir whose persisted status is `not_started` is
  // junk left by a run that never got going — clear it so the fresh run starts
  // clean. NOT_STARTED-ONLY by design: a lingering `complete` dir is a live
  // continuation (friction triage pending, or an unpromoted report the
  // completion transition itself deletes), so it is preserved here and owned by
  // that transition + the manual cleanup verb. Must run BEFORE the mkdir below
  // and BEFORE applyGuidanceFile (fresh guidance must never be swept). Inside
  // the backstop, a malformed audit_state.json re-throw becomes a blocked-step
  // contract rather than a raw crash.
  await cleanupStaleArtifactsDir(artifactsDir, { preRun: true });
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

  let analyzerPolicy: AnalyzerPolicy;
  try {
    // The canonical session artifact contains intent only. Loading it here is
    // deliberately validation-only: review_mode and observability describe the
    // host session, but cannot grant audit-tools execution or routing authority.
    await loadSessionIntent(root);
    analyzerPolicy = await loadAnalyzerPolicy(root);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: reason,
    });
    // The ONE emission that is not a table row, and deliberately so: it runs
    // BEFORE dispatch, so no result kind exists to dispatch on. An unreadable
    // or invalid analyzer policy blocks the step rather than degrading to an
    // empty policy (which would silently drop every recorded consent decision)
    // — and it still goes through the scaffold's single emission site, so the
    // "write the step, log it, exactly once" shape is not re-implemented here.
    // Shared blocked-step assembly: the step JSON says WHY on its own via
    // progress.summary — an automated consumer (release smoke, CI) sees only this
    // contract, not the prompt file.
    await NEXT_STEP_EMISSION.emitPlan(
      blockedStepPlan(operatorHandoffBlock(root, artifactsDir, reason)),
    );
    return;
  }

  const result = await runDeterministicForNextStep({
    root,
    artifactsDir,
    selfCliPath: resolve(argv[1] ?? process.argv[1] ?? ""),
    timeoutMs: getTimeoutMs(argv),
    narrativeEnabled: true,
    analyzers: analyzerPolicy.analyzers,
    // Slice D: enable external-analyzer acquisition on the real CLI path (default-on;
    // session config can opt out). The executor builds its own global-`fetch`
    // adapter when no fetcher is injected. The unit/integration suite never reaches
    // here, so acquisition stays a hermetic no-op in tests.
    externalAcquisition: buildExternalAcquisitionOptions(analyzerPolicy),
    since: getFlag(argv, "--since"),
  });

  // The single dispatch: one table row per result kind, one emission site. A
  // kind the table does not carry is the semantic-review dispatch (the
  // scaffold's fallback), exactly as the old fallthrough branch was.
  await NEXT_STEP_EMISSION.emit(result.kind, {
    argv,
    root,
    artifactsDir,
    analyzerPolicy,
    result,
  });
}

// ── Step emission: one table, one emission site ───────────────────────────────
//
// Every host-actionable `result.kind` used to own a hand-repeated copy of the
// same four-part scaffold — resolve a lane submission path, build a prompt
// array, call writeCurrentStep with the same key set, log and return. A change
// to that emit contract had to be applied in sixteen places by hand, with no
// compiler signal when one was missed. Below, a kind contributes only a HANDLER
// that returns a PLAN; the shared scaffold (audit-tools/shared) owns the one
// call site that writes the step and logs it exactly once.

/** What an emission row is given: the invocation's bindings plus its own result. */
interface NextStepEmitContext {
  argv: string[];
  root: string;
  artifactsDir: string;
  /**
   * The durable analyzer policy, loaded before any dispatch decision. Present
   * on every table-dispatched emission; the acquisition-bearing rows state that
   * dependence explicitly (see `requireLoadedAnalyzerPolicy`) instead of
   * assuming a caller loaded it.
   */
  analyzerPolicy: AnalyzerPolicy | null;
  result: NextStepResult;
}

/**
 * What to emit, never how to write it. Three writers exist (the step-contract
 * writer, the blocked-step writer, and the semantic-review renderer that
 * publishes the host workload), and each is called from exactly ONE place —
 * `writeAuditStep` — so the emit contract has a single edit site per writer.
 */
type AuditStepPlan =
  | { via: "current"; params: Parameters<typeof writeCurrentStep>[0] }
  | { via: "blocked"; params: Parameters<typeof writeBlockedStepContract>[0] }
  | { via: "semantic_review"; params: Parameters<typeof renderSemanticReviewStep>[0] };

type EmittedAuditStep =
  | Awaited<ReturnType<typeof writeCurrentStep>>
  | Awaited<ReturnType<typeof writeBlockedStepContract>>;

function currentStepPlan(
  params: Parameters<typeof writeCurrentStep>[0],
): AuditStepPlan {
  return { via: "current", params };
}

function blockedStepPlan(
  params: Parameters<typeof writeBlockedStepContract>[0],
): AuditStepPlan {
  return { via: "blocked", params };
}

function semanticReviewPlan(
  params: Parameters<typeof renderSemanticReviewStep>[0],
): AuditStepPlan {
  return { via: "semantic_review", params };
}

/**
 * The blocked-step shape both blocked paths share — the pre-dispatch config
 * failure and the `blocked` result kind. Single-sourced so the two cannot drift
 * into two different operator-handoff contracts.
 */
function operatorHandoffBlock(
  root: string,
  artifactsDir: string,
  reason: string,
): Parameters<typeof writeBlockedStepContract>[0] {
  return {
    tool: "audit-code",
    contractVersion: STEP_CONTRACT_VERSION,
    artifactsDir,
    repoRoot: root,
    runId: null,
    reason,
    artifactPaths: {
      operator_handoff: join(artifactsDir, "operator-handoff.json"),
    },
  };
}

/** The ONE writer dispatch. Each underlying writer is called exactly once here. */
async function writeAuditStep(plan: AuditStepPlan): Promise<EmittedAuditStep> {
  switch (plan.via) {
    case "current":
      return await writeCurrentStep(plan.params);
    case "blocked":
      return await writeBlockedStepContract(plan.params);
    case "semantic_review":
      return await renderSemanticReviewStep(plan.params);
  }
}

type NextStepEmissionKind = Exclude<NextStepResult["kind"], "semantic_review">;
type NextStepResultOf<K extends NextStepResult["kind"]> = Extract<
  NextStepResult,
  { kind: K }
>;
type NextStepEmissionRow = (ctx: NextStepEmitContext) => Promise<AuditStepPlan>;

/**
 * Bind one row to its own result variant. The table is keyed BY the result
 * kind, so the row that runs is by construction the row for `ctx.result.kind`;
 * the narrowing is stated once here rather than re-checked in every body.
 */
function emissionRow<K extends NextStepEmissionKind>(
  handle: (
    ctx: NextStepEmitContext,
    result: NextStepResultOf<K>,
  ) => Promise<AuditStepPlan>,
): NextStepEmissionRow {
  return (ctx) => handle(ctx, ctx.result as NextStepResultOf<K>);
}

/**
 * The caller-side precondition the analyzer-acquisition chokepoint declares:
 * an acquisition-bearing step is only emitted for a run whose durable analyzer
 * policy actually loaded. Refusing here (the terminal backstop turns the throw
 * into a written blocked step) keeps the alternative — emitting a consent or
 * install step against no policy — impossible: those steps collect decisions
 * that have nothing to merge into, and admission would see no recorded
 * decision at all, making an operator's recorded decline unrepresentable
 * rather than merely unenforced.
 */
function requireLoadedAnalyzerPolicy(
  policy: AnalyzerPolicy | null,
  stepKind: string,
): void {
  if (policy) return;
  throw new Error(
    `audit-code next-step: the ${stepKind} step is acquisition-bearing and requires the durable analyzer policy, which was not loaded. Refusing to emit it rather than proceeding with no recorded consent decisions.`,
  );
}

/**
 * The acquisition chokepoint's declared caller obligation, discharged in ONE
 * place: BOTH halves of the loaded policy ride every acquisition call — the
 * per-analyzer settings AND the recorded consent decisions. Dropping the
 * decisions leaves a recorded decline unrepresentable at admission (the
 * chokepoint would see `undefined` and read it as "not yet decided"), and no
 * consent token is synthesized here on the operator's behalf: the field is
 * absent, never an empty string.
 */
export function buildExternalAcquisitionOptions(
  policy: AnalyzerPolicy,
): ExternalAcquisitionAdvanceOptions {
  return {
    enabled: true,
    analyzers: policy.analyzers,
    // Item B: recorded consent decisions ride into admission (granted admits
    // without a token) and into the consent fold's pending computation.
    analyzerConsent: policy.analyzer_consent,
  };
}


const emitComplete = emissionRow<"complete">(
  async ({ root, artifactsDir }, result) => {
    const triage = result.triage;
    const frictionPending = triage?.action === "dispose";
    return currentStepPlan({
      artifactsDir,
      stepKind: "present_report",
      status: frictionPending ? "ready" : "complete",
      runId: null,
      // INV-READY-STEP-CONTINUATION (COR-f6a36670): a ready step whose
      // stop_condition instructs calling next-step again must carry the
      // executable continuation command — never leave the host to reconstruct
      // the invocation from prose.
      allowedCommands: frictionPending
        ? [nextStepCommand(root, artifactsDir)]
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
  },
);

const emitBlocked = emissionRow<"blocked">(
  async ({ root, artifactsDir }, result) => {
    // The SAME operator-handoff blocked contract the pre-dispatch config
    // failure emits — built from the one home, never re-typed here.
    return blockedStepPlan(operatorHandoffBlock(root, artifactsDir, result.reason));
  },
);

const emitDesignReviewParallel = emissionRow<"design_review_parallel">(
  async ({ root, artifactsDir }, result) => {
    // Both passes are unsatisfied — dispatch the contract pass and the
    // conceptual pass simultaneously. The conceptual pass is shallow (one agent)
    // or deep (N independent perspective subagents + an independent judge),
    // resolved JIT from the user-confirmed checkpoint / session config.
    const continueCommand = nextStepCommand(root, artifactsDir);

    const conceptualSettings = resolveConceptualReviewSettings(result.bundle);
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

    const shortfall = mergeLaneShortfalls([
      contract.shortfall,
      conceptual.shortfall,
    ]);
    const dispatchPrompt = [
      "# Design review — parallel dispatch",
      "",
      ...renderLaneShortfallLines(shortfall),
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

    return currentStepPlan({
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
      submissionShortfall: shortfall,
    });
  },
);

const emitDesignReviewContract = emissionRow<"design_review_contract">(
  async ({ root, artifactsDir }, result) => {
    // Only the contract pass remains — dispatched exactly as in the parallel
    // branch. This branch is reached whenever the conceptual pass is already
    // done, i.e. late in a run the host itself drove, which is precisely when
    // rendering the adversarial review into the host's own prompt would have it
    // grade its own work (see prepareContractDispatch).
    const continueCommand = nextStepCommand(root, artifactsDir);
    const contract = await prepareContractDispatch({
      artifactsDir,
      bundle: result.bundle,
      maxUnits: resolveConceptualReviewSettings(result.bundle).max_units,
    });

    const dispatchPrompt = [
      "# Design review — contract pass",
      "",
      ...renderLaneShortfallLines(contract.shortfall),
      contract.instructionLine,
      "",
      "When the contract results have been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    return currentStepPlan({
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
      submissionShortfall: contract.shortfall,
    });
  },
);

const emitDesignReviewConceptual = emissionRow<"design_review_conceptual">(
  async ({ root, artifactsDir }, result) => {
    // Only the conceptual pass remains — shallow (one agent) or deep (N
    // independent perspective subagents + an independent judge), resolved JIT
    // from the user-confirmed checkpoint / session config.
    const continueCommand = nextStepCommand(root, artifactsDir);
    const conceptualSettings = resolveConceptualReviewSettings(result.bundle);
    const conceptual = await prepareConceptualPass(
      artifactsDir,
      result.bundle,
      conceptualSettings,
    );

    const prompt = [
      "# Design review — conceptual pass",
      "",
      ...renderLaneShortfallLines(conceptual.shortfall),
      conceptual.instructionLines.join("\n"),
      "",
      "When the conceptual results have been written, run:",
      "",
      `  ${continueCommand}`,
      "",
    ].join("\n");

    return currentStepPlan({
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
      submissionShortfall: conceptual.shortfall,
    });
  },
);

const emitCharterExtraction = emissionRow<"charter_extraction">(
  async ({ root, artifactsDir }, result) => {
    // Phase C charter layer (conceptual, teleological): one blind, materialized
    // LANE per charter kind (design resolution 2 — independence is the shape of
    // the artifacts, not a merge instruction); the tool merges the per-kind
    // submissions and gates + routes them at ingest. Only reached at a deep+
    // ceiling (shallow omits deterministically without a host turn).
    const continueCommand = nextStepCommand(root, artifactsDir);
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
        const lane = charterExtractionLane(kind);
        const submissionPath = laneSubmissionPath(artifactsDir, lane);
        const packetPath = join(
          laneAssetsDir(artifactsDir),
          charterExtractionPacketFilename(kind),
        );
        await writeTextFile(
          packetPath,
          await materializeCharterPacket({ root, bundle: result.bundle, kind }),
        );
        packetPaths.push(packetPath);
        return {
          id: lane,
          label: `Charter ${kind} author (blind lane)`,
          promptFilename: `charter-extraction-${kind}-prompt.md`,
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
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: laneSpecs,
    });
    const completedLanes = fanout.lanes.filter((lane) => lane.resultExists);
    return currentStepPlan({
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
        ...renderLaneShortfallLines(fanout.shortfall),
        "Each charter kind is authored by its OWN blind lane: a lane must not see another lane's prompt or output, so the later stated↔revealed delta is genuine disagreement rather than one author's self-consistent story. The tool merges the per-kind submissions at ingest.",
        "",
        ...renderFanoutExecutionLines({
          lanes: fanout.pendingLanes.map((lane) => ({
            label: lane.label,
            promptPath: lane.promptPath,
            resultPath: lane.resultPath,
          })),
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
      submissionShortfall: fanout.shortfall,
    });
  },
);

const emitCharterDelta = emissionRow<"charter_delta">(
  async ({ root, artifactsDir }, result) => {
    // Phase C.2 charter delta-mining (conceptual, teleological): an INDEPENDENT
    // delta-miner reads the assembled charters (authored by a different pass, blind
    // to the gaps) and mines the pairwise deltas + the goal DAG; the tool routes +
    // gates them at ingest. Only reached at a deep+ ceiling whose extraction pass
    // produced ≥1 subsystem (charter_register.deltas_pending).
    // Always-materialized (design resolution 2): the miner prompt is a lane FILE.
    const continueCommand = nextStepCommand(root, artifactsDir);
    const submissionPath = laneSubmissionPath(artifactsDir, GATE_LANES.charter_delta);
    const lanePrompt = renderCharterDeltaPrompt(result.bundle, { submissionPath });
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.charter_delta,
          label: "Independent charter delta-miner",
          promptFilename: "charter-delta-prompt.md",
          promptText: lanePrompt,
        },
      ],
    });
    return currentStepPlan({
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
        ...renderLaneShortfallLines(fanout.shortfall),
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
      submissionShortfall: fanout.shortfall,
    });
  },
);

const emitCharterClarification = emissionRow<"charter_clarification">(
  async ({ root, artifactsDir }, result) => {
    // Phase D triangulation loop: the tool has already run the deterministic loop
    // (partition → VOI-rank → risk-gate → split by attention) and surfaces the
    // interactive queue here. The host relays each SYMMETRIC question and writes the
    // answers back; the executor applies them + re-splits (interruptible: unanswered
    // questions leave-open). Only reached at a deep+ ceiling with attention > 0 and
    // ≥1 open interactive question.
    const continueCommand = nextStepCommand(root, artifactsDir);
    const answersPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.charter_clarification,
    );
    const ceiling = resolveCharterCeiling(result.bundle.intent_checkpoint);
    const clarificationPrompt = renderCharterClarificationPrompt(result.bundle, {
      answersPath,
      continueCommand,
      ceiling,
    });
    const shortfall = await recordExpectedLanes(
      artifactsDir,
      AUDIT_GATE_SUBMISSION_SCOPE,
      [{ lane: GATE_LANES.charter_clarification, promptText: clarificationPrompt }],
    );
    return currentStepPlan({
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
      prompt: [
        ...renderLaneShortfallLines(shortfall),
        clarificationPrompt,
      ].join("\n"),
      access: {
        read_paths: [join(artifactsDir, "charter_clarification.json")],
        write_paths: [answersPath],
      },
      submissionShortfall: shortfall,
    });
  },
);

const emitSystemicChallenge = emissionRow<"systemic_challenge">(
  async ({ root, artifactsDir }, result) => {
    // Phase E second-order adversary (loop-until-dry): the tool has opened the loop
    // and computed the language-neutral aggregate-metrics digest. The host dispatches
    // a SEPARATE adversary agent whose mandate is optimization/better-way; it writes
    // the round's improvement findings (true-lens) back, and the executor folds them
    // + decides convergence. An empty submission converges the loop.
    const continueCommand = nextStepCommand(root, artifactsDir);
    const submissionPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.systemic_challenge,
    );
  const metrics =
    result.bundle.systemic_challenge?.metrics ?? aggregateMetricsDigest(result.bundle);
  const evidencePaths = [
    join(artifactsDir, "charter_register.json"),
    join(artifactsDir, "design_assessment.json"),
    join(artifactsDir, "conceptual_review_adjudication.json"),
    ...(result.bundle.conceptual_review_adjudication?.contributors.map(
      (contributor) => contributor.result_path,
    ) ?? []),
  ];
  const adversaryPrompt = renderSecondOrderAdversaryPrompt({
    round: (result.bundle.systemic_challenge?.rounds.length ?? 0) + 1,
    metrics,
    submissionPath,
    bundle: result.bundle,
    evidencePaths,
  });
    // Always-materialized (design resolution 2): the adversary prompt is a lane
    // FILE — the adversary is a SEPARATE agent by lane class, on every host.
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.systemic_challenge,
          label: "Second-order adversary (improvement-seeking challenge)",
          promptFilename: "systemic-challenge-prompt.md",
          promptText: adversaryPrompt,
        },
      ],
    });
    return currentStepPlan({
      artifactsDir,
      stepKind: "systemic_challenge",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the second-order-adversary lane prompt (a separate agent from the one that drove this audit), write its findings to the results path, then run next-step. An empty findings array converges the loop.",
      repoRoot: root,
    artifactPaths: {
      ...fanout.artifactPaths,
      systemic_charter_register: join(artifactsDir, "charter_register.json"),
      conceptual_review_adjudication: join(
        artifactsDir,
        "conceptual_review_adjudication.json",
      ),
    },
      prompt: [
        "# audit-code systemic challenge (second-order adversary)",
        "",
        ...renderLaneShortfallLines(fanout.shortfall),
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
        ...evidencePaths,
      ],
        write_paths: fanout.writePaths,
      },
      submissionShortfall: fanout.shortfall,
    });
  },
);

const emitConfirmIntent = emissionRow<"confirm_intent">(
  async ({ root, artifactsDir, argv }, result) => {
    const intentCheckpointPath = join(artifactsDir, "intent_checkpoint.json");
    const continueCommand = nextStepCommand(root, artifactsDir);
    const preDigest = await computeScopePreDigest(
      result.bundle,
      root,
      getFlag(argv, "--since"),
    );
    return currentStepPlan({
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
  },
);

const emitAnalyzerConsent = emissionRow<"analyzer_consent">(
  async ({ root, artifactsDir, analyzerPolicy }, result) => {
    // Acquisition-bearing row: the durable policy must have loaded.
    requireLoadedAnalyzerPolicy(analyzerPolicy, "analyzer_consent");
    const decisionsPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.analyzer_consent,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const consentPrompt = renderAnalyzerConsentPrompt({
      pending: result.pending,
      decisionsPath,
      continueCommand,
    });
    const shortfall = await recordExpectedLanes(
      artifactsDir,
      AUDIT_GATE_SUBMISSION_SCOPE,
      [{ lane: GATE_LANES.analyzer_consent, promptText: consentPrompt }],
    );
    return currentStepPlan({
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
      prompt: [...renderLaneShortfallLines(shortfall), consentPrompt].join("\n"),
      submissionShortfall: shortfall,
    });
  },
);

const emitAnalyzerInstall = emissionRow<"analyzer_install">(
  async ({ root, artifactsDir, analyzerPolicy }, result) => {
    // Acquisition-bearing row: the durable policy must have loaded.
    requireLoadedAnalyzerPolicy(analyzerPolicy, "analyzer_install");
    const decisionsPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.analyzer_decisions,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const installPrompt = renderAnalyzerInstallPrompt({
      unresolved: result.unresolved,
      decisionsPath,
      continueCommand,
    });
    const shortfall = await recordExpectedLanes(
      artifactsDir,
      AUDIT_GATE_SUBMISSION_SCOPE,
      [{ lane: GATE_LANES.analyzer_decisions, promptText: installPrompt }],
    );
    return currentStepPlan({
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
      prompt: [...renderLaneShortfallLines(shortfall), installPrompt].join("\n"),
      submissionShortfall: shortfall,
    });
  },
);

const emitEdgeReasoning = emissionRow<"edge_reasoning">(
  async ({ root, artifactsDir }, result) => {
    const edgeReasoningResultsPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.edge_reasoning,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
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
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.edge_reasoning,
          label: "Edge-reasoning rewrites",
          promptFilename: "edge-reasoning-prompt.md",
          promptText: rejectionNotice
            ? `${basePrompt}\n\n${rejectionNotice}`
            : basePrompt,
        },
      ],
    });
    const edgeReasoningPromptPath = fanout.lanes[0]!.promptPath;
    const shortfallLines = renderLaneShortfallLines(fanout.shortfall);
    return currentStepPlan({
      artifactsDir,
      stepKind: "edge_reasoning_dispatch",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Execute the edge-reasoning lane prompt (subagent if available, else yourself), write the rewrites to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: fanout.artifactPaths,
      prompt: [
        ...shortfallLines,
        renderEdgeReasoningDispatchPrompt({
          promptPath: edgeReasoningPromptPath,
          resultsPath: edgeReasoningResultsPath,
          continueCommand,
          contentHash,
          candidateCount: result.candidates.length,
        }),
      ].join("\n"),
      access: {
        read_paths: [edgeReasoningPromptPath],
        write_paths: [edgeReasoningResultsPath],
      },
      submissionShortfall: fanout.shortfall,
    });
  },
);

export interface IntentEquivalencePromptInput {
  verdictPath: string;
  continueCommand: string;
  pending?: {
    prior_prose: string;
    current_prose: string;
    prior_hash: string;
    new_hash: string;
  };
}

/** Render the worker-facing verdict contract for a prose-only intent change. */
export function renderIntentEquivalencePrompt(
  input: IntentEquivalencePromptInput,
): string {
  const { verdictPath, continueCommand, pending } = input;
  return [
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
}
const emitIntentEquivalence = emissionRow<"intent_equivalence">(
  async ({ root, artifactsDir }, result) => {
    const verdictPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.intent_equivalence,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const status = deriveIntentEquivalenceStatus(result.bundle);
    const pending =
      status.kind === "prose_judgment_pending" ? status : undefined;
    const fullPrompt = renderIntentEquivalencePrompt({
      verdictPath,
      continueCommand,
      pending,
    });
    const shortfall = await recordExpectedLanes(
      artifactsDir,
      AUDIT_GATE_SUBMISSION_SCOPE,
      [{ lane: GATE_LANES.intent_equivalence, promptText: fullPrompt }],
    );
    return currentStepPlan({
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
      prompt: [...renderLaneShortfallLines(shortfall), fullPrompt].join("\n"),
      access: {
        read_paths: [],
        write_paths: [verdictPath],
      },
      submissionShortfall: shortfall,
    });
  },
);

const emitCriticalFlowFallback = emissionRow<"critical_flow_fallback">(
  async ({ root, artifactsDir }, result) => {
    const fallbackResultsPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.critical_flow_fallback,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = result.bundle.critical_flows
      ? renderCriticalFlowFallbackPrompt(result.bundle.critical_flows)
      : "# Critical-flow fallback\n\nNo critical_flows manifest is available; write an empty flows array.";
    // Always-materialized (design resolution 2): the (potentially ~340-line)
    // flow-stub prompt is a lane FILE, never inlined into the step prompt. The
    // results-path section is the lane materializer's, not this emitter's.
    const lanePrompt = basePrompt;
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.critical_flow_fallback,
          label: "Critical-flow fallback enrichment",
          promptFilename: "critical-flow-fallback-prompt.md",
          promptText: lanePrompt,
        },
      ],
    });
    return currentStepPlan({
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
        ...renderLaneShortfallLines(fanout.shortfall),
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
      submissionShortfall: fanout.shortfall,
    });
  },
);

const emitSynthesisNarrative = emissionRow<"synthesis_narrative">(
  async ({ root, artifactsDir }, result) => {
    const narrativeResultsPath = laneSubmissionPath(
      artifactsDir,
      GATE_LANES.synthesis_narrative,
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = result.bundle.audit_findings
      ? renderSynthesisNarrativePrompt(result.bundle.audit_findings)
      : "# Synthesis narrative\n\nNo findings report is available; write an empty themes array.";
    // Always-materialized (design resolution 2): the findings digest (up to 120
    // findings) is a lane FILE, never inlined into the step prompt. This step
    // previously carried no access block at all — the lane form declares one.
    // The results-path section is the lane materializer's, not this emitter's.
    const lanePrompt = basePrompt;
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.synthesis_narrative,
          label: "Synthesis narrative (themes / exec summary / top risks)",
          promptFilename: "synthesis-narrative-prompt.md",
          promptText: lanePrompt,
        },
      ],
    });
    return currentStepPlan({
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
        ...renderLaneShortfallLines(fanout.shortfall),
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
      submissionShortfall: fanout.shortfall,
    });
  },
);

/**
 * The step-emission dispatch table: exactly one row per host-actionable result
 * kind. Typed as a TOTAL record over the kind union, so a kind added upstream
 * with no row here is a compile error rather than a step that silently falls
 * through to the semantic-review dispatch.
 *
 * Exported together with the handled-kinds set below so a drift guard imports
 * the real thing instead of reconstructing it by reading a branch chain.
 */
export const NEXT_STEP_EMISSION_TABLE: Readonly<
  Record<NextStepEmissionKind, NextStepEmissionRow>
> = {
  complete: emitComplete,
  blocked: emitBlocked,
  design_review_parallel: emitDesignReviewParallel,
  design_review_contract: emitDesignReviewContract,
  design_review_conceptual: emitDesignReviewConceptual,
  charter_extraction: emitCharterExtraction,
  charter_delta: emitCharterDelta,
  charter_clarification: emitCharterClarification,
  systemic_challenge: emitSystemicChallenge,
  confirm_intent: emitConfirmIntent,
  analyzer_consent: emitAnalyzerConsent,
  analyzer_install: emitAnalyzerInstall,
  edge_reasoning: emitEdgeReasoning,
  intent_equivalence: emitIntentEquivalence,
  critical_flow_fallback: emitCriticalFlowFallback,
  synthesis_narrative: emitSynthesisNarrative,
};

/**
 * The one emission site for `audit-code next-step`. Rows return plans; this
 * writes and logs exactly once, whichever row (or the fallback) produced it.
 */
const NEXT_STEP_EMISSION = createStepEmissionScaffold<
  NextStepEmitContext,
  AuditStepPlan,
  EmittedAuditStep
>({
  table: NEXT_STEP_EMISSION_TABLE,
  // `semantic_review` is deliberately the FALLBACK rather than a row: the
  // validation boundary here has always been "anything unmatched is a
  // semantic-review dispatch", never an error on an unrecognized kind.
  fallback: (ctx) => {
    const result = ctx.result as NextStepResultOf<"semantic_review">;
    return semanticReviewPlan({
      root: ctx.root,
      artifactsDir: ctx.artifactsDir,
      activeReviewRun: result.activeReviewRun,
      selectedExecutor: result.selectedExecutor,
      inProcessMadeProgress: result.inProcessMadeProgress,
      ingestIssues: result.ingestIssues,
      validationWarnings: result.validationWarnings,
    });
  },
  write: writeAuditStep,
  // The tool's only externally-observable per-invocation contract.
  log: (step) => {
    console.log(JSON.stringify(step, null, 2));
  },
});

/**
 * The handled-kinds set, DERIVED from the table's own keys — never a second,
 * hand-listed copy that could disagree with the table it describes. A drift
 * guard consumes this as the real B side of its seam assertion.
 */
export const NEXT_STEP_EMISSION_KINDS: ReadonlySet<string> =
  NEXT_STEP_EMISSION.handledKeys;
