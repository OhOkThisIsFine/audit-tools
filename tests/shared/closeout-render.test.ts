// Contract test for scripts/render-closeout.mjs — the refusal that keeps the
// end-of-sprint hand-back both SHORT and honest.
//
// The two properties are in tension and the renderer is what holds them apart:
// an empty section is omitted from the report (short), but omitting it requires
// stating "none" in the input (intentional). A test, not prose, because the
// prose version of this rule is exactly what decayed twice.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { worktreeTree } from '../../scripts/shared/worktree-tree.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'render-closeout.mjs');

function render(input: unknown): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-'));
  const file = join(dir, 'in.json');
  writeFileSync(file, JSON.stringify(input), 'utf8');
  // CLAUDE_PROJECT_DIR points at the temp dir on purpose: the renderer writes a
  // HEAD-bound record the closeout Stop gate reads, and a test run must not
  // forge one for the real repo.
  const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Every section stated, all silent except the two that may never be. */
function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verification: ['build + typecheck: green at `abc1234`'],
    cleanup: 'none',
    friction: {
      ambiguous_direction: 'none',
      tool_should_decide: 'none',
      inefficient_feeding: 'none',
      open_ended: 'none',
      logged_to: 'none',
    },
    docs: 'none',
    landed: ['nothing — investigation only'],
    decisions: 'none',
    next_steps: 'none',
    ...overrides,
  };
}

describe('render-closeout: silence is stated, then omitted', () => {
  it('omits every silent section — no "none" line survives into the report', () => {
    const { code, stdout } = render(minimal());
    expect(code).toBe(0);
    expect(stdout).toContain('### Verification');
    expect(stdout).toContain('### Landed this sprint');
    expect(stdout).not.toContain('### Cleanup');
    expect(stdout).not.toContain('### Friction');
    expect(stdout).not.toContain('### Decisions needed from you');
    expect(stdout).not.toMatch(/\bnone\b/i);
  });

  it('REFUSES when a section is simply absent — the omission a short report would hide', () => {
    const input = minimal();
    delete input.decisions;
    const { code, stderr } = render(input);
    expect(code).toBe(1);
    expect(stderr).toContain('decisions');
    expect(stderr).toContain('every section must be stated');
  });

  it('refuses an empty value instead of treating it as silence', () => {
    const { code, stderr } = render(minimal({ cleanup: [] }));
    expect(code).toBe(1);
    expect(stderr).toContain('cleanup');
  });

  it('refuses "none" for a section where absence would read as work skipped', () => {
    const { code, stderr } = render(minimal({ verification: 'none' }));
    expect(code).toBe(1);
    expect(stderr).toContain('required');
  });

  it('renders content sections in the bottom-weighted order the owner reads', () => {
    const { stdout } = render(
      minimal({ cleanup: ['clean'], decisions: ['ship or hold?'], next_steps: ['resume the run → docs/HANDOFF.md'] }),
    );
    const order = ['### Verification', '### Cleanup', '### Landed this sprint', '### Decisions needed from you', '### Remaining next steps'];
    const positions = order.map((h) => stdout.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('drops a silent friction bullet but keeps the section when one bullet has content', () => {
    const { stdout } = render(
      minimal({
        friction: {
          ambiguous_direction: 'none',
          tool_should_decide: 'the rule was memory-enforced',
          inefficient_feeding: 'none',
          open_ended: 'none',
          logged_to: 'none',
        },
      }),
    );
    expect(stdout).toContain('### Friction this sprint');
    expect(stdout).toContain('the rule was memory-enforced');
    expect(stdout).not.toContain('ambiguous_direction');
  });

  it('rejects a section id it does not know, rather than rendering an invented heading', () => {
    const { code, stderr } = render(minimal({ vibes: ['good'] }));
    expect(code).toBe(1);
    expect(stderr).toContain('unknown section id');
  });

  // The blank --template is the documented starting point, and it used to be a
  // two-step contradiction: it ships [''] for the two REQUIRED sections, and the
  // old single empty-value message answered that with the one word those two are
  // the only sections forbidden to use.
  it('never tells a REQUIRED section to write "none" — the advice --template used to walk into', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-tpl-'));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const tpl = spawnSyncHidden(process.execPath, [SCRIPT, '--template'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
    });
    expect(tpl.status).toBe(0);
    const file = join(dir, 'tpl.json');
    writeFileSync(file, tpl.stdout ?? '', 'utf8');
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
    });
    expect(r.status).toBe(1);
    const stderr = r.stderr ?? '';
    expect(stderr).toContain('verification');
    expect(stderr).toContain('landed');
    expect(stderr).not.toContain('Write the literal "none"');
  });

  // The record binds to worktree CONTENT, not HEAD. The closeout commits its own
  // HANDOFF/backlog/memory updates, so a HEAD-bound record was invalidated by the
  // very commit it described, and the Stop gate then demanded a second, different
  // hand-back in the same chat.
  it('binds the record to worktree CONTENT — committing what the report described keeps it valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-git-'));
    const git = (...args: string[]) => spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'closeout-test@example.invalid');
    git('config', 'user.name', 'closeout test');
    // Mirror the real repo: the renderer writes its record under .claude/hooks/,
    // which is ignored, so the record cannot perturb the identity it just took.
    writeFileSync(join(dir, '.gitignore'), '.claude/hooks/*', 'utf8');
    writeFileSync(join(dir, 'seed.txt'), 'seed', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    const headBefore = (git('rev-parse', 'HEAD').stdout ?? '').trim();

    // The closeout's own doc update, still uncommitted when the report is rendered.
    writeFileSync(join(dir, 'HANDOFF.md'), 'next: nothing pending', 'utf8');
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    expect(r.status).toBe(0);
    const record = JSON.parse(
      readFileSync(join(dir, '.claude', 'hooks', '.state', 'closeout-render', 'latest.json'), 'utf8'),
    );
    expect(record.version).toBe(2);
    expect(typeof record.tree).toBe('string');

    git('add', '-A');
    git('commit', '-qm', 'closeout: HANDOFF');
    // HEAD moved — the old binding would now report the record as stale.
    expect((git('rev-parse', 'HEAD').stdout ?? '').trim()).not.toBe(headBefore);
    // The content did not, so the record still describes the tree being handed off.
    expect(worktreeTree(dir)).toBe(record.tree);
  });
});

