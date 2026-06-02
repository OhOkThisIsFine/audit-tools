import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import { renderCommand } from "./args.js";

/**
 * Token prefix the host should use to re-invoke the backend in generated
 * continuation commands. Defaults to the `audit-code` bin (correct for an
 * installed global). The wrapper sets `AUDIT_CODE_INVOCATION` to e.g.
 * `["node","<path>/audit-code.mjs"]` when it runs from a source checkout, so a
 * dogfooded monorepo run keeps generated commands pinned to local code instead
 * of silently falling back to a globally-installed `audit-code`.
 */
function cliInvocationTokens(): string[] {
  const raw = process.env.AUDIT_CODE_INVOCATION;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((t) => typeof t === "string" && t.length > 0)
      ) {
        return parsed as string[];
      }
    } catch {
      // malformed override — fall back to the default bin
    }
  }
  return ["audit-code"];
}

export function nextStepCommand(root: string, artifactsDir: string): string {
  return renderCommand([
    ...cliInvocationTokens(),
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
    ...cliInvocationTokens(),
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
  // Only mention model_hint when the host can actually act on it. When it
  // cannot, the field is left as inert plan metadata rather than surfacing a
  // contradictory "here is model_hint, now ignore it" instruction.
  const modelLine = params.hostCanSelectSubagentModel
    ? "When launching each subagent, map `entry.model_hint.tier` (`small`, `standard`, `deep`) to an available host model without asking the user for model names."
    : null;
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
        "",
        'If a subagent reports a host session/usage limit (e.g. "hit your session limit · resets <time>") instead of submitting its result, do not immediately re-dispatch it: run merge-and-ingest with the results you did get, then wait until the stated reset time before running next-step to re-dispatch the remaining packets. Re-dispatching into an active limit just loses the wave.',
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
    ...(modelLine ? [modelLine] : []),
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

export function renderEdgeReasoningStepPrompt(params: {
  basePrompt: string;
  resultsPath: string;
  continueCommand: string;
  contentHash: string;
}): string {
  return [
    params.basePrompt,
    "",
    "## Results path",
    "",
    'Write the JSON object ({"rewrites":[{"from":"...","to":"...","kind":"...","reason":"..."}]}) to:',
    "",
    `  ${params.resultsPath}`,
    "",
    `Cache key (edge-set content hash): ${params.contentHash}.`,
    "If you already produced rewrites for this exact key, you may reuse them instead of regenerating.",
    "",
    `Then run: ${params.continueCommand}`,
    "",
    "Read and follow only the new step prompt returned by that command.",
    "",
  ].join("\n");
}

export function renderEdgeReasoningDispatchPrompt(params: {
  promptPath: string;
  resultsPath: string;
  continueCommand: string;
  contentHash: string;
  candidateCount: number;
}): string {
  return [
    "# audit-code edge reasoning (subagent dispatch)",
    "",
    `The dependency graph has ${params.candidateCount} low-confidence edge(s) whose`,
    "machine-generated `reason` text can be clarified. This is a single, bounded,",
    "optional pass: it only rewrites the `reason` string of those edges — it never",
    "adds, removes, re-targets, or re-weights an edge.",
    "",
    "Dispatch exactly ONE subagent (via the `task` tool or equivalent). Hand it this",
    "prompt file path; do not load the file into this orchestrator context:",
    "",
    `  ${params.promptPath}`,
    "",
    "Subagent prompt shape:",
    "",
    "  Read and follow the edge-reasoning instructions in: <prompt path above>",
    "",
    'The subagent must write its JSON result ({"rewrites":[...]}) to:',
    "",
    `  ${params.resultsPath}`,
    "",
    `Cache key (edge-set content hash): ${params.contentHash}.`,
    "If you hold a cached result for this exact key from a previous run, you may write",
    "it to the results path directly instead of dispatching a subagent.",
    "",
    "**File access pre-approval:** if your host supports per-subagent file access",
    `restrictions, allow the subagent to read ${params.promptPath} and write ${params.resultsPath}.`,
    "",
    "After the subagent writes the result, run exactly:",
    "",
    `  ${params.continueCommand}`,
    "",
    "Read and follow only the new step prompt returned by that command.",
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
