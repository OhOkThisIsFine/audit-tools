import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./internalExecutors.js";
import type {
  ExternalAnalyzerResults,
  ExternalAnalyzerResultItem,
  ExternalAnalyzerToolStatus,
} from "../types/externalAnalyzer.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodeTool, runFirstAvailableCommand } from "./localCommands.js";

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

const TSCONFIG_FILES = [
  "tsconfig.json",
  "tsconfig.build.json",
  "jsconfig.json",
];

function hasTypeScriptConfig(root: string): boolean {
  return TSCONFIG_FILES.some((file) => existsSync(join(root, file)));
}

function hasEslintConfig(root: string): boolean {
  if (ESLINT_CONFIG_FILES.some((file) => existsSync(join(root, file)))) {
    return true;
  }

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

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function runTsc(root: string): {
  results: ExternalAnalyzerResultItem[];
  status: ExternalAnalyzerToolStatus;
} {
  const results: ExternalAnalyzerResultItem[] = [];
  const command = runFirstAvailableCommand(root, [
    ...resolveNodeTool(
      root,
      join("node_modules", "typescript", "bin", "tsc"),
      ["--noEmit"],
      "tsc --noEmit",
    ),
    { command: "tsc", args: ["--noEmit"], display: "tsc --noEmit" },
  ]);
  if (!command || command.error) {
    return {
      results,
      status: {
        tool: "tsc",
        command: command?.candidate.display,
        resolved: Boolean(command),
        status: command?.error ? "spawn_error" : "not_resolved",
        exit_code: command?.exitCode,
        error: command?.error?.message,
      },
    };
  }

  const output = [command.stdout, command.stderr].filter(Boolean).join("\n");
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/^([^:]+)\((\d+),\d+\):\s+(error\s+TS\d+:.*)$/);
    if (match) {
      results.push({
        id: `tsc-${results.length}`,
        category: "correctness",
        severity: "error",
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
      `[syntax-resolution] tsc output could not be parsed: ${outputSnippet}\n`,
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

function runEslint(root: string): {
  results: ExternalAnalyzerResultItem[];
  status: ExternalAnalyzerToolStatus;
} {
  const results: ExternalAnalyzerResultItem[] = [];
  if (!hasEslintConfig(root)) {
    return {
      results,
      status: {
        tool: "eslint",
        resolved: false,
        status: "skipped",
      },
    };
  }

  const command = runFirstAvailableCommand(root, [
    ...resolveNodeTool(
      root,
      join("node_modules", "eslint", "bin", "eslint.js"),
      [".", "--ext", ".ts,.js,.tsx,.jsx", "--format", "json"],
      "eslint . --ext .ts,.js,.tsx,.jsx --format json",
    ),
    {
      command: "eslint",
      args: [".", "--ext", ".ts,.js,.tsx,.jsx", "--format", "json"],
      display: "eslint . --ext .ts,.js,.tsx,.jsx --format json",
    },
  ]);
  if (!command || command.error) {
    return {
      results,
      status: {
        tool: "eslint",
        command: command?.candidate.display,
        resolved: Boolean(command),
        status: command?.error ? "spawn_error" : "not_resolved",
        exit_code: command?.exitCode,
        error: command?.error?.message,
      },
    };
  }

  const output = [command.stdout, command.stderr].filter(Boolean).join("\n").trim();
  if (output.length === 0) {
    return {
      results,
      status: {
        tool: "eslint",
        command: command.candidate.display,
        resolved: true,
        status: "success",
        exit_code: command.exitCode,
      },
    };
  }

  try {
    const parsed = JSON.parse(output);
    for (const fileResult of parsed) {
      for (const msg of fileResult.messages) {
        results.push({
          id: `eslint-${results.length}`,
          category: "maintainability",
          severity: msg.severity === 2 ? "error" : "warning",
          path: fileResult.filePath
            .replace(/\\/g, "/")
            .replace(root.replace(/\\/g, "/") + "/", ""),
          line_start: msg.line,
          summary: msg.message,
          rule: msg.ruleId || "eslint-error",
        });
      }
    }
  } catch {
    const outputSnippet = snippet(output);
    process.stderr.write(
      `[syntax-resolution] eslint output could not be parsed: ${outputSnippet}\n`,
    );
    return {
      results,
      status: {
        tool: "eslint",
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
      tool: "eslint",
      command: command.candidate.display,
      resolved: true,
      status: results.length > 0 ? "findings" : "success",
      exit_code: command.exitCode,
    },
  };
}

export function runSyntaxResolutionExecutor(
  bundle: ArtifactBundle,
  root: string,
): ExecutorRunResult {
  const items: ExternalAnalyzerResultItem[] = [];
  const toolStatuses: ExternalAnalyzerToolStatus[] = [];

  if (
    hasTypeScriptConfig(root) &&
    bundle.file_disposition?.files.some((f) => f.path.endsWith(".ts"))
  ) {
    const tsc = runTsc(root);
    items.push(...tsc.results);
    toolStatuses.push(tsc.status);
  }
  if (
    bundle.file_disposition?.files.some(
      (f) => f.path.endsWith(".ts") || f.path.endsWith(".js"),
    )
  ) {
    const eslint = runEslint(root);
    items.push(...eslint.results);
    toolStatuses.push(eslint.status);
  }

  const existing = bundle.external_analyzer_results?.results ?? [];
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
  const diagnosticCount = toolStatuses.filter((status) =>
    ["not_resolved", "spawn_error", "parse_error", "failed"].includes(status.status),
  ).length;

  return {
    updated: {
      ...bundle,
      external_analyzer_results: resultsArtifact,
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
