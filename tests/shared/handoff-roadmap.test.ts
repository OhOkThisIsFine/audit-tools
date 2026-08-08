// Contract tests for the generated HANDOFF roadmap:
// `scripts/shared/generate-handoff-roadmap.mjs` + its trigger inside
// `.claude/hooks/pre-commit-gate.mjs`.
//
// These live under tests/shared (not beside the hook) on purpose: vitest
// EXCLUDES `.claude/**`, so a test placed next to a hook never runs in CI and
// the guard is unverified exactly where it matters — same reason
// tests/shared/hook-trap-guards.test.mjs and doc-manifest-gate.test.mjs live here.
//
// What must hold, and why each half matters:
//   • POINTERS, not specs — a generated line carries the backlog entry's own
//     title and a link, never its body. The defect being removed is that the
//     same open item was written out as a full SPEC in HANDOFF *and* in
//     docs/backlog/open-bugs.md, so the two drifted; a restating renderer would
//     silently re-create it.
//   • ORDER is derived — (source rank, position in file), with an optional `▶`
//     pin. Nothing is dropped, so an item cannot fall out of the roadmap by
//     being unmarked.
//   • the hand-written parts survive — only the delimited block is replaced.
//   • the gate FIRES AT COMMIT, not only in verify:checks. The pre-commit hook
//     does not run verify:checks, so a check wired only there first fails in
//     RELEASE CI and burns a tag (the class that burned v0.34.17).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSyncHidden, execFileSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  BEGIN_MARKER,
  END_MARKER,
  PIN_MARKER,
  ROADMAP_SOURCES,
  collectRoadmap,
  parseBulletEntries,
  parseTrackEntries,
  renderRoadmap,
  sectionText,
  spliceRoadmap,
} from '../../scripts/shared/generate-handoff-roadmap.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, '.claude', 'hooks', 'pre-commit-gate.mjs');
const GENERATOR = join(REPO_ROOT, 'scripts', 'shared', 'generate-handoff-roadmap.mjs');

describe('entry parsing — the pointer is the entry\'s own title, verbatim', () => {
  it('takes the whole bold lead-in, even when it wraps across lines', () => {
    const text = [
      '# Open bugs',
      '',
      '- **A title that wraps across',
      '  two lines (2026-07-25, medium).** body prose that must NOT reach the roadmap',
      '  more body.',
      '',
      '- **Second entry.** more body',
    ].join('\n');
    const entries = parseBulletEntries(text, 'docs/backlog/x.md');
    expect(entries.map((e) => e.title)).toEqual([
      'A title that wraps across two lines (2026-07-25, medium).',
      'Second entry.',
    ]);
    expect(entries.map((e) => e.line)).toEqual([3, 7]);
  });

  it('a nested bullet is NOT an entry — only column-0 `- **` starts one', () => {
    const text = ['- **Real entry.** body', '  - **not an entry** sub-bullet', '- **Another.** body'].join('\n');
    expect(parseBulletEntries(text).map((e) => e.title)).toEqual(['Real entry.', 'Another.']);
  });

  it('an UNTERMINATED bold title fails loudly, naming file and line', () => {
    // Degrading to "first line, truncated" would put a mangled paraphrase in the
    // roadmap — a second, wrong copy of the title, which is the exact class this
    // generator exists to remove. So it refuses instead.
    expect(() => parseBulletEntries('- **never closed\nmore text', 'docs/backlog/x.md')).toThrow(
      /docs\/backlog\/x\.md:1[\s\S]*UNTERMINATED/,
    );
  });

  it('reads the `**Track N — …**` paragraph form that Open tracks uses', () => {
    const text = ['## Open tracks', '', '**Track 1 — first.** body', '', '**Track 2 — second.** body'].join('\n');
    expect(parseTrackEntries(text).map((e) => e.title)).toEqual(['Track 1 — first.', 'Track 2 — second.']);
  });

  it('sectionText slices one `## ` section, and refuses a heading that moved', () => {
    const text = ['# doc', '## A', 'a1', '## B', 'b1'].join('\n');
    expect(sectionText(text, 'A')).toBe('a1');
    expect(sectionText(text, 'B')).toBe('b1');
    expect(() => sectionText(text, 'C')).toThrow(/"## C" not found/);
  });
});

