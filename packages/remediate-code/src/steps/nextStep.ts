import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  ItemSpec,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, isRecord, RunLogger, type SessionConfig } from "@audit-tools/shared";
import { runPlanPhase } from "../phases/plan.js";
import { runTriagePhase } from "../phases/triage.js";
import { runClosePhase } from "../phases/close.js";
import { validateRemediationPlan } from "../validation/remediationState.js";
import {
  mergeDocumentResults,
  mergeImplementResults,
  prepareDocumentDispatch,
  prepareImplementDispatch,
  readExtractedPlanIfPresent,
} from "./dispatch.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import { checkAffectedFileIntegrity } from "../utils/fileIntegrity.js";
import { resolveIntakeStep } from "./intakeResolver.js";
import {
  INTAKE_CLARIFICATION_SCHEMA_VERSION,
  INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
  INTAKE_SUMMARY_SCHEMA_VERSION,
  blockingIntakeQuestions,
  buildConversationSourceManifest,
  buildDocumentSourceManifest,
  intakePaths,
  isIntakeReady,
  readIntakeArtifacts,
  resolveManifestSources,
  type IntakeSource,
  type IntakeSourceManifest,
  type IntakeSummary,
} from "../intake.js";

export interface NextStepOptions {
  root?: string;
  artifactsDir?: string;
  input?: string | string[];
  hostCanDispatchSubagents?: boolean;
  hostMaxConcurrent?: number;
  finalizeClosing?: boolean;
  sessionConfig?: SessionConfig | null;
}

export function resolveHostDispatchCapability(options: {
  hostCanDispatchSubagents?: boolean;
  sessionConfig?: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.hostCanDispatchSubagents !== undefined) {
    return options.hostCanDispatchSubagents;
  }
  if (options.sessionConfig?.host_can_dispatch_subagents !== undefined) {
    return options.sessionConfig.host_can_dispatch_subagents;
  }
  const envValue = (options.env ?? process.env).REMEDIATE_HOST_CAN_DISPATCH;
  if (envValue === "true") return true;
  if (envValue === "false") return false;

  // Auto-detect: a configured provider implies the host can dispatch workers.
  const provider = options.sessionConfig?.provider;
  if (provider && provider !== "auto") return true;

  return false;
}

function randomRunId(prefix = "RUN"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRoot(root?: string): string {
  return resolve(root ?? ".");
}

function resolveArtifactsDir(root: string, artifactsDir?: string): string {
  return resolve(artifactsDir ?? join(root, ".remediation-artifacts"));
}

function stateRunId(state: RemediationState | null): string {
  return state?.plan?.plan_id ?? randomRunId("REMEDIATE");
}

function defaultInputCandidates(root: string): string[] {
  return [
    join(root, "audit-report.md"),
    join(root, ".audit-artifacts", "audit-report.md"),
    join(root, ".remediation-artifacts", "audit-report.md"),
  ];
}

interface InputResolution {
  supplied: boolean;
  existing: string[];
  missing: string[];
  checked: string[];
}

function inputValues(input?: string | string[]): string[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

function resolveInputPaths(
  root: string,
  input?: string | string[],
): InputResolution {
  const values = inputValues(input).filter((value) => value.trim().length > 0);
  if (values.length > 0) {
    const checked = values.map((value) => resolve(root, value));
    return {
      supplied: true,
      existing: checked.filter((candidate) => existsSync(candidate)),
      missing: checked.filter((candidate) => !existsSync(candidate)),
      checked,
    };
  }

  const checked = defaultInputCandidates(root);
  return {
    supplied: false,
    existing: checked.filter((candidate) => existsSync(candidate)),
    missing: [],
    checked,
  };
}

function formatAllowed(command: string): string {
  return `- \`${command}\``;
}

function loaderCommand(command: string): string {
  return `remediate-code ${command}`;
}

export type FindingRiskTier = "safe" | "substantive" | "context_dependent";

export interface FindingClassification {
  tier: FindingRiskTier;
  /** One-line explanation of why the rule matched, shown to the reviewing LLM. */
  reason: string;
}

export function classifyFindingRisk(finding: Finding, spec: ItemSpec): FindingClassification {
  const lens = finding.lens.toLowerCase();
  const change = spec.concrete_change.toLowerCase();

  // Context-dependent: low confidence, breaking/compat/removal signals.
  const lensIsBreaking = /\b(compat|api[-_]?break|interface|breaking|deprecat|remov)\b/.test(lens);
  const changeIsDestructive =
    /\b(removes?|deletes?|disables?|no longer|replaces?.*incompatible|breaks?)\b/.test(change);

  if (finding.confidence === "low") {
    return { tier: "context_dependent", reason: "confidence is low" };
  }
  if (lensIsBreaking) {
    return { tier: "context_dependent", reason: `lens "${finding.lens}" signals a breaking/compat concern` };
  }
  if (changeIsDestructive) {
    return { tier: "context_dependent", reason: "concrete_change contains a removal or disabling verb" };
  }

  // Safe: style / formatting / cosmetic / low-severity config with high confidence.
  const lensIsSafe = /\b(style|format|lint|typo|whitespace|cosmetic|config)\b/.test(lens);
  const lowRisk =
    (finding.severity === "low" || finding.severity === "info") &&
    finding.confidence === "high";

  if (lensIsSafe) {
    return { tier: "safe", reason: `lens "${finding.lens}" is a style/format/config lens` };
  }
  if (lowRisk) {
    return { tier: "safe", reason: `severity=${finding.severity} + confidence=high indicates minimal risk` };
  }

  return { tier: "substantive", reason: `lens "${finding.lens}", severity=${finding.severity} — no safe/breaking signal matched` };
}

function documentableFindings(state: RemediationState): Finding[] {
  if (!state.plan || !state.items) return [];
  return state.plan.findings.filter(
    (finding) => state.items?.[finding.id]?.status === "pending",
  );
}

function implementableBlocks(state: RemediationState): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter((block) =>
    block.items.some((findingId) => {
      const item = state.items?.[findingId];
      return item?.status === "documented" && Boolean(item.item_spec);
    }),
  );
}

function blockedItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) => item.status === "blocked");
}

