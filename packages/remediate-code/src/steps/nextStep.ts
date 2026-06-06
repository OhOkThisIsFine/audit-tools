import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  ItemSpec,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, isRecord, RunLogger, DO_NOT_TOKEN_WRAP_NOTE, type SessionConfig } from "@audit-tools/shared";
import { runPlanPhase, applyPlanPipeline } from "../phases/plan.js";
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
  dependenciesSatisfied,
  isTerminalStatus,
  specIndicatesNoChange,
  classifyFindingRisk,
  type FindingRiskTier,
} from "./stepUtils.js";
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
import {
  clarificationPrompt,
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
  extractFindingsPrompt,
  loaderCommand,
  synthesizeIntakePrompt,
  triagePrompt,
} from "./prompts.js";

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

  // Conversation-first default: an interactive agent host (e.g. Claude Code) can
  // dispatch callable subagents, so default to parallel wave dispatch. A host that
  // genuinely cannot dispatch opts out via host_can_dispatch_subagents:false,
  // REMEDIATE_HOST_CAN_DISPATCH=false, or --host-can-dispatch-subagents=false.
  return true;
}

function randomRunId(prefix = "RUN"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRoot(root?: string): string {
  return resolve(root ?? ".");
}

function resolveArtifactsDir(root: string, artifactsDir?: string): string {
  return resolve(artifactsDir ?? join(root, ".audit-tools", "remediation"));
}

function stateRunId(state: RemediationState | null): string {
  return state?.plan?.plan_id ?? randomRunId("REMEDIATE");
}

function defaultInputCandidates(root: string): string[] {
  // Prefer the canonical machine contract (audit-findings.json) over its
  // human-facing render (audit-report.md). The JSON is the source of truth on
  // both sides of the audit -> remediate pipeline, and feeding it triggers the
  // lossless structured hand-off in the plan phase instead of a lossy LLM
  // re-extraction from the markdown render that sits beside it.
  return [
    join(root, ".audit-tools", "audit-findings.json"),
    join(root, ".audit-tools", "audit", "audit-findings.json"),
    join(root, "audit-findings.json"),
    join(root, ".audit-tools", "audit-report.md"),
    join(root, ".audit-tools", "audit", "audit-report.md"),
    join(root, "audit-report.md"),
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
  // Default discovery probes the same logical artifact (the audit output) in
  // several canonical locations and two formats. Select the single
  // highest-priority match — never feed both the structured contract and its
  // markdown render — so a lone .json input takes the lossless structured
  // fast-path instead of being demoted to multi-source LLM extraction.
  const best = checked.find((candidate) => existsSync(candidate));
  return {
    supplied: false,
    existing: best ? [best] : [],
    missing: [],
    checked,
  };
}

function formatAllowed(command: string): string {
  return `- \`${command}\``;
}

export type {
  FindingRiskTier,
  FindingClassification,
} from "./stepUtils.js";
export {
  NO_CHANGE_RE,
  isTerminalStatus,
  dependenciesSatisfied,
  specIndicatesNoChange,
  classifyFindingRisk,
} from "./stepUtils.js";

function documentableFindings(state: RemediationState): Finding[] {
  if (!state.plan || !state.items) return [];
  return state.plan.findings.filter(
    (finding) => state.items?.[finding.id]?.status === "pending",
  );
}

function implementableBlocks(state: RemediationState): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter(
    (block) =>
      dependenciesSatisfied(block, state) &&
      block.items.some((findingId) => {
        const item = state.items?.[findingId];
        return item?.status === "documented" && Boolean(item.item_spec);
      }),
  );
}

function resolvedOrTerminalItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) =>
    isTerminalStatus(item.status),
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

async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
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
          ...integrity.io_errors.map((p) => `io-error: ${p}`),
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

After all results exist:

${DO_NOT_TOKEN_WRAP_NOTE}

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

// Shapes of the reviewed / preliminary risk-classification entries that drive
// the implement-preview tables. Module-scoped so the render helpers below can be
// hoisted out of the state-machine loop rather than re-created per invocation.
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

function isNoOpFinding(
  prelimMap: Map<string, PrelimEntry>,
  findingId: string,
): boolean {
  return specIndicatesNoChange(prelimMap.get(findingId));
}

