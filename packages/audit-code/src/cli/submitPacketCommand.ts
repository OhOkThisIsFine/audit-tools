import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import { validateAuditResults, formatAuditResultIssues } from "../validation/auditResults.js";
import {
  DISPATCH_RESULT_MAP_FILENAME,
  resolveRunScopedArg,
  loadDispatchResultMap,
  entriesByTaskId,
} from "./dispatch.js";
import { fromBase64Url, getArtifactsDir, getFlag, readStdinText } from "./args.js";

export async function cmdSubmitPacket(argv: string[]): Promise<void> {
  const runId = resolveRunScopedArg(argv, "--run-id", "--run-id-b64");
  const packetId = resolveRunScopedArg(argv, "--packet-id", "--packet-id-b64");
  const artifactsDirB64 = getFlag(argv, "--artifacts-dir-b64");
  const artifactsDir = artifactsDirB64
    ? resolve(fromBase64Url(artifactsDirB64))
    : getArtifactsDir(argv);
  if (!runId || !packetId) {
    throw new Error(
      "submit-packet requires --run-id and --packet-id (or --run-id-b64/--packet-id-b64)",
    );
  }

  const runDir = join(artifactsDir, "runs", runId);
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    throw new Error(
      `No ${DISPATCH_RESULT_MAP_FILENAME} found for run ${runId}; run prepare-dispatch first.`,
    );
  }

  let packetEntries = resultMap.entries.filter(
    (entry) => entry.packet_id === packetId,
  );
  let resolvedPacketId = packetId;
  if (packetEntries.length === 0) {
    const trimmed = packetId.trim();
    packetEntries = resultMap.entries.filter(
      (entry) => entry.packet_id.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (packetEntries.length > 0) {
      resolvedPacketId = packetEntries[0]!.packet_id;
      process.stderr.write(
        `[submit-packet] Resolved packet_id '${packetId}' → '${resolvedPacketId}' (case/whitespace normalization)\n`,
      );
    }
  }
  if (packetEntries.length === 0) {
    const knownIds = [...new Set(resultMap.entries.map((e) => e.packet_id))];
    throw new Error(
      `Unknown packet_id '${packetId}' for run ${runId}.\n` +
      `Valid packet IDs: ${knownIds.join(", ")}`,
    );
  }
  if (entriesByTaskId(packetEntries).size !== packetEntries.length) {
    throw new Error(`Dispatch result map has duplicate task entries for packet '${resolvedPacketId}'.`);
  }

  const allTasks = await readJsonFile<AuditTask[]>(tasksPath);
  const taskById = new Map(allTasks.map((task) => [task.task_id, task]));
  const packetTasks = packetEntries.map((entry) => taskById.get(entry.task_id));
  const missingTask = packetEntries.find((entry, index) => !packetTasks[index]);
  if (missingTask) {
    throw new Error(
      `Dispatch result map references unknown task '${missingTask.task_id}'.`,
    );
  }
  const tasks = packetTasks as AuditTask[];
  const expectedTaskIds = new Set(tasks.map((task) => task.task_id));
  const lineIndex = Object.fromEntries(
    tasks.flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
  const encodedResults = getFlag(argv, "--results-b64");
  const raw = encodedResults ? fromBase64Url(encodedResults) : await readStdinText();
  if (raw.trim().length === 0) {
    throw new Error(
      "submit-packet requires an AuditResult[] JSON payload on stdin or --results-b64.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid submit-packet JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resultErrors: string[] = [];
  const issues = validateAuditResults(payload, tasks, { lineIndex });
  const validationErrors = issues.filter((issue) => issue.severity === "error");
  const validationWarnings = issues.filter((issue) => issue.severity === "warning");
  if (validationWarnings.length > 0) {
    process.stderr.write(
      `audit-results validation: ${validationWarnings.length} warning(s):\n` +
        formatAuditResultIssues(validationWarnings) +
        "\n",
    );
  }
  if (validationErrors.length > 0) {
    resultErrors.push(formatAuditResultIssues(validationErrors));
  }

  if (Array.isArray(payload)) {
    const seen = new Set<string>();
    for (const [index, result] of payload.entries()) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        continue;
      }
      const taskId = (result as Record<string, unknown>).task_id;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        continue;
      }
      if (seen.has(taskId)) {
        resultErrors.push(`Duplicate audit result for assigned task '${taskId}'.`);
      }
      seen.add(taskId);
      if (!expectedTaskIds.has(taskId)) {
        resultErrors.push(
          `Result at index ${index} uses task_id '${taskId}', which is not assigned to packet '${resolvedPacketId}'.`,
        );
      }
    }
    for (const task of tasks) {
      if (!seen.has(task.task_id)) {
        resultErrors.push(`Missing audit result for assigned task '${task.task_id}'.`);
      }
    }
  }

  if (resultErrors.length > 0) {
    throw new Error(`submit-packet rejected ${resolvedPacketId}:\n${resultErrors.join("\n")}`);
  }

  // Check for duplicate findings against already-submitted results in this run
  const existingFindingKeys = new Set<string>();
  const otherEntries = resultMap.entries.filter(
    (e) => e.packet_id !== resolvedPacketId,
  );
  for (const other of otherEntries) {
    try {
      const existing = JSON.parse(await readFile(other.result_path, "utf8")) as AuditResult;
      if (existing?.findings) {
        for (const f of existing.findings) {
          const key = [
            (f.lens ?? "").trim().toLowerCase(),
            (f.category ?? "").trim().toLowerCase(),
            (f.title ?? "").trim().toLowerCase(),
            f.affected_files?.[0]?.path ?? "",
          ].join("|");
          existingFindingKeys.add(key);
        }
      }
    } catch { /* file doesn't exist yet or invalid — skip */ }
  }
  let dupCount = 0;
  for (const result of payload as AuditResult[]) {
    for (const f of result.findings ?? []) {
      const key = [
        (f.lens ?? "").trim().toLowerCase(),
        (f.category ?? "").trim().toLowerCase(),
        (f.title ?? "").trim().toLowerCase(),
        f.affected_files?.[0]?.path ?? "",
      ].join("|");
      if (existingFindingKeys.has(key)) {
        dupCount++;
      }
    }
  }
  if (dupCount > 0) {
    process.stderr.write(
      `[submit-packet] Warning: ${dupCount} finding(s) appear to duplicate findings from other packets in this run.\n`,
    );
  }

  const entryByTaskId = entriesByTaskId(packetEntries);
  for (const result of payload as AuditResult[]) {
    const entry = entryByTaskId.get(result.task_id);
    if (!entry) {
      throw new Error(
        `Internal error: no result path for accepted task '${result.task_id}'.`,
      );
    }
    await writeJsonFile(entry.result_path, result);
  }

  const findingCount = (payload as AuditResult[]).reduce(
    (sum, result) => sum + result.findings.length,
    0,
  );
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        packet_id: resolvedPacketId,
        accepted_count: (payload as AuditResult[]).length,
        finding_count: findingCount,
        ...(dupCount > 0 ? { duplicate_warning_count: dupCount } : {}),
      },
      null,
      2,
    ),
  );
}
