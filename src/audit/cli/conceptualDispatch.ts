import { resolve } from "node:path";
import { resolveDesignReviewChoices } from "../orchestrator/designReviewTask.js";
import { designReviewInputRevision } from "../orchestrator/designReviewProjection.js";
import { SEMANTIC_REVIEW_DEMAND } from "../../shared/types/stepContract.js";
import { INDEPENDENT_CONTEXT, renderFanoutExecutionLines } from "../../shared/prompts.js";
// sites-pinned: tests/audit/conceptual-charter-context.test.ts, tests/audit/review-file-map-context.test.ts, tests/audit/conceptual-independent-guidance.test.ts, tests/audit/review-evidence-right-sizing.test.ts
import {
  isFileMissingError,
  type DesignReviewBinding,
  type IntentCheckpoint,
  readTrailingSubmissionRefusals,
  readJsonFile,
  isJsonParseError,
  resolveDesignReviewBinding,
} from "audit-tools/shared";
import type { ConceptualWorkload, StepArtifact } from "./steps.js";
import { readAuditReviewSubmission, ReviewUnavailableError } from "./reviewSubmission.js";
import { readAuditReviewBinding } from "./auditReviewBindings.js";
import { parseReviewSubmissionEnvelope } from "../../shared/types/reviewIndependence.js";
import { parseSubmissionArrayItems, unwrapSubmissionArray } from "./laneValidators.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { resolveIntentLensSelection } from "../orchestrator/lensSelection.js";
import {
  type DesignReviewOptions,
  prepareDesignReviewRecon,
  type DesignReviewRecon,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  selectPerspectives,
} from "../orchestrator/designReviewPrompt.js";
import { materializeFanoutLanes } from "./fanoutLanes.js";
import type { FanoutLaneSpec } from "./fanoutLanes.js";
import {
  buildConceptualReviewAdjudication,
  clearConceptualReviewRoundManifest,
  ConceptualJudgeSubmissionSchema,
  SubmittedDesignFindingSchema,
  conceptualPerspectiveMalformedReason,
  conceptualReviewRoundManifestPath,
  parseConceptualPerspectiveFindings,
  readConceptualReviewRoundManifest,
  writeConceptualReviewRoundManifest,
} from "../types/conceptualAdjudication.js";
import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  GATE_LANES,
  closeDispatchedLaneOutcomes,
  conceptualPerspectiveLane,
  conceptualRoundToken,
  laneSubmissionPath,
  laneSubmissionId,
  recordLaneOutcome,
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";

export interface ConceptualReviewSettings {
  max_units?: number;
  conceptual_depth: "shallow" | "deep";
  perspectives?: NonNullable<IntentCheckpoint["design_review"]>["perspectives"];
  /**
   * Host-visible one-liner surfaced when the settings were REUSED from an existing
   * `intent_checkpoint.design_review` (rather than freshly confirmed this step).
   * Prepended to `ConceptualDispatch.instructionLines` so the host can see, in
   * `current-prompt.md`, which prior intent is being re-applied without re-running
   * `confirm_intent`. Present only on reuse; absent when the checkpoint carries no
   * `design_review`. Purely informational — it never alters the reuse DECISION
   * (the resolved depth/perspectives are byte-identical with or without it),
   * and the lens list it renders is content-sorted so the text never churns.
   */
  reuse_notice?: string;
  /**
   * Host-visible one-liner surfaced when the checkpoint CARRIES a `design_review`
   * block that does NOT bind to this run. The block's dials are therefore not
   * applied — the depth falls back to the schema default — and without this line
   * the fallback is SILENT: a host that wrote `deep` would receive a shallow
   * step with nothing said about the answer it gave. The notice names which
   * confirmation the block belongs to and why it was ignored, so the downgrade
   * is a stated fact the host can act on (re-run `confirm_intent`) rather than a
   * surprising one.
   */
  ignored_review_notice?: string;
}

/**
 * Render the host-visible notice when the CONFIRMED `intent_checkpoint.design_review`
 * block drives this workload. Content-sorted lens list keeps the text stable (no
 * churn), and every field degrades cleanly on a partial checkpoint: a missing
 * `confirmed_at` renders `unknown`, an absent/empty lens selection renders
 * `all lenses`, and a missing depth falls back to the resolved default `shallow`.
 *
 * The wording is "confirmed", NOT "reusing". This notice is reachable only for a
 * block bound to this run's own confirmation (see
 * `resolveRunBoundDesignReview`), so what it states is the answer the operator
 * just gave. "Reusing intent from <timestamp>" described the defect: a setting a
 * PREVIOUS run chose, re-applied without being asked. Hearing that sentence is
 * how the operator learned the tool had made a per-run decision durable.
 *
 * @internal Exported for testing purposes (TST-4c8bd93a-3).
 */
