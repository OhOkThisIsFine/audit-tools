import fs from 'fs';
import path from 'path';

const runId = '20260526T015146464Z_audit_tasks_completed_001';
const resultsDir = `C:\\Code\\auditor-lambda\\.audit-artifacts\\runs\\${runId}\\task-results`;
const pendingTasksPath = `C:\\Code\\auditor-lambda\\.audit-artifacts\\runs\\${runId}\\pending-audit-tasks.json`;
const root = 'C:\\Code\\auditor-lambda';

function countLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) return 0;
  let lines = 0;
  let lastByte = -1;
  for (let i = 0; i < buffer.length; ++i) {
    if (buffer[i] === 10) lines++;
    lastByte = buffer[i];
  }
  return lastByte !== 10 ? lines + 1 : lines;
}

// 1. Load pending tasks and update their file_line_counts
const pendingTasks = JSON.parse(fs.readFileSync(pendingTasksPath, 'utf8'));
const fileToCountMap = new Map();

for (const task of pendingTasks) {
  if (task.file_line_counts) {
    for (const file of Object.keys(task.file_line_counts)) {
      const fullPath = path.resolve(root, file);
      let count = fileToCountMap.get(fullPath);
      if (count === undefined) {
        count = countLines(fullPath);
        fileToCountMap.set(fullPath, count);
      }
      task.file_line_counts[file] = count;
    }
  }
}
fs.writeFileSync(pendingTasksPath, JSON.stringify(pendingTasks, null, 2), 'utf8');
console.log('Updated pending-audit-tasks.json!');

// 2. Load all task JSON results and update their file_coverage total_lines
const resultFiles = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));

for (const file of resultFiles) {
  const filePath = path.join(resultsDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  if (data.file_coverage) {
    for (const cov of data.file_coverage) {
      const fullPath = path.resolve(root, cov.path);
      let count = fileToCountMap.get(fullPath);
      if (count === undefined) {
        count = countLines(fullPath);
        fileToCountMap.set(fullPath, count);
      }
      cov.total_lines = count;
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

console.log('Updated all task result JSON files!');
