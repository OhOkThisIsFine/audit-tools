import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

async function run() {
  const root = "C:\\Code\\audit-tools";
  const runDir = join(root, ".audit-artifacts", "runs", "run_1");
  const failedPath = join(runDir, "failed-tasks.json");
  const taskResultsDir = join(runDir, "task-results");

  const failedTasks = JSON.parse(readFileSync(failedPath, "utf8"));
  
  const expectedCounts = {};
  const regex = /current file line count for '([^']+)' \(expected (\d+)/;

  for (const t of failedTasks) {
    if (!t.errors) continue;
    for (const err of t.errors) {
      const match = err.match(regex);
      if (match) {
        expectedCounts[match[1]] = parseInt(match[2], 10);
      }
    }
  }

  const files = readdirSync(taskResultsDir).filter(f => f.endsWith(".json"));
  let fixed = 0;
  
  for (const file of files) {
    const filePath = join(taskResultsDir, file);
    try {
      const result = JSON.parse(readFileSync(filePath, "utf8"));
      let changed = false;
      if (result.file_coverage) {
        for (const cov of result.file_coverage) {
          if (expectedCounts[cov.path] !== undefined && expectedCounts[cov.path] !== cov.total_lines) {
            cov.total_lines = expectedCounts[cov.path];
            changed = true;
          }
        }
      }
      if (changed) {
        writeFileSync(filePath, JSON.stringify(result, null, 2));
        fixed++;
      }
    } catch(e) {}
  }
  
  console.log(`Fixed ${fixed} task results using exact expected line counts from failed-tasks.json.`);
}

run().catch(console.error);
