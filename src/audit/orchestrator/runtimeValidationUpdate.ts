// sites-pinned: tests/audit/runtime-validation-update.test.ts, tests/audit/runtime-validation-source.test.ts
import type {
  RuntimeValidationReport,
  RuntimeValidationResult,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";

function normalizeResult(
  result: RuntimeValidationResult,
): RuntimeValidationResult {
  return {
    ...result,
    evidence: [...new Set(result.evidence ?? [])],
    notes: [...new Set(result.notes ?? [])],
  };
}

// sites-pinned: tests/audit/runtime-validation-update.test.ts, tests/audit/runtime-validation-source.test.ts
export function updateRuntimeValidationReport(
  tasks: RuntimeValidationTaskManifest,
  existing: RuntimeValidationReport,
  updates: RuntimeValidationReport,
  sourceKey?: string,
): RuntimeValidationReport {
  const tasksById = new Map(tasks.tasks.map((task) => [task.id, task]));
  const merged = new Map<string, RuntimeValidationResult>();
  const staleIds = new Set<string>();

  for (const result of existing.results) {
    if (!tasksById.has(result.task_id)) {
      staleIds.add(result.task_id);
      continue;
    }
    merged.set(result.task_id, normalizeResult(result));
  }

  for (const update of updates.results) {
    const task = tasksById.get(update.task_id);
    if (!task) {
      staleIds.add(update.task_id);
      continue;
    }

    if (task.evidence_requirements?.length && (update.status === "confirmed" || update.status === "not_confirmed") &&
        (!sourceKey || update.verification?.source_key !== sourceKey ||
         !update.verification.observations.some((entry) => entry.trim().length > 0) ||
         !update.evidence?.some((entry) => entry.trim().length > 0))) {
      throw new Error(`Runtime validation ${update.task_id} requires observations and evidence bound to the current source.`);
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
      ...(update.verification ? { verification: update.verification } : {}),
      evidence: [
        ...new Set([...(prior.evidence ?? []), ...(update.evidence ?? [])]),
      ],
      notes: [...new Set([...(prior.notes ?? []), ...(update.notes ?? [])])],
    });
  }

  if (staleIds.size > 0) {
    console.warn(
      "[runtimeValidationUpdate] Dropped %d stale result(s) not in task manifest: %s",
      staleIds.size,
      [...staleIds].join(", "),
    );
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
      compareCodeUnits(a.task_id, b.task_id),
    ),
  };
}
