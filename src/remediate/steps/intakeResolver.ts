import { requestedFindingSelection, selectAuditFindings, renderFindingSelection, type FindingSelectionOptions } from "../intakeSelection.js";

// sites-pinned: tests/remediate/intake-starting-point-contract.test.ts, tests/remediate/next-step-lifecycle.test.ts, tests/remediate/intake-resolver.test.ts, tests/remediate/n-r04-intent-checkpoint.test.ts, tests/remediate/intake-mixed-audit-provenance.test.ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashContent, isRecord, readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import { isAuditFindingsReport } from "../phases/plan.js";
import { QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { InputResolution, RemediationStep } from "./types.js";
import {
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  buildStructuredAuditSourceManifest,
  buildMixedSourceManifest,
  manifestIsInputBound,
  intakePaths,
  type IntakePaths,
  intakeSummaryContentErrors,
  isIntakeReady,
  blockingIntakeQuestions,
  readIntakeArtifacts,
  resolveManifestSources,
  sourceManifestsEquivalent,
  validateClarificationResolution,
  writeRemediationBrief,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
  type IntakeSource,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../intake.js";

const KNOWN_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
]);

export function validateSuppliedInput(
  path: string,
  content: string,
  allowDocumentFallback = false,
): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return allowDocumentFallback ? { ok: true } : { ok: false, reason: "file is not valid JSON" };
  }
  if (isRecord(parsed)) {
    const sv = parsed.schema_version;
    if (sv === "audit-findings/v1alpha1" || parsed.contract_version === "audit-tools/audit-findings/v1alpha2") {
      return { ok: false, reason: `${path} is an archived audit report. Regenerate it with ${QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION} before remediation.` };
    }
    if (parsed.contract_version === QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION) {
      const report = QuestionAuditFindingsReportSchema.safeParse(parsed);
      if (!report.success) return { ok: false, reason: `Invalid audit report: ${report.error.issues.map(issue => issue.message).join("; ")}` };
      return { ok: true };
    }
    if (typeof parsed.contract_version === "string" && parsed.contract_version.startsWith("audit-tools/audit-findings/")) {
      return { ok: false, reason: `Unsupported audit report version: ${parsed.contract_version}.` };
    }
    if (!allowDocumentFallback && typeof sv === "string" && !KNOWN_SCHEMA_VERSIONS.has(sv)) {
      return { ok: false, reason: `unrecognised schema_version: ${sv}` };
    }
  }
  return { ok: true };
}

export type IntakeResult =
  | { kind: "step"; step: RemediationStep }
  | { kind: "pipeline_ready" };

type IntakeStepParams = {
  root: string;
  artifactsDir: string;
  findingSelection?: FindingSelectionOptions;
  inputResolution: InputResolution;
  loaderCommand: (cmd: string) => string;
  randomRunId: (prefix?: string) => string;
  collectStartingPointPrompt: (
    root: string,
    checked: string[],
    missing: string[],
    paths: IntakePaths,
  ) => string;
  synthesizeIntakePrompt: (
    resolvedSources: IntakeSource[],
    paths: IntakePaths,
    hasClarificationResolution: boolean,
  ) => string;
  collectIntakeClarificationsPrompt: (
    summary: IntakeSummary,
    paths: IntakePaths,
  ) => string;
};

type IntakePause = Extract<IntakeResult, { kind: "step" }>;
type CollectStartingPointStep = (missing: string[], stopCondition: string) => Promise<IntakePause>;

