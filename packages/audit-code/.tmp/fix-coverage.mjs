import fs from 'fs';
import path from 'path';

const runId = '20260526T015146464Z_audit_tasks_completed_001';
const resultsDir = `C:\\Code\\auditor-lambda\\.audit-artifacts\\runs\\${runId}\\task-results`;
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

const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const filePath = path.join(resultsDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  if (data.file_coverage) {
    let changed = false;
    for (const cov of data.file_coverage) {
      if (cov.total_lines === 0) {
        const fullPath = path.resolve(root, cov.path);
        const count = countLines(fullPath);
        console.log(`Setting ${cov.path} line count to ${count}`);
        cov.total_lines = count;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
  }
}

console.log('Done fixing line counts!');
