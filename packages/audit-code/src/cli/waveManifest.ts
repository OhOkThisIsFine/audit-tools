import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { AuditTask } from "../types.js";

const WAVE_MANIFEST_FILENAME = "wave-manifest.json";
const WAVE_MANIFEST_CONTRACT = "audit-code-wave/v1alpha1";

export interface WaveSlotEntry {
  run_id: string;
  task_path: string;
  prompt_path: string;
  result_path: string;
  stdout_path: string;
  stderr_path: string;
  status_path: string;
  audit_results_path: string;
  pending_tasks_path: string;
  task_ids: string[];
}

export interface WaveManifest {
  contract_version: typeof WAVE_MANIFEST_CONTRACT;
  obligation_id: string;
  started_at: string;
  pid: number;
  slots: WaveSlotEntry[];
}

export function waveManifestPath(artifactsDir: string): string {
  return join(artifactsDir, "dispatch", WAVE_MANIFEST_FILENAME);
}

export async function writeWaveManifest(
  artifactsDir: string,
  manifest: Omit<WaveManifest, "contract_version">,
): Promise<void> {
  await writeJsonFile(waveManifestPath(artifactsDir), {
    contract_version: WAVE_MANIFEST_CONTRACT,
    ...manifest,
  });
}

export async function readWaveManifest(
  artifactsDir: string,
): Promise<WaveManifest | null> {
  try {
    return await readJsonFile<WaveManifest>(waveManifestPath(artifactsDir));
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
}

export async function removeWaveManifest(artifactsDir: string): Promise<void> {
  await rm(waveManifestPath(artifactsDir), { force: true });
}

export function buildWaveSlotEntry(
  slot: {
    runId: string;
    paths: {
      taskPath: string;
      promptPath: string;
      resultPath: string;
      stdoutPath: string;
      stderrPath: string;
      statusPath: string;
    };
    auditResultsPath: string;
    pendingTasksPath: string;
    group: AuditTask[];
  },
): WaveSlotEntry {
  return {
    run_id: slot.runId,
    task_path: slot.paths.taskPath,
    prompt_path: slot.paths.promptPath,
    result_path: slot.paths.resultPath,
    stdout_path: slot.paths.stdoutPath,
    stderr_path: slot.paths.stderrPath,
    status_path: slot.paths.statusPath,
    audit_results_path: slot.auditResultsPath,
    pending_tasks_path: slot.pendingTasksPath,
    task_ids: slot.group.map((t) => t.task_id),
  };
}
