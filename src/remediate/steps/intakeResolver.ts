import { requestedFindingSelection, selectAuditFindings, renderFindingSelection, type FindingSelectionOptions } from "../intakeSelection.js";

// sites-pinned: tests/remediate-exact-intake-cycle6.test.mjs
import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashContent, isJsonParseError, isRecord, readOptionalJsonFile, toPromptPathToken, writeJsonFile } from "audit-tools/shared";
import { writeFileAtomic } from "../../shared/io/json.js";
import { isAuditFindingsReport } from "../phases/plan.js";
import { QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { InputResolution, RemediationStep } from "./types.js";
import {
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  buildStructuredAuditSourceManifest,
  buildMixedSourceManifest,
  DiscoveredInputBindingSchema,
  type DiscoveredInputBinding,
  type VerifiedDiscoveredInput,
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

function parseSuppliedInput(
  path: string,
  content: string,
  allowDocumentFallback = false,
): { ok: true; parsed?: unknown } | { ok: false; reason: string } {
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
      return { ok: true, parsed };
    }
    if (typeof parsed.contract_version === "string" && parsed.contract_version.startsWith("audit-tools/audit-findings/")) {
      return { ok: false, reason: `Unsupported audit report version: ${parsed.contract_version}.` };
    }
    if (!allowDocumentFallback && typeof sv === "string" && !KNOWN_SCHEMA_VERSIONS.has(sv)) {
      return { ok: false, reason: `unrecognised schema_version: ${sv}` };
    }
  }
  return { ok: true, parsed };
}

export type IntakeResult =
  | { kind: "step"; step: RemediationStep }
  | { kind: "pipeline_ready"; discoveredInput?: VerifiedDiscoveredInput };

export type DiscoveryRead = { path: string; input: VerifiedDiscoveredInput | undefined };

