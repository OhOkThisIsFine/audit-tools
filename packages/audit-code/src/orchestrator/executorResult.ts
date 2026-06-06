import type { ArtifactBundle } from "../io/artifacts.js";

/**
 * Structured log event emitted during an executor step. Machine consumers should
 * read `log_entries` and `degraded` on `ExecutorRunResult` rather than parsing
 * `progress_summary`.
 */
export interface LogEntry {
  severity: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp_ms: number;
  /** Contextual key/value pairs such as task_id, run_id, analyzer name, file path. */
  context?: Record<string, unknown>;
}

/**
 * Resolved audit scope, emitted by the intake executor so the conversation-first
 * loader can echo what is about to be audited (and gate on confirmation when a
 * mis-scope smell suggests the user targeted the wrong directory).
 */
export interface ScopeSummary {
  /** Absolute path of the resolved repository root being audited. */
  repo_root: string;
  /** Count of files that will actually be audited (after disposition filtering). */
  auditable_file_count: number;
  /** Whether `repo_root` sits inside a git working tree. */
  git_available: boolean;
  /**
   * Zero or more human-readable warnings that the resolved root may be the wrong
   * target (e.g. a non-git subdirectory whose ancestor is a repo, or a workspace
   * member of a parent monorepo). Empty when the scope looks correct.
   */
  mis_scope_smells: string[];
}

/**
 * Uniform result of running one audit executor: the updated artifact bundle, the
 * artifact filenames it wrote (which drive metadata/staleness bookkeeping in
 * advanceAudit), and a one-line human progress summary. Shared by every executor
 * module so they need not depend on the internalExecutors barrel.
 *
 * `progress_summary` is a human-readable one-liner for UI display only. Machine
 * consumers should read `log_entries` and `degraded` instead of parsing it.
 */
export interface ExecutorRunResult {
  updated: ArtifactBundle;
  artifacts_written: string[];
  progress_summary: string;
  /**
   * Optional resolved-scope summary. Only the intake executor sets this; it lets
   * the loader echo the audit target and gate on confirmation when
   * `mis_scope_smells` is non-empty.
   */
  scope_summary?: ScopeSummary;
  /**
   * Structured log events emitted during the step (errors, warnings, partial
   * failures, analyzer skips). Machine consumers should read this instead of
   * parsing `progress_summary`.
   */
  log_entries?: LogEntry[];
  /**
   * Wall-clock milliseconds from executor entry to return, enabling step-latency
   * tracking without string-parsing.
   */
  step_duration_ms?: number;
  /**
   * Set to `true` when the step completed but encountered at least one non-fatal
   * error (e.g. a language-analyzer failure, a line-count error, a missing task
   * artifact). Lets callers detect partial failure without scanning
   * `progress_summary`.
   */
  degraded?: boolean;
}