const TERMINAL_STATUSES = ["resolved", "resolved_no_change", "ignored", "deemed_inappropriate"];

export const NO_CHANGE_RE = /\b(already correct|no.?op|no change|nothing to (change|do|fix)|code is correct)\b/i;

/**
 * Decide whether an item spec represents a no-op (no source changes planned).
 *
 * The structured `no_change` flag is authoritative when the worker set it
 * explicitly: an explicit `false` must win even when `concrete_change` happens
 * to mention a no-change phrase about a sub-part (e.g. "no change is required in
 * constants.ts" inside a finding that does change other files). The heuristic
 * regex over the free-text spec is only a fallback for when `no_change` is
 * unspecified.
 */
export function specIndicatesNoChange(
  spec: { no_change?: boolean; concrete_change?: string } | undefined,
): boolean {
  if (spec?.no_change === true) return true;
  if (spec?.no_change === false) return false;
  return NO_CHANGE_RE.test(spec?.concrete_change ?? "");
}

function resolvedOrTerminalItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) =>
    TERMINAL_STATUSES.includes(item.status),
  );
}

function allItemsTerminal(state: RemediationState): boolean {
  const items = Object.values(state.items ?? {});
  return items.length > 0 && resolvedOrTerminalItems(state).length === items.length;
}

function normalizeExtractedPlan(value: unknown): RemediationPlan {
  if (!isRecord(value)) {
    throw new Error("extracted-plan.json must be an object.");
  }
  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  const findings = rawFindings.map((finding) => {
    if (!isRecord(finding)) return finding;
    return {
      category: "General",
      affected_files: [],
      evidence: [],
      ...finding,
    };
  }) as Finding[];
  const rawBlocks = Array.isArray(value.blocks) ? value.blocks : [];
  const blocks =
    rawBlocks.length > 0
      ? rawBlocks.map((block) => {
          if (!isRecord(block)) return block;
          return {
            parallel_safe: true,
            dependencies: [],
            ...block,
          };
        })
      : findings.map((finding, index) => ({
          block_id: `B-${String(index + 1).padStart(3, "0")}`,
          items: [finding.id],
          parallel_safe: true,
        }));
  const dedup = deduplicateCrossLensFindings(findings);
  const dedupBlocks = fixupBlocksAfterDedup(
    blocks as RemediationBlock[],
    dedup.mergeMap,
  );
  const plan: RemediationPlan = {
    plan_id:
      typeof value.plan_id === "string" ? value.plan_id : randomRunId("PLAN"),
    findings: dedup.findings,
    blocks: dedupBlocks,
    project_type:
      typeof value.project_type === "string" ? value.project_type : "unknown",
    test_command:
      typeof value.test_command === "string" ? value.test_command : undefined,
    e2e_command:
      typeof value.e2e_command === "string" ? value.e2e_command : undefined,
    candidate_closing_actions: ["none"],
    block_strategy:
      value.block_strategy === "test_graph" ||
      value.block_strategy === "git_cocommit" ||
      value.block_strategy === "file_overlap" ||
      value.block_strategy === "manual"
        ? value.block_strategy
        : undefined,
  };

  const issues = validateRemediationPlan(plan).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length > 0) {
    throw new Error(`Invalid extracted plan:\n${formatValidationIssues(issues)}`);
  }
  if (plan.findings.length === 0) {
    throw new Error("Extracted plan contains zero findings.");
  }
  return plan;
}

async function saveStateForPlan(
  artifactsDir: string,
  existing: RemediationState,
  plan: RemediationPlan,
): Promise<RemediationState> {
  const items: Record<string, RemediationItemState> = {};
  for (const finding of plan.findings) {
    const block = plan.blocks.find((candidate) =>
      candidate.items.includes(finding.id),
    );
    items[finding.id] = {
      finding_id: finding.id,
      status: "pending",
      block_id: block?.block_id ?? "UNKNOWN",
    };
  }
  const state: RemediationState = {
    ...existing,
    status: "planning",
    plan,
    items,
    closing_plan: { action: "none" },
  };
  await new StateStore(artifactsDir).saveState(state);
  await writeJsonFile(join(artifactsDir, "remediation_plan.json"), plan);
  return state;
}

