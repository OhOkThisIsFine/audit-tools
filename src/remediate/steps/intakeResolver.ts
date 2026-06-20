import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import { isAuditFindingsReport } from "../phases/plan.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import {
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  buildStructuredAuditSourceManifest,
  intakePaths,
  intakeSummaryContentErrors,
  isIntakeReady,
  blockingIntakeQuestions,
  readIntakeArtifacts,
  resolveManifestSources,
  sourceManifestsEquivalent,
  validateClarificationResolution,
  type IntakeSource,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../intake.js";

const KNOWN_SCHEMA_VERSIONS = new Set([
  "audit-findings/v1alpha1",
  "remediate-code-intake-source-manifest/v1alpha1",
  "remediate-code-intake-summary/v1alpha1",
  "remediate-code-intake-clarifications/v1alpha1",
]);

export function validateSuppliedInput(
  _path: string,
  content: string,
): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: "file is not valid JSON" };
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "schema_version" in parsed
  ) {
    const sv = (parsed as Record<string, unknown>).schema_version;
    if (typeof sv === "string" && !KNOWN_SCHEMA_VERSIONS.has(sv)) {
      return { ok: false, reason: `unrecognised schema_version: ${sv}` };
    }
  }
  return { ok: true };
}

export type IntakeResult =
  | { kind: "step"; step: RemediationStep }
  | { kind: "pipeline_ready" };

