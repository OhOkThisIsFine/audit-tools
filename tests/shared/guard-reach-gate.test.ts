// Contract tests for the guard-reach reconciliation gate
// (`scripts/check-guard-reach.mjs` + `scripts/guard-reach-data.mjs`).
//
// The defect class this gate closes (nightly determination ec64d159): a guard
// that sounds general covers only part of what it names, and because nothing
// fails on the uncovered part, it reads as protected. Six recorded instances:
// the loop-core gate missing the CLI step-emitters, the pre-commit gate firing
// only on `git commit`, a smoke script wired into no gate, a forbidden command
// pinned in one file while a sibling still ran it, the vi.spyOn barrel guard
// scanning one of three test dirs, and no gate refusing a direct
// `child_process.spawn` in src/.
//
// The mechanism is the check:doc-manifest shape applied to guards: reach is
// DECLARED DATA (`GUARDS` = every guard implementation + how it is wired;
// `REACH` = which guard claims which tracked files), and one reconciler makes
// the four silent states loud:
//   • an unclaimed tracked file (a tree no guard scans, e.g. `scripts/` before
//     its gap was declared),
//   • a guard wired into no gate (`a script in no gate is not a gate`),
//   • a registered hook or check script with no registry row (bidirectional),
//   • a dead pattern / phantom guard id (the registry itself rotting).
//
// Lives under tests/shared because vitest excludes `.claude/**` — same reason
// as doc-manifest-gate.test.ts.
import { describe, it, expect } from 'vitest';
import { reconcile as reconcileImpl } from '../../scripts/check-guard-reach.mjs';

/** Mirrors the JSDoc typedefs in scripts/guard-reach-data.mjs. */
interface GuardRow {
  id: string;
  kind: 'gate' | 'hook' | 'git-hook' | 'contract-test';
  /** gate: an npm script name OR a repo path referenced verbatim by a reachable
   *  script; hook: the hook file's repo path; git-hook: the module's repo path,
   *  run by the tracked .githooks/<name> files in `hooks`; contract-test: the
   *  test file's repo path (must live under tests/ — vitest excludes .claude/**). */
  impl: string;
  /** git-hook only: the tracked .githooks/<name> files that exec the module. */
  hooks?: string[];
  /** REQUIRED on gates (P34): the derived pre-commit leg behavior, as data.
   *  Typed loosely here so the invalid-enum case can be expressed. */
  preCommit?: false | 'reach' | 'always' | 'final' | string | boolean;
  /** Per-leg remediation hint the derived gate leg prints. */
  fix?: string;
  note?: string;
}
interface ReachRow {
  area: string;
  files: string[];
  /** Guard ids that actually SCAN these files — or 'declared-gap' for a tree
   *  deliberately guarded by nothing, which must say why in `note`. */
  guardedBy: string[] | 'declared-gap';
  /** The stated uncovered half, as data — visible, never implied. */
  uncovered?: string;
  note?: string;
}
type ReconcileArgs = {
  guards: GuardRow[];
  reach: ReachRow[];
  onDisk: string[];
  packageScripts: Record<string, string>;
  settingsHookCommands: string[];
  /** `.githooks/<name>` → text, for the git-hook wiring check (P53). */
  gitHookTexts?: Record<string, string>;
};
const reconcile = reconcileImpl as (args: ReconcileArgs) => string[];

