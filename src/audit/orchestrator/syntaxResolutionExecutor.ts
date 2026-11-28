import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  upsertExternalToolResults,
  type ExternalAnalyzerResults,
  type ExternalAnalyzerResultItem,
  type ExternalAnalyzerToolStatus,
  type AnalyzerConsentDecisions,
} from "audit-tools/shared";
import {
  EXTERNAL_ANALYZER_STATUS_CLASSIFICATION,
  isNonCleanAnalyzerCoverage,
} from "../../shared/analyzers/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodeTool, runFirstAvailableCommand } from "./localCommands.js";

/** Flat config — the only form ESLint 9+ discovers, and readable by 8.21+ as well. */
const FLAT_ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

/** Legacy `.eslintrc*` config — NOT read by ESLint 9+, whatever the file says. */
const LEGACY_ESLINT_CONFIG_FILES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

/**
 * The major in which flat config became the default: ESLint 9 stopped reading
 * `.eslintrc*` and removed `--ext` (flat config discovers its own files, and the
 * flag is rejected as an unrecognized option).
 */
const FLAT_CONFIG_ESLINT_MAJOR = 9;

const TSCONFIG_FILES = [
  "tsconfig.json",
  "tsconfig.build.json",
  "jsconfig.json",
];

function hasTypeScriptConfig(root: string): boolean {
  return TSCONFIG_FILES.some((file) => existsSync(join(root, file)));
}

/**
 * The major version of the eslint the AUDITED repo actually installs, read from
 * its own `node_modules/eslint/package.json`. `undefined` when no repo-local
 * eslint is installed (the run would fall back to whatever is on PATH, whose
 * version is unknowable without spawning it).
 */
function readInstalledEslintMajor(root: string): number | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "node_modules", "eslint", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof manifest.version !== "string") {
      return undefined;
    }
    const major = Number.parseInt(manifest.version.replace(/^\D*/, ""), 10);
    return Number.isFinite(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the installed eslint still reads legacy `.eslintrc*` config and accepts
 * `--ext`. An UNKNOWN major is treated as modern: omitting `--ext` on an old
 * eslint merely narrows the scanned file set, while passing it to a modern one
 * produces no output at all, and believing a legacy config is live under a modern
 * eslint reports a lint run that never happened.
 */
function readsLegacyEslintConfig(major: number | undefined): boolean {
  return major !== undefined && major < FLAT_CONFIG_ESLINT_MAJOR;
}

/**
 * The eslint argv for the installed major. `--ext` was removed in ESLint 9 and is
 * a hard "unrecognized option" there, which kills the whole JSON run and lands it
 * on `parse_error` — i.e. lint extraction failed on every flat-config repo,
 * including this one (COR-743d2837).
 */
export function eslintCommandArgs(major: number | undefined): string[] {
  return readsLegacyEslintConfig(major)
    ? [".", "--ext", ".ts,.js,.tsx,.jsx", "--format", "json"]
    : [".", "--format", "json"];
}

/** Whether the repo's `package.json` carries a legacy inline `eslintConfig` key. */
function hasPackageJsonEslintConfig(root: string): boolean {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      eslintConfig?: unknown;
    };
    return packageJson.eslintConfig !== undefined;
  } catch {
    return false;
  }
}

export interface EslintConfigState {
  /** True only when a config the INSTALLED eslint actually reads is present. */
  runnable: boolean;
  /** Why no run is possible. Always set, and non-empty, when `runnable` is false. */
  skip_reason?: string;
  /** The repo-local eslint major, when one is installed. */
  major?: number;
}

/**
 * Decide whether eslint can produce coverage for this repo, era-aware.
 *
 * A legacy `.eslintrc*` (or an inline `package.json#eslintConfig`) is a config
 * file, but under ESLint 9+ it is one nothing reads — treating its presence as
 * "lint is runnable" invokes a tool that cannot possibly report findings, which
 * is the success-shaped-empty failure this contract forbids. The skip carries a
 * reason so "no config at all" and "config the installed eslint ignores" are
 * distinguishable at the status record, never both silently zero findings.
 */
