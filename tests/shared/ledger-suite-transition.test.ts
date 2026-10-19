// The official attester may carry ONE verified ledger-only transition, never a
// second suite pass or a blanket ignored path. Fixtures contain synthetic run
// evidence; this suite does not claim to qualify the implementation checkout.
import { afterEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSyncHidden as spawnSync } from '../helpers/spawn.mjs';
import { worktreeTrees } from '../../scripts/shared/worktree-tree.mjs';
import { closeoutReadinessFindings } from '../../scripts/shared/closeoutReadiness.mjs';
import { initGateRepo, g, stageLoopCoreFile, runAttest } from './pre-commit-gate-harness.js';
import { applyAttestation } from '../../scripts/shared/loopCoreAttestationLedger.mjs';
import * as stamps from '../../scripts/shared/suiteGreenStamp.mjs';

const repos: string[] = [];
afterEach(() => { for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true }); });
function setup(beforeAttest?: (repo: string) => void) {
  const repo = initGateRepo(); repos.push(repo);
  g(repo, 'branch', '-M', 'main');
  writeFileSync(join(repo, '.gitignore'), '.claude/*\n!.claude/loop-core-attestations.json\n');
  stageLoopCoreFile(repo);
  const a = g(repo, 'write-tree').stdout.trim();
  const evidence = { run_token: 'fixture-original-run', vitest_args: [], tree_before: a, tree_after: a,
    reporter: { runToken: 'fixture-original-run', outcome: { failed: 0, unfinished: 0, passed: 1, total: 1, skipped: 0, failedFiles: [] } } };
  expect(stamps.writeSuiteGreenStamp(repo, a, evidence)).toBe(true);
  const original = readFileSync(stamps.suiteGreenStampPath(repo), 'utf8');
  beforeAttest?.(repo);
  const r = runAttest(repo, ['--reviewed-by', 'fixture-reviewer', '--attester-class', 'agent', '--checked',
    'checked exact ledger-only transition against source and mode changes'], { stamp: false });
  expect(r.status, r.stderr).toBe(0);
  const b = g(repo, 'write-tree').stdout.trim();
  return { repo, a, b, original };
}
function verdict(repo: string, tree: string) {
  return stamps.suiteQualificationVerdict(repo, tree, { concernsBlock: true });
}
test('official producer qualifies exact B while the original full-suite stamp remains byte-identical on A', () => {
  const { repo, a, b, original } = setup();
  expect(a).not.toBe(b);
  expect(readFileSync(stamps.suiteGreenStampPath(repo), 'utf8')).toBe(original);
  expect(stamps.suiteGreenVerdict(stamps.readSuiteGreenStamp(repo), b).ok).toBe(false);
  expect(verdict(repo, b)).toMatchObject({ ok: true, tree: b, viaLedgerTransition: true, viaBumpDelta: false });
});
for (const path of ['source.ts', 'test.test.ts', 'package-lock.json', '.claude/loop-core-attestations.json']) {
  test(`post-producer edit of ${path} refuses`, () => {
    const { repo } = setup();
    writeFileSync(join(repo, path), 'tampered\n');
    g(repo, 'add', '-f', '--', path);
    expect(verdict(repo, g(repo, 'write-tree').stdout.trim()).ok).toBe(false);
  });
}