export function renderReuseNotice(
  checkpoint: NonNullable<IntentCheckpoint["design_review"]>,
  confirmedAt: string | undefined,
  lensSelection: IntentCheckpoint["lens_selection"],
  resolvedDepth: "shallow" | "deep",
): string {
  const when = confirmedAt && confirmedAt.length > 0 ? confirmedAt : "unknown";
  const included = [...(lensSelection?.include ?? [])].sort();
  const excluded = [...(lensSelection?.exclude ?? [])].sort();
  const lensParts: string[] = [];
  if (included.length > 0) lensParts.push(`+${included.join(",")}`);
  if (excluded.length > 0) lensParts.push(`-${excluded.join(",")}`);
  const lenses = lensParts.length > 0 ? lensParts.join(" ") : "all lenses";
  const depth = checkpoint.conceptual_depth ?? resolvedDepth;
  return `_Confirmed intent at ${when}: ${lenses}; conceptual depth ${depth}._`;
}

/**
 * The host-visible line stating that the checkpoint carries a `design_review`
 * block this run did NOT answer, so its dials were ignored. `undefined` when
 * nothing was ignored — an absent block claims nothing, so there is nothing to
 * report.
 *
 * The lead-in states only the fact the tool KNOWS (the block did not bind); the
 * binding's `reason` states WHY, and carries the "belongs to an earlier
 * confirmation" fact when that is in fact the reason. A reason that hard-coded
 * it would assert a provenance the tool cannot see for a block whose
 * `answered_at` is simply unreadable.
 *
 * @internal Exported for testing purposes.
 */
export function renderIgnoredReviewNotice(
  binding: DesignReviewBinding,
): string | undefined {
  if (binding.kind !== "unbound") return undefined;
  return (
    `_A \`design_review\` block is present on the intent checkpoint but was ignored: ` +
    `${binding.reason}. The dials it carries ` +
    `(conceptual depth, perspectives, attention) are NOT in force for this run; ` +
    `re-run \`confirm_intent\` to answer them for it._`
  );
}

/**
 * Resolve the conceptual-review depth and perspective count from confirmed
 * intent. Absent an explicit choice, the default is a shallow review.
 */
export function resolveConceptualReviewSettings(
  bundle: ArtifactBundle,
): ConceptualReviewSettings {
  // RUN-BOUND, never merely present. A `design_review` block a PRIOR
  // confirmation supplied is not this run's answer: these dials are per-run
  // (owner, 2026-08-21), and reading an inherited block here is what made the
  // tool announce `Reusing intent … conceptual depth deep` to an operator who
  // never chose it. The binding returns the block only when this confirmation's
  // write supplied it; otherwise the depth falls back to the schema default and
  // NO reuse notice is rendered, so the next confirm-intent step asks again —
  // and when a block IS present but does not bind, the emitted step SAYS so
  // (`ignored_review_notice`) rather than downgrading in silence.
  const binding = resolveDesignReviewBinding(bundle.intent_checkpoint);
  const checkpoint = binding.kind === "bound" ? binding.settings : undefined;
  const ignoredReviewNotice = renderIgnoredReviewNotice(binding);
  const choices = resolveDesignReviewChoices(bundle);
  const conceptualDepth = choices.conceptual_depth;
  // Surface a notice only when the CONFIRMED block drives the workload. The
  // notice is purely informational — it is derived AFTER the decision fields
  // above so it can never change them (the resolution stays identical with and
  // without it). It reads "confirmed", never "reusing": the block reaching here
  // is bound to THIS confirmation, so the operator is being reminded of the
  // answer they just gave, not told a prior run's choice is being re-applied.
  const reuseNotice = checkpoint
    ? renderReuseNotice(
        checkpoint,
        bundle.intent_checkpoint?.confirmed_at,
        bundle.intent_checkpoint?.lens_selection,
        conceptualDepth,
      )
    : undefined;
  return {
    conceptual_depth: conceptualDepth,
    perspectives: choices.perspectives,
    ...(reuseNotice ? { reuse_notice: reuseNotice } : {}),
    ...(ignoredReviewNotice ? { ignored_review_notice: ignoredReviewNotice } : {}),
  };
}

