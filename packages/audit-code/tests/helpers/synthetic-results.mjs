import { assertNonEmptyString, assertStringArray, describeValue, fail, isRecord } from "./validate.mjs";
import { countLines } from "./countLines.mjs";

async function buildFileCoverage(task, root) {
  return Promise.all(
    task.file_paths.map(async (path) => ({
      path,
      total_lines: await countLines(root, path),
    })),
  );
}

export function validatePendingTask(task, index) {
  if (!isRecord(task)) {
    fail(`pending task ${index} must be an object, got ${describeValue(task)}.`);
  }
  assertNonEmptyString(task.task_id, `pending task ${index}.task_id`);
  assertNonEmptyString(task.unit_id, `pending task ${index}.unit_id`);
  assertNonEmptyString(task.pass_id, `pending task ${index}.pass_id`);
  assertNonEmptyString(task.lens, `pending task ${index}.lens`);
  assertStringArray(task.file_paths, `pending task ${index}.file_paths`);
}

export async function buildSyntheticResults(tasks, root) {
  return Promise.all(tasks.map(async (task, index) => {
    validatePendingTask(task, index);
    const notes = ["Synthetic provider-assisted completion result."];
    if (typeof task.priority === "string" && task.priority.trim().length > 0) {
      notes.push(`Priority: ${task.priority}`);
    }
    if (Array.isArray(task.tags) && task.tags.length > 0) {
      notes.push(`Tags: ${task.tags.join(", ")}`);
    }
    return {
      task_id: task.task_id,
      unit_id: task.unit_id,
      pass_id: task.pass_id,
      lens: task.lens,
      agent_role: "provider-assisted-reviewer",
      file_coverage: await buildFileCoverage(task, root),
      findings: [],
      notes,
      requires_followup: false,
    };
  }));
}
