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
): boolean {
  const result = runFirstAvailableCommand(root, candidates);
  return result !== null && !result.error && result.exitCode === 0;
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
    const prettierStart = Date.now();
    if (
      tryRunConfiguredFormatter(root, [
        ...resolveNodeTool(
          root,
          join("node_modules", "prettier", "bin", "prettier.cjs"),
          ["--write", "."],
          "prettier --write .",
        ),
        { command: "prettier", args: ["--write", "."], display: "prettier --write ." },
        { command: "npx", args: ["--yes", "prettier", "--write", "."], display: "npx --yes prettier --write ." },
      ])
    ) {
      executedTools.push("prettier");
      toolTimings.push({ tool: "prettier", duration_ms: Date.now() - prettierStart });
    }
  }

  // Python
  if (extensions.has("py")) {
    const blackStart = Date.now();
    if (
      tryRunConfiguredFormatter(root, [
        { command: "black", args: ["."], display: "black ." },
        { command: "python", args: ["-m", "black", "."], display: "python -m black ." },
        { command: "uvx", args: ["black", "."], display: "uvx black ." },
        { command: "pipx", args: ["run", "black", "."], display: "pipx run black ." },
      ])
    ) {
      executedTools.push("black");
      toolTimings.push({ tool: "black", duration_ms: Date.now() - blackStart });
    }
  }

  // SQL
  if (extensions.has("sql")) {
    const sqlfluffStart = Date.now();
    if (
      tryRunConfiguredFormatter(root, [
        { command: "sqlfluff", args: ["fix", "--force", "."], display: "sqlfluff fix --force ." },
        { command: "uvx", args: ["sqlfluff", "fix", "--force", "."], display: "uvx sqlfluff fix --force ." },
        { command: "pipx", args: ["run", "sqlfluff", "fix", "--force", "."], display: "pipx run sqlfluff fix --force ." },
      ])
    ) {
      executedTools.push("sqlfluff");
      toolTimings.push({ tool: "sqlfluff", duration_ms: Date.now() - sqlfluffStart });
    }
  }

  // Go
  if (extensions.has("go")) {
    const gofmtStart = Date.now();
    if (
      tryRunConfiguredFormatter(root, [
        { command: "gofmt", args: ["-w", "."], display: "gofmt -w ." },
      ])
    ) {
      executedTools.push("gofmt");
      toolTimings.push({ tool: "gofmt", duration_ms: Date.now() - gofmtStart });
    }
  }

  const resultsArtifact = {
    executed_tools: executedTools,
    tool_timings: toolTimings,
    timestamp: new Date().toISOString(),
  };

  return {
    updated: {
      ...bundle,
      auto_fixes_applied: resultsArtifact,
    },
    artifacts_written: ["auto_fixes_applied.json"],
    progress_summary: `Phase 1 Deterministic Auto-Fix complete. Formatters executed: ${executedTools.length > 0 ? executedTools.join(", ") : "None"}.`,
  };
}