function clarificationPrompt(
  clarifications: ClarificationRequest[],
  resolutionPath: string,
): string {
  return `
# Resolve Remediation Clarifications

Ask the user to resolve all clarifications in one batched response.

${clarifications
  .map(
    (item) => `
## ${item.finding_id}

- Category: ${item.category}
- Question: ${item.description}
${item.options?.length ? `- Options: ${item.options.join(", ")}` : ""}
`,
  )
  .join("\n")}

After the user answers, write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
[
  {
    "finding_id": "...",
    "action": "clarified",
    "rationale": "..."
  }
]
\`\`\`

Use \`"action": "deemed_inappropriate"\` for out-of-scope items. Then run
\`${loaderCommand("next-step")}\`.
`;
}

function triagePrompt(state: RemediationState, resolutionPath: string): string {
  const blocked = blockedItems(state);
  return `
# Resolve Remediation Triage

Ask the user for one decision per blocked item: \`retry\`, \`ignore\`, or \`halt\`.

${blocked
  .map((item) => {
    const finding = state.plan?.findings.find((entry) => entry.id === item.finding_id);
    return `
## ${item.finding_id} - ${finding?.title ?? "Untitled finding"}

- Failure reason: ${item.failure_reason ?? "Unknown"}
- Last successful step: ${item.last_successful_step ?? "none"}
`;
  })
  .join("\n")}

After the user answers, write JSON to exactly:

\`${resolutionPath}\`

\`\`\`json
{
  "items": [
    {
      "finding_id": "...",
      "action": "retry",
      "rationale": "..."
    }
  ]
}
\`\`\`

Then run \`${loaderCommand("next-step")}\`.
`;
}

function formatIntakeSources(sources: IntakeSource[]): string {
  if (sources.length === 0) return "- none";
  return sources.map((source) => `- ${source.type}: \`${source.path}\``).join("\n");
}

function collectStartingPointPrompt(
  root: string,
  checkedPaths: string[],
  missingPaths: string[],
  paths: ReturnType<typeof intakePaths>,
): string {
  const missing = missingPaths.length
    ? `\n\nThe supplied input path did not exist:\n${missingPaths
        .map((path) => `- \`${path}\``)
        .join("\n")}`
    : "";

  return `
# Collect Remediation Starting Point

Ask the user for the starting point for this remediation. Accept either:

- one or more paths to audit reports, feedback documents, issue notes, or design
  notes
- conversational feedback describing the refactor or remediation goal
- both documents and conversational context

Repository root:

\`${root}\`

Checked default input locations:
${checkedPaths.map((candidate) => `- \`${candidate}\``).join("\n")}
${missing}

If the user provides document paths, write JSON to exactly:

\`${paths.sourceManifest}\`

\`\`\`json
{
  "schema_version": "${INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION}",
  "created_from": "conversation",
  "sources": [
    { "type": "document", "path": "path/from/user-or-absolute-path", "label": "input-01" }
  ]
}
\`\`\`

If the user provides conversational feedback, write their full feedback to
exactly:

\`${paths.conversationStart}\`

Then include that file in the source manifest:

\`\`\`json
{
  "schema_version": "${INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION}",
  "created_from": "conversation",
  "sources": [
    { "type": "conversation", "path": ${JSON.stringify(paths.conversationStart)}, "label": "conversation-start" }
  ]
}
\`\`\`

If the user provides both, include both source types in the same manifest. Do
not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}

function synthesizeIntakePrompt(
  manifestPath: string,
  sources: IntakeSource[],
  paths: ReturnType<typeof intakePaths>,
  hasClarificationResolution: boolean,
): string {
  const clarificationText = hasClarificationResolution
    ? `\nAlso read the clarification answers at:\n\n\`${paths.clarificationResolution}\`\n`
    : "";

  return `
# Synthesize Remediation Intake

Read the source manifest:

\`${manifestPath}\`

Then read only the listed source files:

${formatIntakeSources(sources)}
${clarificationText}
Create a launch brief for the remediation workflow. The goal is to eliminate
ambiguity before the normal remediation planner turns this into findings.

Write JSON to exactly:

\`${paths.summary}\`

\`\`\`json
{
  "schema_version": "${INTAKE_SUMMARY_SCHEMA_VERSION}",
  "ready": false,
  "source_type": "documents",
  "goals": ["specific remediation goal"],
  "non_goals": ["explicitly out-of-scope change"],
  "constraints": ["compatibility, dependency, testing, timing, or style constraint"],
  "affected_files": [{ "path": "relative/path.ts", "reason": "why this file is implicated" }],
  "open_questions": [
    {
      "id": "Q-001",
      "category": "scope_of_fix",
      "question": "What needs to be clarified before code changes?",
      "blocking": true
    }
  ]
}
\`\`\`

Set \`ready\` to \`true\` only when the goals, non-goals, affected areas, and
success criteria are clear enough that implementation choices will not depend
on another user decision. If any blocking ambiguity remains, set \`ready\` to
\`false\` and list the questions.

Use \`source_type\` of \`documents\`, \`conversation\`, or \`mixed\`.

Also write a Markdown launch brief to exactly:

\`${paths.brief}\`

The brief must include:

- source summary
- goals
- non-goals
- constraints
- affected files or discovery targets
- acceptance criteria
- open questions, if any

Do not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}

function collectIntakeClarificationsPrompt(
  summary: IntakeSummary,
  paths: ReturnType<typeof intakePaths>,
): string {
  const questions = blockingIntakeQuestions(summary);
  return `
# Resolve Remediation Intake Questions

Ask the user to answer all blocking intake questions in one response.