export type ConceptualDispatch = (
  | { deep: false; workload?: never }
  /** Deep-review work selected by validating bound submissions, not by access grants. */
  | { deep: true; workload: ConceptualWorkload }
) & {
  /**
   * The single conceptual-review result file the orchestrator ingests — the
   * judge's merged output when deep, the lone reviewer's output when shallow.
   */
  conceptualResultsPath: string;
  /** Host-facing lines describing how to run the conceptual pass. */
  instructionLines: string[];
  /** Contributions to the step's `artifactPaths`. */
  artifactPaths: Record<string, string>;
  /** Prompt files the review lanes read. */
  readPaths: string[];
  graphLookupCommand?: string;
  /** Result files the review lanes write. */
  writePaths: string[];
  /** What a previous emission of this pass's lanes is still owed. */
  shortfall: LaneSubmissionShortfall;
};

/** Inspect the actual bound result before counting a perspective as delivered. */
async function inspectPerspective(
  artifactsDir: string,
  lane: string,
  path: string,
  semanticInputRevision?: string,
): Promise<
  | { status: "delivered" | "missing" | "unavailable" }
  | { status: "malformed"; reason: string }
> {
  try {
    parseConceptualPerspectiveFindings(
      await readAuditReviewSubmission(path, artifactsDir, lane, semanticInputRevision),
    );
    return { status: "delivered" };
  } catch (error) {
    if (error instanceof ReviewUnavailableError) return { status: "unavailable" };
    if (isFileMissingError(error)) return { status: "missing" };
    const reason = conceptualPerspectiveMalformedReason(error);
    if (reason === undefined) throw error;
    return { status: "malformed", reason };
  }
}

type PublishedLane = ConceptualWorkload["pending_perspectives"][number];

function samePath(expected: string, published: string | null | undefined): boolean {
  return typeof published === "string" && resolve(expected) === resolve(published);
}

// Only prompt-bound evidence can describe the current lane. Do not call the
// normal submission decoder here: it records declaration events on read.
async function readPublishedConceptualResult(
  artifactsDir: string, lane: PublishedLane, revision: string, previouslyRejected: boolean,
) {
  const binding = await readAuditReviewBinding(artifactsDir, lane.lane_id);
  if (binding?.requirement !== "independent" || binding.runId !== AUDIT_GATE_SUBMISSION_SCOPE ||
      binding.submissionId !== laneSubmissionId(lane.lane_id) ||
      binding.semanticInputRevision !== revision || !samePath(binding.promptPath, lane.prompt_path)) {
    return { state: "stale" as const };
  }
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(lane.result_path);
  } catch (error) {
    if (isFileMissingError(error)) return { state: previouslyRejected ? "correction_required" as const : "missing" as const };
    if (isJsonParseError(error)) return { state: "correction_required" as const };
    throw error;
  }
  const parsed = parseReviewSubmissionEnvelope(raw, binding);
  if (!parsed.ok) return {
    state: parsed.code === "review_unavailable" ? "unavailable" as const : "correction_required" as const,
  };
  return { state: "delivered" as const, value: parsed.result };
}

