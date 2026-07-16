import {
  DISPATCH_PROMPT_HANDOFF_NOTE,
  renderHostScratchNote,
  hostScratchDir,
  renderQuotaCoverageNudge,
  renderTokenBudgetView,
  buildFrictionTriageBlock,
  type FrictionTriageDecision,
  type AuditorDescriptor,
} from "audit-tools/shared";
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

/**
 * Render an {@link AuditorDescriptor} back to the single re-parseable `--auditor
 * <json>` transport (G1 collapsed the former `--host-*` flag bag; G2 folded the
 * provider identity + launch blocks onto `self` and resliced dispatch backends to
 * `sources[]`). Returns `[]` when the descriptor is undefined OR carries nothing —
 * no declared `self` field, no sources, no id/timestamp — so a host with no
 * handshake emits a bare continue-command exactly as before. Otherwise the whole
 * descriptor is JSON-serialized (`JSON.stringify` drops `undefined` self fields).
 */
export function renderAuditorDescriptor(
  descriptor: AuditorDescriptor | undefined,
): string[] {
  if (!descriptor) return [];
  const selfHasField =
    !!descriptor.self &&
    Object.values(descriptor.self).some((value) => value !== undefined);
  const hasContent =
    selfHasField ||
    (descriptor.sources != null && descriptor.sources.length > 0) ||
    descriptor.auditor_id != null ||
    descriptor.resolved_at != null;
  if (!hasContent) return [];
  return ["--auditor", JSON.stringify(descriptor)];
}

