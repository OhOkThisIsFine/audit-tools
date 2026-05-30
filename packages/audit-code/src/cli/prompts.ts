import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import { renderCommand } from "./args.js";

export function nextStepCommand(root: string, artifactsDir: string): string {
  return renderCommand([
    "audit-code",
    "next-step",
    "--root",
    root,
    "--artifacts-dir",
    artifactsDir,
  ]);
}

export function mergeAndIngestCommand(
  artifactsDir: string,
  runId: string,
): string {
  return renderCommand([
    "audit-code",
    "merge-and-ingest",
    "--artifacts-dir",
    artifactsDir,
    "--run-id",
    runId,
  ]);
}

export function renderDispatchReviewPrompt(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  dispatchPlanPath: string;
  dispatchQuotaPath: string | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
}): string {
  const mergeCommand = mergeAndIngestCommand(
    params.artifactsDir,
    params.activeReviewRun.run_id,
  );
  const continueCommand = nextStepCommand(params.root, params.artifactsDir);
  const modelLine = params.hostCanSelectSubagentModel
    ? "When launching each subagent, map `entry.model_hint.tier` (`small`, `standard`, `deep`) to an available host model without asking the user for model names."
    : "Ignore `entry.model_hint`; this host did not report per-subagent model selection.";
  const toolsLine = params.hostCanRestrictSubagentTools
    ? "Restrict review subagents to read/search plus the packet submit command named in their prompt. Do not give them source edit/write tools."
    : "Do not ask the user about per-subagent tool restrictions; this host did not report a callable restriction facility.";

  const dispatchDataLines = params.dispatchQuotaPath
    ? [
        "Read these generated files:",
        "",
        `  Dispatch plan:  ${params.dispatchPlanPath}`,
        `  Dispatch quota: ${params.dispatchQuotaPath}`,
        "",
        "Use the `wave_size` from the quota data. If `cooldown_until` is non-null, wait until that timestamp before starting the first wave.",
        "",
        "`host_concurrency_limit` records any detected hard host cap that contributed to `wave_size`.",
        "",
        "For each wave: use the `task` tool (or equivalent subagent dispatch) to launch up to `wave_size` subagents in parallel (one per entry), wait for all to finish, then start the next wave.",
      ]
    : [
        "Read this generated dispatch plan:",
        "",
        `  ${params.dispatchPlanPath}`,
        "",
        "Launch one subagent for each entry in the plan.",
      ];

  return [
    "# audit-code dispatch review",
    "",
    ...dispatchDataLines,
    "",
    "Pass each `entry.prompt_path` literally to its subagent; do not load packet prompt files into this orchestrator context.",
    "",
    "Subagent prompt shape:",
    "",
    '  Read and follow the audit instructions in: <entry.prompt_path>',
    "",
    modelLine,
    toolsLine,
    "",
    "Each subagent must submit its packet through the submit command printed in its packet prompt and stop after successful submission.",
    "",
    "**File access pre-approval:** Each dispatch plan entry includes an `access` object with `read_paths` and `write_paths`. If your host supports per-subagent file access restrictions, pre-approve those paths before launching each subagent. Workers should not access files outside their declared paths.",
    "",
    "**After all waves complete:**",
    "",
    "Run exactly:",
    "",
    `  ${mergeCommand}`,
    "",
    "If merge-and-ingest fails, stop and report the exact command and error output. Do not manually merge results or edit audit state.",
    "",
    "If merge-and-ingest succeeds, run:",
    "",
    `  ${continueCommand}`,
    "",
    "Read and follow only the new step prompt path returned by that command.",
    "",
  ].join("\n");
}

export function renderSingleTaskFallbackStepPrompt(params: {
  singleTaskPromptPath: string;
  activeReviewRun: ActiveReviewRun;
}): string {
  return [
    "# audit-code single-task fallback step",
    "",
    "Use this step only because the host reported no callable subagent facility.",
    "",
    "Read and follow exactly this generated single-task prompt:",
    "",
    `  ${params.singleTaskPromptPath}`,
    "",
    "Complete exactly one AuditResult for the task named there, write the JSON array to the prompt's audit_results_path, run the exact worker_command from that prompt, then stop.",
    "",
    "Do not run dispatch commands, do not prepare packets, do not run next-step again in this turn, and do not read a report after the worker command.",
    "",
    "The only backend command allowed after writing the result is:",
    "",
    `  ${renderCommand(params.activeReviewRun.worker_command)}`,
    "",
  ].join("\n");
}

export function renderPresentReportPrompt(finalReportPath: string): string {
  return [
    "# audit-code present report",
    "",
    "The deterministic audit is complete.",
    "",
    `Read the final audit report from: ${finalReportPath}`,
    "",
    "Present the completed audit with work blocks first.",
    "",
    "Do not run the orchestrator again for this completed audit.",
    "",
  ].join("\n");
}

export function renderAnalyzerInstallPrompt(params: {
  unresolved: AnalyzerPlanEntry[];
  decisionsPath: string;
  continueCommand: string;
}): string {
  const analyzerLines = params.unresolved.flatMap((entry) => [
    `- **${entry.id}** — needs \`${entry.dependency ?? entry.id}\`; ${entry.supportedCount} in-scope file(s) would be analyzed.`,
  ]);
  const exampleObject = `{ ${params.unresolved
    .map((entry) => `"${entry.id}": "ephemeral"`)
    .join(", ")} }`;

  return [
    "# audit-code analyzer install",
    "",
    "The deterministic regex graph is built. These optional language analyzers can",
    "produce a richer graph (real module resolution, inheritance, and a call graph),",
    "but their compiler dependency is not installed in the audited repo:",
    "",
    ...analyzerLines,
    "",
    "Choose how to resolve each one and write a JSON object of `{ \"<analyzer-id>\": <setting> }`",
    "to the decisions path below. Valid settings:",
    "",
    "- `ephemeral` — install into a shared, version-keyed cache (never touches this project); compile once, reuse across audits.",
    "- `permanent` — same as `ephemeral` but a durable opt-in recorded in session config.",
    "- `skip` — do not run this analyzer; keep the regex floor.",
    "",
    "Default if you are unsure or cannot install: choose `skip`. The audit proceeds either way.",
    "",
    "## Decisions path",
    "",
    "Write your choices to:",
    "",
    `  ${params.decisionsPath}`,
    "",
    `Example: ${exampleObject}`,
    "",
    `Then run: ${params.continueCommand}`,
    "",
    "Read and follow only the new step prompt returned by that command.",
    "",
  ].join("\n");
}

export function renderBlockedStepPrompt(reason: string): string {
  return [
    "# audit-code blocked",
    "",
    "The audit cannot continue automatically from this step.",
    "",
    "Report this blocker verbatim and stop:",
    "",
    reason,
    "",
  ].join("\n");
}
