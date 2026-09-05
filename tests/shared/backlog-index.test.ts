// Contract tests for the generated backlog SEEK INDEX:
// `scripts/shared/generate-backlog-index.mjs` + its trigger inside
// `.claude/hooks/pre-commit-gate.mjs`.
//
// Lives under tests/shared (not beside the hook) on purpose: vitest EXCLUDES
// `.claude/**`, so a test placed next to a hook never runs in CI and the guard
// is unverified exactly where it matters — same reason
// tests/shared/handoff-roadmap.test.mjs lives here.
//
// What must hold, and why each half matters:
//   • ANCHORS ARE CORRECT — a section-scoped source is parsed from a SLICE of
//     its file, so its raw line numbers are relative to that slice. If the
//     re-basing is wrong the index still renders, still passes `--check`, and
//     silently sends every reader of `forward-tracks.md` to the wrong entry. A
//     stale-or-wrong anchor is worse than no anchor, so this is the load-bearing
//     assertion.
//   • POINTERS, not specs — a line carries the entry's own bold title verbatim,
//     never its body, so the index is not a second home for anything.
//   • DURABLE-TRAPS IS INCLUDED — deliberately unlike the roadmap, which
//     excludes it because a queue listing reference material stops being a
//     queue. An index that omits a file you must still navigate is just worse.
//   • the hand-written parts survive — only the delimited block is replaced.
//   • the gate FIRES AT COMMIT, not only in verify:checks. The pre-commit hook
//     does not run verify:checks, so a check wired only there first fails in
//     RELEASE CI and burns a tag.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BEGIN_MARKER,
  END_MARKER,
  INDEX_SOURCES,
  collectIndex,
  renderIndex,
  spliceIndex,
} from '../../scripts/shared/generate-backlog-index.mjs';
import { buildPreCommitLegs } from '../../scripts/shared/derived-file-preflight.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
// P53: the derived legs run at GIT's boundary, in commit-gate.mjs.
const GATE = join(REPO_ROOT, '.claude', 'hooks', 'commit-gate.mjs');

/** A synthetic backlog whose section-scoped file has a deliberately long preamble. */
function fixtureSources() {
  const openBugs = ['# Open bugs', '', '- **First bug.** body', '', '- **Second bug.** body', ''].join('\n');
  const forwardTracks = [
    '# Forward tracks', // 1
    '', // 2
    'Some preamble that pushes the sections down the file.', // 3
    '', // 4
    '## Open tracks', // 5
    '', // 6
    '**Track 1 — the first track.** body', // 7
    '', // 8
    '## Forward tracks', // 9
    '', // 10
    '- **A design direction.** body', // 11
    '',
  ].join('\n');
  const deferred = ['# Deferred', '', '- **Waiting on creds.** body', ''].join('\n');
  const durableTraps = ['# Traps', '', '- **A standing trap.** body', ''].join('\n');
  // The LOW-severity split of open-bugs.md. Indexed identically to it: the
  // severity split bounds the READ, and must never bound the index — an entry
  // that drops out of the seek index is an entry that goes stale unseen.
  const minorBugs = ['# Minor open bugs', '', '- **A low-severity bug.** body', ''].join('\n');
  return new Map([
    ['open-bugs.md', openBugs],
    ['minor-bugs.md', minorBugs],
    ['forward-tracks.md', forwardTracks],
    ['deferred.md', deferred],
    ['durable-traps.md', durableTraps],
  ]);
}

describe('the fixture covers the real source list', () => {
  // Adding a file to INDEX_SOURCES without adding it here makes FIVE unrelated
  // tests fail deep inside collectIndex with "source ... was not supplied" —
  // which is the generator working correctly and the fixture lagging. Bit once,
  // when minor-bugs.md was split out of open-bugs.md. This says so directly.
  it('supplies every file INDEX_SOURCES names', () => {
    const supplied = new Set(fixtureSources().keys());
    const missing = [...new Set(INDEX_SOURCES.map((s) => s.file))].filter((f) => !supplied.has(f));
    expect(
      missing,
      `fixtureSources() is missing ${missing.join(', ')} — add it there when you add an INDEX_SOURCES entry`,
    ).toEqual([]);
  });
});