// ── minimal healthy fixture ──────────────────────────────────────────────────
// One gate reachable through the verify chain, one registered hook, one
// contract test, one declared gap. Every synthetic case below mutates exactly
// one thing and asserts the reconciler names it.
const SCRIPTS: Record<string, string> = {
  'verify:checks':
    'node scripts/shared/profile-run.mjs verify-checks check:alpha build',
  'verify:release':
    'npm run verify:checks && node scripts/shared/run-vitest-gate.mjs',
  'check:alpha': 'node scripts/check-alpha.mjs',
  build: 'tsc -p tsconfig.json',
};
const HOOK_COMMANDS = [
  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/beta-guard.mjs"',
];
const GUARDS: GuardRow[] = [
  { id: 'check:alpha', kind: 'gate', impl: 'check:alpha', preCommit: 'reach', fix: 'fix alpha' },
  { id: 'build', kind: 'gate', impl: 'build', preCommit: false, fix: 'fix the build' },
  { id: 'vitest-gate', kind: 'gate', impl: 'scripts/shared/run-vitest-gate.mjs', preCommit: false, fix: 'fix the suite' },
  { id: 'beta-guard', kind: 'hook', impl: '.claude/hooks/beta-guard.mjs' },
  { id: 'delta-gate', kind: 'git-hook', impl: '.claude/hooks/delta-gate.mjs', hooks: ['.githooks/pre-commit'] },
  { id: 'gamma-contract', kind: 'contract-test', impl: 'tests/shared/gamma.test.ts' },
];
const GIT_HOOK_TEXTS: Record<string, string> = {
  '.githooks/pre-commit': '#!/bin/sh\nexec node "$(dirname "$0")/../.claude/hooks/delta-gate.mjs" pre-commit "$@"\n',
};
const REACH: ReachRow[] = [
  { area: 'source', files: ['src/**'], guardedBy: ['build', 'vitest-gate'] },
  { area: 'tests', files: ['tests/**'], guardedBy: ['vitest-gate'] },
  { area: 'gates', files: ['scripts/**'], guardedBy: ['check:alpha'] },
  { area: 'hooks', files: ['.claude/hooks/**'], guardedBy: ['gamma-contract'] },
  { area: 'git hooks', files: ['.githooks/**'], guardedBy: ['gamma-contract'] },
  {
    area: 'meta',
    files: ['package.json'],
    guardedBy: 'declared-gap',
    note: 'consumed at every gate run; malformed fails loudly',
  },
];
const ON_DISK = [
  'src/a.ts',
  'tests/shared/gamma.test.ts',
  'scripts/check-alpha.mjs',
  'scripts/shared/run-vitest-gate.mjs',
  '.claude/hooks/beta-guard.mjs',
  '.claude/hooks/delta-gate.mjs',
  '.githooks/pre-commit',
  'package.json',
];

const run = (over: Partial<ReconcileArgs> = {}) =>
  reconcile({
    guards: GUARDS,
    reach: REACH,
    onDisk: ON_DISK,
    packageScripts: SCRIPTS,
    settingsHookCommands: HOOK_COMMANDS,
    gitHookTexts: GIT_HOOK_TEXTS,
    ...over,
  });

describe('healthy registry', () => {
  it('a fully claimed, fully wired tree reconciles clean', () => {
    expect(run()).toEqual([]);
  });
});

describe('git-hook guards are wired by git, not settings.json (P53)', () => {
  it('a git-hook row whose .githooks file does not run its module is an error', () => {
    const errors = run({
      gitHookTexts: { '.githooks/pre-commit': '#!/bin/sh\nexec node other.mjs\n' },
    });
    expect(errors.some((e) => e.includes('delta-gate') && e.includes('not wired'))).toBe(true);
  });

  it('a git-hook row naming an untracked hook file is an error', () => {
    const errors = run({ onDisk: ON_DISK.filter((f) => f !== '.githooks/pre-commit') });
    expect(errors.some((e) => e.includes('delta-gate') && /untracked hook file/.test(e))).toBe(true);
  });

  it('a git-hook row with no hooks declared is an error', () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'delta-gate' ? { ...g, hooks: [] } : g)),
    });
    expect(errors.some((e) => e.includes('delta-gate') && /declares no `hooks`/.test(e))).toBe(true);
  });

  it('a tracked .githooks file running a .claude/hooks module with no git-hook row is an error', () => {
    const errors = run({
      guards: GUARDS.filter((g) => g.id !== 'delta-gate'),
      reach: REACH.map((r) => (r.area === 'hooks' ? { ...r, files: ['.claude/hooks/**'] } : r)),
    });
    expect(errors.some((e) => e.includes('.githooks/pre-commit') && /no git-hook GUARDS row/.test(e))).toBe(true);
  });

  it('a preCommit flag on a git-hook row is an error', () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'delta-gate' ? { ...g, preCommit: 'reach' } : g)),
    });
    expect(errors.some((e) => e.includes('delta-gate') && /preCommit flag/.test(e))).toBe(true);
  });
});

