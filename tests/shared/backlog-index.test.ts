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
  BOTH_GENERATORS,
  END_MARKER,
  INDEX_SOURCES,
  collectIndex,
  findBoundaryDamage,
  renderIndex,
  spliceIndex,
} from '../../scripts/shared/generate-backlog-index.mjs';
import {
  findEntryBoundaryDamage,
  renderEntryBoundaryDamage,
  splitBacklogEntries,
} from '../../scripts/shared/backlog-entry-grammar.mjs';
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

describe('entry-boundary damage — the RED the index generator cannot see by construction', () => {
  /**
   * THE INCIDENT (two-identities lap, 2026-08-30). A lap deleted a backlog entry
   * by LINE INDEX and the count ate the NEXT entry's `- **` opener: the
   * neighbour's body survived with no opener and absorbed into the entry above.
   * `check:backlog-index` stayed green — the generator counts entries from the
   * same damaged bytes, so it regenerated an index that AGREED with the damage,
   * and the now-invisible entry vanished from the seek index, the size budget and
   * the roadmap together.
   *
   * So the assertions below come in pairs. Each damage shape is asserted RED, and
   * the shape it is most easily confused with is asserted QUIET — a gate that
   * cries wolf gets disabled, and then nothing is guarded at all.
   */
  const damagedFile = (lines: string[]) => lines.join('\n');

  it('a `- **Title**` that lost its column-0 opener is a RED', () => {
    // The residue: the entry is now nested inside the numeric-index neighbour.
    const hits = findEntryBoundaryDamage(
      damagedFile([
        '# Open bugs',
        '',
        '- **First entry.** body',
        '  more body',
        '',
        '  - **Second entry, moved one level in**',
        '  its body',
        '',
      ]),
    );
    expect(hits).toEqual([
      { kind: 'lost_opener', line: 6, text: '- **Second entry, moved one level in**' },
    ]);
  });

  it('a column-0 bold title with no bullet is a stray continuation', () => {
    // The other residue of the same deletion: the `- ` was eaten, the bold run
    // stayed, and the entry is now a paragraph inside its neighbour.
    const hits = findEntryBoundaryDamage(
      damagedFile(['# T', '', '- **First.** body', '', '**Second lost its bullet**', '  its body', '']),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('stray_continuation');
    expect(hits[0].line).toBe(5);
  });

  it('an indented line above the file’s FIRST entry is a stray continuation', () => {
    // Nothing above it opens an entry, so the text belongs to no entry at all:
    // unreachable from the index, the budget meter and the roadmap alike.
    const hits = findEntryBoundaryDamage(damagedFile(['# T', '', '> preamble', '', '  orphan text', '']));
    expect(hits).toEqual([{ kind: 'stray_continuation', line: 5, text: 'orphan text' }]);
  });

  it('a PARAGRAPH that opens indented is the shape the deletion actually leaves', () => {
    // The load-bearing case, and the one with no other tell. An entry runs
    // `\n\n  <paragraph>` for each continuation paragraph, so within ONE entry an
    // indented line always follows another indented line. A paragraph that OPENS
    // indented — right after a blank one — is therefore a paragraph of an entry
    // whose `- **Title**` line is gone, absorbed into the entry above.
    const hits = findEntryBoundaryDamage(
      damagedFile(['# T', '', '- **First.** lead', '  continued', '', '  an orphaned paragraph', '']),
    );
    expect(hits).toEqual([
      { kind: 'stray_continuation', line: 6, text: 'an orphaned paragraph' },
    ]);
  });

  it('THE INCIDENT, replayed: deleting an opener LINE is caught even though the entry count drops', () => {
    // The exact damage a line-count deletion does — remove the `- **Title**` line
    // and nothing else. The entry is swallowed silently (the splitter's count for
    // the live open-bugs.md drops 77 → 76), and NOTHING else in the pipeline
    // notices: the text is just indented, which every continuation line is.
    // Replayed against the real file so the fixture cannot drift from the corpus
    // it is drawn from. The target is chosen by SHAPE, never by title: the entry
    // the incident was recorded against closes one day (this lap closed it), and
    // a title-pinned replay dies with it. The shape is the incident's: an opener
    // after the file's first entry (before it, every indented line is already
    // ownerless), preceded by a blank line, whose next line is indented prose.
    const lines = readFileSync(join(REPO_ROOT, 'docs', 'backlog', 'open-bugs.md'), 'utf8').split(/\r?\n/);
    const isOpener = (l: string): boolean => /^- \*\*/.test(l);
    const first = lines.findIndex(isOpener);
    const opener = lines.findIndex(
      (l, i) =>
        i > first &&
        isOpener(l) &&
        lines[i - 1]!.trim() === '' &&
        /^[ \t]+[^-*+\s]/.test(lines[i + 1] ?? ''),
    );
    expect(opener, 'open-bugs.md must hold an entry of the incident shape to replay').toBeGreaterThan(0);
    const damaged = [...lines.slice(0, opener), ...lines.slice(opener + 1)].join('\n');

    // The splitter cannot see it: one fewer entry, no malformed markdown.
    expect(splitBacklogEntries(damaged).length).toBe(splitBacklogEntries(lines.join('\n')).length - 1);
    // The damage scan can, and it names the swallowed entry's first line.
    const hits = findEntryBoundaryDamage(damaged);
    expect(hits).toEqual([
      { kind: 'stray_continuation', line: opener + 1, text: lines[opener + 1]!.trim() },
    ]);
    // …and it is the INDEPENDENT leg that catches it — the index generator
    // regenerates happily from these same bytes, which is the whole defect.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a nested bullet opening after a blank line stays QUIET — a list is not a paragraph', () => {
    // Legal Markdown the paragraph rule would otherwise refuse: an entry's list.
    // The rule is about PROSE that opens indented, which is the only shape a
    // surviving body can have.
    expect(
      findEntryBoundaryDamage(
        damagedFile(['# T', '', '- **A.** lead', '', '  - a nested bullet', '    more', '']),
      ),
    ).toEqual([]);
  });

  it('a nested bullet whose bold is INLINE emphasis stays QUIET', () => {
    // The confusing neighbour: `  - **Bold lead** and the prose runs on`. It
    // opens the same three characters as a lost opener, and the only thing that
    // separates them is that a TITLE's bold run closes at end of line.
    expect(
      findEntryBoundaryDamage(
        damagedFile(['# T', '', '- **First.** body', '', '  - **Bold lead** and prose continues', '    more', '']),
      ),
    ).toEqual([]);
  });

  it('the `## Open tracks` paragraph grammar stays QUIET at column 0', () => {
    // Not a stray continuation: that one section legitimately writes its entries
    // as bare bold paragraphs, which `parseTrackEntries` reads by the same rule.
    expect(
      findEntryBoundaryDamage(
        damagedFile([
          '# Forward tracks',
          '',
          '## Open tracks',
          '',
          '**Track 1 — a track.** body',
          'more body',
          '',
          '## Forward tracks',
          '',
          '- **A direction.** body',
          '',
        ]),
      ),
    ).toEqual([]);
  });

  it('the damage scan is INDEPENDENT of index parity, so it fires where the generator cannot', () => {
    // The load-bearing property, asserted directly: an index REGENERATED from the
    // damaged bytes agrees with itself, so parity cannot be the detector. Feeding
    // the damaged source to the index generator produces a block that contains no
    // anchor for the swallowed entry — and the damage scan still finds it.
    const sources = fixtureSources();
    sources.set(
      'open-bugs.md',
      damagedFile([
        '# Open bugs',
        '',
        '- **First bug.** body',
        '',
        '  - **Second bug, opener eaten**',
        '  its body',
        '',
      ]),
    );
    const block = renderIndex(collectIndex(sources));
    expect(block).toContain('First bug.');
    expect(block, 'the generator agrees with the damage — it cannot be the detector').not.toContain(
      'Second bug, opener eaten',
    );
    expect(findBoundaryDamage(sources)).toEqual([
      {
        file: 'open-bugs.md',
        damaged: [{ kind: 'lost_opener', line: 5, text: '- **Second bug, opener eaten**' }],
      },
    ]);
  });

  it('the scan reads the WHOLE file, not collectIndex’s section slice', () => {
    // A slice has lost the `##` headings, and the headings are what tell the
    // detector that `## Open tracks` writes paragraphs — so scanning the slice
    // would red the live forward-tracks.md. This pins the difference.
    const sources = fixtureSources();
    expect(findBoundaryDamage(sources)).toBeNull();
    const sliced = findEntryBoundaryDamage(
      sources.get('forward-tracks.md')!.split('## Open tracks')[1]!,
    );
    expect(sliced, 'a slice of the paragraph-entry section is not scannable').not.toEqual([]);
  });

  it('the refusal names the file, the line, and the damage — and the fix, not just the fault', () => {
    // The refusal is the whole product of this leg: an operator reads it and
    // restores the opener. Asserting the rendered TEXT (not only the finding) is
    // what pins the message the CLI prints at the gate.
    const damage = findEntryBoundaryDamage('- **First.** body\n\n  - **Second lost its opener**\n');
    const refusal = renderEntryBoundaryDamage(damage, 'docs/backlog/open-bugs.md');
    expect(refusal).toContain('docs/backlog/open-bugs.md:3');
    expect(refusal).toContain('lost its column-0');
    expect(refusal).toContain('Second lost its opener');
    // The measured rule the incident produced, stated where it is needed.
    expect(refusal).toContain('anchor the deletion on the');
    expect(refusal).toContain('next `- **`');
  });

  it('the LIVE backlog is clean — the gate ships green on its own corpus', () => {
    const files = [...new Set(INDEX_SOURCES.map((s) => s.file))];
    const sources = new Map(
      files.map((f) => [f, readFileSync(join(REPO_ROOT, 'docs', 'backlog', f), 'utf8')]),
    );
    expect(findBoundaryDamage(sources)).toBeNull();
  });
});

describe('one refusal names BOTH stale generators, so one edit costs one round-trip', () => {
  /**
   * The duplicated-guard lap (2026-07-25): the seek index and the HANDOFF roadmap
   * are two generators with two commit-gate refusals, so a single backlog edit
   * cost two blocked commits to learn both were stale. The gates cannot be
   * merged, but the message can carry both fixes.
   */
  it('names the roadmap generator and its target beside the index one', () => {
    expect(BOTH_GENERATORS).toContain('generate-backlog-index.mjs');
    expect(BOTH_GENERATORS).toContain('generate-handoff-roadmap.mjs');
    expect(BOTH_GENERATORS).toContain('docs/HANDOFF.md');
    expect(BOTH_GENERATORS).toMatch(/BOTH/i);
  });

  it('the refusal text is the same constant in both branches, never a second copy', () => {
    // The damage branch and the parity branch both print it, and the parity
    // branch reaches it through runGeneratedArtifactCli's staleMessage — so a
    // hand-written second copy in either place would be the drift this pins.
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'shared', 'generate-backlog-index.mjs'), 'utf8');
    const uses = src.match(/BOTH_GENERATORS/g) ?? [];
    // The declaration, the damage branch, and staleMessage. More than that is a
    // second copy of the sentence, which is the drift this pins.
    expect(uses.length).toBe(3);
    // The roadmap's fix command appears exactly ONCE — inside the constant that
    // every branch prints. A second spelling would be a refusal the other branch
    // cannot reach, which is the round-trip this constant exists to remove.
    expect((src.match(/scripts\/shared\/generate-handoff-roadmap\.mjs/g) ?? []).length).toBe(1);
  });
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