describe('anchors — the whole point of the index', () => {
  it('re-bases a section-scoped entry onto its line in the WHOLE file', () => {
    const groups = collectIndex(fixtureSources());
    const tracks = groups.find((g) => g.section === 'Open tracks')!;
    const forward = groups.find((g) => g.section === 'Forward tracks')!;

    // `**Track 1 …**` is line 7 of forward-tracks.md; `- **A design direction.**`
    // is line 11. Parsed from the section slice alone they would be 2 and 2.
    expect(tracks.items).toHaveLength(1);
    expect(tracks.items[0].line).toBe(7);
    expect(forward.items).toHaveLength(1);
    expect(forward.items[0].line).toBe(11);
  });

  it('every anchor lands on the line that actually opens that entry', () => {
    const sources = fixtureSources();
    for (const group of collectIndex(sources)) {
      const lines = sources.get(group.file)!.split(/\r?\n/);
      for (const item of group.items) {
        expect(lines[item.line - 1]).toMatch(/^(- \*\*|\*\*)/);
      }
    }
  });

  it('holds against the REAL backlog, not just the fixture', () => {
    const files = [...new Set(INDEX_SOURCES.map((s) => s.file))];
    const sources = new Map(
      files.map((f) => [f, readFileSync(join(REPO_ROOT, 'docs', 'backlog', f), 'utf8')]),
    );
    let checked = 0;
    for (const group of collectIndex(sources)) {
      const lines = sources.get(group.file)!.split(/\r?\n/);
      for (const item of group.items) {
        expect(lines[item.line - 1]).toMatch(/^(- \*\*|\*\*)/);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('rendering — pointers, never a second copy', () => {
  it('emits the entry title verbatim and none of its body', () => {
    const block = renderIndex(collectIndex(fixtureSources()));
    expect(block).toContain('— First bug.');
    expect(block).not.toContain('body');
  });

  it('indexes durable-traps.md, which the roadmap deliberately omits', () => {
    expect(INDEX_SOURCES.map((s) => s.file)).toContain('durable-traps.md');
    const block = renderIndex(collectIndex(fixtureSources()));
    expect(block).toContain('A standing trap.');
  });

  it('refuses a source it was not given rather than silently indexing less', () => {
    const partial = fixtureSources();
    partial.delete('deferred.md');
    expect(() => collectIndex(partial)).toThrow(/deferred\.md was not supplied/);
  });
});

describe('splicing — hand-written prose is untouched', () => {
  it('replaces only the delimited block', () => {
    const doc = `# Backlog\n\nhand-written above\n\n${BEGIN_MARKER}\nOLD\n${END_MARKER}\n\nhand-written below\n`;
    const out = spliceIndex(doc, `${BEGIN_MARKER}\nNEW\n${END_MARKER}`);
    expect(out).toContain('hand-written above');
    expect(out).toContain('hand-written below');
    expect(out).toContain('NEW');
    expect(out).not.toContain('OLD');
  });

  // (Splice refusals are pinned once, in
  // tests/shared/generated-artifacts-splice.test.ts.)
});

describe('the gate fires at COMMIT, not only in verify:checks', () => {
  const gate = readFileSync(GATE, 'utf8');

  it('the derived leg set carries a check:backlog-index leg the hook runs', () => {
    // The hook no longer names any check:* leg by hand (P34) — the leg comes
    // from the guard-reach registry through buildPreCommitLegs, which the hook
    // imports. Assert the import plus the derived leg's existence.
    expect(gate).toContain('derived-file-preflight.mjs');
    expect(gate).toContain('buildPreCommitLegs');
    const leg = buildPreCommitLegs({}).find((l) => l.script === 'check:backlog-index');
    expect(leg).toBeDefined();
    expect(leg!.phase).toBe('main');
  });

  it('it triggers on docs/backlog.md AND on any docs/backlog/*.md', () => {
    // Both directions stale the index: editing a backlog file moves the
    // anchors, and editing docs/backlog.md can clobber the block itself.
    // The trigger is DERIVED from the backlog-family REACH row (P34), so its
    // shape is asserted through the derived leg rather than a hand predicate.
    const leg = buildPreCommitLegs({}).find((l) => l.script === 'check:backlog-index')!;
    const fires = (path: string) => leg.triggered({ root: REPO_ROOT, staged: [path] });
    expect(fires('docs/backlog.md')).toBe(true);
    expect(fires('docs/backlog/open-bugs.md')).toBe(true);
    expect(fires('docs/backlog/sub/deep.md')).toBe(false);
  });

  it('is wired into verify:checks as well', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:backlog-index']).toBeDefined();
    expect(pkg.scripts['verify:checks']).toContain('check:backlog-index');
  });
});
