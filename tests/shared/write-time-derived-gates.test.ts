import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';

import {
  buildWriteTimeLegs,
  runWriteTimeAdvisories,
} from '../../scripts/shared/derived-file-preflight.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PACKAGE_SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

describe('write-time derived gate advisories', () => {
  it('selects only declared file-scoped legs whose reach includes the edited path', () => {
    const backlog = buildWriteTimeLegs('docs/backlog/open-bugs.md', {
      packageScripts: PACKAGE_SCRIPTS,
    }).map((leg) => leg.id);
    expect(backlog).toEqual([
      'check:doc-code-citations',
      'check:backlog-budget',
      'check:backlog-line-numbers',
      'check:memory-citations',
    ]);

    const source = buildWriteTimeLegs('src/shared/contentKey.ts', {
      packageScripts: PACKAGE_SCRIPTS,
    });
    expect(source).toEqual([]);
  });

  it('returns findings as advisory data and never throws on a failed leg', () => {
    const execute = vi.fn(() => {
      const error = new Error('red') as Error & { stdout?: string; stderr?: string };
      error.stderr = 'citation does not resolve';
      throw error;
    });
    const result = runWriteTimeAdvisories({
      root: ROOT,
      filePath: 'docs/backlog/open-bugs.md',
      packageScripts: PACKAGE_SCRIPTS,
      execute,
    });
    expect(result.findings).toHaveLength(4);
    expect(result.findings[0]?.tail).toContain('citation does not resolve');
  });

  it('the live PostToolUse hook consumes the helper and keeps advisory legs exit-zero', () => {
    const hook = readFileSync(join(ROOT, '.claude', 'hooks', 'async-typecheck.mjs'), 'utf8');
    expect(hook).toContain('runWriteTimeAdvisories');
    expect(hook).toMatch(/write-time[^]*process\.exit\(0\)/i);

    const fixture = mkdtempSync(join(tmpdir(), 'write-time-advisory-'));
    try {
      const scripts = Object.fromEntries(
        [
          'check:doc-code-citations',
          'check:backlog-budget',
          'check:backlog-line-numbers',
          'check:memory-citations',
        ].map((name) => [name, 'node -e "process.exit(1)"']),
      );
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts }), 'utf8');
      const result = spawnSyncHidden(process.execPath, [join(ROOT, '.claude', 'hooks', 'async-typecheck.mjs')], {
        cwd: fixture,
        encoding: 'utf8',
        input: JSON.stringify({ tool_input: { file_path: join(fixture, 'docs', 'backlog', 'x.md') } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain('[ADVISORY]');
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); // a spawned hook child can still hold the dir on Windows (EPERM under load, 2026-09-10)
    }
  });
});
