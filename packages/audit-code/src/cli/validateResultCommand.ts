import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, type Finding } from "@audit-tools/shared";
import { validateAuditResults } from "../validation/auditResults.js";
import { verifyFindingGrounding } from "../validation/quoteGrounding.js";
import {
  combineGroundingWithAnchor,
  verifyFindingAnchor,
} from "../validation/anchorGrounding.js";
import { loadDispatchResultMap } from "./dispatch.js";
import { fromBase64Url, getArtifactsDir, getFlag, taskResultPath } from "./args.js";
import type { AuditTask } from "../types.js";

export async function cmdValidateResult(argv: string[]): Promise<void> {
  const rawRunId = getFlag(argv, "--run-id");
  const runIdB64 = getFlag(argv, "--run-id-b64");
  const rawTaskId = getFlag(argv, "--task-id");
  const artifactsDirB64 = getFlag(argv, "--artifacts-dir-b64");
  const runId = rawRunId ?? (runIdB64 ? fromBase64Url(runIdB64) : undefined);
  const taskIdB64 = getFlag(argv, "--task-id-b64");
  const taskId = rawTaskId ?? (taskIdB64 ? fromBase64Url(taskIdB64) : undefined);
  const artifactsDir = artifactsDirB64
    ? resolve(fromBase64Url(artifactsDirB64))
    : getArtifactsDir(argv);
  if (!runId || !taskId) {
    throw new Error(
      "validate-result requires --run-id and --task-id (or --run-id-b64/--task-id-b64)",
    );
  }

  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const resultMap = await loadDispatchResultMap(runDir);
  const resultPath =
    resultMap?.entries.find((entry) => entry.task_id === taskId)?.result_path ??
    taskResultPath(taskResultsDir, taskId);
  const tasksPath = join(runDir, "pending-audit-tasks.json");

  let raw: string;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch {
    console.error(`File not found: ${resultPath}`);
    process.exitCode = 1;
    return;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let allTasks: AuditTask[] = [];
  try { allTasks = await readJsonFile<AuditTask[]>(tasksPath); } catch { /* may not exist */ }

  const matchingTasks = allTasks.filter(t => t.task_id === taskId);
  const lineIndex = matchingTasks[0]?.file_line_counts ?? {};
  const issues = validateAuditResults([obj], matchingTasks, { lineIndex });
  const errors = issues.filter(i => i.severity === "error");

  // S7 grounding self-check: re-verify each finding against disk (repo root =
  // cwd; the worker runs from the repository root) before submitting — re-read
  // the cited verbatim span (tier-1) and run any executable anchor (tier-2), so
  // the worker fixes a hallucinated quote or a refuted behavior claim first.
  // Advisory — it does not change the valid/invalid exit code.
  const groundingWarnings: string[] = [];
  const findings = (obj as { findings?: unknown }).findings;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!f || typeof f !== "object") continue;
      const finding = f as Finding;
      if (typeof finding.id !== "string") continue;
      const tier1 = await verifyFindingGrounding(process.cwd(), finding);
      const anchor = await verifyFindingAnchor(process.cwd(), finding);
      const grounding = combineGroundingWithAnchor(tier1, anchor);
      if (grounding.status === "ungrounded") {
        groundingWarnings.push(`${finding.id}: ${grounding.reason ?? "ungrounded"}`);
      }
    }
  }

  if (errors.length === 0) {
    console.log(`✓ valid: ${taskId}`);
  } else {
    console.error(`✗ invalid: ${taskId}`);
    for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
    process.exitCode = 1;
  }

  if (groundingWarnings.length > 0) {
    console.error(
      `⚠ ${groundingWarnings.length} ungrounded finding(s) — copy a verbatim quoted_text span into affected_files (re-read and content-matched against disk), and ensure any executable_anchor command actually confirms the claim:`,
    );
    for (const w of groundingWarnings) console.error(`  ${w}`);
  }
}
