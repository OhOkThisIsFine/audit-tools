import { readFile } from "node:fs/promises";
import { StateStore } from "../state/store.js";
import type { RemediationState } from "../state/store.js";
import { writeJsonFile } from "@audit-tools/shared";
import { runPlanPhase, isAuditFindingsReport } from "../phases/plan.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import {
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  buildStructuredAuditSourceManifest,
  intakePaths,
  isIntakeReady,
  readIntakeArtifacts,
  resolveManifestSources,
  sourceManifestsEquivalent,
  type IntakeSource,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../intake.js";

export type IntakeResult =
  | { kind: "step"; step: RemediationStep }
  | { kind: "state"; state: RemediationState };

export async function resolveIntakeStep(params: {
  root: string;
  artifactsDir: string;
  input?: string | string[];
  inputResolution: InputResolution;
  store: StateStore;
  loaderCommand: (cmd: string) => string;
  randomRunId: (prefix?: string) => string;
  collectStartingPointPrompt: (
    root: string,
    checked: string[],
    missing: string[],
    paths: ReturnType<typeof intakePaths>,
  ) => string;
  synthesizeIntakePrompt: (
    sourceManifestPath: string,
    resolvedSources: IntakeSource[],
    paths: ReturnType<typeof intakePaths>,
    hasClarificationResolution: boolean,
  ) => string;
  collectIntakeClarificationsPrompt: (
    summary: IntakeSummary,
    paths: ReturnType<typeof intakePaths>,
  ) => string;
  extractFindingsPrompt: (
    paths: ReturnType<typeof intakePaths>,
    resolvedSources: IntakeSource[],
  ) => string;
}): Promise<IntakeResult> {
  const { root, artifactsDir, inputResolution, store } = params;
  const paths = intakePaths(artifactsDir);
  let intake = await readIntakeArtifacts(artifactsDir);
  const previousManifest = intake.manifest;
  let manifest: IntakeSourceManifest | undefined = intake.manifest;
  let manifestRefreshed = false;

  if (!inputResolution.supplied && manifest && inputResolution.existing.length > 0) {
    // Re-derive the manifest from the current default candidates so on-disk
    // changes are picked up. Whether this actually invalidates downstream intake
    // artifacts is decided below by comparing against the persisted manifest —
    // an unchanged candidate set must NOT discard a ready summary/brief.
    manifest = undefined;
  }

  if (inputResolution.supplied && inputResolution.missing.length > 0) {
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "collect_starting_point",
        status: "blocked",
        runId: params.randomRunId("INPUT"),
        repoRoot: root,
        artifactsDir,
        prompt: params.collectStartingPointPrompt(
          root,
          inputResolution.checked,
          inputResolution.missing,
          paths,
        ),
        allowedCommands: [params.loaderCommand("next-step"), params.loaderCommand("next-step --input <path>")],
        stopCondition:
          "Stop after collecting a valid remediation starting point and rerunning next-step.",
        artifactPaths: {
          source_manifest: paths.sourceManifest,
          conversation_start: paths.conversationStart,
        },
      }),
    };
  }

  if (
    inputResolution.existing.length > 0 &&
    (inputResolution.supplied || !manifest)
  ) {
    const singleInput = inputResolution.existing[0];
    let nextManifest: IntakeSourceManifest | undefined;
    const shouldTryAuditFastPath =
      inputResolution.existing.length === 1 &&
      singleInput.toLowerCase().endsWith(".json") &&
      !intake.conversationStart;

    if (shouldTryAuditFastPath) {
      const content = await readFile(singleInput, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = undefined;
      }
      if (isAuditFindingsReport(parsed)) {
        nextManifest = buildStructuredAuditSourceManifest(
          singleInput,
          inputResolution.supplied ? "input" : "default_candidates",
        );
      }
    }

    if (!nextManifest) {
      nextManifest = buildDocumentSourceManifest(
        inputResolution.existing,
        inputResolution.supplied ? "input" : "default_candidates",
      );
    }

    manifest = nextManifest;
    await writeJsonFile(paths.sourceManifest, manifest);
    if (!sourceManifestsEquivalent(previousManifest, manifest)) {
      manifestRefreshed = true;
    }
  }

  if (!manifest && intake.conversationStart) {
    manifest = buildConversationSourceManifest(paths.conversationStart);
    await writeJsonFile(paths.sourceManifest, manifest);
    if (!sourceManifestsEquivalent(previousManifest, manifest)) {
      manifestRefreshed = true;
    }
  }

  if (!manifest) {
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "collect_starting_point",
        status: "blocked",
        runId: params.randomRunId("INPUT"),
        repoRoot: root,
        artifactsDir,
        prompt: params.collectStartingPointPrompt(root, inputResolution.checked, [], paths),
        allowedCommands: [params.loaderCommand("next-step"), params.loaderCommand("next-step --input <path>")],
        stopCondition:
          "Stop after collecting a remediation starting point and rerunning next-step.",
        artifactPaths: {
          source_manifest: paths.sourceManifest,
          conversation_start: paths.conversationStart,
        },
      }),
    };
  }

  const sourceResolution = resolveManifestSources(root, manifest);
  if (sourceResolution.missing.length > 0) {
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "collect_starting_point",
        status: "blocked",
        runId: params.randomRunId("INPUT"),
        repoRoot: root,
        artifactsDir,
        prompt: params.collectStartingPointPrompt(
          root,
          inputResolution.checked,
          sourceResolution.missing.map((source) => source.path),
          paths,
        ),
        allowedCommands: [params.loaderCommand("next-step"), params.loaderCommand("next-step --input <path>")],
        stopCondition:
          "Stop after collecting valid remediation source paths and rerunning next-step.",
        artifactPaths: {
          source_manifest: paths.sourceManifest,
          conversation_start: paths.conversationStart,
        },
      }),
    };
  }

  if (manifestRefreshed) {
    intake = { manifest };
  }

  const summary = manifestRefreshed ? undefined : intake.summary;
  const brief = manifestRefreshed ? undefined : intake.brief;
  const clarificationResolution = manifestRefreshed
    ? undefined
    : intake.clarificationResolution;

  if (
    !summary ||
    !brief ||
    (!isIntakeReady(summary) && Boolean(clarificationResolution))
  ) {
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "synthesize_intake",
        status: "ready",
        runId: params.randomRunId("INTAKE"),
        repoRoot: root,
        artifactsDir,
        prompt: params.synthesizeIntakePrompt(
          paths.sourceManifest,
          sourceResolution.resolved,
          paths,
          Boolean(clarificationResolution),
        ),
        allowedCommands: [params.loaderCommand("next-step")],
        stopCondition:
          "Stop after writing the intake summary and remediation brief, then rerunning next-step.",
        artifactPaths: {
          source_manifest: paths.sourceManifest,
          intake_summary: paths.summary,
          remediation_brief: paths.brief,
          intake_clarifications: paths.clarificationResolution,
        },
      }),
    };
  }

  if (!isIntakeReady(summary)) {
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "collect_intake_clarifications",
        status: "blocked",
        runId: params.randomRunId("INTAKE"),
        repoRoot: root,
        artifactsDir,
        prompt: params.collectIntakeClarificationsPrompt(summary, paths),
        allowedCommands: [params.loaderCommand("next-step")],
        stopCondition:
          "Stop after asking the user for intake clarification answers.",
        artifactPaths: {
          intake_summary: paths.summary,
          intake_clarifications: paths.clarificationResolution,
          remediation_brief: paths.brief,
        },
      }),
    };
  }

  const structuredAuditSource = sourceResolution.resolved.find(
    (source) => source.type === "structured_audit",
  );
  if (structuredAuditSource) {
    const state = await runPlanPhase(
      { status: "pending" },
      { root, artifactsDir, input: structuredAuditSource.path },
    );
    await store.saveState(state);
    return { kind: "state", state };
  }

  return {
    kind: "step",
    step: await writeCurrentStep({
      stepKind: "extract_findings",
      status: "ready",
      runId: params.randomRunId("EXTRACT"),
      repoRoot: root,
      artifactsDir,
      prompt: params.extractFindingsPrompt(paths, sourceResolution.resolved),
      allowedCommands: [params.loaderCommand("next-step")],
      stopCondition:
        "Stop after writing extracted-plan.json and rerunning next-step.",
      artifactPaths: {
        source_manifest: paths.sourceManifest,
        remediation_brief: paths.brief,
        extracted_plan: paths.extractedPlan,
      },
    }),
  };
}

export interface InputResolution {
  supplied: boolean;
  existing: string[];
  missing: string[];
  checked: string[];
}
