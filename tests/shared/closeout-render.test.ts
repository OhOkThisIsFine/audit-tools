// Contract test for scripts/render-closeout.mjs — the refusal that keeps the
// end-of-sprint hand-back both SHORT and honest.
//
// The two properties are in tension and the renderer is what holds them apart:
// an empty section is omitted from the report (short), but omitting it requires
// stating "none" in the input (intentional). A test, not prose, because the
// prose version of this rule is exactly what decayed twice.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'render-closeout.mjs');

function render(input: unknown): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-'));
  const file = join(dir, 'in.json');
  writeFileSync(file, JSON.stringify(input), 'utf8');
  // CLAUDE_PROJECT_DIR points at the temp dir on purpose: the renderer writes a
  // HEAD-bound record the closeout Stop gate reads, and a test run must not
  // forge one for the real repo.
  const r = spawnSync(process.execPath, [SCRIPT, '--in', file], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
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
});
