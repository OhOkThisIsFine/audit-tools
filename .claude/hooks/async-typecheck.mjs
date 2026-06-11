#!/usr/bin/env node
// PostToolUse (async) typecheck: after an Edit/Write to a workspace .ts file,
// typecheck just that package. Registered with "async": true so it NEVER
// blocks the edit; exit 2 + stderr surfaces failures to the agent when done.
// Debounced per package (45s stamp) so edit bursts trigger one check.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let filePath = '';
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  process.exit(0);
}
if (!/\.(ts|mts|cts|tsx)$/i.test(filePath)) process.exit(0);

const m = filePath
  .replace(/\\/g, '/')
  .match(/packages\/(shared|audit-code|remediate-code)\//);
if (!m) process.exit(0);
const pkg = m[1];

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stampDir = join(root, '.claude', 'hooks', '.state');
mkdirSync(stampDir, { recursive: true });
const stamp = join(stampDir, `typecheck-${pkg}.stamp`);
if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < 45_000) {
  process.exit(0);
}
writeFileSync(stamp, String(Date.now()));

try {
  execSync(`npm run check -w packages/${pkg}`, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  process.exit(0);
} catch (err) {
  const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    .trim()
    .split('\n')
    .slice(-30)
    .join('\n');
  console.error(
    `async typecheck: packages/${pkg} is FAILING after your last edit:\n${tail}`,
  );
  process.exit(2);
}
