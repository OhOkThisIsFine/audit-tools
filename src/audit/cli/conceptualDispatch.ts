import {
  type IntentCheckpoint,
  charterReviewDisposition,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { resolveIntentLensSelection } from "../orchestrator/lensSelection.js";
import {
  type DesignReviewOptions,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  selectPerspectives,
} from "../orchestrator/designReviewPrompt.js";
import { materializeFanoutLanes } from "./fanoutLanes.js";
import type { FanoutLaneSpec } from "./fanoutLanes.js";
import {
  clearConceptualReviewRoundManifest,
  conceptualReviewRoundManifestPath,
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
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";

export interface ConceptualReviewSettings {
  max_units?: number;
  conceptual_depth: "shallow" | "deep";
  perspectives?: number;
  /**
   * True when any confirmed charter is low-confidence (Phase A conceptual spine):
   * a review depending on a low-confidence charter must "flag for human intent
   * input, never opine" (`charterReviewDisposition`). Absent/false when no charters
   * are present or all are confident. The charter-aware prompt path consumes this
   * (Phase C); until then it records the disposition on the settings contract.
   */
  flag_for_human?: boolean;
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
}

/**
 * Render the host-visible reuse notice when a prior `intent_checkpoint.design_review`
 * drives this workload. Content-sorted lens list keeps the text stable (no churn),
 * and every field degrades cleanly on a partial checkpoint: a missing `confirmed_at`
 * renders `unknown`, an absent/empty lens selection renders `all lenses`, and a
 * missing depth falls back to the resolved default `shallow`.
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
  return `_Reusing intent from ${when}: ${lenses}; conceptual depth ${depth}._`;
}

/**
 * Resolve the conceptual-review depth and perspective count from confirmed
 * intent. Absent an explicit choice, the default is a shallow review.
 */
export function resolveConceptualReviewSettings(
  bundle: ArtifactBundle,
): ConceptualReviewSettings {
  const checkpoint = bundle.intent_checkpoint?.design_review;
  // A low-confidence charter downgrades the dependent review to flag-for-human
  // (charterReviewDisposition). Charters live on the REGISTER — the checkpoint
  // carries only the ceiling as input (its never-written charter embed was
  // deleted 2026-08-06, design resolution 4).
  const flagForHuman = (bundle.charter_register?.subsystems ?? []).some(
    (subsystem) =>
      subsystem.charters.some(
        (charter) => charterReviewDisposition(charter) === "flag_for_human",
      ),
  );
  const conceptualDepth =
    checkpoint?.conceptual_depth ?? "shallow";
  // Surface a reuse notice only when a prior checkpoint design_review drives the
  // workload. The notice is purely informational — it is derived AFTER the
  // decision fields above so it can never change them (reuse stays byte-identical).
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
    perspectives: checkpoint?.perspectives,
    ...(flagForHuman ? { flag_for_human: true } : {}),
    ...(reuseNotice ? { reuse_notice: reuseNotice } : {}),
  };
}

export interface ConceptualDispatch {
  deep: boolean;
  /**
   * The single conceptual-review result file the orchestrator ingests — the
   * judge's merged output when deep, the lone reviewer's output when shallow.
   */
  conceptualResultsPath: string;
  /** Host-facing lines describing how to run the conceptual pass. */
  instructionLines: string[];
  /** Contributions to the step's `artifactPaths`. */
  artifactPaths: Record<string, string>;
  /** Prompt files the host's subagents read. */
  readPaths: string[];
  /** Result files the host's subagents write. */
  writePaths: string[];
  /** What a previous emission of this pass's lanes is still owed. */
  shortfall: LaneSubmissionShortfall;
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
}): Promise<ConceptualDispatch> {
  const { artifactsDir, bundle, settings } = opts;
  const reReviewSuffix = opts.reReviewSection
    ? `\n\n${opts.reReviewSection}`
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
  // A round that is about to be superseded — by a re-review, or by a switch to
  // the shallow pass — will never be ingested, so this is the last moment its
  // perspectives' dispatch rows can be closed with what they actually
  // delivered. Read from the manifest the tool wrote; no lane id is parsed.
  const priorRound = await readConceptualReviewRoundManifest(artifactsDir);
  const closePriorRound = async (currentRoundId?: string): Promise<void> => {
    if (!priorRound || priorRound.round_id === currentRoundId) return;
    await closeDispatchedLaneOutcomes(artifactsDir, {
      lanes: priorRound.perspectives.map((perspective) => perspective.lane_id),
      roundId: priorRound.round_id,
    });
  };

  if (settings.conceptual_depth !== "deep") {
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: GATE_LANES.design_review_conceptual,
          label: "Conceptual review (generative)",
          promptFilename: "design-review-conceptual-prompt.md",
          promptText:
            renderConceptualReviewPrompt(bundle, reviewOptions) + reReviewSuffix,
        },
      ],
    });
    const conceptualPromptPath = fanout.lanes[0]!.promptPath;
    await closePriorRound();
    await clearConceptualReviewRoundManifest(artifactsDir);
    return {
      deep: false,
      conceptualResultsPath,
      instructionLines: [
        ...(settings.reuse_notice ? [settings.reuse_notice] : []),
        "**Conceptual review** (generative): dispatch a subagent that reads the prompt at the conceptual prompt path and writes findings to the conceptual results path.",
      ],
      artifactPaths: {
        conceptual_prompt: conceptualPromptPath,
        conceptual_results: conceptualResultsPath,
      },
      readPaths: [conceptualPromptPath],
      writePaths: [conceptualResultsPath],
      shortfall: fanout.shortfall,
    };
  }

  // Deep: real fan-out — N perspective subagents + an independent judge.
  // Every one of them is a LANE through the same materializer the rest of the
  // audit uses; this pass used to mint its own filenames, which is precisely how
  // a second naming convention (and a second way for a host to mistype one)
  // came to exist.
  const perspectives = selectPerspectives(settings.perspectives);
  const total = perspectives.length;
  const perspectiveTexts = perspectives.map((p, i) =>
    renderConceptualPerspectivePrompt(bundle, p, i, total, reviewOptions),
  );
  // The round the perspectives are being asked about: the prompts themselves
  // (the whole upstream projection each perspective reads) plus the judge's
  // re-review section, which is present exactly when this is a re-review after
  // staleness. A fresh round therefore mints fresh lane ids and fresh prompts;
  // an unchanged one re-declares the identical bound paths.
  const roundToken = conceptualRoundToken([
    ...perspectiveTexts,
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
    ) + reReviewSuffix;

  const laneSpecs: FanoutLaneSpec[] = [
    ...perspectiveFiles.map((f) => ({
      id: f.lane,
      label: `Conceptual perspective — ${f.name}`,
      promptFilename: f.promptFilename,
      promptText: f.promptText,
      // A perspective's findings are read by the JUDGE, never by this tool —
      // so the tool is owed nothing here and must not record an expectation it
      // will never satisfy. The bound path is still minted and declared below.
      expected: false,
    })),
    {
      // The judge PRODUCES the conceptual submission, so it is that lane — a
      // separate judge lane id would mint a bound path nothing reads.
      id: GATE_LANES.design_review_conceptual,
      label: "Conceptual review judge (independent merge)",
      promptFilename: "design-review-conceptual-judge-prompt.md",
      promptText: judgePromptText,
    },
  ];
  await closePriorRound(roundToken);
  const fanout = await materializeFanoutLanes({
    artifactsDir,
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

  // Resume (COR-4c8bd93a) narrows the INSTRUCTION surface only. writePaths/
  // readPaths/artifactPaths below stay the full, stable perspective set —
  // round identity (conceptual-perspective-round-identity.test.ts) pins a
  // re-emission of the SAME round to re-declare identical bound paths
  // regardless of partial delivery, so they are a stable per-round access
  // declaration, not a must-write list. What resume changes is which lanes
  // the narrative tells the host to actually run: a delivered lane is never
  // re-instructed and its landed submission is never clobbered, because the
  // host is simply never told to write there again.
  const pendingLaneIds = new Set(fanout.pendingLanes.map((lane) => lane.id));
  const pendingPerspectives = perspectivePrompts
    .map((f, i) => ({ ordinal: i + 1, f }))
    .filter(({ f }) => pendingLaneIds.has(f.lane));
  const pendingCount = pendingPerspectives.length;
  const deliveredCount = perspectivePrompts.length - pendingCount;

  const perspectiveLines = pendingPerspectives.map(
    ({ ordinal, f }) =>
      `   - Perspective ${ordinal} (${f.name}): prompt \`${f.promptPath}\` → findings \`${f.resultsPath}\``,
  );

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
    conceptualResultsPath,
    instructionLines: [
      ...(settings.reuse_notice ? [settings.reuse_notice] : []),
      `**Conceptual review** (generative, deep — ${total}-perspective fan-out):`,
      // A resumed round with some (but not all) perspectives already delivered
      // renders this notice so the host sees, in prose, exactly which lanes are
      // being skipped and why — the mechanical guarantee is the narrowed
      // perspectiveLines/step-1 list below; this line is purely informational,
      // the same "state what changed, never rely on the host noticing" pattern
      // `reuse_notice` above uses for checkpoint reuse.
      ...(deliveredCount > 0
        ? [
            `_${deliveredCount} of ${total} perspective lane(s) already delivered a submission this round — reusing that output, not re-executing them._`,
          ]
        : []),
      ...(pendingCount > 0
        ? [
            `1. Execute ${pendingCount === total ? `these ${total}` : `these ${pendingCount} still-pending`} independent perspective lane(s) — one subagent per lane **in parallel** if a subagent facility exists, else sequentially yourself. Each lane reviews only through its own value system and must NOT see the others' output:`,
            ...perspectiveLines,
          ]
        : [
            `1. All ${total} perspective lanes have already delivered a submission this round — nothing to execute here.`,
          ]),
      `2. When all ${total} perspectives have written their findings, execute ONE **independent judge** lane — a fresh subagent that is not any of the perspectives when a facility exists; with no facility, execute it yourself as the explicitly-degraded fallback, setting the perspectives' reasoning aside and merging only their written findings: read the prompt at \`${judgePromptPath}\`, write the merged findings to \`${conceptualResultsPath}\`.`,
      "Each prompt file above is self-contained — it already defines the reviewer's persona, scope, file grants, and output schema. Pass the `prompt_path` to the executor as its instruction verbatim; do NOT restate the persona or re-describe the task in your dispatch message (the parenthesised name is only a label for you).",
    ],
    artifactPaths,
    // Perspective result files must be in readPaths: the judge subagent reads
    // them to merge and synthesise the final output (COR-60ca1f72).
    readPaths: [
      ...perspectivePrompts.map((f) => f.promptPath),
      ...perspectivePrompts.map((f) => f.resultsPath),
      judgePromptPath,
    ],
    writePaths: [
      ...perspectivePrompts.map((f) => f.resultsPath),
      conceptualResultsPath,
    ],
    shortfall: fanout.shortfall,
  };
}