/** Inspect a published conceptual pass, updating neither submissions nor audit state. */
export async function inspectPublishedConceptualProgress(
  artifactsDir: string, step: StepArtifact, loadBundle: () => Promise<ArtifactBundle>,
) {
  const stale = { state: "stale", summary: "Conceptual publication is stale. Run next-step to refresh it." };
  if (step.run_id !== null || !samePath(artifactsDir, step.artifacts_dir)) return stale;
  if (step.status === "blocked") return { state: "blocked", summary: "Conceptual review is blocked." };
  if (step.status !== "ready") return stale;

  try {
    const paths = step.artifact_paths;
    const lane = GATE_LANES.design_review_conceptual;
    const resultPath = laneSubmissionPath(artifactsDir, lane);
    const manifest = await readConceptualReviewRoundManifest(artifactsDir);
    const workload = step.conceptual_workload;
    const promptPath = manifest ? paths.conceptual_judge_prompt : paths.conceptual_prompt;
    if (!samePath(resultPath, paths.conceptual_results) || !promptPath ||
        (paths.design_review_conceptual_results !== undefined &&
          !samePath(resultPath, paths.design_review_conceptual_results))) return stale;
    const output = { lane_id: lane, prompt_path: promptPath, result_path: resultPath };
    const perspectives = manifest?.perspectives ?? [];
    if (manifest) {
      const publishedPerspectivePaths = Object.keys(paths).filter(key => /^conceptual_perspective_\d+_(prompt|results)$/.test(key));
      if (!workload || publishedPerspectivePaths.length !== 2 * perspectives.length ||
          !/^[a-f0-9]{12}$/.test(manifest.round_id) ||
          !samePath(conceptualReviewRoundManifestPath(artifactsDir), paths.conceptual_round_manifest) ||
          manifest.judge.lane_id !== lane || manifest.judge.contributor_id !== lane ||
          !samePath(promptPath, manifest.judge.prompt_path) || !samePath(resultPath, manifest.judge.result_path) ||
          workload.judge.lane_id !== lane || !samePath(promptPath, workload.judge.prompt_path) ||
          !samePath(resultPath, workload.judge.result_path)) return stale;
      for (const [i, perspective] of perspectives.entries()) {
        const id = conceptualPerspectiveLane(i + 1, manifest.round_id);
        if (perspective.lane_id !== id || perspective.contributor_id !== id ||
            !samePath(laneSubmissionPath(artifactsDir, id), perspective.result_path) ||
            !samePath(perspective.prompt_path, paths[`conceptual_perspective_${i + 1}_prompt`]) ||
            !samePath(perspective.result_path, paths[`conceptual_perspective_${i + 1}_results`])) return stale;
      }
    } else if (workload || paths.conceptual_round_manifest || paths.conceptual_judge_prompt) {
      return stale;
    }

    const revision = designReviewInputRevision(await loadBundle(), "conceptual");
    const refused = await readTrailingSubmissionRefusals(
      artifactsDir, [lane, ...perspectives.map(p => p.lane_id)].map(id => laneSubmissionId(id)),
      { runId: AUDIT_GATE_SUBMISSION_SCOPE },
    );
    const readResult = (item: PublishedLane) => readPublishedConceptualResult(
      artifactsDir, item, revision, refused.has(laneSubmissionId(item.lane_id)),
    );

    const perspectiveFindings = new Map<string, ReturnType<typeof parseConceptualPerspectiveFindings>>();
    const pending = [];
    for (const perspective of perspectives) {
      const result = await readResult(perspective);
      let state: string = result.state;
      if (result.state === "delivered") {
        try {
          perspectiveFindings.set(perspective.contributor_id, parseConceptualPerspectiveFindings(result.value));
          continue;
        } catch (error) {
          if (conceptualPerspectiveMalformedReason(error) === undefined) throw error;
          state = "correction_required";
        }
      }
      const { lane_id, prompt_path, result_path } = perspective;
      pending.push({ lane_id, prompt_path, result_path, state });
    }

    const response = await readResult(output);
    if (response.state === "stale" || pending.some(p => p.state === "stale")) return stale;
    const context = {
      mode: manifest ? "deep" : "shallow",
      ...(manifest ? { round_id: manifest.round_id, pending_perspectives: pending } : {}),
      [manifest ? "judge" : "reviewer"]: { ...output, state: response.state === "delivered" ? "received" : response.state },
    };
    if (pending.length > 0) {
      const unavailable = pending.some(p => p.state === "unavailable");
      const correction = pending.some(p => p.state === "correction_required");
      return {
        ...context, state: unavailable ? "blocked" : correction ? "correction_required" : "await_perspectives",
        action: unavailable ? "retry_independent_review" : correction ? "correct_perspectives" : "await_perspectives",
        summary: unavailable ? "Retry unavailable perspectives when independent review is available."
          : correction ? "Correct and resubmit the invalid perspective results to their bound paths."
            : "Waiting for the remaining independent perspective results before dispatching the judge.",
      };
    }

    const role = manifest ? "judge" : "reviewer";
    if (response.state === "missing") return {
      ...context, state: manifest ? "await_judge" : "await_reviewer",
      action: manifest ? "dispatch_judge" : "dispatch_reviewer",
      summary: `Run the independent ${role} and save its bound result.`,
    };
    if (response.state === "unavailable") return {
      ...context, state: "blocked", action: "retry_independent_review",
      summary: `Independent ${role} review is unavailable. Retry when independent review is available.`,
    };

    let valid = false;
    if (response.state === "delivered") {
      if (manifest) {
        const parsed = ConceptualJudgeSubmissionSchema.safeParse(response.value);
        if (parsed.success && parsed.data.round_id !== manifest.round_id) return stale;
        if (parsed.success) {
          try {
            // Pass the original value so tool-owned verdict fields cannot be
            // silently stripped by schema parsing before adjudication.
            buildConceptualReviewAdjudication({
              manifest, perspectiveFindings, submission: response.value, generatedAt: "1970-01-01T00:00:00.000Z",
            });
            valid = true;
          } catch {
            // A shape-valid judge result can still disagree with its inputs.
          }
        }
      } else {
        const unwrapped = unwrapSubmissionArray(response.value);
        valid = unwrapped.ok && parseSubmissionArrayItems(unwrapped.array, SubmittedDesignFindingSchema).ok;
      }
    }
    return valid ? {
      ...context, [role]: { ...output, state: "validated" }, state: "ready", action: "continue",
      summary: step.step_kind === "design_review_parallel"
        ? "The conceptual result is ready for next-step. Contract review is a separate lane."
        : "The conceptual result is ready. Run next-step to continue.",
    } : {
      ...context, [role]: { ...output, state: "correction_required" },
      state: "correction_required", action: "correct_result",
      summary: `Correct the independent ${role} result and save it to the same bound path.`,
    };
  } catch {
    return { state: "unavailable", summary: "Could not inspect the published conceptual review." };
  }
}