${questions
  .map(
    (question) => `
## ${question.id}

- Category: ${question.category ?? "scope"}
- Question: ${question.question}
`,
  )
  .join("\n")}

After the user answers, write JSON to exactly:

\`${paths.clarificationResolution}\`

\`\`\`json
{
  "schema_version": "${INTAKE_CLARIFICATION_SCHEMA_VERSION}",
  "answers": [
    {
      "question_id": "Q-001",
      "answer": "User's answer",
      "rationale": "Optional short note about how the answer resolves ambiguity"
    }
  ]
}
\`\`\`

Then run:

\`${loaderCommand("next-step")}\`
`;
}

function extractFindingsPrompt(
  paths: ReturnType<typeof intakePaths>,
  sources: IntakeSource[],
): string {
  return `
# Extract Findings From Intake Brief

Read the remediation launch brief:

\`${paths.brief}\`

You may use the source files listed below only to preserve evidence and
traceability:

${formatIntakeSources(sources)}

Extract actionable remediation items into JSON at exactly:

\`${paths.extractedPlan}\`

Use this exact shape:

\`\`\`json
{
  "findings": [
    {
      "id": "FINDING-001",
      "title": "Short title",
      "category": "User Goal",
      "severity": "medium",
      "confidence": "high",
      "lens": "maintainability",
      "summary": "One-sentence description",
      "affected_files": [{ "path": "relative/path/to/file.ts" }],
      "evidence": ["specific source note, user statement, or document observation"]
    }
  ],
  "blocks": [
    {
      "block_id": "B-001",
      "items": ["FINDING-001", "FINDING-002"],
      "parallel_safe": true,
      "dependencies": []
    }
  ]
}
\`\`\`

For conversational refactor goals, choose the closest existing \`lens\` value
instead of inventing a new one: \`correctness\`, \`architecture\`,
\`maintainability\`, \`security\`, \`reliability\`, \`performance\`,
\`data_integrity\`, \`tests\`, \`operability\`, \`config_deployment\`, or
\`observability\`. Group related findings into blocks by shared files or
logical cohesion. Do not edit source files.

Then run:

\`${loaderCommand("next-step")}\`
`;
}

async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(root, "remediation-report.md");
  return writeCurrentStep({
    stepKind: "present_report",
    status: "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Present Remediation Report

Read \`${reportPath}\` and summarize the remediation outcome for the user.
Mention the resolved, ignored, and deemed-inappropriate counts plus the closing action.
Stop after presenting the summary.
`,
    allowedCommands: [],
    stopCondition: "Stop after presenting the remediation report summary.",
    artifactPaths: {
      final_report: reportPath,
    },
  });
}

const MAX_ITERATIONS = 10;

/**
 * Public entrypoint: wraps the decision loop with structured run-log events so
 * each bounded next-step invocation records the state it acted on and the step
 * it produced. The logger is no-op when `observability.run_log` is disabled.
 */
type DispatchOutcome = RemediationStep | { continueWithState: RemediationState };

