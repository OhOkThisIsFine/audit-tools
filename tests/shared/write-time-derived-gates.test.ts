/**
 * The write-time backlog advisories: what the PostToolUse hook runs after an edit
 * to `docs/backlog/`, and the ONE leg it defers to commit.
 *
 * WHY ANY OF THIS EXISTS. The backlog's gates were reachable only at commit, and a
 * backlog entry is written in one session and landed in another — nine entries hit
 * `check:doc-code-citations` and then `check:backlog-line-numbers` as a serialized
 * fix-retry loop, against text whose author was no longer present. The hook closes
 * that by running the gates AT THE EDIT, where the text is still the writer's.
 *
 * TWO PROPERTIES ARE PINNED HERE, and neither is visible from reading either file.
 *
 * 1. THE LEG SET IS THE REGISTRY'S, NOT THE HOOK'S. `buildWriteTimeLegs` is the
 *    same draw `buildPreCommitLegs` feeds the commit gate; the hook holds a call
 *    site, no list. This test therefore reads the LIVE registry, so a gate that
 *    gains `writeTime` metadata joins the write-time set with no edit here, and one
 *    that loses it leaves.
 *
 * 2. THE BUDGET LEG IS REPORTED AND DEFERRED. `check:backlog-budget` refuses a
 *    stale recorded ceiling, and its remedy (`--update-baseline`) REWRITES
 *    `docs/backlog/.size-baseline.json`, deleting dead keys. Mid-lap that is the
 *    right action — but a write-time path that ran the leg and offered the remedy
 *    would let an edit that merely makes a ceiling stale clear it from a tree
 *    nobody meant to commit, and the baseline is exactly the lap-scoped state the
 *    budget gate must judge at commit. So the leg is SKIPPED at write time and
 *    announced; the refusal itself is not suppressed, it is deferred.
 *
 * The hook must also stay ADVISORY: whatever it finds, it exits 0. A hook that
 * could block an edit would be a gate, and the commit gate is the authority.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';

import {
  buildWriteTimeLegs,
  legRunnable,
  legCommand,
} from '../../scripts/shared/derived-file-preflight.mjs';
import {
  DEFERRAL_NOTE,
  WRITE_TIME_DEFERRED_LEGS,
  runBacklogWriteTimeGates,
} from '../../scripts/lib/write-time-backlog-gates.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

// The live hook detaches its typecheck work, so a grandchild can still hold the
// fixture directory on Windows after the hook itself has exited — `rmSync`
// then reports EPERM (measured under full-suite load and once alone,
// 2026-09-10). That is the detached child, not the property under test: wait
// for it, bounded, and if it still holds the directory leave the temp dir for
// the OS rather than fail a test whose assertions already passed.
function removeFixtureWithPatience(dir: string): void {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        process.stderr.write(`write-time fixture left in place (held by a detached child): ${dir} — ${String(error)}\n`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

const PACKAGE_SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

/** The ids `buildWriteTimeLegs` draws for one edited path, in registry order. */
function writeTimeIds(filePath: string): string[] {
  return buildWriteTimeLegs(filePath, { packageScripts: PACKAGE_SCRIPTS }).map((leg) => leg.id);
}

describe('the write-time leg set is drawn from the guard registry', () => {
  it('a backlog edit draws the whole file-scoped backlog family, in registry order', () => {
    expect(writeTimeIds('docs/backlog/open-bugs.md')).toEqual([
      'check:doc-code-citations',
      'check:backlog-budget',
      'check:backlog-friction-tags',
      'check:backlog-line-numbers',
      'check:memory-citations',
    ]);
  });

  it('every file-scoped backlog sibling fires on ANY backlog section, not just one', () => {
    for (const file of [
      'docs/backlog/open-bugs.md',
      'docs/backlog/minor-bugs.md',
      'docs/backlog/forward-tracks.md',
      'docs/backlog/deferred.md',
      'docs/backlog/durable-traps.md',
    ]) {
      expect(writeTimeIds(file), `${file} must draw the backlog family`).toEqual([
        'check:doc-code-citations',
        'check:backlog-budget',
        'check:backlog-friction-tags',
        'check:backlog-line-numbers',
        'check:memory-citations',
      ]);
    }
  });

  it('the baseline file its own ratchet reads is a write-time trigger too', () => {
    // The budget's own INPUT — an edit to the recorded ceilings is exactly the
    // edit whose consequence the gate has to state.
    expect(writeTimeIds('docs/backlog/.size-baseline.json')).toContain('check:backlog-budget');
  });

  it('a source .ts edit draws no advisory leg at all', () => {
    // The hook's common case must stay the typecheck alone: no npm process is
    // spawned for a path none of the file-scoped gates claims.
    expect(writeTimeIds('src/shared/contentKey.ts')).toEqual([]);
  });
});

