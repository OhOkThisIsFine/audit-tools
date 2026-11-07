// sites-pinned: tests/audit/result-submit.test.ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadArtifactBundle } from "../io/artifacts.js";
import { readRunSourceRoot } from "../io/runSnapshot.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";
import { buildLineIndex } from "./lineIndex.js";
import { submitAuditHostResult, type AuditHostResultCheck } from "./dispatch/hostHandoff.js";

/**
 * Submit one work item's result by its id (decision 4, 2026-11-06). The shared
 * core of `audit-code submit` and the `submit_result` MCP tool: load what the
 * judgment reads, then judge and, only on acceptance, write the bound path.
 */
export async function submitWorkItemResult(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly workItemId: string;
  readonly source: string;
}): Promise<AuditHostResultCheck> {
  const bundle = await loadArtifactBundle(params.artifactsDir);
  const sourceRoot = await readRunSourceRoot(params.root, params.artifactsDir);
  const lineIndex = bundle.repo_manifest ? await buildLineIndex(sourceRoot, bundle.repo_manifest) : undefined;
  return submitAuditHostResult({
    root: params.root,
    sourceRoot,
    artifactsDir: params.artifactsDir,
    workItemId: params.workItemId,
    source: params.source,
    auditTasks: bundle.audit_tasks ?? [],
    lineIndex,
  });
}

/**
 * `audit-code mcp` — serve the submit-only MCP tool over stdio. The server is
 * imported here, not at the top, so no other command loads the MCP SDK. The
 * paths resolve exactly as `--root` / `--artifacts-dir` resolve for the CLI.
 */
export async function cmdMcp(_argv: string[]): Promise<void> {
  const submitServer = await import("audit-tools/shared/mcp/submitServer");
  await submitServer.serveSubmitMcpOverStdio({
    name: "audit-code",
    submit: async (request) => {
      const argv = ["--root", request.root, ...(request.artifactsDir === undefined ? [] : ["--artifacts-dir", request.artifactsDir])];
      const check = await submitWorkItemResult({
        root: getRootDir(argv),
        artifactsDir: getArtifactsDir(argv),
        workItemId: request.workItemId,
        source: request.source,
      });
      return { ...check, written: check.issues.length === 0 };
    },
  });
}

/**
 * `audit-code submit --work-item <id> --from <file>` — the route for a host
 * without the MCP tool. The reader writes its result JSON with its file tool to
 * any file; only the id and that path pass the shell, so no payload is escaped.
 * Exit 0 means the result is at its bound path and ingestion will accept it.
 */
export async function cmdSubmit(argv: string[]): Promise<void> {
  const workItemId = getFlag(argv, "--work-item");
  const from = getFlag(argv, "--from");
  if (!workItemId || !from) {
    throw new Error(
      "submit requires --work-item <id> and --from <file>: write the result JSON to any file with your file tool, " +
        "then pass the work-item id your prompt names and that file's path.",
    );
  }
  const artifactsDir = getArtifactsDir(argv);
  const check = await submitWorkItemResult({
    root: getRootDir(argv),
    artifactsDir,
    workItemId,
    source: await readFile(from, "utf8"),
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        submitted_from: resolve(from),
        ...check,
        written: check.issues.length === 0,
        warning_count: check.validation_warnings.length,
        error_count: check.issues.length,
      },
      null,
      2,
    ),
  );
  process.exitCode = check.issues.length > 0 ? 1 : 0;
}