type IntakeStepParams = {
  root: string;
  artifactsDir: string;
  findingSelection?: FindingSelectionOptions;
  inputResolution: InputResolution;
  loaderCommand: (cmd: string) => string;
  randomRunId: (prefix?: string) => string;
  archivePriorSourceIntake?: () => Promise<void>;
  discoveryRead?: DiscoveryRead;
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
  const { manifest, discoveredInput } = source;
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

  const sourceResolution = resolveManifestSources(root, manifest, discoveredInput?.path);
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
  const snapshotPath = discoveredInput && join(paths.discoveredInputSnapshots, discoveredInput.sha256, basename(discoveredInput.path));
  const synthesizeIntakeStep = async (reason?: string): Promise<IntakeResult> => {
    // Read the same approved revision even if the original changes while the
    // host is synthesizing. A projected finding subset already has its own file.
    if (discoveredInput && snapshotPath && sourceResolution.resolved.some(source => source.path === discoveredInput.path)) {
      await writeFileAtomic(snapshotPath, discoveredInput.bytes);
    }
    return {
      kind: "step",
      step: await writeCurrentStep({
        stepKind: "synthesize_intake",
        status: "ready",
        runId: params.randomRunId("INTAKE"),
        repoRoot: root,
        artifactsDir,
        prompt: `${params.synthesizeIntakePrompt(
          sourceResolution.resolved.map(source => snapshotPath && source.path === discoveredInput?.path
            ? { ...source, path: snapshotPath } : source),
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
    };
  };

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
  return { kind: "pipeline_ready", discoveredInput };
}

function sameDiscoveredInput(a: unknown, b: DiscoveredInputBinding): boolean {
  return isRecord(a) && a.path === b.path && a.sha256 === b.sha256;
}

export async function readDiscoveredInput(path: string): Promise<VerifiedDiscoveredInput | undefined> {
  const bytes = await readFile(path).catch(() => undefined);
  return bytes && { path, sha256: hashContent(bytes), bytes };
}

async function selectDiscoveredInput(
  params: IntakeStepParams,
  paths: IntakePaths,
  prior: DiscoveredInputBinding | undefined,
  collectStartingPointStep: CollectStartingPointStep,
): Promise<VerifiedDiscoveredInput | IntakePause> {
  const { root, artifactsDir, inputResolution } = params;
  const ack = await readOptionalJsonFile<unknown>(paths.discoveredInputAck).catch(error => {
    if (!isJsonParseError(error)) throw error;
    return undefined;
  });
  if (isRecord(ack) && ack.status === "declined") {
    return collectStartingPointStep([], "Stop after collecting an explicit remediation source (--input <path>) and rerunning next-step.");
  }

  // The tool-owned offer records what was actually displayed, rather than
  // letting a host echo (or a changed ranking) define the subject retroactively.
  const readCandidate = (path: string) => params.discoveryRead?.path === path
    ? Promise.resolve(params.discoveryRead.input) : readDiscoveredInput(path);
  const offer = DiscoveredInputBindingSchema.safeParse(await readOptionalJsonFile<unknown>(paths.discoveredInputOffer));
  const offered = offer.success && inputResolution.allExisting.includes(offer.data.path)
    ? await readCandidate(offer.data.path) : undefined;
  const unchanged = offered !== undefined && offer.success && sameDiscoveredInput(offer.data, offered);
  if (unchanged && ((isRecord(ack) && ack.status === "confirmed" &&
      ack.path === toPromptPathToken(offered.path) && ack.sha256 === offered.sha256) ||
      (ack === undefined && sameDiscoveredInput(prior, offered)))) {
    return offered;
  }

  // An invalid acknowledgement must not revive if the previous bytes reappear.
  if (isRecord(ack) && ack.status === "confirmed") await rm(paths.discoveredInputAck, { force: true });
  const best = inputResolution.existing[0];
  const selected = unchanged ? offered : best
    ? (offered?.path === best ? offered : await readCandidate(best))
    : undefined;
  if (!selected) {
    if (offer.success) await writeJsonFile(paths.discoveredInputOffer, null);
    return collectStartingPointStep(offer.success ? [offer.data.path] : [],
      "Stop after collecting a valid remediation starting point and rerunning next-step.");
  }
  const binding = { path: selected.path, sha256: selected.sha256 };
  await writeJsonFile(paths.discoveredInputOffer, binding);

  const sourceRows: string[] = [];
  for (const path of inputResolution.allExisting) {
    const modified = await stat(path).then(file => file.mtime.toISOString(), () => undefined);
    let findingCount: number | undefined;
    if (path.toLowerCase().endsWith(".json")) {
      try {
        const parsed: unknown = JSON.parse(path === selected.path
          ? selected.bytes.toString("utf8") : await readFile(path, "utf8"));
        if (isAuditFindingsReport(parsed)) findingCount = parsed.findings.length;
      } catch { /* Metadata for other candidates is best-effort. */ }
    }
    const details = [findingCount === undefined ? "type: document" : "type: structured_audit",
      modified ? "modified " + modified : undefined,
      findingCount === undefined ? undefined : findingCount + " finding(s)"].filter(Boolean);
    sourceRows.push("- `" + toPromptPathToken(path) + "` - " + details.join(", "));
  }

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
        "No `--input`/`--guidance-file` was supplied. Confirm the displayed report and exact revision with the user.",
        "Selected: `" + toPromptPathToken(binding.path) + "` (SHA-256: `" + binding.sha256 + "`).",
        "",
        "**Discovered sources:**",
        ...sourceRows,
        "",
        "To use the selected revision, write the following to `" + toPromptPathToken(paths.discoveredInputAck) + "`:",
        "",
        "```json",
        JSON.stringify({ status: "confirmed", path: toPromptPathToken(binding.path), sha256: binding.sha256 }),
        "```",
        "",
        "To use a different report, re-run with `--input <path>`. To use guidance alone, pass `--guidance-file <path>`.",
        'To reject all discovered defaults, write `{ "status": "declined" }` to `' + toPromptPathToken(paths.discoveredInputAck) + "`.",
        "",
        "Then run: `" + params.loaderCommand("next-step") + "`",
      ].join("\n"),
      allowedCommands: [params.loaderCommand("next-step"), params.loaderCommand("next-step --input <path>")],
      stopCondition: "Stop after presenting the discovered sources to the user and writing the ack.",
      artifactPaths: { confirm_auto_discovered_input_ack: paths.discoveredInputAck },
    }),
  };
}

