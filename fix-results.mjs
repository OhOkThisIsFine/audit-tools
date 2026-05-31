import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = "C:\\Code\\audit-tools";
const runDir = join(root, ".audit-artifacts", "runs", "run_1");
const taskResultsDir = join(runDir, "task-results");
const tasksPath = join(runDir, "pending-audit-tasks.json");

const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
const taskMap = new Map(tasks.map(t => [t.task_id, t]));

const files = readdirSync(taskResultsDir).filter(f => f.endsWith(".json"));

let fixedCount = 0;
for (const file of files) {
  const filePath = join(taskResultsDir, file);
  try {
    const result = JSON.parse(readFileSync(filePath, "utf8"));
    const task = taskMap.get(result.task_id);
    if (task && result.file_coverage) {
      result.file_coverage = task.file_paths.map(p => ({
        path: p,
        total_lines: task.file_line_counts ? (task.file_line_counts[p] || 0) : 0
      }));
      writeFileSync(filePath, JSON.stringify(result, null, 2));
      fixedCount++;
    }
  } catch (e) {
    console.error(`Error fixing ${file}: ${e.message}`);
  }
}
console.log(`Fixed ${fixedCount} task results with correct file_coverage.`);
