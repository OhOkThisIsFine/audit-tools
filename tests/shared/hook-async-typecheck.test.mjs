// Behavioral contract for `.claude/hooks/async-typecheck.mjs`.
//
// Ported from a test that lived BESIDE the hook and therefore never ran: vitest
// excludes `.claude/**`, so it sat untracked and unexecuted, and its fixtures
// had silently rotted to the pre-single-package layout (`packages/audit-code/
// src/...`, which the hook's current path regex does not match). A test that
// cannot run cannot notice that.
//
// The hook is ADVISORY — it must never block an edit. Every case here is
// therefore a fail-open case: whatever the payload, exit 0.
//
// Dropped in the port: assertions that grepped the hook SOURCE for strings
// ("must contain currentToken !== token", "must include [ADVISORY]"). Those pin
// prose, not behavior — they pass while the mechanism is broken and fail on a
// harmless reword.
import { describe, it, expect } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = join(resolve(import.meta.dirname, '..', '..'), '.claude', 'hooks', 'async-typecheck.mjs');

// Runs against a THROWAWAY project dir: the hook writes debounce stamps under
// <root>/.claude/hooks/.state, and a test must not perturb the real ones.
function runHook(payload, { timeout = 15_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'async-typecheck-'));
  try {
    const r = spawnSyncHidden(process.execPath, [HOOK], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    return { status: r.status, stderr: r.stderr ?? '', root };
  } finally {
    // Leave the dir for the stamp assertion; callers clean up.
  }
}

describe('async-typecheck hook: fail-open on every payload it cannot act on', () => {
  const cases = [
    ['unparseable JSON', 'this is not json at all'],
    ['empty stdin', ''],
    ['missing file_path', { tool_name: 'Edit', tool_input: {} }],
    ['empty file_path', { tool_name: 'Edit', tool_input: { file_path: '' } }],
    ['non-TypeScript file', { tool_name: 'Edit', tool_input: { file_path: '/repo/src/shared/foo.js' } }],
    ['.ts outside a source area', { tool_name: 'Edit', tool_input: { file_path: '/some/random/place/foo.ts' } }],
  ];

  for (const [label, payload] of cases) {
    it(`${label} → exit 0`, () => {
      const { status, stderr, root } = runHook(payload);
      try {
        expect(status, `stderr:\n${stderr}`).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('async-typecheck hook: debounce stamp', () => {
  it('writes its stamp token immediately, before the debounce wait', () => {
    // A source path in the CURRENT layout — the rotted fixture this replaces
    // used `packages/audit-code/src/...`, which the hook no longer matches, so
    // it was asserting the stamp of a code path it never reached.
    const payload = { tool_name: 'Edit', tool_input: { file_path: '/repo/src/shared/foo.ts' } };
    // The hook debounces for 45s, so it is killed by this short timeout on
    // purpose: the assertion is that the stamp already exists by then.
    const { root } = runHook(payload, { timeout: 3_000 });
    try {
      const stateDir = join(root, '.claude', 'hooks', '.state');
      const stamps = readdirSync(stateDir).filter((f) => f.endsWith('.stamp'));
      expect(stamps.length, 'a stamp must be written before the debounce wait').toBeGreaterThan(0);
      const token = readFileSync(join(stateDir, stamps[0]), 'utf8').trim();
      expect(token).toMatch(/^[0-9a-f]+$/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
