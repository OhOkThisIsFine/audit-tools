// sites-pinned: tests/audit/conceptual-charter-context.test.ts
import {
  type DesignReviewBinding,
  type IntentCheckpoint,
  type LaneReviewRecord,
  SHARED_SEMANTIC_DEMAND_FLOORS,
  charterReviewDisposition,
  readTrailingSubmissionRefusals,
  resolveDesignReviewBinding,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { resolveIntentLensSelection } from "../orchestrator/lensSelection.js";
import {
  type DesignReviewOptions,
  type ConceptualPerspective,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  resolvePerspectiveSet,
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
  laneSubmissionId,
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";

export interface ConceptualReviewSettings {
  max_units?: number;
  conceptual_depth: "shallow" | "deep";
  /**
   * The confirmed perspective SELECTION, exactly as the checkpoint records it:
   * a legacy integer count, or an explicit list of perspective names (built-in
   * names, `custom_perspectives` names, or a mix). An explicit list is honored
   * verbatim at dispatch — never widened with injected defaults — and it is
   * carried here even when the depth is shallow so the choice survives the
   * shallow default and resumed runs instead of disappearing into it.
   */
  perspectives?: number | string[];
  /**
   * Caller-authored perspective definitions the `perspectives` list may
   * reference. Carried alongside the selection for the same survival reason.
   */
  custom_perspectives?: ConceptualPerspective[];
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
 * Resolve conceptual-review depth and perspective selection from confirmed
 * intent. A named list implies deep review when depth is omitted; otherwise
 * the existing shallow default applies. An explicit depth always wins.
 *
 * THROWS when the bound block carries a perspective selection nothing can
 * honor (unknown names, duplicates, custom-name collisions — see
 * `resolvePerspectiveSet`). The checkpoint passed shape validation, so the
 * defect is semantic: the run halts naming the value rather than fanning out
 * a quieter substitute set. Validation runs at EVERY depth — including
 * shallow, where the selection is otherwise unused — so an invalid choice is
 * caught at confirmation time instead of surfacing only when a later deep
 * pass finally reads it.
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
  // A low-confidence charter downgrades the dependent review to flag-for-human
  // (charterReviewDisposition). Charters live on the REGISTER — the checkpoint
  // carries only the ceiling as input (its never-written charter embed was
  // deleted 2026-08-06, design resolution 4).
  const flagForHuman = (bundle.charter_register?.lanes ?? []).some((lane) =>
    lane.nodes.some((node) => charterReviewDisposition(node) === "flag_for_human"),
  );
  const conceptualDepth =
    checkpoint?.conceptual_depth ??
    (Array.isArray(checkpoint?.perspectives) ? "deep" : "shallow");
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
  // Fail fast on a selection nothing can honor — see the doc comment above.
  // The resolved list itself is recomputed at dispatch; what matters here is
  // that an invalid explicit choice throws at confirmation time.
  if (checkpoint?.perspectives !== undefined || checkpoint?.custom_perspectives !== undefined) {
    resolvePerspectiveSet(
      checkpoint?.perspectives,
      checkpoint?.custom_perspectives,
    );
  }
  return {
    conceptual_depth: conceptualDepth,
    perspectives: checkpoint?.perspectives,
    ...(checkpoint?.custom_perspectives
      ? { custom_perspectives: [...checkpoint.custom_perspectives] }
      : {}),
    ...(flagForHuman ? { flag_for_human: true } : {}),
    ...(reuseNotice ? { reuse_notice: reuseNotice } : {}),
    ...(ignoredReviewNotice ? { ignored_review_notice: ignoredReviewNotice } : {}),
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
  /** Prompt files the host's workers read. */
  readPaths: string[];
  /** Result files the host's workers write. */
  writePaths: string[];
  /** What a previous emission of this pass's lanes is still owed. */
  shortfall: LaneSubmissionShortfall;
  /** Declared review modes for bound transport metadata. */
  laneReviews: LaneReviewRecord[];
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
  /** Repair feedback is prompt context, never part of the review round identity. */
  rejectionNotice?: string;
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

  const unitFiles = new Set(
    (bundle.unit_manifest?.units ?? []).flatMap((u) => u.files),
  );
  const fileCount = unitFiles.size > 0
    ? unitFiles.size
    : (bundle.unit_manifest?.units?.length ?? 1);
  const manifestBytes = bundle.unit_manifest
    ? Buffer.byteLength(JSON.stringify(bundle.unit_manifest), "utf8")
    : 0;

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
          fileCount,
          riskScore: SHARED_SEMANTIC_DEMAND_FLOORS.riskScore,
          complexityFloor: SHARED_SEMANTIC_DEMAND_FLOORS.complexity,
          riskFloor: SHARED_SEMANTIC_DEMAND_FLOORS.risk,
          grantedContentBytes: manifestBytes > 0 ? manifestBytes : undefined,
          // A bounded semantic review over work the host authored — an
          // independent context is preferred, but a degraded inline fallback
          // that records itself is an explicitly accepted path (unlike the
          // contract pass, which must never self-review).
          reviewMode: "degraded_permitted",
          reviewReason:
            "conceptual review of planning artifacts the host authored — independent context preferred, self-recorded degraded fallback accepted",
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
        ...(settings.ignored_review_notice ? [settings.ignored_review_notice] : []),
        ...(settings.reuse_notice ? [settings.reuse_notice] : []),
        "**Conceptual review** (generative): execute the prompt at the conceptual prompt path in an independent context (or inline as degraded fallback) and write findings to the conceptual results path.",
      ],
      artifactPaths: {
        conceptual_prompt: conceptualPromptPath,
        conceptual_results: conceptualResultsPath,
      },
      readPaths: [conceptualPromptPath],
      writePaths: [conceptualResultsPath],
      shortfall: fanout.shortfall,
      laneReviews: fanout.laneReviews,
    };
  }

  // Deep: real fan-out — N perspective lanes + an independent judge.
  // Every one of them is a LANE through the same materializer the rest of the
  // audit uses; this pass used to mint its own filenames, which is precisely how
  // a second naming convention (and a second way for a host to mistype one)
  // came to exist.
  //
  // The reviewer set is the operator's EXPLICIT list when one was confirmed —
  // exactly those reviewers, no injected defaults — and the legacy count draw
  // otherwise. Both arrive through the one production reader
  // (`resolvePerspectiveSet`), so the dispatch cannot honor a selection the
  // settings resolver refused.
  const perspectives = resolvePerspectiveSet(
    settings.perspectives,
    settings.custom_perspectives,
  );
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

  const perspectiveRefusals = await readTrailingSubmissionRefusals(
    artifactsDir,
    perspectiveFiles.map((f) => laneSubmissionId(f.lane)),
    { runId: AUDIT_GATE_SUBMISSION_SCOPE },
  );

  const laneSpecs: FanoutLaneSpec[] = [
    ...perspectiveFiles.map((f) => ({
      id: f.lane,
      label: `Conceptual perspective — ${f.name}`,
      promptFilename: f.promptFilename,
      promptText: f.promptText + (perspectiveRefusals.has(laneSubmissionId(f.lane))
        ? `\n\n## Previous submission rejected\n\n${perspectiveRefusals.get(laneSubmissionId(f.lane))!.message}`
        : ""),
      // A perspective's findings are read by the JUDGE, never by this tool —
      // so the tool is owed nothing here and must not record an expectation it
      // will never satisfy. The bound path is still minted and declared below.
      expected: false,
      fileCount,
      riskScore: SHARED_SEMANTIC_DEMAND_FLOORS.riskScore,
      complexityFloor: SHARED_SEMANTIC_DEMAND_FLOORS.complexity,
      riskFloor: SHARED_SEMANTIC_DEMAND_FLOORS.risk,
      grantedContentBytes: manifestBytes > 0 ? manifestBytes : undefined,
      // Each perspective reviews only through its own value system and must NOT
      // see the others' output — its independence is the whole point of a
      // multi-perspective fan-out, so it requires a context that shares no
      // authorship with the other perspectives.
      reviewMode: "independence_required" as const,
      reviewReason:
        "blind perspective lane — must not share authorship with or see the output of the other perspectives",
    })),
    {
      // The judge PRODUCES the conceptual submission, so it is that lane — a
      // separate judge lane id would mint a bound path nothing reads.
      id: GATE_LANES.design_review_conceptual,
      label: "Conceptual review judge (independent merge)",
      promptFilename: "design-review-conceptual-judge-prompt.md",
      promptText: judgePromptText,
      fileCount: Math.max(1, perspectiveFiles.length),
      riskScore: SHARED_SEMANTIC_DEMAND_FLOORS.riskScore,
      complexityFloor: SHARED_SEMANTIC_DEMAND_FLOORS.complexity,
      riskFloor: SHARED_SEMANTIC_DEMAND_FLOORS.risk,
      // The judge merges perspectives it did not author; the instruction lets it
      // run inline only as an EXPLICITLY-degraded fallback that sets the
      // perspectives' reasoning aside and merges their written findings — so a
      // degraded fallback is permitted, but must record its degradation.
      reviewMode: "degraded_permitted" as const,
      reviewReason:
        "judge is independent of the perspectives it merges — inline merging is the explicitly-degraded fallback, not the self-review of authored findings",
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
    ({ ordinal, f }) => {
      const lane = fanout.lanes.find((l) => l.id === f.lane);
      const demandTag = lane?.demand
        ? ` [demand: size=${lane.demand.size}, complexity=${lane.demand.complexity}, risk=${lane.demand.risk}]`
        : "";
      return `   - Perspective ${ordinal} (${f.name}): prompt \`${f.promptPath}\` → findings \`${f.resultsPath}\`${demandTag}`;
    },
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
      ...(settings.ignored_review_notice ? [settings.ignored_review_notice] : []),
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
            `1. Execute ${pendingCount === total ? `these ${total}` : `these ${pendingCount} still-pending`} independent perspective lane(s) — in an independent context per lane (**in parallel** if concurrent execution is supported, else sequentially). Each lane reviews only through its own value system and must NOT see the others' output. If independent contexts are unavailable, pause and report that independent perspective review could not be performed; do not self-conduct or advance:`,
            ...perspectiveLines,
          ]
        : [
            `1. All ${total} perspective lanes have already delivered a submission this round — nothing to execute here.`,
          ]),
      `2. When all ${total} perspectives have written their findings, execute ONE **independent judge** lane — an independent context that did not author any of the perspectives; if no independent context is available, execute it yourself as the explicitly-degraded fallback, setting the perspectives' reasoning aside and merging only their written findings: read the prompt at \`${judgePromptPath}\`, write the merged findings to \`${conceptualResultsPath}\`.`,
      "Each prompt file above is self-contained — it already defines the reviewer's persona, scope, file grants, and output schema. Pass the `prompt_path` to the executor as its instruction verbatim; do NOT restate the persona or re-describe the task in your dispatch message (the parenthesised name is only a label for you).",
    ],
    artifactPaths,
    // Perspective result files must be in readPaths: the judge reads
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
    laneReviews: fanout.laneReviews,
  };
}
