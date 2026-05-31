import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const root = "C:\\Code\\audit-tools";
const runDir = join(root, ".audit-artifacts", "runs", "run_1");
const tasksPath = join(runDir, "pending-audit-tasks.json");

const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));

for (const task of tasks) {
  if (!task.file_line_counts) {
    task.file_line_counts = {};
  }
  for (const p of task.file_paths) {
    const fullPath = join(root, p);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf8");
      // count lines just like addFileLineCountHints:
      // Typically it's content.split('\n').length
      task.file_line_counts[p] = content.split('\n').length;
    } else {
      task.file_line_counts[p] = 0;
    }
  }
}

writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
console.log("Updated pending-audit-tasks.json with actual line counts.");
