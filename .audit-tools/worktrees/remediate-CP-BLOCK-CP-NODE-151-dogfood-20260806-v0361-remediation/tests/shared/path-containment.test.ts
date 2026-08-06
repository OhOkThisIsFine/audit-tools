// Contract tests for the single-sourced root-containment guard
// (`src/shared/io/pathContainment.ts`).
//
// This check used to be reimplemented five times across audit dispatch, the
// TypeScript analyzer, graph extraction, the openai-compatible provider and
// remediate's worktree seeding. The cases below pin the two places the copies
// DISAGREED, because those are the ones a re-fork would silently reintroduce.
import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { resolveWithinRoot, assertWithinRoot } from '../../src/shared/io/pathContainment.js';

const ROOT = resolve(process.platform === 'win32' ? 'C:/repo' : '/repo');

describe('resolveWithinRoot: contained paths', () => {
  it('resolves a repo-relative path to its absolute form', () => {
    expect(resolveWithinRoot(ROOT, 'src/index.ts')).toBe(resolve(ROOT, 'src/index.ts'));
  });

  it('accepts an absolute path that is already inside the root', () => {
    const abs = resolve(ROOT, 'src/index.ts');
    expect(resolveWithinRoot(ROOT, abs)).toBe(abs);
  });

  it('accepts a path that normalizes back inside (`a/../b`)', () => {
    expect(resolveWithinRoot(ROOT, 'src/../lib/x.ts')).toBe(resolve(ROOT, 'lib/x.ts'));
  });

  it('treats both separators identically', () => {
    expect(resolveWithinRoot(ROOT, 'src\\a\\b.ts')).not.toBeNull();
    expect(resolveWithinRoot(ROOT, 'src/a/b.ts')).not.toBeNull();
  });
});

describe('resolveWithinRoot: escapes', () => {
  it('rejects a `..` escape', () => {
    expect(resolveWithinRoot(ROOT, '../outside/x.ts')).toBeNull();
    expect(resolveWithinRoot(ROOT, '..')).toBeNull();
    expect(resolveWithinRoot(ROOT, 'src/../../x.ts')).toBeNull();
  });

  it('rejects an absolute path outside the root', () => {
    const outside = resolve(process.platform === 'win32' ? 'C:/elsewhere/x.ts' : '/elsewhere/x.ts');
    expect(resolveWithinRoot(ROOT, outside)).toBeNull();
  });

  it('rejects empty / non-string candidates', () => {
    expect(resolveWithinRoot(ROOT, '')).toBeNull();
    // @ts-expect-error — deliberately exercising the runtime `typeof candidate !== "string"`
    // guard against a non-TS caller passing undefined.
    expect(resolveWithinRoot(ROOT, undefined)).toBeNull();
    // @ts-expect-error — same runtime guard, against a non-TS caller passing null.
    expect(resolveWithinRoot(ROOT, null)).toBeNull();
  });

  // The copy in worktreeLifecycle.ts tested ONLY `startsWith("..")`. On win32 a
  // cross-drive `relative()` returns an ABSOLUTE path, which does not start with
  // ".." — so that copy read a different drive as CONTAINED.
  it.skipIf(process.platform !== 'win32')('rejects a different win32 drive (relative() returns absolute)', () => {
    expect(resolveWithinRoot('C:/repo', 'D:/elsewhere/x.ts')).toBeNull();
  });
});

describe('resolveWithinRoot: the root itself', () => {
  it('counts the root as contained by default', () => {
    expect(resolveWithinRoot(ROOT, '.')).toBe(ROOT);
    expect(resolveWithinRoot(ROOT, ROOT)).toBe(ROOT);
  });

  it('rejects the root under `allowRoot: false` (a write target is never "the repo")', () => {
    expect(resolveWithinRoot(ROOT, '.', { allowRoot: false })).toBeNull();
    expect(resolveWithinRoot(ROOT, ROOT, { allowRoot: false })).toBeNull();
  });
});

describe('resolveWithinRoot: the escape test is SEGMENT-accurate', () => {
  // A bare `startsWith("..")` rejected a real entry whose NAME begins with two
  // dots — it is inside the root, and every hand-rolled copy got it wrong.
  it('accepts an entry named `..cache` inside the root', () => {
    expect(resolveWithinRoot(ROOT, '..cache/x.ts')).toBe(resolve(ROOT, '..cache/x.ts'));
  });

  it('still rejects the real parent traversal it resembles', () => {
    expect(resolveWithinRoot(ROOT, `..${sep}cache/x.ts`)).toBeNull();
  });
});

describe('assertWithinRoot', () => {
  it('returns the absolute path when contained', () => {
    expect(assertWithinRoot(ROOT, 'src/index.ts')).toBe(resolve(ROOT, 'src/index.ts'));
  });

  it('throws naming the offending path and the root', () => {
    expect(() => assertWithinRoot(ROOT, '../x.ts')).toThrow(/escapes repository root/);
    expect(() => assertWithinRoot(ROOT, '../x.ts')).toThrow(/\.\.\/x\.ts/);
  });

  it('honors allowRoot: false', () => {
    expect(() => assertWithinRoot(ROOT, '.', { allowRoot: false })).toThrow(/escapes repository root/);
  });
});