// Select and persist the source manifest before interpreting saved readiness.
async function selectIntakeSource(
  params: IntakeStepParams,
  paths: IntakePaths,
  previousManifest: IntakeSourceManifest | undefined,
  conversationStart: string | undefined,
  requestedSelection: ReturnType<typeof requestedFindingSelection>,
  collectStartingPointStep: CollectStartingPointStep,
): Promise<IntakePause | { kind: "selected"; manifest: IntakeSourceManifest; discoveredInput?: VerifiedDiscoveredInput }> {
  // sites-pinned: tests/plan-authority.test.mjs
  const { inputResolution } = params;
  let manifest = previousManifest;
  let discoveredInput: VerifiedDiscoveredInput | undefined;
  let classifiedAudit: { path: string; content: string; parsed: unknown } | undefined;
  let selectedPaths = inputResolution.existing;
  if (!inputResolution.supplied && !conversationStart && (!manifest || manifest.created_from === "default_candidates")) {
    const selected = await selectDiscoveredInput(params, paths, manifest?.discovered_input, collectStartingPointStep);
    if ("kind" in selected) return selected;
    discoveredInput = selected;
    selectedPaths = [selected.path];
    manifest = undefined;
  }
  // Explicit guidance can replace a discovery that has not yet become a plan source.
  if (!inputResolution.supplied && conversationStart && manifest?.created_from === "default_candidates") {
    manifest = undefined;
  }

  if (inputResolution.supplied && inputResolution.missing.length > 0) {
    return collectStartingPointStep(
      inputResolution.missing,
      "Stop after collecting a valid remediation starting point and rerunning next-step.",
    );
  }

  if (selectedPaths.length > 0 && (inputResolution.supplied || discoveredInput)) {
    const singleInput = selectedPaths[0];
    let nextManifest: IntakeSourceManifest | undefined;
    const shouldTryAuditFastPath =
      selectedPaths.length === 1 &&
      singleInput.toLowerCase().endsWith(".json");

    if (selectedPaths.length > 1) {
      const reports: string[] = [];
      for (const path of selectedPaths.filter(path => path.toLowerCase().endsWith(".json"))) {
        const content = await readFile(path, "utf8");
        const validation = parseSuppliedInput(path, content, true);
        if (!validation.ok) return collectStartingPointStep([path], validation.reason);
        if (isAuditFindingsReport(validation.parsed)) {
          reports.push(path);
          classifiedAudit = { path, content, parsed: validation.parsed };
        }
      }
      if (reports.length > 1) return collectStartingPointStep(reports, "Select one canonical audit report for remediation.");
      if (reports.length === 1) {
        const from = inputResolution.supplied ? "input" : "default_candidates";
        const audit = buildStructuredAuditSourceManifest(reports[0]!, from);
        const guidance = buildDocumentSourceManifest(selectedPaths.filter(path => path !== reports[0]), from);
        nextManifest = { ...audit, sources: [...audit.sources, ...guidance.sources] };
      }
    }

    if (shouldTryAuditFastPath) {
      const content = discoveredInput?.bytes.toString("utf8") ?? await readFile(singleInput, "utf8");
      // Recognize an explicit audit even alongside guidance, while preserving
      // mixed document intake's existing fallback for non-audit JSON content.
      const allowDocumentFallback = !inputResolution.supplied || (Boolean(conversationStart) && requestedSelection === undefined && previousManifest?.finding_selection === undefined);
      const validation = parseSuppliedInput(singleInput, content, allowDocumentFallback);
      if (!validation.ok) {
        return collectStartingPointStep(
          [singleInput],
          `Stop after providing a valid remediation starting point. Error: ${validation.reason}`,
        );
      }
      if (isAuditFindingsReport(validation.parsed)) {
        classifiedAudit = { path: singleInput, content, parsed: validation.parsed };
        nextManifest = buildStructuredAuditSourceManifest(
          singleInput,
          inputResolution.supplied ? "input" : "default_candidates",
        );
      }
    }

    if (!nextManifest) {
      nextManifest = buildDocumentSourceManifest(
        selectedPaths,
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
      if (discoveredInput) {
        const { path, sha256 } = discoveredInput;
        manifest.discovered_input = { path, sha256 };
      }
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
    // A resumed manifest may not have classified this file in this invocation.
    const report = classifiedAudit?.path === source.path ? classifiedAudit : undefined;
    const content = report?.content ?? await readFile(source.path, "utf8");
    const selected = selectAuditFindings(report ? report.parsed : JSON.parse(content), criteria);
    const projectedPath = join(paths.dir, "selected-audit-findings.json");
    manifest = { ...manifest, finding_selection: {
      criteria, source_path: source.path, source_hash: hashContent(content),
      projected_path: projectedPath, selected_count: selected.findings.length,
    } };
    await writeJsonFile(projectedPath, selected);
  }
  if (previousManifest?.created_from === "default_candidates" && !sourceManifestsEquivalent(previousManifest, manifest)) {
    await params.archivePriorSourceIntake?.();
  }
  await writeJsonFile(paths.sourceManifest, manifest);
  return { kind: "selected", manifest, discoveredInput };
}