describe('union coverage — the scripts/-tree hole made loud', () => {
  it('a tracked file no reach row claims is an error naming the file', () => {
    const errors = run({ onDisk: [...ON_DISK, 'tools/orphan.mjs'] });
    expect(errors.some((e) => e.includes('tools/orphan.mjs'))).toBe(true);
  });

  it('a declared-gap row is a CLAIM — deliberate gaps reconcile clean, silence does not', () => {
    const errors = run({
      onDisk: [...ON_DISK, 'assets/logo.png'],
      reach: [
        ...REACH,
        { area: 'assets', files: ['assets/**'], guardedBy: 'declared-gap', note: 'binary assets' },
      ],
    });
    expect(errors).toEqual([]);
  });
});

describe('registry rot — dead patterns and phantom guards', () => {
  it('a reach pattern matching zero tracked files is an error', () => {
    const errors = run({
      reach: [...REACH, { area: 'ghost', files: ['ghost/**'], guardedBy: ['build'] }],
    });
    expect(errors.some((e) => e.includes('ghost/**'))).toBe(true);
  });

  it('a guardedBy id with no GUARDS row is an error', () => {
    const errors = run({
      reach: [{ ...REACH[0], guardedBy: ['no-such-guard'] }, ...REACH.slice(1)],
    });
    expect(errors.some((e) => e.includes('no-such-guard'))).toBe(true);
  });

  it('duplicate guard ids are an error', () => {
    const errors = run({ guards: [...GUARDS, { ...GUARDS[0] }] });
    expect(errors.some((e) => e.includes('check:alpha') && /duplicate/i.test(e))).toBe(true);
  });
});

describe('wiring — a script in no gate is not a gate', () => {
  it('a gate row whose npm script is not reachable from verify:release is an error', () => {
    const errors = run({
      guards: [...GUARDS, { id: 'check:stray', kind: 'gate', impl: 'check:stray', preCommit: false, fix: 'fix stray' }],
      packageScripts: { ...SCRIPTS, 'check:stray': 'node scripts/check-stray.mjs' },
    });
    expect(errors.some((e) => e.includes('check:stray'))).toBe(true);
  });

  it('a gate row may be wired as a path referenced verbatim in a reachable script (the vitest-gate shape)', () => {
    // vitest-gate's impl is a path inside verify:release's command string, not
    // an npm script name — the healthy fixture already asserts it reconciles.
    const errors = run({
      guards: GUARDS.map((g) =>
        g.id === 'vitest-gate' ? { ...g, impl: 'scripts/shared/never-invoked.mjs' } : g,
      ),
      onDisk: [...ON_DISK, 'scripts/shared/never-invoked.mjs'],
    });
    expect(errors.some((e) => e.includes('never-invoked'))).toBe(true);
  });

  it('a hook row not registered in settings.json hook commands is an error', () => {
    const errors = run({ settingsHookCommands: [] });
    expect(errors.some((e) => e.includes('beta-guard'))).toBe(true);
  });

  it('a contract-test row whose file is untracked, or outside tests/, is an error', () => {
    const gone = run({ onDisk: ON_DISK.filter((f) => f !== 'tests/shared/gamma.test.ts') });
    expect(gone.some((e) => e.includes('gamma.test.ts'))).toBe(true);

    const misplaced = run({
      guards: GUARDS.map((g) =>
        g.id === 'gamma-contract' ? { ...g, impl: '.claude/hooks/gamma.test.ts' } : g,
      ),
      onDisk: [...ON_DISK, '.claude/hooks/gamma.test.ts'],
    });
    expect(misplaced.some((e) => e.includes('gamma.test.ts'))).toBe(true);
  });
});

describe('bidirectional — a new guard cannot land outside the registry', () => {
  it('a settings.json hook command whose file has no GUARDS row is an error', () => {
    const errors = run({
      settingsHookCommands: [
        ...HOOK_COMMANDS,
        'node "$CLAUDE_PROJECT_DIR/.claude/hooks/unregistered.mjs"',
      ],
      onDisk: [...ON_DISK, '.claude/hooks/unregistered.mjs'],
    });
    expect(errors.some((e) => e.includes('unregistered.mjs'))).toBe(true);
  });

  it('a settings.json hook command pointing at an untracked file is an error', () => {
    const errors = run({
      settingsHookCommands: [
        ...HOOK_COMMANDS,
        'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ghost-hook.mjs"',
      ],
    });
    expect(errors.some((e) => e.includes('ghost-hook.mjs'))).toBe(true);
  });

  it('a tracked scripts/check-*.mjs no gate row runs is an error', () => {
    const errors = run({ onDisk: [...ON_DISK, 'scripts/check-orphaned.mjs'] });
    expect(errors.some((e) => e.includes('check-orphaned.mjs'))).toBe(true);
  });

  it('a check:* npm script with no GUARDS row is an error', () => {
    const errors = run({
      packageScripts: { ...SCRIPTS, 'check:rowless': 'node scripts/check-alpha.mjs' },
    });
    expect(errors.some((e) => e.includes('check:rowless'))).toBe(true);
  });
});

