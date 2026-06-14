import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DispatchModelHint,
  DispatchModelTier,
  SessionConfig,
} from "@audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import {
  type DesignReviewOptions,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  selectPerspectives,
} from "../orchestrator/designReviewPrompt.js";

export interface ConceptualReviewSettings {
  max_units?: number;
  conceptual_depth: "shallow" | "deep";
  perspectives?: number;
  /**
   * Relative rank for perspective subagents (divergent ideation). Defaults to
   * `"standard"`; the judge always routes `"deep"`.
   */
  perspective_tier?: DispatchModelTier;
}

/**
 * Resolve the conceptual-review depth + fan-out count just before dispatch.
 * The user-confirmed `intent_checkpoint.design_review` is the source of truth;
 * `sessionConfig.design_review` is the host/session override consulted when the
 * checkpoint is silent; absent both, the default is shallow.
 */
export function resolveConceptualReviewSettings(
  bundle: ArtifactBundle,
  sessionConfig: SessionConfig,
): ConceptualReviewSettings {
  const checkpoint = bundle.intent_checkpoint?.design_review;
  const cfg = sessionConfig.design_review;
  return {
    max_units: cfg?.max_units,
    conceptual_depth:
      checkpoint?.conceptual_depth ?? cfg?.conceptual_depth ?? "shallow",
    perspectives: checkpoint?.perspectives ?? cfg?.perspectives,
    perspective_tier: cfg?.perspective_tier,
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
  /**
   * Relative model ranks for the deep fan-out: perspectives route `"standard"`
   * by default (divergent ideation), the judge routes `"deep"` (it merges,
   * dedups, and ranks across every perspective output). Absent when shallow.
   */
  modelHints?: { perspectives: DispatchModelHint; judge: DispatchModelHint };
}

/**
 * Write the conceptual-review prompt artifacts and return the dispatch pieces.
 *
 * Shallow: one conceptual prompt file dispatched to a single subagent.
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
   * Render each subagent's `model_hint.tier` into the instruction lines. Only
   * set when the host reported it can act on model hints — otherwise the tiers
   * stay inert metadata on `modelHints`, mirroring the packet-dispatch path.
   */
  hostCanSelectSubagentModel?: boolean;
}): Promise<ConceptualDispatch> {
  const { artifactsDir, bundle, settings } = opts;
  const incoming = join(artifactsDir, "incoming");
  await mkdir(incoming, { recursive: true });
  const conceptualResultsPath = join(
    incoming,
    "design-review-conceptual-findings.json",
  );
  const reviewOptions: DesignReviewOptions = { max_units: settings.max_units };

  if (settings.conceptual_depth !== "deep") {
    const conceptualPromptPath = join(
      incoming,
      "design-review-conceptual-prompt.md",
    );
    await writeFile(
      conceptualPromptPath,
      renderConceptualReviewPrompt(bundle, reviewOptions),
      "utf8",
    );
    return {
      deep: false,
      conceptualResultsPath,
      instructionLines: [
        "**Conceptual review** (generative): dispatch a subagent that reads the prompt at the conceptual prompt path and writes findings to the conceptual results path.",
      ],
      artifactPaths: {
        conceptual_prompt: conceptualPromptPath,
        conceptual_results: conceptualResultsPath,
      },
      readPaths: [conceptualPromptPath],
      writePaths: [conceptualResultsPath],
    };
  }

  // Deep: real fan-out — N perspective subagents + an independent judge.
  const modelHints = {
    perspectives: {
      tier: settings.perspective_tier ?? "standard",
      reasons: ["conceptual_perspective_ideation"],
    },
    judge: {
      tier: "deep",
      reasons: ["conceptual_judge_synthesis"],
    },
  } satisfies ConceptualDispatch["modelHints"];
  const renderTier = (hint: DispatchModelHint): string =>
    opts.hostCanSelectSubagentModel ? ` [model_hint.tier: ${hint.tier}]` : "";
  const perspectives = selectPerspectives(settings.perspectives);
  const total = perspectives.length;
  const perspectiveFiles: Array<{
    name: string;
    promptPath: string;
    resultsPath: string;
  }> = [];
  for (let i = 0; i < total; i++) {
    const p = perspectives[i];
    const promptPath = join(
      incoming,
      `design-review-conceptual-p${i + 1}-prompt.md`,
    );
    const resultsPath = join(
      incoming,
      `design-review-conceptual-p${i + 1}-findings.json`,
    );
    await writeFile(
      promptPath,
      renderConceptualPerspectivePrompt(bundle, p, i, total, reviewOptions),
      "utf8",
    );
    perspectiveFiles.push({ name: p.name, promptPath, resultsPath });
  }

  const judgePromptPath = join(
    incoming,
    "design-review-conceptual-judge-prompt.md",
  );
  await writeFile(
    judgePromptPath,
    renderConceptualJudgePrompt(
      perspectiveFiles.map((f) => ({ name: f.name, path: f.resultsPath })),
    ),
    "utf8",
  );

  const perspectiveLines = perspectiveFiles.map(
    (f, i) =>
      `   - Perspective ${i + 1} (${f.name}): prompt \`${f.promptPath}\` → findings \`${f.resultsPath}\`${renderTier(modelHints.perspectives)}`,
  );

  const artifactPaths: Record<string, string> = {
    conceptual_results: conceptualResultsPath,
    conceptual_judge_prompt: judgePromptPath,
  };
  perspectiveFiles.forEach((f, i) => {
    artifactPaths[`conceptual_perspective_${i + 1}_prompt`] = f.promptPath;
    artifactPaths[`conceptual_perspective_${i + 1}_results`] = f.resultsPath;
  });

  return {
    deep: true,
    conceptualResultsPath,
    instructionLines: [
      `**Conceptual review** (generative, deep — ${total}-perspective fan-out):`,
      `1. Dispatch these ${total} independent perspective subagents **in parallel**. Each reviews only through its own value system and must NOT see the others' output:`,
      ...perspectiveLines,
      `2. When all ${total} perspectives have written their findings, dispatch ONE **independent judge** subagent — it must be a different agent than any of the perspectives: read the prompt at \`${judgePromptPath}\`, write the merged findings to \`${conceptualResultsPath}\`.${renderTier(modelHints.judge)}`,
      "Each prompt file above is self-contained — it already defines the reviewer's persona, scope, file grants, and output schema. Pass the `prompt_path` to the subagent as its instruction verbatim; do NOT restate the persona or re-describe the task in your dispatch message (the parenthesised name is only a label for you).",
      ...(opts.hostCanSelectSubagentModel
        ? [
            "Map each `model_hint.tier` (`small`, `standard`, `deep`) to an available host model without asking the user for model names.",
          ]
        : []),
    ],
    artifactPaths,
    // Perspective result files must be in readPaths: the judge subagent reads
    // them to merge and synthesise the final output (COR-60ca1f72).
    readPaths: [
      ...perspectiveFiles.map((f) => f.promptPath),
      ...perspectiveFiles.map((f) => f.resultsPath),
      judgePromptPath,
    ],
    writePaths: [
      ...perspectiveFiles.map((f) => f.resultsPath),
      conceptualResultsPath,
    ],
    modelHints,
  };
}