export async function resolveIntakeStep(params: IntakeStepParams): Promise<IntakeResult> {
  const { root, artifactsDir, inputResolution } = params;
  const paths = intakePaths(artifactsDir);
  const requestedSelection = requestedFindingSelection(params.findingSelection ?? {});

  // MNT-e6c289ae: every "collect_starting_point" branch emits the identical
  // blocked step (same stepKind/allowedCommands/artifactPaths and prompt source),
  // differing only by the missing-paths prompt argument and the stop condition.
  // Funnel them through one builder so the step shape stays consistent.
  const collectStartingPointStep: CollectStartingPointStep = async (missingPaths, stopCondition) => ({
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
        params.loaderCommand("next-step --input <path>"),
        params.loaderCommand("next-step --guidance-file <path>"),
        params.loaderCommand("next-step --input <path> --guidance-file <path>"),
      ],
      stopCondition,
      artifactPaths: {
        conversation_start: paths.conversationStart,
      },
    }),
  });

  let intake = await readIntakeArtifacts(artifactsDir);
  const previousManifest = intake.manifest;
  const source = await selectIntakeSource(params, paths, previousManifest, intake.conversationStart,
    requestedSelection, collectStartingPointStep);
  if (source.kind === "step") return source;
  const { manifest } = source;
  const manifestRefreshed = !sourceManifestsEquivalent(previousManifest, manifest);
  if (manifest.finding_selection?.selected_count === 0) {
    return { kind: "step", step: await writeCurrentStep({
      stepKind: "zero_documentable_findings", status: "complete",
      runId: params.randomRunId("EMPTY"), repoRoot: root, artifactsDir,
      prompt: "No findings match the selected severities or finding IDs. No remediation work was started.",
      allowedCommands: [], stopCondition: "No work remains in the selected finding subset.",
      artifactPaths: { selected_audit_findings: manifest.finding_selection.projected_path },
    }) };
  }

  const sourceResolution = resolveManifestSources(root, manifest);
  if (sourceResolution.missing.length > 0) {
    return collectStartingPointStep(
      sourceResolution.missing.map((source) => source.path),
      "Stop after collecting valid remediation source paths and rerunning next-step.",
    );
  }

  if (manifestRefreshed) {
    // A refreshed manifest means the whole prior read is discarded (summary,
    // brief and resolution below), so there is no resolution left whose resolved
    // questions could matter.
    intake = { manifest, resolvedQuestions: [] };
  }

  const summary = intake.summary;
  const summaryRefusal = intake.summaryRefusal;
  const clarificationResolution = intake.clarificationResolution;

  // The brief is a render of the summary, never host-authored: refresh it
  // whenever a schema-valid summary is read, before any step can list it.
  if (summary) await writeRemediationBrief(artifactsDir, summary);

  // Validate clarification resolution before forwarding it to synthesize_intake.
  // A malformed or empty resolution file must not silently corrupt the synthesis
  // pass — re-emit collect_intake_clarifications with the validation errors so the
  // host can supply a corrected resolution.
  //
  // `summary` here is the read-time-reconciled one: the questions the resolution
  // ANSWERS are already cleared from `open_questions`, so the two validator
  // inputs are rebuilt from that reconciliation rather than from the raw file —
  // the answered ids are re-admitted to the known-id set (an answer naming its
  // own question is not a typo) and to the blocking set (the question must still
  // be shown as answered, or the "addresses no blocking question" check would
  // refuse a resolution that just resolved the last one).
  if (clarificationResolution !== undefined && summary) {
    const resolved = intake.resolvedQuestions;
    // The reconciled summary plus the questions it just cleared is the summary
    // as authored, which is what the id-join must be checked against.
    const knownQuestions = [...(summary.open_questions ?? []), ...resolved];
    const blocking = [
      ...blockingIntakeQuestions(summary),
      ...resolved.filter((question) => question.blocking === true),
    ];
    const validation = validateClarificationResolution(
      clarificationResolution,
      blocking,
      knownQuestions,
    );
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

  // One builder for every synthesize_intake emit. `reason` is set when the
  // previous summary was refused; the step then comes back with the reason
  // appended, so the host rewrites the one file it owns.
  const synthesizeIntakeStep = async (reason?: string): Promise<IntakeResult> => ({
    kind: "step",
    step: await writeCurrentStep({
      stepKind: "synthesize_intake",
      status: "ready",
      runId: params.randomRunId("INTAKE"),
      repoRoot: root,
      artifactsDir,
      prompt: `${params.synthesizeIntakePrompt(
        sourceResolution.resolved,
        paths,
        Boolean(clarificationResolution),
      )}${renderFindingSelection(manifest.finding_selection)}${reason ? `\n**Rewrite required.** ${reason}\n` : ""}`,
      allowedCommands: [params.loaderCommand("next-step")],
      stopCondition: reason
        ? "Stop after rewriting the intake summary, then rerunning next-step."
        : "Stop after writing the intake summary, then rerunning next-step.",
      artifactPaths: {
        intake_summary: paths.summary,
        intake_clarifications: paths.clarificationResolution,
      },
    }),
  });

  if (!summary) return synthesizeIntakeStep(summaryRefusal);
  if (!isIntakeReady(summary) && Boolean(clarificationResolution)) {
    return synthesizeIntakeStep();
  }

  if (!isIntakeReady(summary)) {
    // Two not-ready summaries have no question to ask, so each goes back to
    // synthesize_intake with the reason named: `ready:true` with empty required
    // fields, and `ready:false` with no blocking question. The second one used
    // to reach collect_intake_clarifications with ZERO questions — a step no
    // answer can clear, because the validator needs an answer to a blocking one.
    const contentErrors = summary.ready ? intakeSummaryContentErrors(summary) : [];
    const unaskableNotReady =
      !summary.ready && blockingIntakeQuestions(summary).length === 0;
    if (contentErrors.length > 0 || unaskableNotReady) {
      const reason = unaskableNotReady
        ? "The previous intake summary set `ready: false` but listed no blocking question " +
          "(`blocking: true`), so there is nothing to ask the user. Either set `ready` to " +
          "`true`, or add each open blocking question to `open_questions` with `blocking: true`."
        : `The previous intake summary set \`ready: true\` but ${contentErrors.join(" and ")}.`;
      return synthesizeIntakeStep(reason);
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

// Select and persist the source manifest before interpreting any saved readiness
// artifacts. A host-facing source choice can pause this phase without starting intake.
async function selectIntakeSource(
  params: IntakeStepParams,
  paths: IntakePaths,
  previousManifest: IntakeSourceManifest | undefined,
  conversationStart: string | undefined,
  requestedSelection: ReturnType<typeof requestedFindingSelection>,
  collectStartingPointStep: CollectStartingPointStep,
): Promise<IntakePause | { kind: "selected"; manifest: IntakeSourceManifest }> {
  const { root, artifactsDir, inputResolution } = params;
  let manifest: IntakeSourceManifest | undefined = previousManifest;

  if (
    !inputResolution.supplied &&
    manifest &&
    !manifestIsInputBound(manifest) &&
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

  // Discovered-sources gate: on a fresh run (no manifest ever written) with no
  // explicit source — neither `--input` (inputResolution.supplied) NOR
  // `--guidance-file` (which lands as conversationStart) — surface EVERY
  // auto-discovered candidate to the host as a context manifest before writing
  // source-manifest.json. The host decides (confirm the auto-selected best, or
  // pass `--input <path>` to pick another / a new file). Awareness never blocks
  // an explicit source: when the host supplied one, this gate is skipped entirely
  // (that is what broke the old decline→re-offer loop — a `--guidance-file` reply
  // used to re-trigger the identical single-candidate prompt). Re-derivation
  // (previousManifest set but cleared above) does NOT re-trigger it.
  if (
    !inputResolution.supplied &&
    !conversationStart &&
    inputResolution.existing.length > 0 &&
    !manifest &&
    !previousManifest
  ) {
    const ackPath = join(artifactsDir, "confirm_auto_discovered_input_ack.json");
    const ack = await readOptionalJsonFile<{ status?: string }>(ackPath);
    if (ack?.status === "declined") {
      // Host explicitly rejected the discovered defaults — do NOT silently build a
      // manifest from the very candidate they declined; ask for an explicit source
      // instead. This breaks the loop even without a `--guidance-file` reply.
      return collectStartingPointStep(
        [],
        "Stop after collecting an explicit remediation source (--input <path>) and rerunning next-step.",
      );
    }
    if (ack?.status !== "confirmed") {
      // Build one manifest row per discovered source, each with provenance the
      // host can weigh (type, mtime, finding count) — the full context set, not
      // just the single best match the pipeline would auto-select.
      const sourceRows: string[] = [];
      for (const candidatePath of inputResolution.allExisting) {
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
              findingCount = parsed.findings.length;
            }
          } catch { /* best-effort */ }
        }
        const meta = [
          `type: ${sourceTypeLabel}`,
          mtimeStr ? `modified ${mtimeStr}` : undefined,
          findingCount !== undefined ? `${findingCount} finding(s)` : undefined,
        ].filter((s): s is string => Boolean(s));
        sourceRows.push(`- \`${candidatePath}\` — ${meta.join(", ")}`);
      }
      const autoSelected = inputResolution.existing[0];

      return {
        kind: "step",
        step: await writeCurrentStep({
          stepKind: "confirm_auto_discovered_input",
          status: "blocked",
          runId: params.randomRunId("INPUT"),
          repoRoot: root,
          artifactsDir,
          prompt: [
            "# Confirm discovered remediation source(s)",
            "",
            "No `--input`/`--guidance-file` was supplied. The following remediation",
            "source(s) were auto-discovered on disk. Review them and decide with the user",
            "which to use — the tool would otherwise auto-select the highest-priority one",
            `(\`${autoSelected}\`).`,
            "",
            "**Discovered sources:**",
            ...sourceRows,
            "",
            `To proceed with the auto-selected source (\`${autoSelected}\`), write to \`${ackPath}\`:`,
            "",
            "```json",
            '{ "status": "confirmed" }',
            "```",
            "",
            "To use a DIFFERENT discovered source, or a file not listed, re-run with",
            "`--input <path>` (it takes the lossless structured fast-path for a `.json`).",
            "",
            `To reject all discovered defaults, write \`{ "status": "declined" }\` to \`${ackPath}\``,
            "and re-run with an explicit `--input <path>`.",
            "",
            `Then run: \`${params.loaderCommand("next-step")}\``,
          ].join("\n"),
          allowedCommands: [
            params.loaderCommand("next-step"),
            params.loaderCommand("next-step --input <path>"),
          ],
          stopCondition:
            "Stop after presenting the discovered sources to the user and writing the ack.",
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
    // A present conversation-start.md (a `--guidance-file` this invocation, or a
    // leftover from a prior guidance run) is an explicit source and must win over
    // any stale default candidate on disk: without this guard a leftover
    // `.audit-tools/audit-findings.json` would be registered as
    // `default_candidates` here and shadow the just-written guidance (the
    // conversation branch below is only reached when `!manifest`). An explicit
    // `--input` still takes precedence over conversation-start. Consistent with the
    // discovered-sources gate above, which likewise skips on `conversationStart`.
    (inputResolution.supplied || (!manifest && !conversationStart))
  ) {
    const singleInput = inputResolution.existing[0];
    let nextManifest: IntakeSourceManifest | undefined;
    const shouldTryAuditFastPath =
      inputResolution.existing.length === 1 &&
      singleInput.toLowerCase().endsWith(".json");

    if (inputResolution.existing.length > 1) {
      const reports: string[] = [];
      for (const path of inputResolution.existing.filter(path => path.toLowerCase().endsWith(".json"))) {
        const content = await readFile(path, "utf8");
        const validation = validateSuppliedInput(path, content, true);
        if (!validation.ok) return collectStartingPointStep([path], validation.reason);
        try {
          if (isAuditFindingsReport(JSON.parse(content))) reports.push(path);
        } catch { /* Non-audit documents retain the usual intake path. */ }
      }
      if (reports.length > 1) return collectStartingPointStep(reports, "Select one canonical audit report for remediation.");
      if (reports.length === 1) {
        const from = inputResolution.supplied ? "input" : "default_candidates";
        const audit = buildStructuredAuditSourceManifest(reports[0]!, from);
        const guidance = buildDocumentSourceManifest(inputResolution.existing.filter(path => path !== reports[0]), from);
        nextManifest = { ...audit, sources: [...audit.sources, ...guidance.sources] };
      }
    }

    if (shouldTryAuditFastPath) {
      const content = await readFile(singleInput, "utf8");
      // Recognize an explicit audit even alongside guidance, while preserving
      // mixed document intake's existing fallback for non-audit JSON content.
      {
        const allowDocumentFallback = !inputResolution.supplied || (Boolean(conversationStart) && requestedSelection === undefined && previousManifest?.finding_selection === undefined);
        const validation = validateSuppliedInput(singleInput, content, allowDocumentFallback);
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

    // If both --input and --guidance-file (conversationStart) are present,
    // merge them into a mixed manifest that includes both sources. This ensures
    // the operator's guidance is NOT evicted when they supply both inputs and guidance.
    if (inputResolution.supplied && conversationStart) {
      manifest = buildMixedSourceManifest(nextManifest, paths.conversationStart);
    } else {
      manifest = nextManifest;
    }

    // Persist after the optional selection has been validated below.
  }

  if (!manifest && conversationStart) {
    manifest = buildConversationSourceManifest(paths.conversationStart);
    // Persist after the optional selection has been validated below.
  }

  if (!manifest) {
    return collectStartingPointStep(
      [],
      "Stop after collecting a remediation starting point and rerunning next-step.",
    );
  }

  const sameSources = previousManifest?.sources.length === manifest.sources.length &&
    previousManifest.sources.every((source, index) => source.path === manifest!.sources[index]?.path && source.type === manifest!.sources[index]?.type);
  const criteria = requestedSelection ?? (sameSources ? previousManifest?.finding_selection?.criteria : undefined);
  if (criteria) {
    const audits = manifest.sources.filter((source) => source.type === "structured_audit");
    if (audits.length !== 1 || manifest.sources.some((source) => source.type === "document")) {
      throw new Error("Finding selection requires one structured audit report supplied with --input.");
    }
    const source = audits[0]!;
    const content = await readFile(source.path, "utf8");
    const selected = selectAuditFindings(JSON.parse(content), criteria);
    const projectedPath = join(paths.dir, "selected-audit-findings.json");
    manifest = { ...manifest, finding_selection: {
      criteria, source_path: source.path, source_hash: hashContent(content),
      projected_path: projectedPath, selected_count: selected.findings.length,
    } };
    await writeJsonFile(projectedPath, selected);
  }
  await writeJsonFile(paths.sourceManifest, manifest);
  return { kind: "selected", manifest };
}