function recordPath(repo: string, tree: string) { return join(repo, '.claude', 'loop-core-review', `${tree}.json`); }
function rewriteRecord(repo: string, tree: string, change: (record: any) => void, to = tree) {
  const record = JSON.parse(readFileSync(recordPath(repo, tree), 'utf8'));
  change(record);
  writeFileSync(recordPath(repo, to), JSON.stringify(record));
}
for (const kind of ['mode', 'deletion', 'source', 'test', 'lock']) {
  test(`complete tree comparison rejects ${kind} even with a copied destination record`, () => {
    const { repo, b } = setup();
    if (kind === 'mode') g(repo, 'update-index', '--chmod=+x', 'sentinel.txt');
    else if (kind === 'deletion') g(repo, 'rm', 'sentinel.txt');
    else { const path = kind === 'source' ? 'source.ts' : kind === 'test' ? 'test.test.ts' : 'package-lock.json';
      writeFileSync(join(repo, path), 'changed\n'); g(repo, 'add', path); }
    const next = g(repo, 'write-tree').stdout.trim();
    rewriteRecord(repo, b, (r) => { r.staged_tree = next; r.suite_transition.to_tree = next; }, next);
    expect(verdict(repo, next).ok).toBe(false);
  });
}
for (const kind of ['producer', 'transition', 'preflight', 'concerns', 'tests-ran']) {
  test(`missing or invalid ${kind} evidence refuses`, () => {
    const { repo, b } = setup();
    rewriteRecord(repo, b, (r) => {
      if (kind === 'producer') r.suite_transition.producer = 'hand-authored';
      if (kind === 'transition') delete r.suite_transition;
      if (kind === 'preflight') r.preflight.attributable = false;
      if (kind === 'concerns') { r.verdict = 'concerns'; r.override = 'still not eligible for this exception'; }
      if (kind === 'tests-ran') r.tests_ran.tree = '0'.repeat(40);
    });
    expect(verdict(repo, b).ok).toBe(false);
  });
}
test('missing or changed original stamp refuses', () => {
  const { repo, b } = setup();
  writeFileSync(stamps.suiteGreenStampPath(repo), '{}');
  expect(verdict(repo, b).ok).toBe(false);
  rmSync(stamps.suiteGreenStampPath(repo));
  expect(verdict(repo, b).ok).toBe(false);
});
for (const kind of ['missing', 'shard', 'filtered', 'stale-token', 'unfinished', 'failed', 'changed-during-run']) {
  test(`retained original run rejects ${kind} even when its byte binding is updated`, () => {
    const { repo, b } = setup();
    const stamp = JSON.parse(readFileSync(stamps.suiteGreenStampPath(repo), 'utf8'));
    const e = stamp.run_evidence;
    if (kind === 'missing') delete stamp.run_evidence;
    if (kind === 'shard') e.vitest_args = ['--shard=1/4'];
    if (kind === 'filtered') e.vitest_args = ['tests/one.test.ts'];
    if (kind === 'stale-token') e.reporter.runToken = 'another-run';
    if (kind === 'unfinished') e.reporter.outcome.unfinished = 1;
    if (kind === 'failed') e.reporter.outcome.failed = 1;
    if (kind === 'changed-during-run') e.tree_before = '0'.repeat(40);
    const raw = JSON.stringify(stamp);
    writeFileSync(stamps.suiteGreenStampPath(repo), raw);
    rewriteRecord(repo, b, (r) => { r.suite_transition.original_stamp = raw;
      r.suite_transition.original_stamp_sha256 = createHash('sha256').update(raw).digest('hex'); });
    expect(verdict(repo, b).ok).toBe(false);
  });
}
test('legacy stamp can attest but cannot earn the ledger-only exception', () => {
  const { repo } = setup();
  writeFileSync(join(repo, 'src/shared/engine/x.ts'), 'export const x = 2;\n');
  g(repo, 'add', '-A');
  const a = g(repo, 'write-tree').stdout.trim();
  stamps.writeSuiteGreenStamp(repo, a);
  const r = runAttest(repo, ['--reviewed-by', 'reviewer', '--attester-class', 'agent', '--checked',
    'checked fixture source for changed control flow'], { stamp: false });
  expect(r.status, r.stderr).toBe(0);
  const b = g(repo, 'write-tree').stdout.trim();
  expect(JSON.parse(readFileSync(recordPath(repo, b), 'utf8')).suite_transition).toBeUndefined();
  expect(verdict(repo, b).ok).toBe(false);
});
test('release version edits do not compose with a ledger transition', () => {
  const { repo } = setup();
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg.version = '9.9.9'; writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  g(repo, 'add', 'package.json');
  expect(stamps.suiteQualificationVerdict(repo, worktreeTrees(repo), { concernsBlock: true }).ok).toBe(false);
});
test('immutable final ledger is checked, not a valid index ledger beside it', () => {
  const { repo, b } = setup();
  const path = '.claude/loop-core-attestations.json';
  const valid = readFileSync(join(repo, path), 'utf8');
  writeFileSync(join(repo, path), '{}\n'); g(repo, 'add', '-f', path);
  const bad = g(repo, 'write-tree').stdout.trim();
  const badBlob = g(repo, 'rev-parse', `${bad}:${path}`).stdout.trim();
  rewriteRecord(repo, b, (r) => { r.staged_tree = bad; r.suite_transition.to_tree = bad;
    r.suite_transition.ledger_blob = badBlob; }, bad);
  writeFileSync(join(repo, path), valid); g(repo, 'add', '-f', path);
  expect(verdict(repo, bad).ok).toBe(false);
});

