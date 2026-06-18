#!/usr/bin/env node
// PostToolUse (async) typecheck: after an Edit/Write to a source .ts file,
// typecheck the (single) package.
//
// ADVISORY ONLY — this hook surfaces early type-error hints to the agent;
// it is NOT an authoritative correctness verdict. The PreToolUse commit gate
// (pre-commit-gate.mjs) runs a full clean-env `npm run check` before every
// commit and is the sole authority. Never treat this hook's output as blocking
// evidence of correctness or incorrectness.
//
// Registered with "async": true so it NEVER blocks the edit.
// Exit 2 + stderr surfaces advisory failures; exit 0 = clean or skipped.
//
// Concurrency-safe debounce: uses a token-write-then-recheck protocol so that
// overlapping invocations for the same package coalesce to one post-quiescence
// run. The last writer wins; earlier writers detect they were superseded and exit.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ── 1. Parse payload — fail-open on any parse error ─────────────────────────
let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let filePath = '';
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  // Unparseable payload — advisory hint impossible; exit silently.
  process.exit(0);
}

// ── 2. Guard: only .ts files in a source subsystem ───────────────────────────
if (!filePath || !/\.(ts|mts|cts|tsx)$/i.test(filePath)) process.exit(0);

// Single-package layout: src/(shared|audit|remediate). Any one of them edited →
// run the whole-package typecheck (one tsc project compiles all three together).
const m = filePath
  .replace(/\\/g, '/')
  .match(/\/src\/(shared|audit|remediate)\//);
if (!m) process.exit(0);
const pkg = m[1];

// ── 3. Concurrency-safe debounce ─────────────────────────────────────────────
// Protocol: write a unique token, wait DEBOUNCE_MS, re-read.
// If the token still matches we are the last writer → proceed.
// If the token changed a later invocation superseded us → yield.
// This coalesces any burst of overlapping edits to one post-quiescence run.
const DEBOUNCE_MS = 45_000;
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stampDir = join(root, '.claude', 'hooks', '.state');
try {
  mkdirSync(stampDir, { recursive: true });
} catch {
  // Cannot create stamp dir — skip advisory check silently.
  process.exit(0);
}

const stamp = join(stampDir, `typecheck-${pkg}.stamp`);
const token = randomBytes(8).toString('hex');

try {
  writeFileSync(stamp, token, { encoding: 'utf8' });
} catch {
  // Stamp write failed (permissions, disk full, …) — skip silently.
  process.exit(0);
}

// Wait for the debounce window, then check if we still own the stamp.
await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));

let currentToken = '';
try {
  currentToken = readFileSync(stamp, { encoding: 'utf8' }).trim();
} catch {
  // Cannot read stamp — another process may have cleaned it; skip silently.
  process.exit(0);
}

if (currentToken !== token) {
  // A later invocation superseded us — it will run the check.
  process.exit(0);
}

// ── 4. Run typecheck — ADVISORY hint only ────────────────────────────────────
try {
  execSync(`npm run check`, {
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
    `[ADVISORY] async typecheck hint: src/${pkg} edit triggered type errors after your last edit.\n` +
    `This is an early hint only — the commit gate (pre-commit-gate.mjs) is the authority.\n${tail}`,
  );
  process.exit(2);
}