async function buildDocumentDispatchStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  pendingFindings: Finding[];
}): Promise<DispatchOutcome> {
  const { root, artifactsDir, state, options, pendingFindings } = ctx;
    if (state.plan) {
      const integrity = await checkAffectedFileIntegrity(root, state.plan.findings);
      if (!integrity.is_clean) {
        const details = [
          ...integrity.changed.map((p) => `changed: ${p}`),
          ...integrity.missing.map((p) => `missing: ${p}`),
        ];
        const replanCommand = loaderCommand("next-step --force-replan");
        return writeCurrentStep({
          stepKind: "collect_starting_point",
          status: "blocked",
          runId: stateRunId(state),
          repoRoot: root,
          artifactsDir,
          prompt: [
            "## File integrity check failed",
            "",
            "The following files have changed since the remediation plan was created:",
            ...details.map((d) => `- ${d}`),
            "",
            "Re-run planning to pick up the current file state before documenting begins.",
            "Run:",
            "",
            `\`${replanCommand}\``,
          ].join("\n"),
          allowedCommands: [replanCommand],
          stopCondition: "Stop after re-planning completes.",
        });
      }
    }

    const sessionConfig = options.sessionConfig ??
      await readOptionalJsonFile<SessionConfig>(
        join(root, ".remediation-artifacts", "session-config.json"),
      ) ?? await readOptionalJsonFile<SessionConfig>(
        join(root, "session-config.json"),
      );
    const canDispatch = resolveHostDispatchCapability({
      hostCanDispatchSubagents: options.hostCanDispatchSubagents,
      sessionConfig,
    });

    const runId = stateRunId(state);
    const waveOpts = { hostMaxConcurrent: options.hostMaxConcurrent, sessionConfig: sessionConfig ?? null };
    const onlyFinding = !canDispatch ? pendingFindings[0].id : undefined;
    const dispatchPlan = await prepareDocumentDispatch(
      { root, artifactsDir },
      runId,
      onlyFinding,
      waveOpts,
    );
    const planPath = join(artifactsDir, "runs", runId, "document", "dispatch-plan.json");
    const mergeCommand = loaderCommand(`merge-document-results --run-id ${runId}`);
    const nextCommand = loaderCommand("next-step");

    if (!canDispatch) {
      const item = dispatchPlan.items[0];
      if (!item) {
        return { continueWithState: await mergeDocumentResults({ root, artifactsDir }, runId) };
      }
      return writeCurrentStep({
        stepKind: "document_single_item",
        status: "ready",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `
# Document One Remediation Item

Read and follow only this prompt:

\`${item.prompt_path}\`

After writing the result JSON, run:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
        allowedCommands: [mergeCommand, nextCommand],
        stopCondition:
          "Stop when the single item result has been merged and next-step has been run.",
        artifactPaths: {
          dispatch_plan: planPath,
          single_task_prompt: item.prompt_path,
          result: item.result_path,
        },
      });
    }

    const docQuotaPath = join(artifactsDir, "runs", runId, "document", "dispatch-quota.json");
    return writeCurrentStep({
      stepKind: "dispatch_document",
      status: "ready",
      runId,
      repoRoot: root,
      artifactsDir,
      prompt: `
# Dispatch Documentation Work

Read the dispatch plan and quota JSONs:

\`${planPath}\`
\`${docQuotaPath}\`

Launch at most \`wave_size\` subagents simultaneously (from the quota file).
Each item's \`model_hint.tier\` suggests which model to use (small/standard/deep).
If your provider has rate limits, pace launches accordingly.

For each item in \`items\`, dispatch one subagent with that item's
\`prompt_path\`. Each subagent must write only its assigned \`result_path\`.

After all results exist, run:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
      allowedCommands: [mergeCommand, nextCommand],
      stopCondition:
        "Stop after all document worker results have been merged and next-step has been run.",
      artifactPaths: { dispatch_plan: planPath, dispatch_quota: docQuotaPath },
    });
}

async function buildImplementDispatchStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  implementBlocks: RemediationBlock[];
}): Promise<DispatchOutcome> {
  const { root, artifactsDir, state, options, implementBlocks } = ctx;
    const preliminaryPath = join(artifactsDir, "impl_risk_preliminary.json");
    const reviewedPath = join(artifactsDir, "impl_risk_reviewed.json");
    const previewAckPath = join(artifactsDir, "impl_preview_acknowledged.json");

    if (!existsSync(previewAckPath)) {
      const nextCommand = loaderCommand("next-step");

      if (!existsSync(reviewedPath)) {
        // Write preliminary JSON and dispatch a bounded, model-agnostic review task.
        type PreliminaryEntry = {
          finding_id: string;
          title: string;
          severity: string;
          confidence: string;
          lens: string;
          affected_files: string[];
          summary: string;
          evidence: string[];
          concrete_change: string;
          no_change?: boolean;
          tests_to_write: { name: string; assertions: string[] }[];
          block_id: string;
          preliminary_tier: FindingRiskTier;
          preliminary_reason: string;
        };

        const entries: PreliminaryEntry[] = [];
        for (const block of implementBlocks) {
          for (const id of block.items) {
            const item = state.items?.[id];
            const finding = state.plan?.findings.find((f) => f.id === id);
            if (!item?.item_spec || !finding) continue;
            const spec = item.item_spec as ItemSpec;
            const { tier, reason } = classifyFindingRisk(finding, spec);
            entries.push({
              finding_id: finding.id,
              title: finding.title,
              severity: finding.severity,
              confidence: finding.confidence,
              lens: finding.lens,
              affected_files: finding.affected_files.map((f) => f.path),
              summary: finding.summary,
              evidence: finding.evidence ?? [],
              concrete_change: spec.concrete_change,
              no_change: spec.no_change,
              tests_to_write: spec.tests_to_write,
              block_id: block.block_id,
              preliminary_tier: tier,
              preliminary_reason: reason,
            });
          }
        }

        await writeJsonFile(preliminaryPath, {
          schema_version: "impl-risk-preliminary/v1",
          tier_definitions: {
            safe: "Style, formatting, config, or clearly correct bug-fixes that are unambiguously good regardless of project context.",
            substantive: "Changes that meaningfully affect correctness, security, or runtime behaviour.",
            context_dependent: "Changes whose appropriateness depends on project scope, user base, or deployment constraints. Covers low-confidence findings and anything that removes or disables existing behaviour.",
          },
          findings: entries,
        });

        return writeCurrentStep({
          stepKind: "classify_impl_risks",
          status: "ready",
          runId: stateRunId(state),
          repoRoot: root,
          artifactsDir,
          prompt: `
# Review Implementation Risk Classifications

A rule-based classifier has produced preliminary risk tiers for all planned
implementation changes. Read the preliminary classifications, review each one
against the full finding context, and write a reviewed result.

## Input

\`${preliminaryPath}\`

Read only that file. Do not read source code files.

## Tier definitions

- **safe**: Style, formatting, config, or clearly correct bug-fixes that are
  unambiguously good regardless of project context.
- **substantive**: Changes that meaningfully affect correctness, security,
  or runtime behaviour.
- **context_dependent**: Changes whose appropriateness depends on project
  scope, user base, or deployment constraints. Covers low-confidence findings
  and anything that removes or disables existing behaviour.

## Task

For each entry in \`findings\`:
1. Read \`preliminary_tier\` and \`preliminary_reason\`.
2. Check \`summary\`, \`evidence\`, \`concrete_change\`, and \`lens\` for signals the
   rule missed or misread.
3. Keep or adjust the tier. If you adjust, explain why in \`reason\`.

## Output

Write to exactly:

\`${reviewedPath}\`

\`\`\`json
{
  "schema_version": "impl-risk-reviewed/v1",
  "findings": [
    {
      "finding_id": "...",
      "tier": "safe | substantive | context_dependent",
      "reason": "one-line explanation"
    }
  ]
}
\`\`\`

Include every \`finding_id\` from the input. Then run:

\`${nextCommand}\`
`,
          allowedCommands: [nextCommand],
          stopCondition:
            "Stop after writing impl_risk_reviewed.json and running next-step.",
          artifactPaths: {
            preliminary: preliminaryPath,
            reviewed: reviewedPath,
          },
        });
      }

      // Reviewed classifications exist. Build the tiered display in the backend
      // so the preview step is pure present-and-confirm — no reasoning required.
      type ReviewedEntry = { finding_id: string; tier: string; reason: string };
      type PrelimEntry = {
        finding_id: string;
        title: string;
        concrete_change: string;
        no_change?: boolean;
        affected_files: string[];
        preliminary_tier: string;
        preliminary_reason: string;
      };

      const reviewedFile = await readOptionalJsonFile<{ findings: ReviewedEntry[] }>(reviewedPath);
      const prelimFile = await readOptionalJsonFile<{ findings: PrelimEntry[] }>(preliminaryPath);

      const reviewedMap = new Map(
        (reviewedFile?.findings ?? []).map((e) => [e.finding_id, e]),
      );
      const prelimMap = new Map(
        (prelimFile?.findings ?? []).map((e) => [e.finding_id, e]),
      );

      // Fall back to preliminary tier for any finding the reviewer omitted.
      for (const [id, prelim] of prelimMap) {
        if (!reviewedMap.has(id)) {
          reviewedMap.set(id, {
            finding_id: id,
            tier: prelim.preliminary_tier,
            reason: prelim.preliminary_reason,
          });
        }
      }

      function isNoOp(findingId: string): boolean {
        return specIndicatesNoChange(prelimMap.get(findingId));
      }

      function renderTierSection(tier: string, label: string): string {
        const matches = [...reviewedMap.values()].filter(
          (e) => e.tier === tier && !isNoOp(e.finding_id),
        );
        if (matches.length === 0) return "";
        const header = "| ID | Title | Planned Change | Files |";
        const sep = "|---|---|---|---|";
        const rows = matches.map((reviewed) => {
          const prelim = prelimMap.get(reviewed.finding_id);
          const files = (prelim?.affected_files.join(", ") ?? "—").replaceAll("|", "\\|");
          const change = (prelim?.concrete_change ?? "—").replaceAll("|", "\\|");
          const title = (prelim?.title ?? "—").replaceAll("|", "\\|");
          return `| ${reviewed.finding_id} | ${title} | ${change} | ${files} |`;
        });
        return `## ${label}\n\n${header}\n${sep}\n${rows.join("\n")}`;
      }

      function renderNoOpSection(): string {
        const noOps = [...reviewedMap.values()].filter((e) => isNoOp(e.finding_id));
        if (noOps.length === 0) return "";
        const rows = noOps.map((e) => {
          const title = (prelimMap.get(e.finding_id)?.title ?? "—").replaceAll("|", "\\|");
          return `- **${e.finding_id}**: ${title}`;
        });
        return `## Already Correct (no changes planned)\n\n${rows.join("\n")}`;
      }

      const sections = [
        renderTierSection("safe", "Tier 1 — Unambiguously Good"),
        renderTierSection("substantive", "Tier 2 — Substantive"),
        renderTierSection("context_dependent", "Tier 3 — Context-Dependent"),
        renderNoOpSection(),
      ]
        .filter(Boolean)
        .join("\n\n");

      return writeCurrentStep({
        stepKind: "preview_implement",
        status: "blocked",
        runId: stateRunId(state),
        repoRoot: root,
        artifactsDir,
        prompt: `
# Implementation Plan Preview

Show the tables below to the user exactly as written — every row, every column.
Do not summarise, abbreviate, or list only IDs. The user needs the title and
planned-change columns to make an informed decision.

${sections}

---

After showing the full tables, ask the user to choose one of:

1. **Approve everything** — proceed with all changes as listed.
2. **Skip specific Tier 3 findings** — name the IDs to exclude (they will be
   marked \`deemed_inappropriate\`). Example: \`skip SEC-001, DI-001\`.
3. **Decline entirely** — stop without making any source changes.

If the user approves (all or in part), write \`{"status":"confirmed"}\` to exactly:

\`${previewAckPath}\`

Then run:

\`${nextCommand}\`
`,
        allowedCommands: [nextCommand],
        stopCondition:
          "Present the plan to the user, get their decision. Write the ack file and run next-step only if approved.",
        artifactPaths: {
          preliminary: preliminaryPath,
          reviewed: reviewedPath,
          impl_preview_ack: previewAckPath,
        },
      });
    }

    const sessionConfigImpl = options.sessionConfig ??
      await readOptionalJsonFile<SessionConfig>(
        join(root, ".remediation-artifacts", "session-config.json"),
      ) ?? await readOptionalJsonFile<SessionConfig>(
        join(root, "session-config.json"),
      );
    const canDispatchImpl = resolveHostDispatchCapability({
      hostCanDispatchSubagents: options.hostCanDispatchSubagents,
      sessionConfig: sessionConfigImpl,
    });

    const runId = stateRunId(state);
    const waveOptsImpl = { hostMaxConcurrent: options.hostMaxConcurrent, sessionConfig: sessionConfigImpl ?? null };
    const onlyBlock = !canDispatchImpl ? implementBlocks[0].block_id : undefined;
    const dispatchPlan = await prepareImplementDispatch(
      { root, artifactsDir },
      runId,
      onlyBlock,
      waveOptsImpl,
    );
    const planPath = join(artifactsDir, "runs", runId, "implement", "dispatch-plan.json");
    const mergeCommand = loaderCommand(`merge-implement-results --run-id ${runId}`);
    const nextCommand = loaderCommand("next-step");

    if (!canDispatchImpl) {
      const item = dispatchPlan.items[0];
      if (!item) {
        return { continueWithState: await mergeImplementResults({ root, artifactsDir }, runId) };
      }
      return writeCurrentStep({
        stepKind: "implement_single_item",
        status: "ready",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `
# Implement One Remediation Block

Read and follow only this prompt:

\`${item.prompt_path}\`

After writing the result JSON, run:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
        allowedCommands: [mergeCommand, nextCommand],
        stopCondition:
          "Stop when the single implementation result has been merged and next-step has been run.",
        artifactPaths: {
          dispatch_plan: planPath,
          single_task_prompt: item.prompt_path,
          result: item.result_path,
        },
      });
    }

    const implQuotaPath = join(artifactsDir, "runs", runId, "implement", "dispatch-quota.json");
    return writeCurrentStep({
      stepKind: "dispatch_implement",
      status: "ready",
      runId,
      repoRoot: root,
      artifactsDir,
      prompt: `
# Dispatch Implementation Work

Read the dispatch plan and quota JSONs:

\`${planPath}\`
\`${implQuotaPath}\`

Launch at most \`wave_size\` subagents simultaneously (from the quota file).
Each item's \`model_hint.tier\` suggests which model to use (small/standard/deep).
If your provider has rate limits, pace launches accordingly.

For each item in \`items\`, dispatch one subagent with that item's
\`prompt_path\`. Each subagent may edit source files needed for that bounded
block and must write only its assigned \`result_path\`.

After all results exist, run:

\`${mergeCommand}\`

Then run:

\`${nextCommand}\`
`,
      allowedCommands: [mergeCommand, nextCommand],
      stopCondition:
        "Stop after all implementation results have been merged and next-step has been run.",
      artifactPaths: { dispatch_plan: planPath, dispatch_quota: implQuotaPath },
    });
}

