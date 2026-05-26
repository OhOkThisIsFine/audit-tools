import fs from 'fs';

const path = 'C:\\Code\\auditor-lambda\\.audit-artifacts\\runs\\20260526T015146464Z_audit_tasks_completed_001\\audit-results.json';
if (fs.existsSync(path)) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log('Results in audit-results.json:', data.length);
  for (const res of data) {
    console.log(`  Task: ${res.task_id}`);
  }
} else {
  console.log('audit-results.json does not exist');
}
