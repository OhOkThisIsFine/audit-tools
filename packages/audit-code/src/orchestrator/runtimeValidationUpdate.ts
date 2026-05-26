import type {
  RuntimeValidationReport,
  RuntimeValidationResult,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";

function normalizeResult(
  result: RuntimeValidationResult,
): RuntimeValidationResult {
  return {
    ...result,
    evidence: [...new Set(result.evidence ?? [])],
    notes: [...new Set(result.notes ?? [])],
  };
}

export function updateRuntimeValidationReport(
  tasks: RuntimeValidationTaskManifest,
  existing: RuntimeValidationReport,
  updates: RuntimeValidationReport,
): RuntimeValidationReport {
  const validTaskIds = new Set(tasks.tasks.map((task) => task.id));
  const merged = new Map<string, RuntimeValidationResult>();

  for (const result of existing.results) {
    if (!validTaskIds.has(result.task_id)) {
      continue;
    }
    merged.set(result.task_id, normalizeResult(result));
  }

  for (const update of updates.results) {
    if (!validTaskIds.has(update.task_id)) {
      continue;
    }

    const prior = merged.get(update.task_id);
    if (!prior) {
      merged.set(update.task_id, normalizeResult(update));
      continue;
    }

    merged.set(update.task_id, {
      task_id: update.task_id,
      status: update.status,
      summary: update.summary,
      evidence: [
        ...new Set([...(prior.evidence ?? []), ...(update.evidence ?? [])]),
      ],
      notes: [...new Set([...(prior.notes ?? []), ...(update.notes ?? [])])],
    });
  }

  for (const task of tasks.tasks) {
    if (!merged.has(task.id)) {
      merged.set(task.id, {
        task_id: task.id,
        status: "pending",
        summary: `Deterministic runtime validation has not executed yet for ${task.id}.`,
        evidence: [],
        notes: [],
      });
    }
  }

  return {
    results: [...merged.values()].sort((a, b) =>
      a.task_id.localeCompare(b.task_id),
    ),
  };
}