export async function decideNextStep(
  options: NextStepOptions = {},
): Promise<RemediationStep> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  const sessionConfig =
    options.sessionConfig ??
    (await readOptionalJsonFile<SessionConfig>(
      join(root, "session-config.json"),
    ));
  const runLogger = new RunLogger(join(artifactsDir, "run.log.jsonl"), {
    enabled: sessionConfig?.observability?.run_log ?? true,
  });
  const startedAt = Date.now();
  try {
    const step = await decideNextStepInner(options, runLogger);
    runLogger.event({
      phase: "next-step",
      kind: "step",
      obligation: step.step_kind,
      note: step.status,
      duration_ms: Date.now() - startedAt,
    });
    return step;
  } catch (error) {
    runLogger.event({
      phase: "next-step",
      kind: "error",
      duration_ms: Date.now() - startedAt,
      note: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function decideNextStepInner(
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  const store = new StateStore(artifactsDir);
  let state = await store.loadState();
  runLogger.event({
    phase: "next-step",
    kind: "state",
    obligation: state?.status ?? "pending",
  });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  if (state?.status === "complete" || existsSync(join(root, "remediation-report.md"))) {
    return presentReportStep(root, artifactsDir, state);
  }

  if (!state) {
    const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
    if (extractedPlan) {
      try {
        state = await saveStateForPlan(
          artifactsDir,
          { status: "pending" },
          normalizeExtractedPlan(extractedPlan),
        );
      } catch (error) {
        const paths = intakePaths(artifactsDir);
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(paths.extractedPlan);
        } catch { /* already gone */ }
        process.stderr.write(
          `[remediate-code] Corrupted extracted-plan.json removed (${error instanceof Error ? error.message : String(error)}). Re-emitting extraction step.\n`,
        );
      }
    }
  }

  if (!state) {
    const inputResolution = resolveInputPaths(root, options.input);
    const intakeResult = await resolveIntakeStep({
      root,
      artifactsDir,
      input: options.input,
      inputResolution,
      store,
      loaderCommand,
      randomRunId,
      collectStartingPointPrompt,
      synthesizeIntakePrompt,
      collectIntakeClarificationsPrompt,
      extractFindingsPrompt,
    });
    if (intakeResult.kind === "step") return intakeResult.step;
    state = intakeResult.state;
  }

  if (!state) {
    const paths = intakePaths(artifactsDir);
    return writeCurrentStep({
      stepKind: "collect_starting_point",
      status: "blocked",
      runId: randomRunId("INPUT"),
      repoRoot: root,
      artifactsDir,
      prompt: collectStartingPointPrompt(
        root,
        defaultInputCandidates(root),
        [],
        paths,
      ),
      allowedCommands: [loaderCommand("next-step"), loaderCommand("next-step --input <path>")],
      stopCondition:
        "Stop after collecting a remediation starting point and rerunning next-step.",
      artifactPaths: {
        source_manifest: paths.sourceManifest,
        conversation_start: paths.conversationStart,
      },
    });
  }

  if (state.status === "waiting_for_clarification") {
    const clarifications =
      state.clarifications ??
      (await readOptionalJsonFile<ClarificationRequest[]>(
        join(artifactsDir, "clarification_request.json"),
      )) ??
      [];
    const resolutionPath = join(artifactsDir, "clarification_resolution.json");
    return writeCurrentStep({
      stepKind: "collect_clarifications",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: clarificationPrompt(clarifications, resolutionPath),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after asking the user for clarification answers, unless the answers are already available and the prompt told you to continue.",
      artifactPaths: {
        clarification_request: join(artifactsDir, "clarification_request.json"),
        clarification_resolution: resolutionPath,
      },
    });
  }

  if (state.status === "waiting_for_triage") {
    const resolutionPath = join(artifactsDir, "triage_resolution.json");
    return writeCurrentStep({
      stepKind: "collect_triage",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: triagePrompt(state, resolutionPath),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after asking the user for triage decisions, unless the decisions are already available and the prompt told you to continue.",
      artifactPaths: {
        triage_batch: join(artifactsDir, "triage_batch.json"),
        triage_resolution: resolutionPath,
      },
    });
  }

  const pendingFindings = documentableFindings(state);
  if (state.status === "planning" && pendingFindings.length > 0) {
    const outcome = await buildDocumentDispatchStep({ root, artifactsDir, state, options, pendingFindings });
    if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
    return outcome;
  }

  const implementBlocks = implementableBlocks(state);
  if (state.status === "documenting" && implementBlocks.length > 0 && state.plan) {
    const integrity = await checkAffectedFileIntegrity(root, state.plan.findings);
    if (!integrity.is_clean) {
      const details = [
        ...integrity.changed.map((p) => `changed: ${p}`),
        ...integrity.missing.map((p) => `missing: ${p}`),
      ];
      const nextCommand = loaderCommand("next-step --force-replan");
      return writeCurrentStep({
        stepKind: "collect_starting_point",
        status: "blocked",
        runId: stateRunId(state),
        repoRoot: root,
        artifactsDir,
        prompt: [
          "## File integrity check failed",
          "",
          "The following files have changed since the remediation plan was created:",
          ...details.map((d) => `- ${d}`),
          "",
          "Re-run planning to pick up the current file state before implementation begins.",
          "Run:",
          "",
          `\`${nextCommand}\``,
        ].join("\n"),
        allowedCommands: [nextCommand],
        stopCondition:
          "Stop after re-planning completes.",
      });
    }
  }
  if (state.status === "documenting" && implementBlocks.length > 0) {
    const outcome = await buildImplementDispatchStep({ root, artifactsDir, state, options, implementBlocks });
    if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
    return outcome;
  }

  if (state.status === "implementing") {
    const triageStart = Date.now();
    runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
    const triaged = await runTriagePhase(state, { root, artifactsDir });
    runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
    await store.saveState(triaged);
    state = triaged;
    continue;
  }

  if (state.status === "triage") {
    const triageStart = Date.now();
    runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
    const triaged = await runTriagePhase(state, { root, artifactsDir });
    runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
    await store.saveState(triaged);
    state = triaged;
    continue;
  }

  if (state.status === "documenting" && implementBlocks.length === 0) {
    state.status = "implementing";
    await store.saveState(state);
    continue;
  }

  if (allItemsTerminal(state) && state.status !== "closing") {
    state.status = "closing";
    await store.saveState(state);
  }

  if (state.status === "closing") {
    const closeStart = Date.now();
    runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });
    const closed = await runClosePhase(state, { root, artifactsDir }, runLogger);
    runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
    if (closed.status !== "complete") {
      await store.saveState(closed);
    }
    state = closed;
    continue;
  }

  const itemsByStatus: Record<string, string[]> = {};
  for (const item of Object.values(state.items ?? {})) {
    (itemsByStatus[item.status] ??= []).push(item.finding_id);
  }
  const statusBreakdown = Object.entries(itemsByStatus)
    .map(([status, ids]) => `- **${status}**: ${ids.join(", ")}`)
    .join("\n");

  return writeCurrentStep({
    stepKind: "unhandled_state",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Unhandled State

The remediation workflow reached a state it has no transition for.

- **State status**: \`${state.status}\`
- **State file**: \`${join(artifactsDir, "state.json")}\`

## Item Breakdown

${statusBreakdown || "No items in state."}

Report this diagnostic to the user and stop. Do not attempt to advance the run.
`,
    allowedCommands: [],
    stopCondition: "Stop after reporting the diagnostic to the user.",
  });
  }

  return writeCurrentStep({
    stepKind: "unhandled_state",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# State transition loop exhausted

The remediation workflow cycled through ${MAX_ITERATIONS} internal transitions without
reaching a step that can be returned to the host.

- **Last state status**: \`${state?.status ?? "null"}\`
- **State file**: \`${join(artifactsDir, "state.json")}\`

Report this diagnostic to the user and stop. Do not attempt to advance the run.
`,
    allowedCommands: [],
    stopCondition: "Stop after reporting the diagnostic to the user.",
  });
}