describe('win32 — comparisons survive backslashed inputs', () => {
  it('backslashed hook command paths and onDisk entries normalize before comparison', () => {
    const errors = run({
      settingsHookCommands: ['node "$CLAUDE_PROJECT_DIR/.claude\\hooks\\beta-guard.mjs"'],
      onDisk: ON_DISK.map((f) => f.replace(/\//g, '\\')),
    });
    expect(errors).toEqual([]);
  });
});

describe('preCommit flag discipline (P34) — the derived leg set is stated, never silent', () => {
  it('a gate row with no preCommit flag is an error naming the gate', () => {
    const errors = run({
      guards: GUARDS.map((g) => {
        if (g.id !== 'check:alpha') return g;
        const { preCommit: _preCommit, ...rest } = g;
        return rest as GuardRow;
      }),
    });
    expect(errors.some((e) => e.includes('check:alpha') && e.includes('preCommit'))).toBe(true);
  });

  it('a preCommit flag on a hook row is an error', () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'beta-guard' ? { ...g, preCommit: false as const } : g)),
    });
    expect(errors.some((e) => e.includes('beta-guard') && e.includes('preCommit'))).toBe(true);
  });

  it('a preCommit flag on a contract-test row is an error', () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'gamma-contract' ? { ...g, preCommit: 'reach' } : g)),
    });
    expect(errors.some((e) => e.includes('gamma-contract') && e.includes('preCommit'))).toBe(true);
  });

  it('an invalid enum value is an error (true is not a value — the statement must be one of the four)', () => {
    for (const bad of [true, 'sometimes'] as const) {
      const errors = run({
        guards: GUARDS.map((g) => (g.id === 'check:alpha' ? { ...g, preCommit: bad } : g)),
      });
      expect(
        errors.some((e) => e.includes('check:alpha') && e.includes('invalid preCommit')),
        `preCommit ${JSON.stringify(bad)} must be refused`,
      ).toBe(true);
    }
  });

  it("a 'reach' gate cited by zero REACH rows is an error — an empty trigger can never fire", () => {
    // Rewire the 'gates' row to a different guard so check:alpha keeps its
    // wiring but loses every citation.
    const errors = run({
      reach: REACH.map((r) => (r.area === 'gates' ? { ...r, guardedBy: ['build'] } : r)),
    });
    expect(errors.some((e) => e.includes('check:alpha') && e.includes('no REACH row'))).toBe(true);
  });

  it("a 'final' gate cited by zero REACH rows is an error too", () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'check:alpha' ? { ...g, preCommit: 'final' as const } : g)),
      reach: REACH.map((r) => (r.area === 'gates' ? { ...r, guardedBy: ['build'] } : r)),
    });
    expect(errors.some((e) => e.includes('check:alpha') && e.includes('no REACH row'))).toBe(true);
  });

  it("an 'always' gate needs no citation — its trigger is unconditional", () => {
    const errors = run({
      guards: GUARDS.map((g) => (g.id === 'check:alpha' ? { ...g, preCommit: 'always' as const } : g)),
      reach: REACH.map((r) => (r.area === 'gates' ? { ...r, guardedBy: ['build'] } : r)),
    });
    expect(errors).toEqual([]);
  });

  it('a gate row without a fix is an error — a fixless gate is invisible to the regenerate-shaped meta-test (F2)', () => {
    const errors = run({
      guards: GUARDS.map((g) => {
        if (g.id !== 'check:alpha') return g;
        const { fix: _dropped, ...rest } = g;
        return rest;
      }),
    });
    expect(errors.some((e) => e.includes('check:alpha') && e.includes('declares no fix'))).toBe(true);
  });
});
