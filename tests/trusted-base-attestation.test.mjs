import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAttestation, loopCoreBlobs, serializeLedger } from '../scripts/shared/loopCoreAttestationLedger.mjs';

const launcher = fileURLToPath(new URL('../scripts/prototype-base-loop-core-verifier.mjs', import.meta.url));
const ledgerPath = '.claude/loop-core-attestations.json';
const fixturePath = 'src/audit/cli/nextStepCommand.ts';

test('trusted-base prototype binds verdicts to committed fixture identities', () => {
  const repo = mkdtempSync(join(tmpdir(), 'loop-core-prototype-test-'));
  try {
    const git = (args) => {
      const p = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
      return { ok: p.status === 0, stdout: p.stdout, stderr: p.stderr };
    };
    const run = (...args) => {
      const r = git(args);
      assert.ok(r.ok, r.stderr);
      return r.stdout.trim();
    };
    const write = (path, content) => {
      const dest = join(repo, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    };
    const checkpoint = (label) => {
      run('add', '--all');
      run('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks',
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-qm', label);
      return run('rev-parse', 'HEAD');
    };
    const check = (base, head, verdict) => {
      const result = spawnSync(process.execPath, [launcher, repo, base, head], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, verdict === 'pass' ? 0 : 1, result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual([parsed.evaluator, parsed.base, parsed.head, parsed.verdict], ['designated-base', base, head, verdict]);
      return parsed;
    };
    const attest = (previous) => {
      run('add', '--all');
      const blobs = loopCoreBlobs(git);
      const ledger = applyAttestation(previous, blobs, [...blobs.keys()], {
        reviewed_by: 'Fixture reviewer', attester_class: 'human', checked: 'Read the fixture changes',
        verdict: 'clear', override: null, attested_at: '2026-10-01T00:00:00.000Z',
      });
      write(ledgerPath, serializeLedger(ledger));
      return ledger;
    };

    run('init', '-q');
    for (const path of ['scripts/shared/loopCoreAttestationLedger.mjs', 'scripts/shared/primitives.mjs', '.claude/hooks/loop-core-patterns.mjs']) {
      const dest = join(repo, path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(new URL('../' + path, import.meta.url), dest);
    }
    write(fixturePath, 'export const fixtureValue = 1;\n');
    const initialLedger = attest(null);
    const base = checkpoint('trusted baseline');
    write('README.md', 'Benign documentation.\n');
    const docs = checkpoint('documentation');
    assert.equal(check(base, docs, 'pass').reviewed, 3);
    write(fixturePath, 'export const fixtureValue = 2;\n');
    const changed = checkpoint('ordinary code change without review');
    assert.match(check(base, changed, 'refuse').problems.join('\n'), /content is not the attested content/);
    attest(initialLedger);
    const reviewed = checkpoint('ordinary code change reviewed');
    assert.equal(check(base, reviewed, 'pass').reviewed, 3);
    write(ledgerPath, 'malformed fixture');
    const malformed = checkpoint('malformed ledger');
    assert.match(check(base, malformed, 'refuse').problems.join('\n'), /unreadable/);
    assert.equal(check(base, reviewed, 'pass').reviewed, 3);
    assert.match(check(reviewed, base, 'no-verdict').fault, /descend/);
    assert.match(check(base, 'HEAD', 'no-verdict').fault, /full head commit ID/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
