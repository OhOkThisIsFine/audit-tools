// Contract test for scripts/render-closeout.mjs — the refusal that keeps the
// end-of-sprint hand-back both SHORT and honest.
//
// The two properties are in tension and the renderer is what holds them apart:
// an empty section is omitted from the report (short), but omitting it requires
// stating "none" in the input (intentional). A test, not prose, because the
// prose version of this rule is exactly what decayed twice.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { worktreeTree } from '../../scripts/shared/worktree-tree.mjs';
import { writeSuiteGreenStamp } from '../../scripts/shared/suiteGreenStamp.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'render-closeout.mjs');

/**
 * The renderer spawns in this file all share ONE environment rule: both
 * session-id names are cleared unless the case sets them, so a developer
 * running this suite inside a real session cannot have the fixture's record
 * keyed to — or its commit range derived from — that live session.
 *
 * A helper rather than a repeated literal because the file has several spawn
 * sites and the NEXT one added is exactly the one that would forget.
 */
function renderEnv(
  dir: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    ...overrides,
  };
}

function render(
  input: unknown,
  extraArgs: string[] = [],
  envOverrides: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-'));
  const file = join(dir, 'in.json');
  writeFileSync(file, JSON.stringify(input), 'utf8');
  // CLAUDE_PROJECT_DIR points at the temp dir on purpose: the renderer writes a
  // HEAD-bound record the closeout Stop gate reads, and a test run must not
  // forge one for the real repo. See `renderEnv` for the session-id rule.
  const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: renderEnv(dir, envOverrides),
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

describe('render-closeout: --start, the flag the closeout SKILL instructs', () => {
  // `/start-lap` records the sprint's start commit in `.claude/lap-start.json`,
  // and step 5 of the machine-wide closeout skill tells every repo to pass it as
  // `--start`. This renderer answered `unknown argument: --start` and exited 1,
  // so a run following that skill verbatim failed here. Accepting the flag is
  // only half the fix — a flag that parses and does nothing is worse than one
  // that errors — so it must DERIVE something the report's author cannot type.
  it('accepts --start and renders the commit range it derives', () => {
    // A REAL throwaway repo with two commits: the range has to come from git,
    // so a test that could pass against a non-repo would prove nothing.
    const dir = mkdtempSync(join(tmpdir(), 'closeout-range-'));
    const g = (...args: string[]) =>
      spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    // Mirror the real repo: the renderer writes its record — and the suite-green
    // stamp lives — under .claude/hooks/, which is ignored, so neither can
    // perturb the tree identity the readiness seam just took.
    writeFileSync(join(dir, '.gitignore'), '.claude/hooks/*\n', 'utf8');
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8');
    g('add', '-A');
    g('commit', '-qm', 'first commit of the sprint');
    writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf8');
    g('add', '-A');
    g('commit', '-qm', 'the work this sprint landed');

    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    // The pre-render readiness seam demands a full-suite green bound to the tree
    // being handed off — the same act a real `npm test` performs through the
    // vitest gate. A real repo fixture has to satisfy it like a real repo does.
    writeSuiteGreenStamp(dir, worktreeTree(dir));
    const r = spawnSyncHidden(
      process.execPath,
      [SCRIPT, '--in', file, '--start', 'HEAD~1'],
      { cwd: dir, encoding: 'utf8', env: renderEnv(dir) },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('### Commits in this sprint');
    expect(r.stdout).toContain('HEAD~1..HEAD');
    // The DERIVED half: the subject line came from git, not from the input.
    expect(r.stdout).toContain('the work this sprint landed');
    expect(r.stdout).not.toContain('first commit of the sprint');
  });

  it('REFUSES a start commit git cannot resolve, rather than rendering a silent empty range', () => {
    const { code, stderr } = render(minimal(), ['--start', 'not-a-real-commit']);
    expect(code).toBe(1);
    expect(stderr).toContain('not-a-real-commit');
  });

  it('renders no commit section when --start is omitted AND no session record exists', () => {
    // The temp CLAUDE_PROJECT_DIR holds no `.claude/hooks/.state/sessions`, and
    // CLAUDE_SESSION_ID is unset in this env — so neither derivation source is
    // available and the section is honestly absent rather than invented.
    const { code, stdout } = render(minimal(), [], { CLAUDE_SESSION_ID: '' });
    expect(code).toBe(0);
    expect(stdout).not.toContain('### Commits in this sprint');
  });

  // The author-supplied sha is the LAST resort, not the only one: the range is
  // a fact the repository holds at session start, so SessionStart records it
  // (`readSessionStartingHead`) and the renderer derives from that. A value
  // typed at the end is a second copy of a fact that was already knowable.
  it('derives the range from the session record when --start is not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-session-head-'));
    const git = (...args: string[]) => spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'closeout-test@example.invalid');
    git('config', 'user.name', 'closeout test');
    writeFileSync(join(dir, '.gitignore'), '.claude/hooks/*\n', 'utf8');
    writeFileSync(join(dir, 'seed.txt'), 'seed', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'the commit the session opened on');
    const sessionStart = (git('rev-parse', 'HEAD').stdout ?? '').trim();

    writeFileSync(join(dir, 'work.txt'), 'the work this sprint landed', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'the work this sprint landed');

    // The SessionStart leg's own write, in the shape the hook produces.
    const sessionId = 'test-session-abcdef';
    const sessionsDir = join(dir, '.claude', 'hooks', '.state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        version: 1,
        session_id: sessionId,
        registered_at: '2026-09-10T00:00:00.000Z',
        starting_head: sessionStart,
        source: 'startup',
        baseline: [],
      }),
      'utf8',
    );

    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    writeSuiteGreenStamp(dir, worktreeTree(dir));
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: dir,
      encoding: 'utf8',
      env: renderEnv(dir, { CLAUDE_SESSION_ID: sessionId }),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('### Commits in this sprint');
    expect(r.stdout).toContain(sessionStart);
    // The DERIVED half: the subject came from git, and the commit the session
    // OPENED on is the range's exclusive base, so it is NOT listed.
    expect(r.stdout).toContain('the work this sprint landed');
    expect(r.stdout).not.toContain('the commit the session opened on');
  });

  it('--start still WINS over the session record — the explicit flag is the override', () => {
    // A temp repo where BOTH sources exist and disagree: the flag names the base
    // commit, the session record names a LATER one. Only the flag's range may
    // render, and the provenance line must say so.
    const dir = mkdtempSync(join(tmpdir(), 'closeout-start-wins-'));
    const git = (...args: string[]) => spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'closeout-test@example.invalid');
    git('config', 'user.name', 'closeout test');
    writeFileSync(join(dir, '.gitignore'), '.claude/hooks/*\n', 'utf8');
    writeFileSync(join(dir, 'a.txt'), 'one', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'commit the flag will name');
    const flagBase = (git('rev-parse', 'HEAD').stdout ?? '').trim();
    writeFileSync(join(dir, 'b.txt'), 'two', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'commit the session record will name');

    const sessionId = 'session-that-disagrees';
    const sessionsDir = join(dir, '.claude', 'hooks', '.state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    // The session record names a LATER commit than the flag: if the record won,
    // the earlier commit would drop out of the rendered range.
    writeFileSync(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        version: 1,
        session_id: sessionId,
        registered_at: '2026-09-10T00:00:00.000Z',
        starting_head: 'HEAD',
        source: 'startup',
        baseline: [],
      }),
      'utf8',
    );

    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    writeSuiteGreenStamp(dir, worktreeTree(dir));
    const r = spawnSyncHidden(
      process.execPath,
      [SCRIPT, '--in', file, '--start', flagBase],
      { cwd: dir, encoding: 'utf8', env: renderEnv(dir, { CLAUDE_SESSION_ID: sessionId }) },
    );

    expect(r.status, r.stderr).toBe(0);
    // The provenance line names the FLAG, not the record.
    expect(r.stdout).toContain(flagBase);
    expect(r.stdout).toContain('commit the session record will name');
    // `git log base..HEAD` is exclusive of the base, so the flag's own commit
    // must NOT be listed — the same property the --start test above pins.
    expect(r.stdout).not.toContain('commit the flag will name');
  });
});

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
    const env = renderEnv(dir);
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
    // The pre-render readiness seam demands a full-suite green bound to the
    // tree being handed off — stamp the fixture's current tree (in.json
    // included, since it sits unignored in the worktree), the same act a real
    // `npm test` performs through the vitest gate.
    writeSuiteGreenStamp(dir, worktreeTree(dir));
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: dir,
      encoding: 'utf8',
      env: renderEnv(dir, { CLAUDE_CODE_SESSION_ID: 'content-bound-session' }),
    });
    expect(r.status, r.stderr).toBe(0);
    const record = JSON.parse(
      readFileSync(
        join(
          dir,
          '.claude',
          'hooks',
          '.state',
          'closeout-render',
          'content-bound-session.json',
        ),
        'utf8',
      ),
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

describe('render-closeout: the record NAMES its session, and is keyed per session', () => {
  // The record was ONE repo-global file whose ownership rested on a TIMESTAMP:
  // the Stop gate compared `rendered_at` against the session registry's
  // `registered_at`, so a CONCURRENT session's render — written after this one
  // started — read as this one's own. The stated reason for the timestamp, that
  // the renderer cannot read a session id, was false: it read
  // `CLAUDE_SESSION_ID`, which nothing sets; the environment carries
  // `CLAUDE_CODE_SESSION_ID`, whose value is exactly the filename of that
  // session's record in the registry directory.
  it('records CLAUDE_CODE_SESSION_ID and writes ONE FILE PER SESSION', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-sid-'));
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: renderEnv(dir, { CLAUDE_CODE_SESSION_ID: 'sid-alpha' }),
    });
    expect(r.status, r.stderr).toBe(0);
    const stateDir = join(dir, '.claude', 'hooks', '.state', 'closeout-render');
    const record = JSON.parse(readFileSync(join(stateDir, 'sid-alpha.json'), 'utf8'));
    // The id the ENVIRONMENT supplies, not the one nothing sets.
    expect(record.session_id).toBe('sid-alpha');
    // Not one repo-global file: that is what made it last-writer-wins across
    // concurrent sessions.
    expect(existsSync(join(stateDir, 'latest.json'))).toBe(false);
  });

  it('two sessions rendering the SAME tree each keep their own record', () => {
    // The load-bearing case. Both renders describe identical content, so a
    // content-bound but session-blind reader cannot tell them apart — which is
    // exactly how a concurrent session satisfied another's Stop gate.
    const dir = mkdtempSync(join(tmpdir(), 'closeout-two-'));
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    const renderAs = (sid: string) =>
      spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir, { CLAUDE_CODE_SESSION_ID: sid }),
      });
    expect(renderAs('sid-one').status).toBe(0);
    expect(renderAs('sid-two').status).toBe(0);
    const stateDir = join(dir, '.claude', 'hooks', '.state', 'closeout-render');
    const one = JSON.parse(readFileSync(join(stateDir, 'sid-one.json'), 'utf8'));
    const two = JSON.parse(readFileSync(join(stateDir, 'sid-two.json'), 'utf8'));
    expect(one.session_id).toBe('sid-one');
    expect(two.session_id).toBe('sid-two');
    // Same tree, so a content comparison alone would have called these the same
    // render — the session id is the only thing that separates them.
    expect(one.tree).toBe(two.tree);
  });

  it('honours CLAUDE_SESSION_ID as the fallback when the code id is absent', () => {
    // A host that sets only the older name keeps working; a name the
    // environment does not supply is never guessed at.
    const dir = mkdtempSync(join(tmpdir(), 'closeout-fallback-'));
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(minimal()), 'utf8');
    const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: renderEnv(dir, { CLAUDE_SESSION_ID: 'legacy-id' }),
    });
    expect(r.status, r.stderr).toBe(0);
    const record = JSON.parse(
      readFileSync(
        join(dir, '.claude', 'hooks', '.state', 'closeout-render', 'legacy-id.json'),
        'utf8',
      ),
    );
    expect(record.session_id).toBe('legacy-id');
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
        decisions: [
          'Split docs/backlog/open-bugs.md, or keep condensing to stay under the ceiling? ' +
            'Splitting costs an index update; condensing costs an entry every time.',
        ],
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

  // P63, repo half. A headless run with a genuinely open decision could not
  // satisfy both this renderer (which refuses the section without a question)
  // and the machine-wide unasked-decision gate (which refuses a question posed
  // in prose, and directs the session to `AskUserQuestion` — a tool a headless
  // session does not have). The queue item such a run writes instead IS an ask:
  // it lands on the project's answerable page, and `npm run nightly:ingest`
  // reads the answer back. Accepting it WIDENS what counts as asking; it does
  // not narrow what counts as unasked.
  describe('a written decision-queue item is an accepted answering route (P63)', () => {
    /** A repo whose decision queue holds exactly `items`. */
    function repoWithQueue(items: Array<Record<string, unknown>>): string {
      const dir = mkdtempSync(join(tmpdir(), 'closeout-queue-'));
      mkdirSync(join(dir, '.audit-tools', 'nightly'), { recursive: true });
      writeFileSync(
        join(dir, '.audit-tools', 'nightly', 'open-items.json'),
        JSON.stringify({
          generated_at: '2026-09-10T00:00:00.000Z',
          run: 'test',
          items,
          applied: [],
          skipped: [],
        }),
        'utf8',
      );
      return dir;
    }
    const openItem = (key: string) => ({
      id: `item-${key}`,
      subject_key: key,
      subject: 'a subject',
      title: 'a title',
    });

    it('accepts a decisions value naming an OPEN queue item, and renders it', () => {
      const dir = repoWithQueue([openItem('e978fad576fb2473')]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({
            // DELIBERATELY carries no question mark: the interrogative arm would
            // accept it anyway, and a test that passes with the queue channel
            // disabled proves nothing about the queue channel. This is the shape
            // a headless run actually produces — a statement pointing at where
            // the question is posed and answerable.
            decisions: [
              'Open owner decision, posed and answerable as queue subject key ' +
                'e978fad576fb2473 in docs/nightly-inbox.md: whether to re-home the shadowed ' +
                'repository /start-lap skill into CLAUDE.md, rename it, or delete it.',
            ],
          }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('### Decisions needed from you');
      expect(r.stdout).toContain('e978fad576fb2473');
    });

    it('REFUSES a key that names no open item — the claim has to be checkable', () => {
      // The conservative direction, and deliberately the opposite of every
      // other check here. Those fail open because a readiness check that cannot
      // see its evidence must not assert a problem; this one is the REPORT'S
      // claim that a question was posed somewhere answerable, and an
      // unverifiable claim is not one.
      const dir = repoWithQueue([openItem('aaaa111122223333')]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({ decisions: ['See subject key deadbeefdeadbeef in docs/nightly-inbox.md.'] }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('deadbeefdeadbeef');
      expect(r.stderr).toContain('names an OPEN item');
    });

    it('accepts an OPEN key cited AFTER a settled one — every candidate is tried, not just the first', () => {
      // The value is prose the author wrote, and prose legitimately cites a
      // settled subject as context while asking about a live one. Reading only
      // the FIRST 16-hex match made that shape unrenderable, and the refusal
      // then named the SETTLED key as though the OPEN one were the problem —
      // false, and unactionable for the author reading it.
      const dir = repoWithQueue([openItem('aaaa111122223333')]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({
            decisions: [
              'Supersedes the settled decision deadbeefdeadbeef. Still open and awaiting you: ' +
                'aaaa111122223333 — whether to re-home the shadowed skill or delete it.',
            ],
          }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('### Decisions needed from you');
      expect(r.stdout).toContain('aaaa111122223333');
    });

    it('REFUSES naming EVERY key it tried when none of several candidates is open', () => {
      // The other half of collecting them all: the refusal has to account for
      // the whole value. Naming one key when three were cited sends the author
      // to fix the wrong one.
      const dir = repoWithQueue([]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({
            decisions: [
              'Both of these were answered: deadbeefdeadbeef, and also aaaa111122223333.',
            ],
          }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('deadbeefdeadbeef');
      expect(r.stderr).toContain('aaaa111122223333');
    });

    it('REFUSES a settled key — a settled subject asks nothing, so it cannot stand in for asking', () => {
      const dir = repoWithQueue([]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({ decisions: ['Answered already: see subject key e978fad576fb2473.'] }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('e978fad576fb2473');
    });

    it('refuses a settled-DECISION claim with no key at all, and says how to supply one', () => {
      const dir = repoWithQueue([openItem('e978fad576fb2473')]);
      const file = join(dir, 'in.json');
      writeFileSync(
        file,
        JSON.stringify(
          minimal({
            decisions: [
              'Four owner decisions were asked and are all answered and recorded. Nothing waits.',
            ],
          }),
        ),
        'utf8',
      );
      const r = spawnSyncHidden(process.execPath, [SCRIPT, '--in', file], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: renderEnv(dir),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('subject key');
      // And the original refusal still stands behind it.
      expect(r.stderr).toContain('contains no question');
    });
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
      env: renderEnv(dir),
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

describe('render-closeout: the sections the owner ACTS on are itemized', () => {
  // A bare string renders as ONE bullet. For "decisions needed from you" and
  // "remaining next steps" that hides the item COUNT behind prose — the reader
  // has to parse a paragraph to learn how many things are waiting, and a step
  // dropped from the middle leaves the section still looking complete.
  it('refuses a decisions section passed as one block of prose', () => {
    const { code, stderr } = render(
      minimal({ decisions: 'Split the file, or keep condensing? And also: bump the ceiling?' }),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('ONE DECISION PER ELEMENT');
  });

  it('refuses a next_steps section passed as one block of prose', () => {
    const { code, stderr } = render(
      minimal({ next_steps: 'Implement CX-02 (docs/HANDOFF.md); then the async-twin migration.' }),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('ONE STEP PER ELEMENT');
  });

  it('renders one bullet per element when both are arrays', () => {
    const { code, stdout } = render(
      minimal({
        decisions: ['Split the file, or keep condensing?', 'Raise the ceiling instead?'],
        next_steps: ['Implement CX-02 — docs/HANDOFF.md', 'Async-twin migration — open-bugs.md'],
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('- Split the file, or keep condensing?');
    expect(stdout).toContain('- Raise the ceiling instead?');
    expect(stdout).toContain('- Implement CX-02 — docs/HANDOFF.md');
    expect(stdout).toContain('- Async-twin migration — open-bugs.md');
  });

  it('still accepts "none" — an itemized section may fall silent', () => {
    const { code } = render(minimal({ decisions: 'none', next_steps: 'none' }));
    expect(code).toBe(0);
  });
});
