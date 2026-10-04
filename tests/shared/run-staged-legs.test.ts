// Contract test for `scripts/run-staged-legs.mjs` (`npm run staged:legs`): it runs
// exactly the commit gate's derived legs for the staged set, without committing,
// and reports a verdict only when the working tree IS the staged tree.
//
// The fixture repository declares the triggered leg's npm script itself, so the
// test controls the leg's outcome and never runs a real gate.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { buildPreCommitLegs } from '../../scripts/shared/derived-file-preflight.mjs';

const RUNNER = resolve(import.meta.dirname, '..', '..', 'scripts', 'run-staged-legs.mjs');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Leg {
  id: string;
  script: string;
  testPath?: string;
  triggered: (ctx: { root: string; staged: string[] }) => boolean;
}

/** A repo with `docs/a.md` staged and the first gate leg it triggers wired to `body`. */
function fixture(body: string): { root: string; leg: Leg } {
  const root = mkdtempSync(join(tmpdir(), 'staged-legs-'));
  roots.push(root);
  const g = (...args: string[]) => spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  // The worktree-tree read starts from HEAD, which every real checkout has.
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  g('add', 'seed.txt');
  g('commit', '-qm', 'seed');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.md'), '# a\n');
  const staged = ['docs/a.md', 'package.json'];
  const leg = (buildPreCommitLegs({ packageScripts: {} }) as Leg[]).find(
    (l) => !l.testPath && l.triggered({ root, staged }),
  );
  if (!leg) throw new Error('no gate leg is triggered by a staged docs/*.md — pick another fixture path');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { [leg.script]: body } }));
  g('add', '.');
  return { root, leg };
}

const run = (root: string) => spawnSyncHidden(process.execPath, [RUNNER], { cwd: root, encoding: 'utf8' });

describe('staged:legs runs the commit gate legs for the staged set', () => {
  it('exits 1 and names the leg when a triggered leg fails on the staged tree', () => {
    const { root, leg } = fixture('node -e "process.exit(1)"');
    const r = run(root);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(leg.script);
  });

  it('exits 0 when every triggered leg passes', () => {
    const { root } = fixture('node -e "process.exit(0)"');
    const r = run(root);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it('abstains instead of judging when the working tree is not the staged tree', () => {
    const { root } = fixture('node -e "process.exit(1)"');
    writeFileSync(join(root, 'docs', 'a.md'), '# a, edited after staging\n');
    const r = run(root);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(3);
    expect(r.stderr).toContain('ABSTAINED');
  });
});
