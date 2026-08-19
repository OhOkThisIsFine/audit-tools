// P34 (owner decision 2026-08-18): the pre-commit gate's leg set and every
// trigger are DERIVED from the guard-reach registry via `buildPreCommitLegs`
// (scripts/shared/derived-file-preflight.mjs) instead of hand-accreted in the
// hook. This is the unit matrix over that derivation, run against the LIVE
// registry + the LIVE package.json: every retired hand-coded trigger must be
// reproduced (or safely WIDENED — more legs firing is the safe direction;
// fewer is the defect class the derivation exists to end). The spawn-through-
// the-real-hook smoke lives in pre-commit-gate-derived-legs.test.ts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPreCommitLegs } from '../../scripts/shared/derived-file-preflight.mjs';
import { GUARDS } from '../../scripts/guard-reach-data.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const PACKAGE_SCRIPTS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

interface Leg {
  id: string;
  script: string;
  phase: 'main' | 'final';
  fix: string;
  triggered(ctx: { root: string; staged: string[] }): boolean;
}
interface GuardRow {
  id: string;
  kind: 'gate' | 'hook' | 'contract-test';
  impl: string;
  preCommit?: false | 'reach' | 'always' | 'final';
}
const guards = GUARDS as GuardRow[];

// A root with NO nightly queue, so the handoff widening exercises only its
// fixed predicate — the probe scans are queue-state-dependent and belong to
// the module's own e2e coverage.
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'leg-derivation-'));
process.on('exit', () => {
  try {
    rmSync(EMPTY_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const legs = () => buildPreCommitLegs({ packageScripts: PACKAGE_SCRIPTS }) as Leg[];
const triggeredIds = (staged: string[]) =>
  legs()
    .filter((l) => l.triggered({ root: EMPTY_ROOT, staged }))
    .map((l) => l.id);

describe('leg-set membership follows the registry preCommit flags', () => {
  it('every gate with a non-false preCommit flag is a leg; nothing else is', () => {
    const expected = guards
      .filter((g) => g.kind === 'gate' && g.preCommit !== false && g.preCommit != null)
      .map((g) => g.id)
      .sort();
    expect(legs().map((l) => l.id).sort()).toEqual(expected);
  });

  it('check:doc-links is phase final and ordered last — the masking fix survives derivation', () => {
    const all = legs();
    const docLinks = all.find((l) => l.id === 'check:doc-links');
    expect(docLinks?.phase).toBe('final');
    // Every final-phase leg sits after every main-phase leg.
    const firstFinal = all.findIndex((l) => l.phase === 'final');
    expect(all.slice(firstFinal).every((l) => l.phase === 'final')).toBe(true);
    expect(all[all.length - 1].id).toBe('check:doc-links');
  });

  it('every leg carries a fix hint (registry fix, or the generic fallback)', () => {
    for (const leg of legs()) {
      expect(leg.fix, `${leg.id} must carry a fix hint`).toBeTruthy();
    }
  });
});

describe('every retired hand-coded trigger is reproduced', () => {
  it('check:guard-reach fires unconditionally, even on a src-only staged set', () => {
    expect(triggeredIds(['src/shared/types.ts'])).toContain('check:guard-reach');
  });

  it('any staged markdown fires the md-corpus gates: doc-manifest, doc-code-citations, memory-citations, doc-links', () => {
    const ids = triggeredIds(['spec/audit/audit-goals.md']);
    for (const g of ['check:doc-manifest', 'check:doc-code-citations', 'check:memory-citations', 'check:doc-links']) {
      expect(ids, `staged md must trigger ${g}`).toContain(g);
    }
  });

  it('a staged backlog file fires the whole backlog family: index, budget, status, handoff parity', () => {
    const ids = triggeredIds(['docs/backlog/open-bugs.md']);
    for (const g of ['check:backlog-index', 'check:backlog-budget', 'check:backlog-status', 'check:handoff-roadmap']) {
      expect(ids, `staged backlog md must trigger ${g}`).toContain(g);
    }
    // docs/backlog.md (the router/index file) fires the family too.
    expect(triggeredIds(['docs/backlog.md'])).toContain('check:backlog-index');
  });

  it('the nightly-prompt sources and the check script itself fire check:nightly-routine-prompt', () => {
    for (const p of [
      'docs/nightly-routine.md',
      'docs/doc-review-guidelines.md',
      'docs/nightly-routine-prompt.md',
      'scripts/check-nightly-routine-prompt.mjs', // impl-path auto-rule
    ]) {
      expect(triggeredIds([p]), `${p} must trigger the nightly-prompt leg`).toContain('check:nightly-routine-prompt');
    }
  });

  it('the HANDOFF fixed inputs fire check:handoff-roadmap (custom widening intact)', () => {
    for (const p of [
      'docs/HANDOFF.md',
      '.audit-tools/nightly/open-items.json',
      '.claude/nightly-decisions.json',
      'scripts/shared/generate-handoff-roadmap.mjs',
      'scripts/nightly/items.mjs', // only reachable through the widening predicate
    ]) {
      expect(triggeredIds([p]), `${p} must trigger the handoff leg`).toContain('check:handoff-roadmap');
    }
  });

  it('the philosophy pair fires check:philosophy-brief — and other markdown does not', () => {
    expect(triggeredIds(['README.md'])).toContain('check:philosophy-brief');
    expect(triggeredIds(['docs/project-philosophy.md'])).toContain('check:philosophy-brief');
    expect(triggeredIds(['docs/HANDOFF.md'])).not.toContain('check:philosophy-brief');
  });

  it('the gate-enumeration render target fires check:gate-enumeration', () => {
    expect(triggeredIds(['.claude/skills/ship/SKILL.md'])).toContain('check:gate-enumeration');
  });

  it('ci.yml fires check:ci-trigger-paths; the registry data file fires it too (gate-scripts row)', () => {
    expect(triggeredIds(['.github/workflows/ci.yml'])).toContain('check:ci-trigger-paths');
    expect(triggeredIds(['scripts/guard-reach-data.mjs'])).toContain('check:ci-trigger-paths');
  });

  it('the link-lift helper fires BOTH parity gates that execute it', () => {
    const ids = triggeredIds(['scripts/shared/rebase-relative-links.mjs']);
    expect(ids).toContain('check:handoff-roadmap');
    expect(ids).toContain('check:backlog-index');
  });

  it('staged package.json fires every reach/final leg (the auto-rule)', () => {
    const ids = triggeredIds(['package.json']);
    for (const g of guards) {
      if (g.kind !== 'gate' || g.preCommit === false || g.preCommit == null) continue;
      expect(ids, `package.json must trigger ${g.id}`).toContain(g.id);
    }
  });

  it('a src-only staged set stays fast: only the unconditional guard-reach leg fires', () => {
    expect(triggeredIds(['src/audit/orchestrator/advance.ts'])).toEqual(['check:guard-reach']);
  });

  it('backslashed staged paths normalize before matching (win32)', () => {
    expect(triggeredIds(['docs\\backlog\\open-bugs.md'])).toContain('check:backlog-index');
  });
});
