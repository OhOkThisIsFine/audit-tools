import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function run() {
  const root = "C:\\Code\\audit-tools";
  const runDir = join(root, ".audit-artifacts", "runs", "run_1");
  const taskResultsDir = join(runDir, "task-results");
  
  const files = readdirSync(taskResultsDir).filter(f => f.endsWith(".json"));
  
  // Collect all paths to index
  const allPaths = new Set();
  const fileData = [];
  for (const file of files) {
    const filePath = join(taskResultsDir, file);
    try {
      const result = JSON.parse(readFileSync(filePath, "utf8"));
      fileData.push({ filePath, result });
      if (result.file_coverage) {
        for (const cov of result.file_coverage) {
          allPaths.add(cov.path);
        }
      }
    } catch(e) {}
  }
  
  const lineIndex = {};
  for (const p of allPaths) {
    const full = join(root, p);
    try {
      const content = readFileSync(full, "utf8");
      let lines = 0;
      if (content.length > 0) {
        lines = content.split('\n').length;
        if (content.endsWith('\n')) lines--;
      }
      lineIndex[p] = lines;
    } catch {
      lineIndex[p] = 0;
    }
  }

  let fixed = 0;
  for (const { filePath, result } of fileData) {
    if (result.file_coverage) {
      result.file_coverage = result.file_coverage.map(cov => ({
        path: cov.path,
        total_lines: lineIndex[cov.path] || 0
      }));
      writeFileSync(filePath, JSON.stringify(result, null, 2));
      fixed++;
    }
  }
  console.log(`Fixed ${fixed} task results with precise line counting.`);
}

run().catch(console.error);
