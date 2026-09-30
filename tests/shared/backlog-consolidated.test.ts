import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { evaluateBacklogCorpus, loadBacklogCorpus, runBacklogCheck } from '../../scripts/check-backlog.mjs';
import { normalizeBaseline } from '../../scripts/check-backlog-budget.mjs';
import { parseBacklogDocument } from '../../scripts/shared/backlog-entry-grammar.mjs';
import { parseBulletEntries, parseTrackEntries } from '../../scripts/shared/generate-handoff-roadmap.mjs';
import { reconcile } from '../../scripts/check-guard-reach.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARDS } from '../../scripts/guard-reach-data.mjs';
import { catalogGates } from '../../scripts/shared/verify-steps.mjs';

describe('one executable backlog check', () => {
  it('has one release and pre-commit registration for the four independent validators', () => {
    const ids = ['check:backlog', 'check:backlog-budget', 'check:backlog-status', 'check:backlog-line-numbers', 'check:backlog-friction-tags'];
    expect(catalogGates().filter((g) => ids.includes(g.id)).map((g) => g.id)).toEqual(['check:backlog']);
    expect(GUARDS.filter((g) => ids.includes(g.id) && g.preCommit !== false).map((g) => g.id)).toEqual(['check:backlog']);
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'backlog-corpus-')); roots.push(root);
  mkdirSync(join(root, 'docs/backlog'), { recursive: true });
  writeFileSync(join(root, 'docs/backlog/open-bugs.md'), text);
  return root;
}
const broken = '- **SHIPPED (friction: false_red).** see `src/a.ts:12` ' + 'x'.repeat(3000);

describe('shared corpus with independent refusal classes', () => {
  it('loads each source once and reports every applicable refusal on one entry', () => {
    const root = fixture(broken);
    let reads = 0;
    const corpus = loadBacklogCorpus(root, (path: string) => { reads++; return readFileSync(path, 'utf8'); });
    expect(reads).toBe(1);
    const result = evaluateBacklogCorpus(corpus, normalizeBaseline(null));
    expect(new Set(result.diagnostics.map((d) => d.check))).toEqual(new Set(['budget/property', 'status', 'line-citation', 'friction']));
    expect(reads).toBe(1);
    const cli = spawnSyncHidden(process.execPath, [fileURLToPath(new URL('../../scripts/check-backlog.mjs', import.meta.url)), '--root', root], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    for (const check of ['budget/property', 'status', 'line-citation', 'friction']) expect(cli.stderr).toContain(`[backlog:${check}]`);
  });

  it('preserves write-time scope and never reads or changes the deferred budget baseline', () => {
    const root = fixture(broken);
    const baseline = join(root, 'docs/backlog/.size-baseline.json');
    writeFileSync(baseline, '{invalid');
    const result = runBacklogCheck(root, { writeTime: true });
    expect(new Set(result.diagnostics.map((d) => d.check))).toEqual(new Set(['line-citation', 'friction']));
    expect(readFileSync(baseline, 'utf8')).toBe('{invalid');
    expect(() => runBacklogCheck(root)).toThrow('Cannot read backlog baseline');
  });

  it('fails closed on unreadable sources and damaged entry boundaries', () => {
    const root = fixture('**An opener was lost.** orphaned text');
    expect(runBacklogCheck(root).diagnostics.some((d) => d.check === 'entry-boundary')).toBe(true);
    mkdirSync(join(root, 'docs/backlog/unreadable.md'));
    expect(() => loadBacklogCorpus(root)).toThrow();
  });

  it('uses the same bullet and track boundaries as the generated index readers', () => {
    const bullets = '- **First\ncontinued title.** Body\n  - nested detail\n- **Second.** Tail';
    const parsed = parseBacklogDocument(bullets);
    expect(parseBulletEntries(bullets).map(({ line, body }) => ({ line, body }))).toEqual(parsed.entries.map(({ line, body }) => ({ line, body })));
    const tracks = '## Open tracks\n**Track one.** Body\n**Track two.** Tail\n## Forward tracks\n- **Bullet.** Body';
    expect(parseTrackEntries(tracks).map(({ line, body }) => ({ line, body }))).toEqual(parseBacklogDocument(tracks).tracks.map(({ line, body }) => ({ line, body })));
  });

  it('does not let diagnostic aliases hide unrelated executable checks', () => {
    const guards = [{ id: 'check:aggregate', kind: 'gate', impl: 'check:aggregate', preCommit: false, fix: 'repair',
      diagnosticAliases: [{ script: 'check:aggregate-hidden', module: 'scripts/check-known.mjs', purpose: 'focused diagnostics' }],
      forms: [{ module: 'scripts/check-known.mjs' }] }];
    const errors = reconcile({ guards, reach: [], onDisk: [], settingsHookCommands: [], packageScripts: {
      'verify:release': 'npm run check:aggregate', 'check:aggregate': 'node scripts/aggregate.mjs',
      'check:aggregate-hidden': 'node scripts/check-known.mjs && node scripts/unregistered.mjs',
    } });
    expect(errors.join('\n')).toContain('Invalid diagnostic alias');
  });
});