export function nextStepCommand(
  root: string,
  artifactsDir: string,
  auditorDescriptor?: AuditorDescriptor,
): string {
  return renderCommand([
    ...cliInvocationTokens(),
    "next-step",
    "--root",
    root,
    "--artifacts-dir",
    artifactsDir,
    ...renderAuditorDescriptor(auditorDescriptor),
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

/**
 * Build the dispatch data lines (plan/quota reading instructions) shared
 * between the dispatch-review and rolling-dispatch prompts.
 */
function buildDispatchDataLines(
  dispatchPlanPath: string,
  dispatchQuotaPath: string | null,
  sessionLimitNote: string,
  driverInstruction?: string,
): string[] {
  return dispatchQuotaPath
    ? [
        "Read these generated files:",
        "",
        `  Dispatch plan:  ${dispatchPlanPath}`,
        `  Dispatch quota: ${dispatchQuotaPath}`,
        "",
        "The tool has already ADMITTED the set of packets that fit the live budget this pass: dispatch EXACTLY the entries whose `packet_id` is in `admission.granted_packet_ids` (in the quota data) — no more, no fewer. That granted set IS the amount of work to run now; there is no separate concurrency number to read or guess. If `cooldown_until` is non-null, wait until that timestamp before dispatching.",
        "",
        "If `admission.declared_cap` is non-null, it is a hard environment in-flight limit (e.g. a nested-agent host's cap): keep at most that many granted subagents running at once, refilling from the granted set as each completes. Otherwise run the granted set as your host allows. If you hit a rate limit (429/TPM/RPM), pause until the reset time clears, then continue.",
        "",
        "When every granted packet's result is captured, run merge-and-ingest, then run next-step: the tool reconciles the grant and admits the next affordable set (any packets not granted this pass are deferred, not dropped).",
        // S-BROKER-WIRING: the tool-chosen driver (delegate the rolling loop to a
        // dispatcher subagent vs. drive it from the top host). Single-sourced via
        // renderDispatchDriverInstruction so audit + remediate can't drift.
        ...(driverInstruction ? ["", driverInstruction] : []),
        "",
        sessionLimitNote,
      ]
    : [
        "Read this generated dispatch plan:",
        "",
        `  ${dispatchPlanPath}`,
        "",
        "Launch one subagent for each entry in the plan.",
      ];
}

export function renderDispatchReviewPrompt(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  dispatchPlanPath: string;
  dispatchQuotaPath: string | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
  driverInstruction?: string;
  /** The current driver's handshake, re-emitted onto the continue-command. */
  hostDescriptor?: AuditorDescriptor;
}): string {
  const mergeCommand = mergeAndIngestCommand(
    params.artifactsDir,
    params.activeReviewRun.run_id,
  );
  const continueCommand = nextStepCommand(params.root, params.artifactsDir, params.hostDescriptor);
  // Only mention model_hint when the host can actually act on it. When it
  // cannot, the field is left as inert plan metadata rather than surfacing a
  // contradictory "here is model_hint, now ignore it" instruction.
  const modelLine = params.hostCanSelectSubagentModel
    ? "When launching each subagent, map `entry.model_hint.tier` (`small`, `standard`, `deep`) to an available host model without asking the user for model names."
    : null;
  const toolsLine = params.hostCanRestrictSubagentTools
    ? "Restrict review subagents to read/search plus the packet submit command named in their prompt. Do not give them source edit/write tools."
    : "Do not ask the user about per-subagent tool restrictions; this host did not report a callable restriction facility.";

  const dispatchDataLines = buildDispatchDataLines(
    params.dispatchPlanPath,
    params.dispatchQuotaPath,
    'If a subagent reports a host session/usage limit (e.g. "hit your session limit · resets <time>") instead of submitting its result, do not immediately re-dispatch it: run merge-and-ingest with the results you did get, then wait until the stated reset time before running next-step to re-dispatch the remaining packets.',
    params.driverInstruction,
  );

  const quotaCoverageNudge = renderQuotaCoverageNudge(
    params.dispatchQuotaPath,
    params.artifactsDir,
  );
  const tokenBudgetView = renderTokenBudgetView(params.dispatchQuotaPath);

  return [
    "# audit-code dispatch review",
    "",
    ...dispatchDataLines,
    "",
    ...(quotaCoverageNudge ? [quotaCoverageNudge, ""] : []),
    ...(tokenBudgetView ? [tokenBudgetView, ""] : []),
    DISPATCH_PROMPT_HANDOFF_NOTE,
    "",
    renderHostScratchNote(
      hostScratchDir(params.artifactsDir, params.activeReviewRun.run_id),
    ),
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
    "**File access pre-approval:** Each dispatch plan entry includes an `access` object with `read_paths`, `write_paths`, and `forbidden_patterns`. If your host supports per-subagent file access restrictions, pre-approve exactly `entry.access.read_paths` and `entry.access.write_paths` for each subagent. Do not grant broad workspace or task-results directory write access. Workers should not access files outside their declared paths.",
    "",
    "**After all packets complete:**",
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
    "Dispatch exactly ONE subagent (via the `task` tool or equivalent).",
    "",
    DISPATCH_PROMPT_HANDOFF_NOTE,
    "",
    `  Prompt path: ${params.promptPath}`,
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

/**
 * Host prompt for the rolling dispatch step.
 * Each worker writes its own AuditResult[] to `entry.result_path` (an inline
 * return is a fallback the host captures). Ingestion is folded into the same
 * logical turn: after all packets complete the host runs merge-and-ingest once,
 * then next-step.
 */
export function renderRollingDispatchPrompt(params: {
  root: string;
  artifactsDir: string;
  runId: string;
  dispatchPlanPath: string;
  dispatchQuotaPath: string | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
  driverInstruction?: string;
  /** The current driver's handshake, re-emitted onto the continue-command. */
  hostDescriptor?: AuditorDescriptor;
}): string {
  const mergeCommand = mergeAndIngestCommand(params.artifactsDir, params.runId);
  const continueCommand = nextStepCommand(params.root, params.artifactsDir, params.hostDescriptor);

  const modelLine = params.hostCanSelectSubagentModel
    ? "When launching each subagent, map `entry.model_hint.tier` (`small`, `standard`, `deep`) to an available host model without asking the user for model names."
    : null;
  const toolsLine = params.hostCanRestrictSubagentTools
    ? "Restrict review subagents to read/search tools plus a Write tool scoped to their own `entry.result_path` (they write exactly that one results file and run no shell commands). Do not give them source edit tools."
    : "Do not ask the user about per-subagent tool restrictions; this host did not report a callable restriction facility.";

  const dispatchDataLines = buildDispatchDataLines(
    params.dispatchPlanPath,
    params.dispatchQuotaPath,
    'If a subagent reports a host session/usage limit instead of emitting its result, run merge-and-ingest with the results you did get, then wait until the stated reset time before running next-step to re-dispatch the remaining packets.',
    params.driverInstruction,
  );

  return [
    "# audit-code rolling dispatch",
    "",
    ...dispatchDataLines,
    "",
    DISPATCH_PROMPT_HANDOFF_NOTE,
    "",
    renderHostScratchNote(hostScratchDir(params.artifactsDir, params.runId)),
    "",
    "## Result capture (no submit-packet command)",
    "",
    "Pass `entry.prompt_path` to each subagent as its instruction verbatim — the",
    "prompt is self-contained (scope, file grants, output schema, and its",
    "`result_path`). Do not restate it in your dispatch message.",
    "Each worker writes its own AuditResult[] JSON array to its assigned",
    "`entry.result_path` and replies with a one-line confirmation; keeping the",
    "worker payloads out of this conversation is what lets a large fan-out scale.",
    "Fallback: if a worker returns the AuditResult[] inline instead of writing it,",
    "extract the JSON array from its reply and write it to `entry.result_path`",
    "yourself. Do NOT run submit-packet or any shell command to record results.",
    "",
    "**Record token usage (enables quota calibration):** a dispatched subagent",
    "cannot see its own harness-measured token spend — only you (the dispatching",
    "host) see it, in the usage/cost figures your own subagent-dispatch tool",
    "reports once that subagent's turn completes. When your host surfaces that",
    "figure, add it to EVERY result object the corresponding subagent wrote to",
    "its `entry.result_path`, as `token_usage: { input_tokens, output_tokens }`",
    "(re-read the file, add the field to each array entry, write it back). This",
    "is optional — omitting it never blocks a result from being accepted — but",
    "it is what lets the tool learn your real quota headroom instead of staying",
    "capped at a conservative cold-start batch. Skip it if your host reports no",
    "per-dispatch usage figure.",
    "",
    ...(modelLine ? [modelLine] : []),
    toolsLine,
    "",
    "**File access pre-approval:** Each dispatch plan entry includes an `access` object. If your host supports per-subagent file access restrictions, pre-approve exactly `entry.access.read_paths` for reading and grant write access to that subagent's `entry.result_path` (the one file it writes). Do not grant broader workspace or task-results directory write access.",
    "",
    "**After all packets complete:**",
    "",
    "Run exactly:",
    "",
    `  ${mergeCommand}`,
    "",
    "If merge-and-ingest fails, stop and report the exact command and error output.",
    "",
    "If merge-and-ingest succeeds, run:",
    "",
    `  ${continueCommand}`,
    "",
    "Read and follow only the new step prompt path returned by that command.",
    "",
  ].join("\n");
}

export function renderPresentReportPrompt(
  finalReportPath: string,
  triage?: FrictionTriageDecision,
): string {
  const frictionBlock = triage ? buildFrictionTriageBlock(triage) : "";
  if (triage?.action === "dispose") {
    return [
      "# audit-code friction triage",
      "",
      "Complete friction triage before the audit report is presented.",
      frictionBlock,
    ].join("\n");
  }
  return [
    "# audit-code present report",
    "",
    "The deterministic audit is complete.",
    "",
    `Read the final audit report from: ${finalReportPath}`,
    "",
    "Present the completed audit with work blocks first.",
    frictionBlock,
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