describe('render-closeout: the decisions section must ASK something', () => {
  // The heading is "Decisions needed from you". Filling it with decisions
  // already TAKEN reads to the owner as a demand for something they have
  // already given — reported by the owner 2026-08-28 after it happened on
  // consecutive reports. `prompt` could not prevent it: the renderer shows a
  // prompt only when a value is MISSING, so a section filled with the wrong
  // KIND of content sailed straight through.
  it('refuses a decisions section that states settled decisions instead of asking', () => {
    const { code, stderr } = render(
      minimal({
        decisions:
          'Four owner decisions were asked and are all answered and recorded. ' +
          'Nothing is left waiting on the owner.',
      }),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('contains no question');
    expect(stderr).toContain('"none"');
  });

  it('accepts a decisions section that actually asks, and renders it', () => {
    const { code, stdout } = render(
      minimal({
        decisions:
          'Split docs/backlog/open-bugs.md, or keep condensing to stay under the ceiling? ' +
          'Splitting costs an index update; condensing costs an entry every time.',
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('### Decisions needed from you');
  });

  it('still allows "none" — silence stays a stated, omitted disposition', () => {
    const { code, stdout } = render(minimal({ decisions: 'none' }));
    expect(code).toBe(0);
    expect(stdout).not.toContain('### Decisions needed from you');
  });
});

describe('render-closeout: readiness is checked BEFORE the report describes the tree', () => {
  // The Stop challenge runs the same checks, but a Stop hook can only speak
  // once a report exists — so the loop was render, get challenged, fix, RENDER
  // AGAIN, with the first report wrong at the moment it was written. The
  // renderer shares the deterministic half (scripts/shared/closeoutReadiness.mjs)
  // so the fixes land before the first render.
  it('refuses to render while the generated HANDOFF is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-ready-'));
    mkdirSync(join(dir, 'scripts', 'shared'), { recursive: true });
    // A stand-in generator that reports STALE, so the test does not depend on
    // the real repo's HANDOFF being out of date.
    writeFileSync(
      join(dir, 'scripts', 'shared', 'generate-handoff-roadmap.mjs'),
      'process.exit(process.argv.includes("--check") ? 1 : 0);\n',
      'utf8',
    );
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? '').toContain('not ready to hand back');
    expect(r.stderr ?? '').toContain('generate-handoff-roadmap');
  });

  it('fails OPEN when the generator is absent — a check that cannot see its evidence stays quiet', () => {
    // No scripts/ tree at all: a different repo, or a checkout without the
    // generator. That is not a stale HANDOFF, and reporting it as one would be
    // a false red on a correct hand-back.
    const { code } = render(minimal());
    expect(code).toBe(0);
  });
});