export function resolveEslintConfigState(root: string): EslintConfigState {
  const major = readInstalledEslintMajor(root);
  const base = major === undefined ? {} : { major };

  if (FLAT_ESLINT_CONFIG_FILES.some((file) => existsSync(join(root, file)))) {
    return { ...base, runnable: true };
  }

  const hasLegacyConfig =
    LEGACY_ESLINT_CONFIG_FILES.some((file) => existsSync(join(root, file))) ||
    hasPackageJsonEslintConfig(root);
  if (!hasLegacyConfig) {
    return { ...base, runnable: false, skip_reason: "no eslint configuration found" };
  }

  return readsLegacyEslintConfig(major)
    ? { ...base, runnable: true }
    : {
        ...base,
        runnable: false,
        skip_reason:
          `only legacy .eslintrc-style config found; the installed eslint ` +
          `(major ${major ?? "unknown"}) reads flat eslint.config.* only`,
      };
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function commandErrorResult(
  tool: string,
  command: Awaited<ReturnType<typeof runFirstAvailableCommand>>,
  results: ExternalAnalyzerResultItem[],
): { results: ExternalAnalyzerResultItem[]; status: ExternalAnalyzerToolStatus } {
  // A declined candidate resolves to a record with NO command and NO error —
  // only `declinedReason`. `Boolean(record)` alone would read that refusal as
  // "the tool resolved and ran", so the status must branch on the decline
  // marker first: a vetoed spawn is coverage the operator refused, not a
  // resolution failure — and never a resolved:true run.
  if (command?.declinedReason) {
    return {
      results,
      status: {
        tool,
        resolved: false,
        status: "skipped",
        error: command.declinedReason,
      },
    };
  }
  return {
    results,
    status: {
      tool,
      command: command?.candidate.display,
      resolved: Boolean(command),
      status: command?.error ? "spawn_error" : "not_resolved",
      exit_code: command?.exitCode,
      error: command?.error?.message,
    },
  };
}

async function runTsc(
  root: string,
  analyzerConsent: AnalyzerConsentDecisions | undefined,
): Promise<{
  results: ExternalAnalyzerResultItem[];
  status: ExternalAnalyzerToolStatus;
}> {
  const results: ExternalAnalyzerResultItem[] = [];
  const command = await runFirstAvailableCommand(root, [
    ...resolveNodeTool(
      root,
      join("node_modules", "typescript", "bin", "tsc"),
      ["--noEmit"],
      "tsc --noEmit",
    ),
    { command: "tsc", args: ["--noEmit"], display: "tsc --noEmit" },
  ], { analyzerConsent });
  if (!command || command.error || command.declinedReason) {
    return commandErrorResult("tsc", command, results);
  }

  const output = [command.stdout, command.stderr].filter(Boolean).join("\n");
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/^([^:]+)\((\d+),\d+\):\s+(error\s+TS\d+:.*)$/);
    if (match) {
      results.push({
        id: `tsc-${results.length}`,
        category: "correctness",
        // Canonical severity vocabulary required by ExternalAnalyzerResultsSchema
        // is critical|high|medium|low|info — a tsc error maps to "high"
        // (COR-5d9f2421), not the raw "error".
        severity: "high",
        // construction-site: FindingLocation
        path: match[1].replace(/\\/g, "/"),
        line_start: parseInt(match[2], 10),
        summary: match[3],
        rule: "tsc",
      });
    }
  }

  if (command.exitCode === 0 && output.trim().length === 0) {
    return {
      results,
      status: {
        tool: "tsc",
        command: command.candidate.display,
        resolved: true,
        status: "success",
        exit_code: command.exitCode,
      },
    };
  }

  if (results.length === 0 && output.trim().length > 0) {
    const outputSnippet = snippet(output);
    process.stderr.write(
      `[syntax-resolution] tsc output could not be parsed: ${outputSnippet} (root=${root}, exit_code=${command.exitCode}, ts=${new Date().toISOString()})\n`,
    );
    return {
      results,
      status: {
        tool: "tsc",
        command: command.candidate.display,
        resolved: true,
        status: "parse_error",
        exit_code: command.exitCode,
        output_snippet: outputSnippet,
      },
    };
  }

  return {
    results,
    status: {
      tool: "tsc",
      command: command.candidate.display,
      resolved: true,
      status: results.length > 0 ? "findings" : "failed",
      exit_code: command.exitCode,
    },
  };
}

