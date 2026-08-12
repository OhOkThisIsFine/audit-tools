import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SESSION_INTENT_RELATIVE_PATH,
  frictionCapturePath,
  renderPromptCommand,
  writeJsonFile,
} from "audit-tools/shared";
import { type ArtifactBundle, AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import type {
  AuditState,
  AuditTopLevelStatus,
  ObligationState,
} from "../types/auditState.js";

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
  operator_inputs_dir: string;
  operator_handoff_json: string;
  operator_handoff_markdown: string;
  session_config: string;
  run_ledger: string;
  current_review_run: string | null;
  current_prompt: string | null;
  current_tasks: string | null;
  audit_tasks: string | null;
  runtime_validation_tasks: string | null;
  friction_record: string;
}

/** Provider-neutral persisted identity for one semantic-review frontier. */
export interface ActiveReviewRun {
  contract_version: "audit-review-run/v1alpha1";
  run_id: string;
  review_run_path: string;
  pending_audit_tasks_path: string;
  host_workload_path: string;
  host_result_map_path: string;
}

export interface AuditCodeHandoff {
  status: AuditTopLevelStatus;
  repo_root: string;
  artifacts_dir: string;
  summary: string;
  pending_obligations: string[];
  suggested_inputs: AuditCodeHandoffInput[];
  suggested_commands: string[];
  artifact_paths: AuditCodeHandoffArtifactPaths;
  active_review_run?: ActiveReviewRun;
  quick_start?: string;
  file_map?: Record<string, string>;
}

/**
 * Where an OPERATOR drops files they pass to a CLI import flag
 * (`--results`, `--batch-results`, `--updates`,
 * `--external-analyzer-results`). Distinct from `submissions/`: those paths are
 * tool-computed and a host may not choose them, whereas these are advisory
 * suggestions for a human who names the file on the command line.
 */
export const OPERATOR_INPUTS_DIRNAME = "operator-inputs";
export const OPERATOR_HANDOFF_JSON_FILENAME = "operator-handoff.json";
export const OPERATOR_HANDOFF_MARKDOWN_FILENAME = "operator-handoff.md";
export const RUN_LEDGER_FILENAME = "run-ledger.json";
export const CURRENT_TASK_FILENAME = "current-review-run.json";
export const CURRENT_TASKS_FILENAME = "current-tasks.json";
export const AUDIT_TASKS_FILENAME = "audit_tasks.json";
export const RUNTIME_VALIDATION_TASKS_FILENAME = "runtime_validation_tasks.json";

const BLOCKED_STATUS: AuditTopLevelStatus = "blocked";
const NON_PENDING_OBLIGATION_STATES = new Set<ObligationState>([
  "present",
  "satisfied",
]);

function buildPendingObligations(state: AuditState): string[] {
  return state.obligations
    .filter((item) => !NON_PENDING_OBLIGATION_STATES.has(item.state))
    .map((item) => item.id);
}

function buildSummary(
  status: AuditTopLevelStatus,
  fallbackSummary: string,
): string {
  if (status === "complete") {
    return "No operator handoff is required. All known obligations are currently satisfied.";
  }
  if (status === BLOCKED_STATUS) return fallbackSummary;
  if (status === "not_started") {
    return "The artifact bundle is not initialized yet. Run the wrapper from the repository root to create the initial audit artifacts.";
  }
  return "Automatic deterministic work can continue. Re-run the same wrapper or inspect the listed artifacts for context.";
}

function buildSuggestedInputs(
  artifactsDir: string,
  status: AuditTopLevelStatus,
  isConfigError: boolean,
  activeReviewRun?: ActiveReviewRun,
): AuditCodeHandoffInput[] {
  if (status !== BLOCKED_STATUS || isConfigError || activeReviewRun) return [];
  const inputsDir = join(artifactsDir, OPERATOR_INPUTS_DIRNAME);
  return [
    {
      flag: "--results",
      suggested_path: join(inputsDir, "audit-results.json"),
      description: "Import structured audit-review results.",
    },
    {
      flag: "--batch-results",
      suggested_path: join(inputsDir, "audit-results-batch"),
      description: "Import a directory of canonical per-task audit results.",
    },
    {
      flag: "--updates",
      suggested_path: join(inputsDir, "runtime-validation-updates.json"),
      description: "Merge runtime validation evidence gathered outside the wrapper.",
    },
    {
      flag: "--external-analyzer-results",
      suggested_path: join(inputsDir, "external-analyzer-results.json"),
      description: "Import normalized external-analyzer results.",
    },
  ];
}

function buildSuggestedCommands(
  artifactsDir: string,
  inputs: AuditCodeHandoffInput[],
  status: AuditTopLevelStatus,
  activeReviewRun?: ActiveReviewRun,
): string[] {
  if (status !== BLOCKED_STATUS) return [];
  if (activeReviewRun) {
    return [renderPromptCommand(["audit-code", "next-step", "--artifacts-dir", artifactsDir])];
  }
  return inputs.map((input) =>
    renderPromptCommand([
      "audit-code",
      input.flag === "--updates" ? "update-runtime-validation" : "ingest-results",
      input.flag,
      input.suggested_path,
      "--artifacts-dir",
      artifactsDir,
    ]),
  );
}

