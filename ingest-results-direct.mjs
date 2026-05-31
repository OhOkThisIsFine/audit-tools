import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const root = "C:\\Code\\audit-tools";
const artifactsDir = join(root, ".audit-artifacts");
const runDir = join(artifactsDir, "runs", "run_1");
const workerResultsDir = join(runDir, "worker-results");
const taskResultsDir = join(runDir, "task-results");
const ingestedDir = join(runDir, "worker-results-ingested");

if (!existsSync(ingestedDir)) {
  mkdirSync(ingestedDir, { recursive: true });
}
if (!existsSync(taskResultsDir)) {
  mkdirSync(taskResultsDir, { recursive: true });
}

let files = [];
try {
  files = readdirSync(workerResultsDir).filter(f => f.endsWith(".json"));
} catch (e) {
  console.error(e);
}

let ingestedTasks = 0;

for (const file of files) {
  const filePath = join(workerResultsDir, file);
  try {
    const content = readFileSync(filePath, "utf8");
    const results = JSON.parse(content);
    
    if (!Array.isArray(results)) {
      console.error(`File ${file} does not contain a JSON array.`);
      continue;
    }

    for (const result of results) {
      if (!result || !result.task_id) {
         console.warn(`Skipping invalid result in ${file}`);
         continue;
      }
      
      const sanitized = result.task_id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const targetPath = join(taskResultsDir, `${sanitized}.json`);
      writeFileSync(targetPath, JSON.stringify(result, null, 2));
      ingestedTasks++;
    }
    
    renameSync(filePath, join(ingestedDir, file));
  } catch (err) {
    console.error(`Failed to ingest ${file}:`, err.message);
  }
}

console.log(`Direct ingestion complete. Wrote ${ingestedTasks} task results.`);