describe('ordering — derived from document structure, nothing dropped', () => {
  const sources = () =>
    new Map([
      ['open-bugs.md', ['- **bug one.** b', '', '- **bug two.** b'].join('\n')],
      [
        'forward-tracks.md',
        ['## Open tracks', '', '**Track 1 — t1.** b', '', '## Forward tracks', '', '- **fwd one.** b'].join('\n'),
      ],
      ['deferred.md', '- **parked one.** b'],
    ]);

  it('orders PINNED entries by (source rank, position in file)', () => {
    const s = sources();
    // One pin per source, deliberately out of source order in the files, so the
    // assertion below can only pass if source rank is what orders them.
    s.set('deferred.md', [`- **${PIN_MARKER} pinned parked.** b`, '', '- **parked one.** b'].join('\n'));
    s.set('open-bugs.md', ['- **bug one.** b', '', `- **${PIN_MARKER} pinned bug.** b`].join('\n'));
    const groups = collectRoadmap(s);
    expect(groups.map((g) => g.items.map((i) => i.title))).toEqual([
      [`${PIN_MARKER} pinned bug.`, `${PIN_MARKER} pinned parked.`],
    ]);
    // Source order is the roadmap's ordering spine — pin it explicitly.
    expect(ROADMAP_SOURCES.map((s) => `${s.file}${s.section ? `#${s.section}` : ''}`)).toEqual([
      'open-bugs.md',
      'forward-tracks.md#Open tracks',
      'forward-tracks.md#Forward tracks',
      'deferred.md',
    ]);
  });

  it('the "Next up" group ALWAYS exists, empty included — an absent section reads as "the generator never ran"', () => {
    // Inverts the previous contract deliberately. While the block listed every open
    // item, an empty head was misleading and was suppressed. Now the block IS the
    // head, so suppressing it would erase the section entirely and make "nothing is
    // pinned" indistinguishable from a generator that did not run.
    const groups = collectRoadmap(sources());
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toContain('Next up');
    expect(groups[0].items).toEqual([]);
  });

  it(`a \`${PIN_MARKER}\` prefix hoists an entry to the top, keeping document order among the pinned`, () => {
    const s = sources();
    s.set('open-bugs.md', ['- **bug one.** b', '', `- **${PIN_MARKER} pinned bug.** b`].join('\n'));
    s.set(
      'deferred.md',
      [`- **${PIN_MARKER} pinned parked.** b`, '', '- **parked one.** b'].join('\n'),
    );
    const groups = collectRoadmap(s);
    expect(groups[0].heading).toContain('Next up');
    expect(groups[0].items.map((i) => i.title)).toEqual([
      `${PIN_MARKER} pinned bug.`,
      `${PIN_MARKER} pinned parked.`,
    ]);
    // A pinned entry LEAVES its source group — it appears once, not twice.
    const all = groups.flatMap((g) => g.items.map((i) => i.title));
    expect(all.filter((t) => t === `${PIN_MARKER} pinned bug.`)).toHaveLength(1);
  });

  it('selection IS a filter — an unpinned entry never reaches HANDOFF', () => {
    // The reverse of the earlier contract, and the point of the change: HANDOFF is
    // the immediate next step, not an index of open work. All five fixture entries
    // are unpinned, so none may appear; they remain in the backlog, which is their
    // one home, reachable by the seek index.
    const groups = collectRoadmap(sources());
    expect(groups.flatMap((g) => g.items)).toHaveLength(0);

    // ...and pinning exactly one lets exactly that one through.
    const s = sources();
    s.set('open-bugs.md', ['- **bug one.** b', '', `- **${PIN_MARKER} pinned bug.** b`].join('\n'));
    expect(collectRoadmap(s).flatMap((g) => g.items).map((i) => i.title)).toEqual([
      `${PIN_MARKER} pinned bug.`,
    ]);
  });
});