test('push, readiness and owned status consume the official transition', () => {
  const { repo } = setup();
  g(repo, 'commit', '-qm', 'fixture official transition');
  const push = spawnSync(process.execPath, [resolve('.claude/hooks/push-gate.mjs')], {
    cwd: repo, encoding: 'utf8', input: JSON.stringify({ cwd: repo, tool_input: { command: 'git push origin HEAD:main' } }),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'fixture' },
  });
  expect(push.status, push.stderr).toBe(0);
  expect(closeoutReadinessFindings(repo).filter((s: string) => /full-suite|different content/.test(s))).toEqual([]);
  const status = spawnSync(process.execPath, [resolve('scripts/shared/suite-green-status.mjs')], { cwd: repo, encoding: 'utf8' });
  expect(status.status, status.stderr).toBe(0);
});

for (const defect of ['unreferenced', 'missing-entry', 'vouches', 'concerns']) {
  test(`final immutable ledger refuses ${defect} after rebinding the destination and blob`, () => {
    const { repo, b } = setup();
    const path = '.claude/loop-core-attestations.json';
    const ledger = JSON.parse(readFileSync(join(repo, path), 'utf8'));
    const review = Object.values(ledger.reviews)[0] as any;
    if (defect === 'unreferenced') ledger.reviews.extra = {};
    if (defect === 'missing-entry') delete ledger.entries['src/shared/engine/x.ts'];
    if (defect === 'vouches') review.vouches['src/shared/engine/x.ts'] = '0'.repeat(40);
    if (defect === 'concerns') { review.verdict = 'concerns'; review.override = null;
      Object.assign(ledger, applyAttestation(ledger, new Map(Object.entries(review.vouches) as [string, string][]),
        ['src/shared/engine/x.ts'], review)); }
    writeFileSync(join(repo, path), JSON.stringify(ledger)); g(repo, 'add', '-f', path);
    const bad = g(repo, 'write-tree').stdout.trim();
    rewriteRecord(repo, b, (r) => { r.staged_tree = bad; r.suite_transition.to_tree = bad;
      r.suite_transition.ledger_blob = g(repo, 'rev-parse', `${bad}:${path}`).stdout.trim(); }, bad);
    expect(verdict(repo, bad).ok).toBe(false);
  });
}
test('complete entry comparison rejects an added empty subtree', () => {
  const { repo, b } = setup();
  const empty = spawnSync('git', ['mktree'], { cwd: repo, encoding: 'utf8', input: '' }).stdout.trim();
  const entries = g(repo, 'ls-tree', b).stdout;
  const bad = spawnSync('git', ['mktree'], { cwd: repo, encoding: 'utf8',
    input: `${entries}040000 tree ${empty}\tempty-extra\n` }).stdout.trim();
  expect(bad).toMatch(/^[a-f0-9]{40}$/);
  rewriteRecord(repo, b, (r) => { r.staged_tree = bad; r.suite_transition.to_tree = bad; }, bad);
  expect(verdict(repo, bad).ok).toBe(false);
});

