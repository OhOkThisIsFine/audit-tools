import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAuditExcludedStatus } from "../extractors/disposition.js";
import {
  resolveNodeTool,
  runFirstAvailableCommand,
  type LocalCommandCandidate,
} from "./localCommands.js";

function tryRunConfiguredFormatter(
  root: string,
  candidates: LocalCommandCandidate[],
): "not_found" | "success" | "failed" {
  const result = runFirstAvailableCommand(root, candidates);
  if (result === null) return "not_found";
  if (!result.error && result.exitCode === 0) return "success";
  return "failed";
}

const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function hasPrettierConfig(root: string): Promise<boolean> {
  const configChecks = await Promise.all(
    PRETTIER_CONFIG_FILES.map((file) => pathExists(join(root, file))),
  );
  if (configChecks.some(Boolean)) {
    return true;
  }

  const packageJsonPath = join(root, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      prettier?: unknown;
    };
    return packageJson.prettier !== undefined;
  } catch {
    // Missing package.json or unparseable JSON => no prettier config.
    return false;
  }
}

function runFormatter(
  root: string,
  toolName: string,
  candidates: LocalCommandCandidate[],
  executedTools: string[],
  failedTools: string[],
  toolTimings: { tool: string; duration_ms: number }[],
): void {
  const start = Date.now();
  const outcome = tryRunConfiguredFormatter(root, candidates);
  if (outcome === "success") {
    executedTools.push(toolName);
    toolTimings.push({ tool: toolName, duration_ms: Date.now() - start });
  } else if (outcome === "failed") {
    failedTools.push(toolName);
  }
}

export async function runAutoFixExecutor(
  bundle: ArtifactBundle,
  root: string,
): Promise<ExecutorRunResult> {
  if (!bundle.file_disposition) {
    throw new Error("Cannot run auto fix executor without file_disposition");
  }

  const extensions = new Set<string>();
  for (const file of bundle.file_disposition.files) {
    if (!isAuditExcludedStatus(file.status)) {
      const match = file.path.match(/\.([^.]+)$/);
      if (match) {
        extensions.add(match[1].toLowerCase());
      }
    }
  }

  const executedTools: string[] = [];
  const failedTools: string[] = [];
  const toolTimings: { tool: string; duration_ms: number }[] = [];

  // JS, TS, HTML, CSS, JSON, YAML, MD
  if (
    (await hasPrettierConfig(root)) &&
    (extensions.has("ts") ||
      extensions.has("js") ||
      extensions.has("tsx") ||
      extensions.has("jsx") ||
      extensions.has("html") ||
      extensions.has("css") ||
      extensions.has("json") ||
      extensions.has("yml") ||
      extensions.has("yaml") ||
      extensions.has("md"))
  ) {
    runFormatter(root, "prettier", [
      ...resolveNodeTool(
        root,
        join("node_modules", "prettier", "bin", "prettier.cjs"),
        ["--write", "."],
        "prettier --write .",
      ),
      { command: "prettier", args: ["--write", "."], display: "prettier --write ." },
      { command: "npx", args: ["--yes", "prettier", "--write", "."], display: "npx --yes prettier --write ." },
    ], executedTools, failedTools, toolTimings);
  }

  // Python
  if (extensions.has("py")) {
    runFormatter(root, "black", [
      { command: "black", args: ["."], display: "black ." },
      { command: "python", args: ["-m", "black", "."], display: "python -m black ." },
      { command: "uvx", args: ["black", "."], display: "uvx black ." },
      { command: "pipx", args: ["run", "black", "."], display: "pipx run black ." },
    ], executedTools, failedTools, toolTimings);
  }

  // SQL
  if (extensions.has("sql")) {
    runFormatter(root, "sqlfluff", [
      { command: "sqlfluff", args: ["fix", "--force", "."], display: "sqlfluff fix --force ." },
      { command: "uvx", args: ["sqlfluff", "fix", "--force", "."], display: "uvx sqlfluff fix --force ." },
      { command: "pipx", args: ["run", "sqlfluff", "fix", "--force", "."], display: "pipx run sqlfluff fix --force ." },
    ], executedTools, failedTools, toolTimings);
  }

  // Go
  if (extensions.has("go")) {
    runFormatter(root, "gofmt", [
      { command: "gofmt", args: ["-w", "."], display: "gofmt -w ." },
    ], executedTools, failedTools, toolTimings);
  }

  const resultsArtifact = {
    executed_tools: executedTools,
    failed_tools: failedTools,
    tool_timings: toolTimings,
    timestamp: new Date().toISOString(),
  };

  let progressDetail: string;
  if (executedTools.length === 0 && failedTools.length === 0) {
    progressDetail = "Formatters executed: None.";
  } else if (failedTools.length === 0) {
    progressDetail = `Formatters executed: ${executedTools.join(", ")}.`;
  } else if (executedTools.length === 0) {
    progressDetail = `Formatters executed: None. Formatters failed: ${failedTools.join(", ")}.`;
  } else {
    progressDetail = `Formatters executed: ${executedTools.join(", ")}. Formatters failed: ${failedTools.join(", ")}.`;
  }

  return {
    updated: {
      ...bundle,
      auto_fixes_applied: resultsArtifact,
    },
    artifacts_written: ["auto_fixes_applied.json"],
    progress_summary: `Phase 1 Deterministic Auto-Fix complete. ${progressDetail}`,
  };
}