async function runEslint(
  root: string,
  analyzerConsent: AnalyzerConsentDecisions | undefined,
): Promise<{
  results: ExternalAnalyzerResultItem[];
  status: ExternalAnalyzerToolStatus;
}> {
  const results: ExternalAnalyzerResultItem[] = [];
  const configState = resolveEslintConfigState(root);
  if (!configState.runnable) {
    return {
      results,
      status: {
        tool: "eslint",
        resolved: false,
        status: "skipped",
        error: configState.skip_reason,
      },
    };
  }

  const args = eslintCommandArgs(configState.major);
  const display = ["eslint", ...args].join(" ");
  const command = await runFirstAvailableCommand(root, [
    ...resolveNodeTool(
      root,
      join("node_modules", "eslint", "bin", "eslint.js"),
      args,
      display,
    ),
    { command: "eslint", args, display },
  ], { analyzerConsent });
  if (!command || command.error || command.declinedReason) {
    return commandErrorResult("eslint", command, results);
  }

  const stdout = command.stdout.trim();
  const stderrSnippet = snippet(command.stderr);
  const base = {
    tool: "eslint",
    command: command.candidate.display,
    resolved: true,
    exit_code: command.exitCode,
    ...(stderrSnippet ? { stderr_snippet: stderrSnippet } : {}),
  };
  if (!stdout) {
    return { results, status: { ...base, status: "failed", error: "Missing ESLint JSON report." } };
  }

  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    // Classified alongside other invalid top-level reports below.
  }
  if (!Array.isArray(report)) {
    return {
      results,
      status: {
        ...base,
        status: "parse_error",
        error: "Expected an ESLint JSON array of file results.",
        output_snippet: snippet(stdout),
      },
    };
  }

  const rootPrefix = root.replace(/\\/g, "/") + "/";
  let droppedRows = 0;
  for (const file of report) {
    if (!file || typeof file.filePath !== "string" || !file.filePath.trim() || !Array.isArray(file.messages)) {
      droppedRows++;
      continue;
    }
    for (const msg of file.messages) {
      if (
        !msg ||
        typeof msg.message !== "string" || !msg.message.trim() ||
        (msg.severity !== 1 && msg.severity !== 2) ||
        (msg.line !== undefined && !Number.isInteger(msg.line)) ||
        (msg.ruleId !== null && msg.ruleId !== undefined && typeof msg.ruleId !== "string")
      ) {
        droppedRows++;
        continue;
      }
      results.push({
        id: `eslint-${results.length}`,
        category: "maintainability",
        severity: msg.severity === 2 ? "high" : "medium",
        path: file.filePath.replace(/\\/g, "/").replace(rootPrefix, ""),
        line_start: msg.line,
        summary: msg.message,
        rule: msg.ruleId || "eslint-error",
      });
    }
  }

  if (droppedRows > 0) {
    return {
      results,
      status: {
        ...base,
        status: "parse_error",
        error: "Malformed ESLint file or message rows.",
        dropped_rows: droppedRows,
        output_snippet: snippet(stdout),
      },
    };
  }
  // ESLint uses 1 for a completed lint run with errors or too many warnings.
  // Other nonzero exits and a missing exit status do not certify coverage.
  if (results.length > 0 && (command.exitCode === 0 || command.exitCode === 1)) {
    return { results, status: { ...base, status: "findings" } };
  }
  if (command.exitCode === 0) {
    return { results, status: { ...base, status: "success" } };
  }
  return {
    results,
    status: {
      ...base,
      status: "failed",
      error: "ESLint did not complete with a clean report or a finding exit.",
      output_snippet: snippet(stdout),
    },
  };
}

export interface SyntaxResolutionExecutorOptions {
  /**
   * Recorded consent decisions (from the durable analyzer policy). A recorded
   * `declined` for `tsc` or `eslint` vetoes that spawn at the shared
   * admitLocalSpawn chokepoint — the same decline-first rule every other local
   * tooling spawn faces.
   */
  analyzerConsent?: AnalyzerConsentDecisions;
}

export async function runSyntaxResolutionExecutor(
  bundle: ArtifactBundle,
  root: string,
  options: SyntaxResolutionExecutorOptions = {},
): Promise<ExecutorRunResult> {
  const items: ExternalAnalyzerResultItem[] = [];
  const toolStatuses: ExternalAnalyzerToolStatus[] = [];

  if (
    hasTypeScriptConfig(root) &&
    bundle.file_disposition?.files.some((f) => f.path.endsWith(".ts"))
  ) {
    const tsc = await runTsc(root, options.analyzerConsent);
    items.push(...tsc.results);
    toolStatuses.push(tsc.status);
  }
  if (
    bundle.file_disposition?.files.some(
      (f) => f.path.endsWith(".ts") || f.path.endsWith(".js"),
    )
  ) {
    const eslint = await runEslint(root, options.analyzerConsent);
    items.push(...eslint.results);
    toolStatuses.push(eslint.status);
  }

  const existing =
    bundle.external_analyzer_results?.find(
      (tool) => tool.tool === "syntax_resolution_executor",
    )?.results ?? [];
  const merged = [...existing, ...items];

  // Deduplicate by path + rule + summary
  const seen = new Set<string>();
  const deduped: ExternalAnalyzerResultItem[] = [];
  for (const r of merged) {
    const key = `${r.path}:${r.line_start ?? ""}:${r.rule}:${r.summary}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }

  const resultsArtifact: ExternalAnalyzerResults = {
    tool: "syntax_resolution_executor",
    results: deduped,
    tool_statuses: toolStatuses,
  };
  // A diagnostic is any tool run that produced no trustworthy coverage. That
  // question is answered by the SINGLE exported status classification, never by a
  // second hand-copied list of status strings here: a member added to the shared
  // vocabulary (`checksum_mismatch` was) silently fell outside a private copy and
  // was read as "the run was fine". Widening the union without classifying the new
  // member is a compile error at the shared map, so this consumer cannot drift.
  const diagnosticCount = toolStatuses.filter((status) =>
    isNonCleanAnalyzerCoverage(EXTERNAL_ANALYZER_STATUS_CLASSIFICATION[status.status]),
  ).length;

  return {
    updated: {
      ...bundle,
      external_analyzer_results: upsertExternalToolResults(
        bundle.external_analyzer_results,
        resultsArtifact,
      ),
      syntax_resolution_status: {
        tool: "syntax_resolution_executor",
        completed_at: new Date().toISOString(),
        tool_statuses: toolStatuses,
      },
    },
    artifacts_written: [
      "external_analyzer_results.json",
      "syntax_resolution_status.json",
    ],
    progress_summary:
      `Phase 2 Syntax Resolution complete. Extracted ${items.length} unfixable syntax/lint errors` +
      (diagnosticCount > 0
        ? ` with ${diagnosticCount} analyzer diagnostic(s).`
        : ", triggering high-priority LLM resolution tasks."),
  };
}