const ARTIFACT_PATH_RENDER_FIELDS: {
  readonly [K in keyof AuditCodeHandoffArtifactPaths]: {
    readonly label: string;
    readonly fallback?: string;
  };
} = {
  operator_handoff_json: { label: "operator handoff json" },
  operator_handoff_markdown: { label: "operator handoff markdown" },
  operator_inputs_dir: { label: "operator inputs dir" },
  session_config: { label: "session intent" },
  run_ledger: { label: "run ledger" },
  current_review_run: { label: "current review run", fallback: "not available" },
  current_prompt: { label: "current prompt", fallback: "not available" },
  current_tasks: { label: "current tasks", fallback: "not available" },
  audit_tasks: { label: "audit tasks", fallback: "not available yet" },
  runtime_validation_tasks: {
    label: "runtime validation tasks",
    fallback: "not available yet",
  },
  friction_record: { label: "friction record" },
};

function renderMarkdown(handoff: AuditCodeHandoff): string {
  const lines = [
    "# audit-code operator handoff",
    "",
    `Status: ${handoff.status}`,
    `Repo root: ${handoff.repo_root}`,
    `Artifacts dir: ${handoff.artifacts_dir}`,
    "",
    `Summary: ${handoff.summary}`,
    "",
    "Pending obligations:",
    ...(handoff.pending_obligations.length > 0
      ? handoff.pending_obligations.map((id) => `- ${id}`)
      : ["- none"]),
    "",
    "Useful artifact paths:",
  ];
  for (const [key, field] of Object.entries(ARTIFACT_PATH_RENDER_FIELDS) as Array<
    [keyof AuditCodeHandoffArtifactPaths, { label: string; fallback?: string }]
  >) {
    lines.push(`- ${field.label}: ${handoff.artifact_paths[key] ?? field.fallback ?? "not available"}`);
  }
  if (handoff.suggested_commands.length > 0) {
    lines.push("", "Suggested commands:");
    lines.push(...handoff.suggested_commands.map((command) => `- ${command}`));
  }
  if (handoff.active_review_run) {
    lines.push(
      "",
      "Active review run:",
      `- run id: ${handoff.active_review_run.run_id}`,
      `- review manifest: ${handoff.active_review_run.review_run_path}`,
      `- pending tasks: ${handoff.active_review_run.pending_audit_tasks_path}`,
      `- host workload: ${handoff.active_review_run.host_workload_path}`,
      `- result bindings: ${handoff.active_review_run.host_result_map_path}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function buildAuditCodeHandoff(params: {
  root: string;
  artifactsDir: string;
  state: AuditState;
  bundle: ArtifactBundle;
  progressSummary: string;
  isConfigError?: boolean;
  activeReviewRun?: ActiveReviewRun;
  runId?: string;
}): AuditCodeHandoff {
  const isConfigError = params.isConfigError ?? false;
  const blocked = params.state.status === BLOCKED_STATUS;
  const artifactPaths: AuditCodeHandoffArtifactPaths = {
    operator_inputs_dir: join(params.artifactsDir, OPERATOR_INPUTS_DIRNAME),
    operator_handoff_json: join(params.artifactsDir, OPERATOR_HANDOFF_JSON_FILENAME),
    operator_handoff_markdown: join(params.artifactsDir, OPERATOR_HANDOFF_MARKDOWN_FILENAME),
    session_config: join(params.root, ...SESSION_INTENT_RELATIVE_PATH.split("/")),
    run_ledger: join(params.artifactsDir, RUN_LEDGER_FILENAME),
    current_review_run: blocked
      ? join(params.artifactsDir, "dispatch", CURRENT_TASK_FILENAME)
      : null,
    current_prompt: blocked
      ? join(params.artifactsDir, "steps", "current-prompt.md")
      : null,
    current_tasks: blocked
      ? join(params.artifactsDir, "dispatch", CURRENT_TASKS_FILENAME)
      : null,
    audit_tasks: params.bundle.audit_tasks
      ? join(params.artifactsDir, AUDIT_TASKS_FILENAME)
      : null,
    runtime_validation_tasks: params.bundle.runtime_validation_tasks
      ? join(params.artifactsDir, RUNTIME_VALIDATION_TASKS_FILENAME)
      : null,
    friction_record: frictionCapturePath(params.artifactsDir, params.runId ?? "run"),
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
    summary: buildSummary(params.state.status, params.progressSummary),
    pending_obligations: buildPendingObligations(params.state),
    suggested_inputs: suggestedInputs,
    suggested_commands: buildSuggestedCommands(
      params.artifactsDir,
      suggestedInputs,
      params.state.status,
      params.activeReviewRun,
    ),
    artifact_paths: artifactPaths,
    ...(params.activeReviewRun ? { active_review_run: params.activeReviewRun } : {}),
  };
  if (blocked && params.activeReviewRun) {
    handoff.quick_start = renderPromptCommand([
      "audit-code",
      "next-step",
      "--artifacts-dir",
      params.artifactsDir,
    ]);
    handoff.file_map = {
      current_review_run: artifactPaths.current_review_run!,
      current_prompt: artifactPaths.current_prompt!,
      host_workload: params.activeReviewRun.host_workload_path,
      host_result_map: params.activeReviewRun.host_result_map_path,
      final_report: join(params.artifactsDir, AUDIT_REPORT_FILENAME),
    };
  }
  return handoff;
}

export async function writeAuditCodeHandoffArtifacts(
  handoff: AuditCodeHandoff,
): Promise<void> {
  try {
    await mkdir(handoff.artifact_paths.operator_inputs_dir, { recursive: true });
    await mkdir(join(handoff.artifact_paths.operator_inputs_dir, "audit-results-batch"), {
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
      `Failed to write operator handoff artifacts: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