describe('rendering — a pointer, never a restated spec', () => {
  const groups = [{ heading: 'G', items: [{ title: 'the entry title (2026-07-25, medium).', file: 'open-bugs.md' }] }];

  it('emits the title verbatim plus a link, and never the entry body', () => {
    const out = renderRoadmap(groups);
    expect(out).toContain('- the entry title (2026-07-25, medium). · [`open-bugs.md`](backlog/open-bugs.md)');
    expect(out.startsWith(BEGIN_MARKER)).toBe(true);
    expect(out.endsWith(END_MARKER)).toBe(true);
  });

  it('states the pinned count and points at the backlog for the full set', () => {
    const out = renderRoadmap(groups);
    expect(out).toMatch(/1 pinned item\(s\)/);
    // The block must say where everything else lives, or a reader takes it for the
    // whole open set — the exact misreading this scoping change exists to prevent.
    expect(out).toContain('Every open item lives in');
    expect(out).toContain('backlog.md');
  });

  it('an empty block STATES that nothing is pinned rather than rendering as absent', () => {
    const out = renderRoadmap([{ heading: 'G', items: [] }]);
    expect(out).toMatch(/nothing pinned/);
    expect(out).toMatch(/no immediate next step is set/);
  });
});

describe('splicing — only the delimited block is touched', () => {
  const handoff = `# HANDOFF\n\nhand-written above\n\n${BEGIN_MARKER}\nOLD\n${END_MARKER}\n\nhand-written below\n`;

  it('leaves every hand-written line byte-identical', () => {
    const out = spliceRoadmap(handoff, `${BEGIN_MARKER}\nNEW\n${END_MARKER}`);
    expect(out).toBe(`# HANDOFF\n\nhand-written above\n\n${BEGIN_MARKER}\nNEW\n${END_MARKER}\n\nhand-written below\n`);
  });

  it('refuses a HANDOFF with no markers rather than appending a second copy', () => {
    expect(() => spliceRoadmap('# HANDOFF\n\nno markers\n', `${BEGIN_MARKER}\nX\n${END_MARKER}`)).toThrow(
      /missing the generated-roadmap markers/,
    );
  });

  it('refuses markers in the wrong order', () => {
    expect(() =>
      spliceRoadmap(`${END_MARKER}\n${BEGIN_MARKER}\n`, `${BEGIN_MARKER}\nX\n${END_MARKER}`),
    ).toThrow(/out of order/);
  });
});