describe('the runner reports findings as data and never owns a verdict', () => {
  const legs = buildWriteTimeLegs('docs/backlog/open-bugs.md', { packageScripts: PACKAGE_SCRIPTS });
  const wired = (): boolean => true;

  it('a failing leg becomes a finding carrying the gate id, its output and its fix hint', () => {
    const execute = vi.fn((command: string) => {
      if (command.includes('check:backlog-line-numbers')) {
        const error = new Error('red') as Error & { stdout?: string; stderr?: string };
        error.stderr = 'line-number citation `src/x.ts:123`';
        throw error;
      }
    });
    const result = runBacklogWriteTimeGates({
      legs,
      root: ROOT,
      execute,
      legRunnable: wired,
      legCommand,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe('check:backlog-line-numbers');
    expect(result.findings[0]?.tail).toContain('line-number citation');
    expect(result.findings[0]?.fix).toBeTruthy();
  });

  it('the registry leg is run by the command the shared leg decision yields', () => {
    // Not a hand-written `npm run <script>` in the runner: the leg KIND is a
    // property of the leg (`legCommand`), so a future non-npm leg kind is one
    // branch in one place rather than a second spelling here.
    const commands: string[] = [];
    runBacklogWriteTimeGates({
      legs,
      root: ROOT,
      execute: (command: string) => void commands.push(command),
      legRunnable: wired,
      legCommand,
    });
    expect(commands).toContain('npm run check:backlog-line-numbers');
  });

  it('an unwired leg is announced as skipped rather than counted as a pass', () => {
    const result = runBacklogWriteTimeGates({
      legs,
      root: ROOT,
      execute: () => {},
      legRunnable: () => false,
      legCommand,
    });
    expect(result.ran).toEqual([]);
    // The deferred leg is never probed for wiring — it does not run here at all,
    // so reporting it as "unwired" would be an announcement about nothing.
    expect(result.skipped).toHaveLength(legs.length - result.deferred.length);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });
});

describe('the size budget RATCHETS at commit only', () => {
  it('the budget leg is skipped at write time, and its remedy is not offered mid-edit', () => {
    const delivered: string[] = [];
    const result = runBacklogWriteTimeGates({
      legs: buildWriteTimeLegs('docs/backlog/open-bugs.md', { packageScripts: PACKAGE_SCRIPTS }),
      root: ROOT,
      execute: (command: string) => void delivered.push(command),
      legRunnable: () => true,
      legCommand,
    });

    expect(WRITE_TIME_DEFERRED_LEGS.has('check:backlog-budget')).toBe(true);
    expect(result.deferred).toEqual(['check:backlog-budget']);
    // The point of the deferral: the gate that WRITES the baseline never runs here.
    expect(delivered).not.toContain('npm run check:backlog-budget');
    // …while every sibling still does.
    expect(delivered).toContain('npm run check:backlog-line-numbers');
    expect(delivered).toContain('npm run check:doc-code-citations');
  });

  it('the deferral is stated, not silent — and the sentence has ONE home', () => {
    expect(DEFERRAL_NOTE).toMatch(/RATCHETS only at commit/);
    expect(DEFERRAL_NOTE).toMatch(/--update-baseline/);
    const hook = readFileSync(join(ROOT, '.claude', 'hooks', 'async-typecheck.mjs'), 'utf8');
    expect(hook).toContain('writeTime.deferred');
    expect(hook).toMatch(/DEFERRED to commit/);
    // The hook PRINTS the exported sentence rather than paraphrasing it: two copies of
    // one sentence decay independently, which is the rule this repo applies everywhere.
    expect(hook).toContain('DEFERRAL_NOTE');
    expect(hook, 'the hook must not restate the note').not.toMatch(/RATCHETS only at commit/);
  });

  it('the live PostToolUse hook consumes the runner and still exits 0 on every payload', () => {
    const hookSource = readFileSync(join(ROOT, '.claude', 'hooks', 'async-typecheck.mjs'), 'utf8');
    expect(hookSource).toContain('runBacklogWriteTimeGates');
    expect(hookSource).toContain('buildWriteTimeLegs');

    const fixture = mkdtempSync(join(tmpdir(), 'write-time-advisory-'));
    try {
      // Every advisory leg wired to a FAILING command, so the only thing that can
      // make this exit 0 is the hook's own advisory contract.
      const scripts = Object.fromEntries(
        [
          'check:doc-code-citations',
          'check:backlog-line-numbers',
          'check:memory-citations',
          'check:backlog-friction-tags',
        ].map((name) => [name, 'node -e "process.exit(1)"']),
      );
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts }), 'utf8');
      const result = spawnSyncHidden(process.execPath, [join(ROOT, '.claude', 'hooks', 'async-typecheck.mjs')], {
        cwd: fixture,
        encoding: 'utf8',
        input: JSON.stringify({ tool_input: { file_path: join(fixture, 'docs', 'backlog', 'x.md') } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
        timeout: 30_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain('[ADVISORY]');
      expect(result.stderr).toContain('DEFERRED to commit');
    } finally {
      removeFixtureWithPatience(fixture);
    }
  });
});

describe('legRunnable keeps a fixture repo from reporting a false gap', () => {
  it('an unwired gate script reads as not-runnable rather than as a failing leg', () => {
    const legs = buildWriteTimeLegs('docs/backlog/open-bugs.md', { packageScripts: PACKAGE_SCRIPTS });
    const fixture = mkdtempSync(join(tmpdir(), 'write-time-runnable-'));
    try {
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');
      for (const leg of legs) expect(legRunnable(fixture, leg)).toBe(false);
      for (const leg of legs) expect(legRunnable(ROOT, leg)).toBe(true);
    } finally {
      removeFixtureWithPatience(fixture);
    }
  });
});
