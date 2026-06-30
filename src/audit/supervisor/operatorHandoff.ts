import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile, frictionCapturePath } from "audit-tools/shared";
import { type ArtifactBundle, AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import type {
  AuditState,
  AuditTopLevelStatus,
  ObligationState,
} from "../types/auditState.js";
import type { ProviderName } from "audit-tools/shared";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "../providers/constants.js";

export interface AuditCodeHandoffInput {
  flag:
    | "--results"
    | "--batch-results"
    | "--updates"
    | "--external-analyzer-results";
  suggested_path: string;
  description: string;
}

export interface AuditCodeHandoffArtifactPaths {
  incoming_dir: string;
  operator_handoff_json: string;
  operator_handoff_markdown: string;
  session_config: string;
  run_ledger: string;
  current_task: string | null;
  current_prompt: string | null;
  current_tasks: string | null;
  audit_tasks: string | null;
  runtime_validation_tasks: string | null;
  /**
   * The run's friction-capture record path (run_id-keyed, under the artifacts dir).
   * Single-sourced from the shared `frictionCapturePath` so it cannot drift from the
   * close-out writer in `decideAuditFrictionCloseout`.
   */
  friction_record: string;
}

export interface ActiveReviewRun {
  run_id: string;
  task_path: string;
  prompt_path: string;
  pending_audit_tasks_path?: string;
  audit_results_path: string;
  worker_command: string[];
}

export interface AuditCodeHandoff {
  status: AuditTopLevelStatus;
  repo_root: string;
  artifacts_dir: string;
  provider: string | null;
  summary: string;
  pending_obligations: string[];
  suggested_inputs: AuditCodeHandoffInput[];
  suggested_commands: string[];
  interactive_provider_hint: string | null;
  artifact_paths: AuditCodeHandoffArtifactPaths;
  active_review_run?: ActiveReviewRun;
  quick_start?: string;
  file_map?: Record<string, string>;
}

export const INCOMING_DIRNAME = "incoming";
export const OPERATOR_HANDOFF_JSON_FILENAME = "operator-handoff.json";
export const OPERATOR_HANDOFF_MARKDOWN_FILENAME = "operator-handoff.md";
export const SESSION_CONFIG_FILENAME = "session-config.json";
export const RUN_LEDGER_FILENAME = "run-ledger.json";
export const CURRENT_TASK_FILENAME = "current-task.json";
export const CURRENT_PROMPT_FILENAME = "current-prompt.md";
export const CURRENT_TASKS_FILENAME = "current-tasks.json";
export const AUDIT_TASKS_FILENAME = "audit_tasks.json";
export const RUNTIME_VALIDATION_TASKS_FILENAME = "runtime_validation_tasks.json";
const BLOCKED_STATUS: AuditTopLevelStatus = "blocked";
const COMPLETE_STATUS: AuditTopLevelStatus = "complete";
const NOT_STARTED_STATUS: AuditTopLevelStatus = "not_started";
const NON_PENDING_OBLIGATION_STATES = new Set<ObligationState>([
  "present",
  "satisfied",
]);
const INTERACTIVE_PROVIDER_OPTIONS: readonly ProviderName[] = [
  "auto",
  "claude-code",
  "codex",
  "opencode",
  "subprocess-template",
  "vscode-task",
  "antigravity",
];

function quoteShellPath(filePath: string): string {
  // The handoff renders a single shell argument, so the snippet only needs
  // double-quote wrapping plus escaping embedded double quotes.
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

function renderShellCommand(argv: string[]): string {
  return argv.map((item) => quoteShellPath(item)).join(" ");
}

function buildPendingObligations(state: AuditState): string[] {
  return state.obligations
    .filter((item) => !NON_PENDING_OBLIGATION_STATES.has(item.state))
    .map((item) => item.id);
}

function formatQuotedList(values: readonly string[]): string {
  if (values.length === 1) {
    return `"${values[0]}"`;
  }
  const head = values.slice(0, -1).map((value) => `"${value}"`).join(", ");
  return `${head}, or "${values[values.length - 1]}"`;
}

function buildSummary(
  status: AuditTopLevelStatus,
  providerName: string | null,
  fallbackSummary: string,
): string {
  if (status === COMPLETE_STATUS) {
    return "No operator handoff is required. All known obligations are currently satisfied.";
  }

  if (status === BLOCKED_STATUS) {
    return fallbackSummary;
  }

  if (status === NOT_STARTED_STATUS) {
    return "The artifact bundle is not initialized yet. Run the wrapper from the repository root to create the initial audit artifacts.";
  }

  return providerName
    ? `Automatic work can continue under ${providerName}. Re-run the same wrapper or inspect the listed artifacts if you need operator context.`
    : "Automatic work can continue. Re-run the same wrapper or inspect the listed artifacts if you need operator context.";
}

function buildSuggestedInputs(
  artifactsDir: string,
  status: AuditTopLevelStatus,
  isConfigError: boolean,
  activeReviewRun?: ActiveReviewRun,
): AuditCodeHandoffInput[] {
  if (status !== BLOCKED_STATUS || isConfigError) {
    return [];
  }

  if (activeReviewRun) {
    return [];
  }

  const incomingDir = join(artifactsDir, INCOMING_DIRNAME);
  return [
    {
      flag: "--results",
      suggested_path: join(incomingDir, "audit-results.json"),
      description:
        "Import structured audit-review results after manual or provider-assisted review finishes.",
    },
    {
      flag: "--batch-results",
      suggested_path: join(incomingDir, "audit-results-batch"),
      description:
        "Import a directory of per-batch audit result files when the conversation agent reviews multiple tasks before ingestion.",
    },
    {
      flag: "--updates",
      suggested_path: join(incomingDir, "runtime-validation-updates.json"),
      description:
        "Merge runtime validation evidence updates gathered outside the wrapper.",
    },
    {
      flag: "--external-analyzer-results",
      suggested_path: join(incomingDir, "external-analyzer-results.json"),
      description:
        "Import normalized external analyzer results such as Semgrep findings.",
    },
  ];
}

function buildSuggestedCommands(
  artifactsDir: string,
  suggestedInputs: AuditCodeHandoffInput[],
  status: AuditTopLevelStatus,
  activeReviewRun?: ActiveReviewRun,
): string[] {
  if (status !== BLOCKED_STATUS) {
    return [];
  }

  if (activeReviewRun) {
    return [
      renderShellCommand([
        "audit-code",
        "next-step",
        "--artifacts-dir",
        artifactsDir,
      ]),
    ];
  }

  return suggestedInputs.map(
    (item) =>
      `audit-code advance-audit ${item.flag} ${quoteShellPath(item.suggested_path)}`,
  );
}

function buildInteractiveProviderHint(
  status: AuditTopLevelStatus,
  providerName: string | null,
  sessionConfigPath: string,
  isConfigError: boolean,
): string | null {
  if (status !== BLOCKED_STATUS) {
    return null;
  }

  if (isConfigError) {
    return `Configuration error: Verify --root points to the intended repository root and that the tree contains auditable files.`;
  }

  const providerLabel = providerName ?? LOCAL_SUBPROCESS_PROVIDER_NAME;
  return `Provider: ${providerLabel}. This is a deterministic semantic-review handoff, not a failed audit. Use host subagents when the active toolset provides them; otherwise use the single-task fallback and stop after the worker command. For automatic LLM review, configure an interactive provider in ${sessionConfigPath}; that is only needed for backend-launched review.`;
}

// Single source for which artifact paths render in the markdown handoff and how
// absent ones read. renderMarkdown and file_map both source paths from the
// artifact path model (AuditCodeHandoffArtifactPaths), so adding or renaming a
// handoff artifact is one edit here instead of coordinated edits across sites.
const ARTIFACT_PATH_RENDER_FIELDS: ReadonlyArray<{
  label: string;
  key: keyof AuditCodeHandoffArtifactPaths;
  fallback?: string;
}> = [
  { label: "operator handoff json", key: "operator_handoff_json" },
  { label: "operator handoff markdown", key: "operator_handoff_markdown" },
  { label: "incoming dir", key: "incoming_dir" },
  { label: "session config", key: "session_config" },
  { label: "run ledger", key: "run_ledger" },
  { label: "current task", key: "current_task", fallback: "not available" },
  { label: "current prompt", key: "current_prompt", fallback: "not available" },
  { label: "current tasks", key: "current_tasks", fallback: "not available" },
  { label: "audit tasks", key: "audit_tasks", fallback: "not available yet" },
  {
    label: "runtime validation tasks",
    key: "runtime_validation_tasks",
    fallback: "not available yet",
  },
  { label: "friction record", key: "friction_record" },
];

function renderMarkdown(handoff: AuditCodeHandoff): string {
  const lines: string[] = [
    "# audit-code operator handoff",
    "",
    `Status: ${handoff.status}`,
    `Provider: ${handoff.provider ?? "n/a"}`,
    `Repo root: ${handoff.repo_root}`,
    `Artifacts dir: ${handoff.artifacts_dir}`,
    "",
    `Summary: ${handoff.summary}`,
    "",
    "Pending obligations:",
  ];

  if (handoff.pending_obligations.length === 0) {
    lines.push("- none");
  } else {
    for (const obligation of handoff.pending_obligations) {
      lines.push(`- ${obligation}`);
    }
  }

  lines.push("", "Useful artifact paths:");
  for (const field of ARTIFACT_PATH_RENDER_FIELDS) {
    const value = handoff.artifact_paths[field.key];
    lines.push(`- ${field.label}: ${value ?? field.fallback ?? "not available"}`);
  }

  if (handoff.suggested_inputs.length > 0) {
    lines.push("", "Suggested evidence inputs:");
    for (const item of handoff.suggested_inputs) {
      lines.push(`- ${item.flag} -> ${item.suggested_path}`);
      lines.push(`  ${item.description}`);
    }
  }

  if (handoff.suggested_commands.length > 0) {
    lines.push("", "Suggested commands:");
    for (const command of handoff.suggested_commands) {
      lines.push(`- ${command}`);
    }
    if (handoff.active_review_run) {
      lines.push(
        "- Use next-step so the backend renders either packet dispatch or single-task fallback from CLI flags, session config, environment, or the default single-task path.",
      );
    }
  }

  if (handoff.active_review_run) {
    lines.push("", "Active review run:");
    lines.push(`- run id: ${handoff.active_review_run.run_id}`);
    lines.push(`- task file: ${handoff.active_review_run.task_path}`);
    lines.push(`- prompt file: ${handoff.active_review_run.prompt_path}`);
    if (handoff.active_review_run.pending_audit_tasks_path) {
      lines.push(
        `- pending tasks: ${handoff.active_review_run.pending_audit_tasks_path}`,
      );
    }
    lines.push(`- audit results: ${handoff.active_review_run.audit_results_path}`);
  }

  if (handoff.interactive_provider_hint) {
    lines.push("", "Interactive provider hint:");
    lines.push(`- ${handoff.interactive_provider_hint}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function buildAuditCodeHandoff(params: {
  root: string;
  artifactsDir: string;
  state: AuditState;
  bundle: ArtifactBundle;
  providerName?: string | null;
  progressSummary: string;
  isConfigError?: boolean;
  activeReviewRun?: ActiveReviewRun;
  /**
   * The run_id this handoff belongs to. Used only to resolve the run_id-keyed
   * friction-capture record path. Defaults to "run" when the caller has no run_id
   * yet (early/blocked handoffs), matching the shared helper's sanitized fallback.
   */
  runId?: string;
}): AuditCodeHandoff {
  const isConfigError = params.isConfigError ?? false;
  const incomingDir = join(params.artifactsDir, INCOMING_DIRNAME);
  const artifactPaths: AuditCodeHandoffArtifactPaths = {
    incoming_dir: incomingDir,
    operator_handoff_json: join(
      params.artifactsDir,
      OPERATOR_HANDOFF_JSON_FILENAME,
    ),
    operator_handoff_markdown: join(
      params.artifactsDir,
      OPERATOR_HANDOFF_MARKDOWN_FILENAME,
    ),
    session_config: join(params.artifactsDir, SESSION_CONFIG_FILENAME),
    run_ledger: join(params.artifactsDir, RUN_LEDGER_FILENAME),
    current_task:
      params.state.status === BLOCKED_STATUS
        ? join(params.artifactsDir, "dispatch", CURRENT_TASK_FILENAME)
        : null,
    current_prompt:
      params.state.status === BLOCKED_STATUS
        ? join(params.artifactsDir, "dispatch", CURRENT_PROMPT_FILENAME)
        : null,
    current_tasks:
      params.state.status === BLOCKED_STATUS
        ? join(params.artifactsDir, "dispatch", CURRENT_TASKS_FILENAME)
        : null,
    audit_tasks: params.bundle.audit_tasks
      ? join(params.artifactsDir, AUDIT_TASKS_FILENAME)
      : null,
    runtime_validation_tasks: params.bundle.runtime_validation_tasks
      ? join(params.artifactsDir, RUNTIME_VALIDATION_TASKS_FILENAME)
      : null,
    friction_record: frictionCapturePath(
      params.artifactsDir,
      params.runId ?? "run",
    ),
  };
  const suggestedInputs = buildSuggestedInputs(
    params.artifactsDir,
    params.state.status,
    isConfigError,
    params.activeReviewRun,
  );

  const handoff: AuditCodeHandoff = {
    status: params.state.status,
    repo_root: params.root,
    artifacts_dir: params.artifactsDir,
    provider: params.providerName ?? null,
    summary: buildSummary(
      params.state.status,
      params.providerName ?? null,
      params.progressSummary,
    ),
    pending_obligations: buildPendingObligations(params.state),
    suggested_inputs: suggestedInputs,
    suggested_commands: buildSuggestedCommands(
      params.artifactsDir,
      suggestedInputs,
      params.state.status,
      params.activeReviewRun,
    ),
    interactive_provider_hint: buildInteractiveProviderHint(
      params.state.status,
      params.providerName ?? null,
      artifactPaths.session_config,
      isConfigError,
    ),
    artifact_paths: artifactPaths,
    active_review_run: params.activeReviewRun,
  };

  // Add quick_start command and file map when blocked for review
  if (params.state.status === BLOCKED_STATUS && params.activeReviewRun) {
    handoff.quick_start = renderShellCommand([
      "audit-code",
      "next-step",
      "--artifacts-dir",
      params.artifactsDir,
    ]);
    handoff.file_map = {
      current_task: artifactPaths.current_task!,
      current_prompt: artifactPaths.current_prompt!,
      audit_results: params.activeReviewRun.audit_results_path,
      // Synthesis writes the report into the artifacts dir; it is only promoted
      // to <repo-root>/audit-report.md at completion (which then removes the
      // artifacts dir). A blocked-for-review handoff happens before that, so the
      // advertised deliverable must point at its real mid-run location, not the
      // repo-root path that does not exist yet.
      final_report: join(params.artifactsDir, AUDIT_REPORT_FILENAME),
    };
  }

  return handoff;
}

export async function writeAuditCodeHandoffArtifacts(
  handoff: AuditCodeHandoff,
): Promise<void> {
  try {
    await mkdir(handoff.artifact_paths.incoming_dir, { recursive: true });
    await mkdir(join(handoff.artifact_paths.incoming_dir, "audit-results-batch"), {
      recursive: true,
    });
    await writeJsonFile(handoff.artifact_paths.operator_handoff_json, handoff);
    await writeFile(
      handoff.artifact_paths.operator_handoff_markdown,
      renderMarkdown(handoff),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Failed to write operator handoff artifacts: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
