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
    process.stderr.write(
      JSON.stringify({
        kind: "auto_fix_formatter_failed",
        tool: toolName,
        duration_ms: Date.now() - start,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }
}

/**
 * Group the eligible (non-excluded) disposition file paths by lowercased
 * extension. Auto-fix formatters MUST run only over the audited in-scope files —
 * never over `.`/the whole repo (a write-scope violation that would reformat
 * gitignored, vendored, or out-of-scope sibling files). The returned paths are
 * the exact targets each formatter is invoked against.
 */
export function buildInScopePathsByExtension(
  bundle: ArtifactBundle,
): Map<string, string[]> {
  const byExtension = new Map<string, string[]>();
  for (const file of bundle.file_disposition!.files) {
    if (isAuditExcludedStatus(file.status)) continue;
    const match = file.path.match(/\.([^.]+)$/);
    if (!match) continue;
    const extension = match[1].toLowerCase();
    const paths = byExtension.get(extension) ?? [];
    paths.push(file.path);
    byExtension.set(extension, paths);
  }
  return byExtension;
}

/** Collect the in-scope paths whose extension is in `extensions`, sorted+deduped. */
function pathsForExtensions(
  byExtension: Map<string, string[]>,
  extensions: string[],
): string[] {
  const collected = new Set<string>();
  for (const extension of extensions) {
    for (const path of byExtension.get(extension) ?? []) {
      collected.add(path);
    }
  }
  return [...collected].sort((a, b) => a.localeCompare(b));
}

export async function runAutoFixExecutor(
  bundle: ArtifactBundle,
  root: string,
): Promise<ExecutorRunResult> {
  if (!bundle.file_disposition) {
    throw new Error("Cannot run auto fix executor without file_disposition");
  }

  const byExtension = buildInScopePathsByExtension(bundle);

  const executedTools: string[] = [];
  const failedTools: string[] = [];
  const toolTimings: { tool: string; duration_ms: number }[] = [];

  // JS, TS, HTML, CSS, JSON, YAML, MD — restricted to the audited in-scope files.
  const prettierPaths = pathsForExtensions(byExtension, [
    "ts",
    "js",
    "tsx",
    "jsx",
    "html",
    "css",
    "json",
    "yml",
    "yaml",
    "md",
  ]);
  if (prettierPaths.length > 0 && (await hasPrettierConfig(root))) {
    const display = `prettier --write (${prettierPaths.length} in-scope file${prettierPaths.length === 1 ? "" : "s"})`;
    runFormatter(root, "prettier", [
      ...resolveNodeTool(
        root,
        join("node_modules", "prettier", "bin", "prettier.cjs"),
        ["--write", ...prettierPaths],
        display,
      ),
      { command: "prettier", args: ["--write", ...prettierPaths], display },
      { command: "npx", args: ["--yes", "prettier", "--write", ...prettierPaths], display },
    ], executedTools, failedTools, toolTimings);
  }

  // Python
  const pythonPaths = pathsForExtensions(byExtension, ["py"]);
  if (pythonPaths.length > 0) {
    const display = `black (${pythonPaths.length} in-scope file${pythonPaths.length === 1 ? "" : "s"})`;
    runFormatter(root, "black", [
      { command: "black", args: [...pythonPaths], display },
      { command: "python", args: ["-m", "black", ...pythonPaths], display },
      { command: "uvx", args: ["black", ...pythonPaths], display },
      { command: "pipx", args: ["run", "black", ...pythonPaths], display },
    ], executedTools, failedTools, toolTimings);
  }

  // SQL
  const sqlPaths = pathsForExtensions(byExtension, ["sql"]);
  if (sqlPaths.length > 0) {
    const display = `sqlfluff fix --force (${sqlPaths.length} in-scope file${sqlPaths.length === 1 ? "" : "s"})`;
    runFormatter(root, "sqlfluff", [
      { command: "sqlfluff", args: ["fix", "--force", ...sqlPaths], display },
      { command: "uvx", args: ["sqlfluff", "fix", "--force", ...sqlPaths], display },
      { command: "pipx", args: ["run", "sqlfluff", "fix", "--force", ...sqlPaths], display },
    ], executedTools, failedTools, toolTimings);
  }

  // Go
  const goPaths = pathsForExtensions(byExtension, ["go"]);
  if (goPaths.length > 0) {
    const display = `gofmt -w (${goPaths.length} in-scope file${goPaths.length === 1 ? "" : "s"})`;
    runFormatter(root, "gofmt", [
      { command: "gofmt", args: ["-w", ...goPaths], display },
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