test('land reaches its publication boundary only for the official ledger transition', () => {
  const { repo, b } = setup();
  const remote = join(repo, '.git', 'fixture-remote', 'github.com', 'o', 'r.git');
  mkdirSync(remote, { recursive: true });
  const init = spawnSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  // Keep the local transport URL-shaped on Windows as well as POSIX.
  g(repo, 'remote', 'add', 'origin', pathToFileURL(remote).href);
  g(repo, 'push', '-q', 'origin', 'HEAD:main');
  g(repo, 'remote', 'set-head', 'origin', 'main');
  g(repo, 'commit', '-qm', 'fixture official transition');
  const preload = join(repo, '.git', 'stop-publication.cjs');
  writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command === 'gh' || (command === 'git' && args.includes('push'))) {
    return { status: 1, stdout: '', stderr: 'FIXTURE reached qualified publication boundary' };
  }
  return original(command, args, options);
};
require('node:module').syncBuiltinESMExports();`);
  const land = () => spawnSync(process.execPath, ['--require', preload, resolve('scripts/land.mjs')],
    { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  const allowed = land();
  expect(allowed.stderr).toContain('FIXTURE reached qualified publication boundary');
  expect(allowed.stderr).not.toContain('different content');
  rmSync(recordPath(repo, b));
  const refused = land();
  expect(refused.stderr).toContain('different content');
  expect(refused.stderr).not.toContain('FIXTURE reached qualified publication boundary');
});

test('a diverged worktree makes the producer abstain from the exception', () => {
  const { repo, b, original } = setup((root) => writeFileSync(join(root, 'sentinel.txt'), 'DIVERGED\n'));
  const record = JSON.parse(readFileSync(recordPath(repo, b), 'utf8'));
  expect(record.preflight.attributable).toBe(false);
  expect(record.suite_transition).toBeUndefined();
  expect(readFileSync(stamps.suiteGreenStampPath(repo), 'utf8')).toBe(original);
  expect(verdict(repo, b).ok).toBe(false);
});
test('complete entry comparison rejects deletion of an empty subtree from A', () => {
  const { repo, a, b } = setup();
  const empty = spawnSync('git', ['mktree'], { cwd: repo, encoding: 'utf8', input: '' }).stdout.trim();
  const from = spawnSync('git', ['mktree'], { cwd: repo, encoding: 'utf8',
    input: `${g(repo, 'ls-tree', a).stdout}040000 tree ${empty}\tempty-original\n` }).stdout.trim();
  const stamp = JSON.parse(readFileSync(stamps.suiteGreenStampPath(repo), 'utf8'));
  stamp.tree = from; stamp.run_evidence.tree_before = from; stamp.run_evidence.tree_after = from;
  const raw = JSON.stringify(stamp); writeFileSync(stamps.suiteGreenStampPath(repo), raw);
  rewriteRecord(repo, b, (r) => {
    r.suite_transition.from_tree = from; r.suite_transition.original_stamp = raw;
    r.suite_transition.original_stamp_sha256 = createHash('sha256').update(raw).digest('hex');
    r.tests_ran.tree = from; r.preflight.staged_tree = from;
    r.preflight.worktree_tree_before = from; r.preflight.worktree_tree_after = from;
  });
  expect(verdict(repo, b).ok).toBe(false);
});

test('complete entry comparison preserves distinct non-UTF8 filename bytes', () => {
  const { repo, a, b } = setup();
  const blob = (text: string) => spawnSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: repo, input: text, encoding: 'utf8' }).stdout.trim();
  const originalBlob = blob('original\n'), changedBlob = blob('changed\n');
  const withNames = (tree: string, firstBlob: string) => {
    const input = Buffer.concat([Buffer.from(g(repo, 'ls-tree', '-z', tree).stdout),
      Buffer.from(`100644 blob ${firstBlob}\t`), Buffer.from([0xfe]), Buffer.from([0]),
      Buffer.from(`100644 blob ${originalBlob}\t`), Buffer.from([0xff]), Buffer.from([0])]);
    return spawnSync('git', ['mktree', '-z'], { cwd: repo, input, encoding: 'utf8' }).stdout.trim();
  };
  const from = withNames(a, originalBlob), to = withNames(b, changedBlob);
  expect(from).toMatch(/^[a-f0-9]{40}$/); expect(to).toMatch(/^[a-f0-9]{40}$/);
  const stamp = JSON.parse(readFileSync(stamps.suiteGreenStampPath(repo), 'utf8'));
  stamp.tree = from; stamp.run_evidence.tree_before = from; stamp.run_evidence.tree_after = from;
  const raw = JSON.stringify(stamp); writeFileSync(stamps.suiteGreenStampPath(repo), raw);
  rewriteRecord(repo, b, (r) => {
    r.staged_tree = to; r.suite_transition.to_tree = to; r.suite_transition.from_tree = from;
    r.suite_transition.original_stamp = raw;
    r.suite_transition.original_stamp_sha256 = createHash('sha256').update(raw).digest('hex');
    r.tests_ran.tree = from; r.preflight.staged_tree = from;
    r.preflight.worktree_tree_before = from; r.preflight.worktree_tree_after = from;
  }, to);
  expect(verdict(repo, to).ok).toBe(false);
});