function renderTierSection(
  reviewedMap: Map<string, ReviewedEntry>,
  prelimMap: Map<string, PrelimEntry>,
  tier: string,
  label: string,
): string {
  const matches = [...reviewedMap.values()].filter(
    (e) => e.tier === tier && !isNoOpFinding(prelimMap, e.finding_id),
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

function renderNoOpSection(
  reviewedMap: Map<string, ReviewedEntry>,
  prelimMap: Map<string, PrelimEntry>,
): string {
  const noOps = [...reviewedMap.values()].filter((e) =>
    isNoOpFinding(prelimMap, e.finding_id),
  );
  if (noOps.length === 0) return "";
  const rows = noOps.map((e) => {
    const title = (prelimMap.get(e.finding_id)?.title ?? "—").replaceAll("|", "\\|");
    return `- **${e.finding_id}**: ${title}`;
  });
  return `## Already Correct (no changes planned)\n\n${rows.join("\n")}`;
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
        // Build the risk preview from EVERY block with documented work, not just
        // the dependency-ready wave-1 subset (implementableBlocks is now
        // dependency-gated). The preview/ack is one-shot, so a later dependency
        // wave would otherwise bypass the user's risk review entirely.
        for (const block of state.plan?.blocks ?? []) {
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

      const sections = [
        renderTierSection(reviewedMap, prelimMap, "safe", "Tier 1 — Unambiguously Good"),
        renderTierSection(reviewedMap, prelimMap, "substantive", "Tier 2 — Substantive"),
        renderTierSection(reviewedMap, prelimMap, "context_dependent", "Tier 3 — Context-Dependent"),
        renderNoOpSection(reviewedMap, prelimMap),
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
   marked \`deemed_inappropriate\` and never implemented).
3. **Decline entirely** — stop without making any source changes.

If the user approves (all or in part), write the ack to exactly:

\`${previewAckPath}\`

\`\`\`json
{ "status": "confirmed", "skip": ["FINDING-ID-TO-EXCLUDE"] }
\`\`\`

Use an empty \`skip\` array (\`[]\`) when the user approves everything; otherwise
list the exact finding IDs they chose to skip.

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

    // The preview ack may approve only part of the plan: honor the skip list by
    // marking those findings deemed_inappropriate so they are excluded from the
    // implement dispatch (and cannot be resurrected by a worker result).
    const previewAck = await readOptionalJsonFile<{ status?: string; skip?: unknown }>(
      previewAckPath,
    );
    const skipIds = Array.isArray(previewAck?.skip)
      ? previewAck.skip.filter((id): id is string => typeof id === "string")
      : [];
    if (previewAck?.status === "declined") {
      let changed = false;
      for (const it of Object.values(state.items ?? {})) {
        if (!["resolved", "blocked", "deemed_inappropriate"].includes(it.status)) {
          it.status = "deemed_inappropriate";
          it.failure_reason = "Implementation declined by the user at the preview step.";
          changed = true;
        }
      }
      if (changed) await new StateStore(artifactsDir).saveState(state);
      return { continueWithState: state };
    }
    if (skipIds.length > 0) {
      let changed = false;
      for (const id of skipIds) {
        const it = state.items?.[id];
        if (it && it.status !== "deemed_inappropriate") {
          it.status = "deemed_inappropriate";
          it.failure_reason = "Skipped by the user at the implementation preview.";
          changed = true;
        }
      }
      if (changed) await new StateStore(artifactsDir).saveState(state);
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
    // Everything implementable may already be done or skipped (e.g. every Tier 3
    // finding excluded) — fold straight to merge rather than dispatching a wave
    // of zero workers.
    if (dispatchPlan.items.length === 0) {
      return {
        continueWithState: await mergeImplementResults({ root, artifactsDir }, runId),
      };
    }
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

After all results exist:

${DO_NOT_TOKEN_WRAP_NOTE}

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

// --- Per-state handlers -----------------------------------------------------
// Each handler owns one branch of the original decideNextStepInner dispatch.
// Handlers that emit a step return RemediationStep directly; handlers that need
// the loop to continue with mutated state return { continueWithState }.

async function handleComplete(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  return presentReportStep(root, artifactsDir, state);
}

async function handlePendingExtractedPlan(
  root: string,
  artifactsDir: string,
  existing: RemediationState,
  extractedPlan: unknown,
): Promise<RemediationState | null> {
  try {
    const normalized = normalizeExtractedPlan(extractedPlan);
    const pipelined = await applyPlanPipeline(normalized, { root, artifactsDir });
    return await saveStateForPlan(artifactsDir, existing, pipelined);
  } catch (error) {
    const paths = intakePaths(artifactsDir);
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.extractedPlan);
    } catch { /* already gone */ }
    process.stderr.write(
      `[remediate-code] Corrupted extracted-plan.json removed (${error instanceof Error ? error.message : String(error)}). Re-emitting extraction step.\n`,
    );
    return null;
  }
}

async function handlePendingIntake(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
  store: StateStore,
): Promise<RemediationStep | RemediationState | null> {
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
  return intakeResult.state;
}

async function handleNoState(
  root: string,
  artifactsDir: string,
): Promise<RemediationStep> {
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

async function handleInputConflict(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  inputResolution: InputResolution,
): Promise<RemediationStep> {
  const planId = state.plan?.plan_id ?? "(none)";
  const itemCount = state.items ? Object.keys(state.items).length : 0;
  const suppliedInline =
    inputResolution.checked.length > 0
      ? inputResolution.checked.map((p) => `\`${p}\``).join(", ")
      : "(input supplied)";
  return writeCurrentStep({
    stepKind: "input_conflict",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# New \`--input\` given, but a remediation run is already in progress

A remediation run already exists in \`${artifactsDir}\` and has advanced past intake,
so the new \`--input\` you passed will **not** replace it — it would be ignored and the
existing plan resumed.

- **Current state**: \`${state.status}\`
- **Plan**: \`${planId}\` (${itemCount} item(s))
- **Supplied input**: ${suppliedInline}

Choose one explicitly and report the choice to the user:

1. **Resume the existing run** — re-run WITHOUT \`--input\`: \`${loaderCommand("next-step")}\`
2. **Start fresh from the new input** — first move aside or delete the existing
   \`${artifactsDir}\` directory (and the stale \`remediation-report.md\` /
   \`remediation-report.json\` in \`.audit-tools/\`, which would otherwise be overwritten on completion),
   then re-run \`${loaderCommand("next-step --input <path>")}\`.

Stop after presenting this choice. Do not advance the run until the user decides.
`,
    allowedCommands: [
      loaderCommand("next-step"),
      loaderCommand("next-step --input <path>"),
    ],
    stopCondition:
      "Stop after presenting the resume-vs-restart choice to the user.",
    artifactPaths: {
      state_file: join(artifactsDir, "state.json"),
    },
  });
}

async function handleWaitingForClarification(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
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

async function handleWaitingForTriage(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
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

async function handlePlanning(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  options: NextStepOptions,
): Promise<DispatchOutcome> {
  const pendingFindings = documentableFindings(state);
  return buildDocumentDispatchStep({ root, artifactsDir, state, options, pendingFindings });
}

async function handleDocumenting(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  options: NextStepOptions,
  store: StateStore,
): Promise<DispatchOutcome> {
  const implementBlocks = implementableBlocks(state);
  if (implementBlocks.length > 0) {
    if (state.plan) {
      const integrity = await checkAffectedFileIntegrity(root, state.plan.findings);
      if (!integrity.is_clean) {
        const details = [
          ...integrity.changed.map((p) => `changed: ${p}`),
          ...integrity.missing.map((p) => `missing: ${p}`),
          ...integrity.io_errors.map((p) => `io-error: ${p}`),
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
    return buildImplementDispatchStep({ root, artifactsDir, state, options, implementBlocks });
  }

  // No dependency-ready block remains. Any item still 'documented' is stuck on a
  // dependency that failed (a prerequisite block was blocked) or is part of a
  // cycle — mark it blocked rather than stranding un-implementable documented work.
  for (const it of Object.values(state.items ?? {})) {
    if (it.status === "documented" && it.item_spec) {
      it.status = "blocked";
      it.failure_reason =
        it.failure_reason ??
        "Block dependencies were not satisfied (a prerequisite block was blocked, or dependencies are cyclic).";
    }
  }
  state.status = "implementing";
  await store.saveState(state);
  return { continueWithState: state };
}

async function handleImplementing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
): Promise<DispatchOutcome> {
  const triageStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
  const triaged = await runTriagePhase(state, { root, artifactsDir });
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
  await store.saveState(triaged);
  return { continueWithState: triaged };
}

async function handleAllTerminalTransition(
  state: RemediationState,
  store: StateStore,
): Promise<DispatchOutcome> {
  state.status = "closing";
  await store.saveState(state);
  return { continueWithState: state };
}

async function handleClosing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
): Promise<DispatchOutcome> {
  const closeStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });
  const closed = await runClosePhase(state, { root, artifactsDir }, runLogger);
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
  if (closed.status !== "complete") {
    await store.saveState(closed);
  }
  return { continueWithState: closed };
}

async function handleUnhandledState(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
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
  let countedStateStep = false;
  const countStateStep = async (): Promise<void> => {
    if (!state || countedStateStep) return;
    if (!state.started_at) {
      state.started_at = new Date().toISOString();
    }
    state.step_count = (state.step_count ?? 0) + 1;
    countedStateStep = true;
    await store.saveState(state);
  };

  const inputResolution = resolveInputPaths(root, options.input);

  // A new --input against a run that already advanced past intake must not
  // silently resume the old plan (nor silently complete on a stale report).
  // Require the caller to choose resume-vs-restart explicitly.
  if (inputResolution.supplied && state != null && state.status !== "pending") {
    await countStateStep();
    return handleInputConflict(root, artifactsDir, state, inputResolution);
  }

  // A finished run deletes .remediation-artifacts/ at close (state.json included),
  // leaving only the root report. On a bare re-invocation with NO fresh-run intent
  // (no --input, no conversation brief, no extracted plan), re-present that report
  // instead of asking for a new starting point. Any fresh intent falls through and
  // starts a new run, ignoring the stale report.
  if (
    state == null &&
    !inputResolution.supplied &&
    existsSync(join(dirname(artifactsDir), "remediation-report.md"))
  ) {
    const ip = intakePaths(artifactsDir);
    const freshIntent =
      existsSync(ip.conversationStart) || existsSync(ip.extractedPlan);
    if (!freshIntent) {
      return handleComplete(root, artifactsDir, state);
    }
  }

  // A leftover remediation-report.md while a fresh run IS being started will be
  // overwritten at close — warn rather than treating it as "done".
  if (
    existsSync(join(dirname(artifactsDir), "remediation-report.md")) &&
    state?.status !== "complete"
  ) {
    process.stderr.write(
      "[remediate-code] A previous remediation-report.md exists in .audit-tools/; it will be overwritten when this run completes.\n",
    );
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (state?.status === "complete") {
      await countStateStep();
      return handleComplete(root, artifactsDir, state);
    }

    if (!state) {
      const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
      if (extractedPlan) {
        state = await handlePendingExtractedPlan(
          root,
          artifactsDir,
          { status: "pending" },
          extractedPlan,
        );
      }
    }

    if (!state) {
      const intakeOutcome = await handlePendingIntake(root, artifactsDir, options, store);
      if (intakeOutcome && "step_kind" in intakeOutcome) return intakeOutcome;
      state = intakeOutcome;
    }

    if (!state) {
      return handleNoState(root, artifactsDir);
    }

    await countStateStep();

    if (state.status === "waiting_for_clarification") {
      return handleWaitingForClarification(root, artifactsDir, state);
    }

    if (state.status === "waiting_for_triage") {
      return handleWaitingForTriage(root, artifactsDir, state);
    }

    if (state.status === "planning" && documentableFindings(state).length > 0) {
      const outcome = await handlePlanning(root, artifactsDir, state, options);
      if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
      return outcome;
    }

    if (state.status === "documenting") {
      const outcome = await handleDocumenting(root, artifactsDir, state, options, store);
      if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
      return outcome;
    }

    if (state.status === "implementing" || state.status === "triage") {
      const outcome = await handleImplementing(root, artifactsDir, state, runLogger, store);
      if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
      return outcome;
    }

    if (allItemsTerminal(state) && state.status !== "closing") {
      const outcome = await handleAllTerminalTransition(state, store);
      if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
      return outcome;
    }

    if (state.status === "closing") {
      const outcome = await handleClosing(root, artifactsDir, state, runLogger, store);
      if ("continueWithState" in outcome) { state = outcome.continueWithState; continue; }
      return outcome;
    }

    return handleUnhandledState(root, artifactsDir, state);
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