/**
 * Write the conceptual-review prompt artifacts and return the host workload.
 *
 * Shallow: one conceptual prompt file for a single reviewer.
 * Deep: N independent perspective prompt files (real fan-out, one value system
 * each) plus an independent judge prompt that merges them — the judge writes the
 * single `conceptualResultsPath` the orchestrator ingests, so the state machine
 * is unchanged. The perspectives' intermediate result files are never ingested.
 */
export async function prepareConceptualDispatch(opts: {
  artifactsDir: string;
  /** The run's frozen snapshot root, stated in every lane prompt. */
  sourceRoot: string;
  bundle: ArtifactBundle;
  settings: ConceptualReviewSettings;
  /**
   * Diff-based re-review section (B2 parity port). Present only when the
   * conceptual pass is being re-emitted after staleness. Appended to the single
   * reviewer's prompt when shallow, and to the JUDGE's prompt when deep — the
   * judge holds the prior merged verdict and produces the ingested result, so
   * the merge becomes diff-aware while the perspectives stay independent (each
   * still reviews fresh through its own lens, never seeing the prior verdict).
   */
  reReviewSection?: string;
  /** Repair feedback is prompt context, never part of the review round identity. */
  rejectionNotice?: string;
  recon?: DesignReviewRecon;
  graphLookup?: { path: string; command: string };
}): Promise<ConceptualDispatch> {
  const { artifactsDir, bundle, settings } = opts;
  const notes = [opts.reReviewSection, opts.rejectionNotice].filter(Boolean).join("\n\n");
  const reReviewSuffix = notes
    ? `\n\n${notes}`
    : "";
  // The single conceptual submission the orchestrator ingests — written by the
  // lone reviewer when shallow, by the independent judge when deep. Either way
  // it is the `design_review_conceptual` LANE, so the gate reads one bound path
  // and the state machine is unchanged by the depth choice.
  const conceptualResultsPath = laneSubmissionPath(
    artifactsDir,
    GATE_LANES.design_review_conceptual,
  );
  // The operator's lens selection reaches EVERY lens-open lane of this pass —
  // the shallow reviewer, each perspective, and the judge. It reached none of
  // them before: this options object had no lens field at all, so the only lens
  // a lane ever saw was the output example's hard-coded literal.
  const lenses = resolveIntentLensSelection(
    bundle.intent_checkpoint?.lens_selection,
  );
  const reviewOptions: DesignReviewOptions = {
    max_units: settings.max_units,
    ...(lenses === undefined ? {} : { lenses }),
  };
  // Built ONCE for the pass: every lane rendered with `reviewOptions` anchors the
  // same starting points, so the shallow reviewer — or every perspective and
  // the judge — reads the same read-only, bound map file; each prompt carries
  // only its summary.
  const recon = opts.recon ?? prepareDesignReviewRecon(bundle, reviewOptions);
  const fileMapContext = recon.fileMap.contextFiles;
  const contextPaths = opts.graphLookup ? [opts.graphLookup.path] : [];
  const graphGuidance = opts.graphLookup ? [
    "",
    "## On-demand dependency lookup",
    "The call-site map covers starting points only. To explore any admitted file, including a unit not in that map, replace REPO_RELATIVE_PATH in:",
    "`" + opts.graphLookup.command + "`",
    "Follow --offset when results have another page. Treat graph links as navigation hints and verify them in frozen source.",
  ].join("\n") : "";

  // A round that is about to be superseded — by a re-review, or by a switch to
  // the shallow pass — will never be ingested, so this is the last moment its
  // perspectives' dispatch rows can be closed with what they actually
  // delivered. Read from the manifest the tool wrote; no lane id is parsed.
  const priorRound = await readConceptualReviewRoundManifest(artifactsDir);
  const closePriorRound = async (currentRoundId?: string): Promise<void> => {
    if (!priorRound || priorRound.round_id === currentRoundId) return;
    for (const { lane_id: lane } of priorRound.perspectives) {
      const result = await inspectPerspective(artifactsDir, lane, laneSubmissionPath(artifactsDir, lane));
      if (result.status === "malformed") {
        // The generic ledger observer checks only the envelope and array shape.
        // Close invalid perspective results as refusals before that observer
        // can credit their raw array as clean/findings delivery.
        await recordLaneOutcome(artifactsDir, lane, {
          kind: "rejected",
          issueCode: "submission_contract_invalid",
          message: `Malformed perspective result: ${result.reason}`,
        });
      }
    }
    await closeDispatchedLaneOutcomes(artifactsDir, {
      lanes: priorRound.perspectives.map((perspective) => perspective.lane_id),
      roundId: priorRound.round_id,
    });
  };
  // The same for every lane of the pass: the bundle is not mutated between lanes.
  const semanticInputRevision = designReviewInputRevision(bundle, "conceptual");
  const fileCount = bundle.repo_manifest?.files.length ?? 0;

  if (settings.conceptual_depth !== "deep") {
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      sourceRoot: opts.sourceRoot,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.design_review_conceptual,
          semanticInputRevision,
          fileCount,
          ...SEMANTIC_REVIEW_DEMAND,
          label: "Conceptual review (generative)",
          promptFilename: "design-review-conceptual-prompt.md",
          contextPaths,
          generatedContext: fileMapContext,
          promptText:
            renderConceptualReviewPrompt(bundle, reviewOptions, recon) + graphGuidance + reReviewSuffix,
        },
      ],
    });
    const conceptualPromptPath = fanout.lanes[0]!.promptPath;
    const mapPaths = fanout.lanes[0]!.generatedContextPaths;
    await closePriorRound();
    await clearConceptualReviewRoundManifest(artifactsDir);
    return {
      deep: false,
      graphLookupCommand: opts.graphLookup?.command,
      conceptualResultsPath,
      instructionLines: [
        ...(settings.ignored_review_notice ? [settings.ignored_review_notice] : []),
        ...(settings.reuse_notice ? [settings.reuse_notice] : []),
        // Concrete paths, from the same values as `artifactPaths` below — the
        // step markdown must name what it tells the host to read and write.
        `**Conceptual review** (generative): in ${INDEPENDENT_CONTEXT}, read the prompt at \`${conceptualPromptPath}\` and write findings to \`${conceptualResultsPath}\`.`,
      ],
      artifactPaths: {
        conceptual_prompt: conceptualPromptPath,
        conceptual_results: conceptualResultsPath,
      },
      readPaths: [conceptualPromptPath, ...mapPaths, ...contextPaths, opts.sourceRoot],
      writePaths: [conceptualResultsPath],
      shortfall: fanout.shortfall,
    };
  }

  // Deep: real fan-out — N perspective lanes + an independent judge.
  // Every one of them is a LANE through the same materializer the rest of the
  // audit uses; this pass used to mint its own filenames, which is precisely how
  // a second naming convention (and a second way for a host to mistype one)
  // came to exist.
  const deepContext = [...fileMapContext, recon.deepEvidence];
  const perspectives = selectPerspectives(settings.perspectives);
  const total = perspectives.length;
  const perspectiveTexts = perspectives.map((p, i) =>
    renderConceptualPerspectivePrompt(bundle, p, i, total, reviewOptions, recon) + graphGuidance,
  );
  // The round the perspectives are being asked about: the prompts themselves
  // and shared evidence files each perspective reads, plus the judge's
  // re-review section, which is present exactly when this is a re-review after
  // staleness. A fresh round therefore mints fresh lane ids and fresh prompts;
  // an unchanged one re-declares the identical bound paths.
  const roundToken = conceptualRoundToken([
    ...perspectiveTexts,
    ...deepContext.flatMap(file => [file.filename, file.text]),
    opts.reReviewSection ?? "",
  ]);
  const perspectiveFiles: Array<{
    name: string;
    lane: string;
    promptFilename: string;
    promptText: string;
    resultsPath: string;
  }> = perspectives.map((p, i) => {
    const lane = conceptualPerspectiveLane(i + 1, roundToken);
    return {
      name: p.name,
      lane,
      promptFilename: `design-review-conceptual-p${i + 1}-prompt.md`,
      promptText: perspectiveTexts[i]!,
      resultsPath: laneSubmissionPath(
        artifactsDir,
        lane,
        AUDIT_GATE_SUBMISSION_SCOPE,
      ),
    };
  });

  const judgePromptText =
    renderConceptualJudgePrompt(
      bundle,
      perspectiveFiles.map((f) => ({
        name: f.name,
        path: f.resultsPath,
        contributor_id: f.lane,
      })),
      roundToken,
      reviewOptions,
      recon,
    ) + graphGuidance + reReviewSuffix;

  const perspectiveRefusals = await readTrailingSubmissionRefusals(
    artifactsDir,
    perspectiveFiles.map((f) => laneSubmissionId(f.lane)),
    { runId: AUDIT_GATE_SUBMISSION_SCOPE },
  );

  const laneSpecs: FanoutLaneSpec[] = [
    ...perspectiveFiles.map((f) => ({
      id: f.lane,
      semanticInputRevision,
      fileCount,
      ...SEMANTIC_REVIEW_DEMAND,
      label: `Conceptual perspective - ${f.name}`,
      promptFilename: f.promptFilename,
      contextPaths,
      generatedContext: deepContext,
      // Keep the bound prompt stable. Repair feedback goes into the parent
      // instructions; changing this prompt would invalidate a corrected result.
      promptText: f.promptText,
      // The judge consumes these findings; the audit gate expects only the judge.
      expected: false,
    })),
    {
      // The judge PRODUCES the conceptual submission, so it is that lane — a
      // separate judge lane id would mint a bound path nothing reads.
      id: GATE_LANES.design_review_conceptual,
      semanticInputRevision,
      fileCount,
      ...SEMANTIC_REVIEW_DEMAND,
      label: "Conceptual review judge (independent merge)",
      promptFilename: "design-review-conceptual-judge-prompt.md",
      contextPaths,
      generatedContext: deepContext,
      promptText: judgePromptText,
    },
  ];
  await closePriorRound(roundToken);
  const fanout = await materializeFanoutLanes({
    artifactsDir,
    sourceRoot: opts.sourceRoot,
    runId: AUDIT_GATE_SUBMISSION_SCOPE,
    roundId: roundToken,
    lanes: laneSpecs,
  });
  const promptPathFor = (laneId: string): string =>
    fanout.lanes.find((lane) => lane.id === laneId)!.promptPath;
  const judgePromptPath = promptPathFor(GATE_LANES.design_review_conceptual);
  const perspectivePrompts = perspectiveFiles.map((f) => ({
    ...f,
    promptPath: promptPathFor(f.lane),
  }));

  await writeConceptualReviewRoundManifest(artifactsDir, {
    schema_version: 1,
    mode: "deep",
    round_id: roundToken,
    perspectives: perspectivePrompts.map((perspective) => ({
      contributor_id: perspective.lane,
      perspective: perspective.name,
      lane_id: perspective.lane,
      prompt_path: perspective.promptPath,
      result_path: perspective.resultsPath,
    })),
    judge: {
      contributor_id: GATE_LANES.design_review_conceptual,
      lane_id: GATE_LANES.design_review_conceptual,
      prompt_path: judgePromptPath,
      result_path: conceptualResultsPath,
    },
  });

  // Work (both structured and rendered) narrows on resume; access and the
  // manifest retain the full, stable bindings for this round, including the
  // landed perspective submissions the judge still needs to read.
  const pendingPerspectives: Array<{
    ordinal: number;
    f: (typeof perspectivePrompts)[number];
    diagnostic: string;
  }> = [];
  for (const [i, f] of perspectivePrompts.entries()) {
    const result = await inspectPerspective(artifactsDir, f.lane, f.resultsPath, semanticInputRevision);
    if (result.status === "delivered") continue;
    const diagnostic = result.status === "malformed"
      ? `malformed result: ${result.reason}. Correct and resubmit to the same result path`
      : result.status === "unavailable"
        ? "declared unavailable; retry only if independent review is available"
        : perspectiveRefusals.has(laneSubmissionId(f.lane))
          ? "previous result rejected; correct it and resubmit to the same result path"
          : "result not received";
    pendingPerspectives.push({ ordinal: i + 1, f, diagnostic });
  }
  const pendingCount = pendingPerspectives.length;
  const deliveredCount = perspectivePrompts.length - pendingCount;

  const artifactPaths: Record<string, string> = {
    conceptual_results: conceptualResultsPath,
    conceptual_judge_prompt: judgePromptPath,
    conceptual_round_manifest:
      conceptualReviewRoundManifestPath(artifactsDir),
  };
  perspectivePrompts.forEach((f, i) => {
    artifactPaths[`conceptual_perspective_${i + 1}_prompt`] = f.promptPath;
    artifactPaths[`conceptual_perspective_${i + 1}_results`] = f.resultsPath;
  });

  return {
    deep: true,
    graphLookupCommand: opts.graphLookup?.command,
    workload: {
      pending_perspectives: pendingPerspectives.map(({ f }) => ({
        lane_id: f.lane,
        prompt_path: f.promptPath,
        result_path: f.resultsPath,
      })),
      judge: {
        lane_id: GATE_LANES.design_review_conceptual,
        prompt_path: judgePromptPath,
        result_path: conceptualResultsPath,
        ready: pendingCount === 0,
      },
    },
    conceptualResultsPath,
    instructionLines: [
      ...(settings.ignored_review_notice ? [settings.ignored_review_notice] : []),
      ...(settings.reuse_notice ? [settings.reuse_notice] : []),
      `**Conceptual review** (generative, deep — ${total}-perspective fan-out):`,
      // A resumed round with some (but not all) perspectives already delivered
      // renders this notice so the host sees, in prose, exactly which lanes are
      // being skipped and why — the workload and the step-1 list below
      // both use the validated pending set; this line is purely informational,
      // the same "state what changed, never rely on the host noticing" pattern
      // `reuse_notice` above uses for checkpoint reuse.
      ...(deliveredCount > 0
        ? [
            `_${deliveredCount} of ${total} perspective lane(s) already delivered a submission this round — reusing that output, not re-executing them._`,
          ]
        : []),
      // sites-pinned: tests/audit/conceptual-independent-guidance.test.ts, tests/audit/conceptual-perspective-round-identity.test.ts, tests/audit/conceptual-reuse-notice.test.ts, tests/audit/review-evidence-right-sizing.test.ts
      ...(pendingCount > 0
        ? [
            `1. Execute ${pendingCount === total ? `these ${total}` : `these ${pendingCount} still-pending`} independent perspective lane(s) in parallel where possible, otherwise sequentially in independent contexts. Each lane reviews only through its own value system and must NOT see the others' output:`,
            ...pendingPerspectives.map(({ ordinal, diagnostic }) => `   Perspective ${ordinal}: ${diagnostic}.`),
            ...renderFanoutExecutionLines({
              lanes: pendingPerspectives.map(({ ordinal, f }) => ({ label: `Perspective ${ordinal} (${f.name})`, promptPath: f.promptPath, resultPath: f.resultsPath })),
              independenceRequired: true,
              unavailableReview: "declare",
            }),
          ]
        : [
            `1. All ${total} perspective lanes have already delivered a submission this round — nothing to execute here.`,
          ]),
      `2. When all ${total} perspectives have written their findings in independent contexts, execute ONE **independent judge** lane in a fresh context that is not any of the perspectives. Merge only their written findings. If a perspective is unavailable, declare the judge unavailable as well and continue to record the pause; preserve completed independent perspectives.`,
      ...renderFanoutExecutionLines({
        lanes: [{ label: "Independent judge", promptPath: judgePromptPath, resultPath: conceptualResultsPath }],
        independenceRequired: true,
        unavailableReview: "declare",
      }),
      "Each prompt file above defines the reviewer's persona, scope, evidence paths, and output schema. Before dispatch, ensure the executor can open the frozen source and the bound read-only context files named in its prompt. If the worker runs elsewhere, stage those exact files at the paths visible to that worker; a path on the dispatcher's computer alone is not access. Do not treat an executor without those reads as a full reviewer. Pass the `prompt_path` to the executor as its instruction verbatim; do NOT restate the persona or re-describe the task in your dispatch message (the parenthesised name is only a label for you).",
    ],
    artifactPaths,
    // Perspective result files must be in readPaths: the judge lane reads
    // them to merge and synthesise the final output (COR-60ca1f72).
    readPaths: [
      ...perspectivePrompts.map((f) => f.promptPath),
      ...perspectivePrompts.map((f) => f.resultsPath),
      judgePromptPath,
      ...new Set(fanout.lanes.flatMap((lane) => lane.generatedContextPaths)),
      ...contextPaths,
      // The snapshot every prompt tells its reader to verify against.
      opts.sourceRoot,
    ],
    writePaths: [
      ...perspectivePrompts.map((f) => f.resultsPath),
      conceptualResultsPath,
    ],
    shortfall: fanout.shortfall,
  };
}