export async function resolveIntakeStep(params: {
  root: string;
  artifactsDir: string;
  input?: string | string[];
  inputResolution: InputResolution;
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
    intentCheckpointPath?: string,
  ) => string;
  collectIntakeClarificationsPrompt: (
    summary: IntakeSummary,
    paths: ReturnType<typeof intakePaths>,
  ) => string;
}): Promise<IntakeResult> {
  const { root, artifactsDir, inputResolution } = params;
  const paths = intakePaths(artifactsDir);

  // MNT-e6c289ae: every "collect_starting_point" branch emits the identical
  // blocked step (same stepKind/allowedCommands/artifactPaths and prompt source),
  // differing only by the missing-paths prompt argument and the stop condition.
  // Funnel them through one builder so the step shape stays consistent.
  const collectStartingPointStep = async (
    missingPaths: string[],
    stopCondition: string,
  ): Promise<IntakeResult> => ({
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
        missingPaths,
        paths,
      ),
      allowedCommands: [
        params.loaderCommand("next-step"),
        params.loaderCommand("next-step --input <path>"),
      ],
      stopCondition,
      artifactPaths: {
        source_manifest: paths.sourceManifest,
        conversation_start: paths.conversationStart,
      },
    }),
  });

  let intake = await readIntakeArtifacts(artifactsDir);
  const previousManifest = intake.manifest;
  let manifest: IntakeSourceManifest | undefined = intake.manifest;
  let manifestRefreshed = false;

  if (
    !inputResolution.supplied &&
    manifest &&
    manifest.created_from !== "input" &&
    inputResolution.existing.length > 0
  ) {
    // Re-derive the manifest from the current default candidates so on-disk
    // changes are picked up. Whether this actually invalidates downstream intake
    // artifacts is decided below by comparing against the persisted manifest —
    // an unchanged candidate set must NOT discard a ready summary/brief.
    //
    // BUT never clobber an `input`-bound manifest: the loader re-passes `--input`
    // on every next-step, yet a bare next-step (no flag) must NOT silently swap the
    // user's explicit input for a default candidate (a stale `audit-findings.json`
    // in `.audit-tools/` would otherwise hijack the run). An input-bound run's
    // source set is fixed by the user, so it is preserved across bare calls.
    manifest = undefined;
  }

  // Auto-discovered input confirmation gate: when a candidate was found via
  // default discovery (no --input supplied) and no manifest has ever been
  // written for this run (previousManifest is undefined), present the file to
  // the user before writing source-manifest.json. Only after the user confirms
  // (via confirm_auto_discovered_input_ack.json) does the run proceed to write
  // the manifest and continue. Re-derivation (previousManifest set but cleared
  // above) does NOT re-trigger the gate — the user already confirmed that input.
  if (
    !inputResolution.supplied &&
    inputResolution.existing.length > 0 &&
    !manifest &&
    !previousManifest
  ) {
    const ackPath = join(artifactsDir, "confirm_auto_discovered_input_ack.json");
    const ack = await readOptionalJsonFile<{ status?: string }>(ackPath);
    if (!ack || ack.status !== "confirmed") {
      const candidatePath = inputResolution.existing[0];
      // Determine source type label for the prompt
      let sourceTypeLabel = "document";
      let findingCount: number | undefined;
      let mtimeStr: string | undefined;
      try {
        const fileStat = await stat(candidatePath);
        mtimeStr = fileStat.mtime.toISOString();
      } catch { /* best-effort */ }
      if (candidatePath.toLowerCase().endsWith(".json")) {
        try {
          const content = await readFile(candidatePath, "utf8");
          const parsed = JSON.parse(content);
          if (isAuditFindingsReport(parsed)) {
            sourceTypeLabel = "structured_audit";
            const asRecord = parsed as unknown as Record<string, unknown>;
            if (Array.isArray(asRecord.findings)) {
              findingCount = (asRecord.findings as unknown[]).length;
            }
          }
        } catch { /* best-effort */ }
      }
      const detailLines = [
        `- **Path**: \`${candidatePath}\``,
        `- **Type**: ${sourceTypeLabel}`,
        mtimeStr ? `- **Last modified**: ${mtimeStr}` : undefined,
        findingCount !== undefined ? `- **Findings**: ${findingCount}` : undefined,
      ].filter((line): line is string => Boolean(line));

      return {
        kind: "step",
        step: await writeCurrentStep({
          stepKind: "confirm_auto_discovered_input",
          status: "blocked",
          runId: params.randomRunId("INPUT"),
          repoRoot: root,
          artifactsDir,
          prompt: [
            "# Confirm Auto-Discovered Input",
            "",
            "A remediation input was automatically discovered. Please confirm whether to use it.",
            "",
            ...detailLines,
            "",
            `If you want to use this file, write the following to \`${ackPath}\`:`,
            "",
            "```json",
            '{ "status": "confirmed" }',
            "```",
            "",
            `If you want to use a different file, write \`{ "status": "declined" }\` to \`${ackPath}\` and re-run with \`--input <path>\`.`,
            "",
            `Then run: \`${params.loaderCommand("next-step")}\``,
          ].join("\n"),
          allowedCommands: [
            params.loaderCommand("next-step"),
            params.loaderCommand("next-step --input <path>"),
          ],
          stopCondition:
            "Stop after presenting the discovered file to the user and writing the ack.",
          artifactPaths: {
            confirm_auto_discovered_input_ack: ackPath,
          },
        }),
      };
    }
  }

  if (inputResolution.supplied && inputResolution.missing.length > 0) {
    return collectStartingPointStep(
      inputResolution.missing,
      "Stop after collecting a valid remediation starting point and rerunning next-step.",
    );
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
      if (inputResolution.supplied) {
        const validation = validateSuppliedInput(singleInput, content);
        if (!validation.ok) {
          return collectStartingPointStep(
            [singleInput],
            `Stop after providing a valid remediation starting point. Error: ${validation.reason}`,
          );
        }
      }
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
    return collectStartingPointStep(
      [],
      "Stop after collecting a remediation starting point and rerunning next-step.",
    );
  }

  const sourceResolution = resolveManifestSources(root, manifest);
  if (sourceResolution.missing.length > 0) {
    return collectStartingPointStep(
      sourceResolution.missing.map((source) => source.path),
      "Stop after collecting valid remediation source paths and rerunning next-step.",
    );
  }

  if (manifestRefreshed) {
    intake = { manifest };
  }

  const summary = manifestRefreshed ? undefined : intake.summary;
  const brief = manifestRefreshed ? undefined : intake.brief;
  const rawClarificationResolution = manifestRefreshed
    ? undefined
    : intake.clarificationResolution;

  // Validate clarification resolution before forwarding it to synthesize_intake.
  // A malformed or empty resolution file must not silently corrupt the synthesis
  // pass — re-emit collect_intake_clarifications with the validation errors so the
  // host can supply a corrected resolution.
  let clarificationResolution: unknown = rawClarificationResolution;
  if (rawClarificationResolution !== undefined && summary && !isIntakeReady(summary)) {
    const blocking = blockingIntakeQuestions(summary);
    const validation = validateClarificationResolution(rawClarificationResolution, blocking);
    if (!validation.valid) {
      const errorDetail = validation.errors.map((e) => `- ${e}`).join("\n");
      return {
        kind: "step",
        step: await writeCurrentStep({
          stepKind: "collect_intake_clarifications",
          status: "blocked",
          runId: params.randomRunId("INTAKE"),
          repoRoot: root,
          artifactsDir,
          prompt: `${params.collectIntakeClarificationsPrompt(summary, paths)}\n\n**Validation errors in the previous clarification file:**\n${errorDetail}\n\nPlease rewrite the file at \`${paths.clarificationResolution}\` with a valid answers array before rerunning next-step.`,
          allowedCommands: [params.loaderCommand("next-step")],
          stopCondition:
            "Stop after asking the user to correct the clarification answers.",
          artifactPaths: {
            intake_summary: paths.summary,
            intake_clarifications: paths.clarificationResolution,
            remediation_brief: paths.brief,
          },
        }),
      };
    }
  }

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
    // If the summary claims ready:true but has empty required fields, re-issue
    // synthesize_intake so the agent rewrites the summary with proper content.
    if (summary.ready && intakeSummaryContentErrors(summary).length > 0) {
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
            "Stop after rewriting the intake summary with non-empty goals and affected_files, then rerunning next-step.",
          artifactPaths: {
            source_manifest: paths.sourceManifest,
            intake_summary: paths.summary,
            remediation_brief: paths.brief,
            intake_clarifications: paths.clarificationResolution,
          },
        }),
      };
    }

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

  // Intake is ready. Both structured_audit and document/conversation sources
  // enter the contract pipeline. Signal the caller to route to the pipeline.
  return { kind: "pipeline_ready" };
}

export interface InputResolution {
  supplied: boolean;
  existing: string[];
  missing: string[];
  checked: string[];
}
