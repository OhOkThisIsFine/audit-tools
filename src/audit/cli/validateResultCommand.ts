import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mapWithConcurrency, readJsonFile, type Finding } from "audit-tools/shared";
import { validateAuditResults } from "../validation/auditResults.js";
import { verifyFindingGrounding } from "../validation/quoteGrounding.js";
import {
  ANCHOR_GROUNDING_CONCURRENCY,
  combineGroundingWithAnchor,
  verifyFindingAnchor,
} from "../validation/anchorGrounding.js";
import { loadDispatchResultMap } from "./dispatch.js";
import { fromBase64Url, getArtifactsDir, getFlag, getRootDir, taskResultPath } from "./args.js";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";

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

  // Ground findings against the CONFIGURED repository root, never process.cwd().
  // The dispatched run records its repo root in task.json (repo_root); a worker
  // invoked from any other directory would otherwise re-read cited spans against
  // the wrong tree and spuriously flag every finding ungrounded. Fall back to
  // the resolved --root (still not raw cwd) if task.json is absent.
  let repoRoot = getRootDir(argv);
  try {
    const workerTask = await readJsonFile<WorkerTask>(join(runDir, "task.json"));
    if (typeof workerTask.repo_root === "string" && workerTask.repo_root.trim() !== "") {
      repoRoot = workerTask.repo_root;
    }
  } catch { /* no task.json — fall back to resolved --root */ }

  const matchingTasks = allTasks.filter(t => t.task_id === taskId);
  const lineIndex = matchingTasks[0]?.file_line_counts ?? {};
  const issues = validateAuditResults([obj], matchingTasks, { lineIndex });
  const errors = issues.filter(i => i.severity === "error");

  // S7 grounding self-check: re-verify each finding against disk (repo root =
  // the configured run root, resolved above) before submitting — re-read the
  // cited verbatim span (tier-1) and run any executable anchor (tier-2), so the
  // worker fixes a hallucinated quote or a refuted behavior claim first.
  // Advisory — it does not change the valid/invalid exit code.
  const rawFindings = (obj as { findings?: unknown }).findings;
  const validFindings: Finding[] = Array.isArray(rawFindings)
    ? rawFindings.filter(
        (f): f is Finding =>
          !!f && typeof f === "object" && typeof (f as Finding).id === "string",
      )
    : [];
  // Same bounded-concurrency grounding pass as ingest: anchors spawn child
  // processes, so a serial pass over a finding-heavy result is slow. Order is
  // preserved, so the warnings list is stable.
  const warningsPerFinding = await mapWithConcurrency(
    validFindings,
    ANCHOR_GROUNDING_CONCURRENCY,
    async (finding) => {
      const tier1 = await verifyFindingGrounding(repoRoot, finding);
      const anchor = await verifyFindingAnchor(repoRoot, finding);
      const grounding = combineGroundingWithAnchor(tier1, anchor);
      return grounding.status === "ungrounded"
        ? `${finding.id}: ${grounding.reason ?? "ungrounded"}`
        : null;
    },
  );
  const groundingWarnings = warningsPerFinding.filter(
    (w): w is string => w !== null,
  );

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