describe('the live tree', () => {
  it('docs/HANDOFF.md matches a fresh render — and would NOT match a drifted one', () => {
    const onDisk = readFileSync(join(REPO_ROOT, 'docs', 'HANDOFF.md'), 'utf8');
    const sources = new Map(
      [...new Set(ROADMAP_SOURCES.map((s) => s.file))].map((f) => [
        f,
        readFileSync(join(REPO_ROOT, 'docs', 'backlog', f), 'utf8'),
      ]),
    );
    const fresh = spliceRoadmap(onDisk, renderRoadmap(collectRoadmap(sources)));
    expect(fresh).toBe(onDisk);

    // The check must be able to FAIL, or it is decoration. The mutation has to touch
    // something that REACHES the block: now that only pinned entries are emitted,
    // removing an arbitrary backlog entry changes nothing and the control would be
    // inert — silently passing forever. So un-pin a pinned entry instead.
    const pinnedFile = ROADMAP_SOURCES.map((s) => s.file).find((f) =>
      sources.get(f)!.includes(`- **${PIN_MARKER}`),
    );
    expect(
      pinnedFile,
      'the live backlog must pin at least one entry, or this drift control cannot fire',
    ).toBeDefined();
    const drifted = new Map(sources);
    drifted.set(pinnedFile!, sources.get(pinnedFile!)!.replaceAll(`- **${PIN_MARKER}`, '- **'));
    expect(spliceRoadmap(onDisk, renderRoadmap(collectRoadmap(drifted)))).not.toBe(onDisk);
  });

  it('`--check` is green on the committed tree', () => {
    const r = spawnSyncHidden(process.execPath, [GENERATOR, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
    expect(r.stdout).toMatch(/pointer\(s\)/);
  });

  // The former 'shares ONE definition of "a backlog entry"' test compared this
  // generator's entry COUNT against check-backlog-budget's. Both now segment
  // through scripts/shared/backlog-entry-grammar.mjs, so there is one grammar and
  // nothing left to drift — extraction replaces the drift test rather than
  // sitting beside it.
});

// ── the pre-commit gate, end to end in a throwaway repo ──────────────────────
// The gate is spawned as a real process with a real hook payload on stdin — the
// same contract Claude Code uses. Exit 2 = blocked, exit 0 = allowed. The temp
// repo's `check:handoff-roadmap` script FAILS, so the gate blocking proves the
// trigger actually ran the check rather than merely being wired.
describe('pre-commit gate — the HANDOFF-roadmap trigger fires at COMMIT', () => {
  let repo: string;

  const git = (args: string[]) => execFileSyncHidden('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });

  const writeFile = (rel: string, body: string) => {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };

  const runGate = () => {
    const r = spawnSyncHidden(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } }),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    return { code: r.status, stderr: r.stderr ?? '' };
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'audit-tools-roadmap-gate-'));
    execFileSyncHidden('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    git(['config', 'user.email', 'test@test']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFile(
      'package.json',
      JSON.stringify(
        {
          name: 'roadmap-fixture',
          version: '0.0.0',
          private: true,
          scripts: {
            check: 'node -e ""',
            'test:doc-contract': 'node -e ""',
            'check:doc-manifest': 'node -e ""',
            // Broadest trigger in the same hook; no-op so this suite observes the
            // roadmap trigger alone.
            'check:doc-links': 'node -e ""',
            'check:handoff-roadmap': 'node -e "process.exit(1)"',
            // The seek-index gate is a SEPARATE trigger in the same hook and it
            // legitimately owns `docs/backlog.md`. It must succeed here, so that
            // what this suite observes is the roadmap trigger alone.
            'check:backlog-index': 'node -e ""',
          },
        },
        null,
        2,
      ),
    );
    writeFile('README.md', '# fixture\n');
    writeFile('.gitignore', '.claude/\nnode_modules/\n');
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
  });

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly; a leaked temp dir is not a failure */
    }
  });

  const reset = () => {
    git(['reset', '--hard', 'HEAD']);
    git(['clean', '-fd']);
  };

  // The fixture repo is shared across cases, so a case that throws BEFORE its
  // own `reset()` leaves its staged files behind and the NEXT case fails for a
  // reason that has nothing to do with what it asserts. That cascade cost a
  // false second failure the first time this suite met a new gate trigger.
  afterEach(reset);

  it('BLOCKS a commit that edits a BACKLOG file (the backlog can stale HANDOFF)', () => {
    writeFile('docs/backlog/open-bugs.md', '# open bugs\n\n- **new entry.** body\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/HANDOFF roadmap check FAILED/);
    expect(stderr).toMatch(/generate-handoff-roadmap\.mjs/);
    reset();
  });

  it('BLOCKS a commit that edits HANDOFF itself (a hand-edit inside the block is the drift)', () => {
    writeFile('docs/HANDOFF.md', '# handoff\n\nhand-edited roadmap\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/HANDOFF roadmap check FAILED/);
    reset();
  });

  it('does NOT fire on unrelated markdown — the trigger stays narrow', () => {
    // `docs/reviews/*` are records. Firing on those would train the regenerate
    // step into noise.
    //
    // `docs/backlog.md` used to be listed here too, on the reasoning that it is
    // the INDEX rather than a section file. That is still true of the ROADMAP —
    // but the file now also carries the generated SEEK INDEX, whose own gate
    // legitimately fires on it (a hand-edit inside that block is exactly the
    // drift it catches). So it belongs to the other trigger, not to this
    // "unrelated" set; the case below pins that split.
    writeFile('docs/reviews/some-record-2026-07-25.md', '# record\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    reset();
  });

  it('leaves docs/backlog.md to the seek-index trigger, not this one', () => {
    writeFile('docs/backlog.md', '# index\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    // The roadmap check is rigged to exit 1 in this fixture, so if the ROADMAP
    // trigger fired the gate would block with its message. It must not.
    expect(code, stderr).toBe(0);
    expect(stderr).not.toMatch(/HANDOFF roadmap check FAILED/);
    reset();
  });

  it('does NOT fire on a commit that carries no docs at all', () => {
    writeFile('src/thing.ts', 'export const x = 1;\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    reset();
  });
});
