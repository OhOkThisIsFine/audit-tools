#!/usr/bin/env node
// sites-pinned: tests/trusted-base-attestation.test.mjs
// Local proof of concept; not a required GitHub check.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ledgerModule = 'scripts/shared/loopCoreAttestationLedger.mjs';
const baseModules = [
  ledgerModule,
  'scripts/shared/primitives.mjs',
  '.claude/hooks/loop-core-patterns.mjs',
];
const ledgerPath = '.claude/loop-core-attestations.json';
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function evaluate(repo, base, head) {
  if (!repo || !oid.test(base) || !oid.test(head) || base.length !== head.length) {
    throw new Error('usage: node <trusted launcher> <operator-controlled repo> <full base commit ID> <full head commit ID>');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'loop-core-base-'));
  try {
    // Git and the object store/config are operator-controlled. Candidate objects
    // may be imported, but never point this at a candidate-supplied .git.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(scratch, 'no-global-config'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    });
    const dir = resolve(repo);
    function git(args) {
      const r = spawnSync('git', ['--no-replace-objects', '-C', dir, ...args], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      });
      if (r.error || r.signal) throw new Error('Git failed while reading committed objects');
      return { ok: r.status === 0, stdout: r.stdout ?? Buffer.alloc(0) };
    }
    for (const value of [base, head]) {
      const exact = git(['rev-parse', '--verify', value + '^{commit}']);
      if (!exact.ok || exact.stdout.toString().trim() !== value) throw new Error('commit identity did not resolve exactly');
      const type = git(['cat-file', '-t', value]);
      if (!type.ok || type.stdout.toString().trim() !== 'commit') throw new Error('base and head must be existing commit objects');
    }
    if (!git(['merge-base', '--is-ancestor', base, head]).ok) {
      throw new Error('head must descend from the designated base');
    }
    const ledger = git(['cat-file', 'blob', head + ':' + ledgerPath]);
    if (!ledger.ok) throw new Error('could not read candidate ledger as a committed blob');
    for (const file of baseModules) {
      const blob = git(['cat-file', 'blob', base + ':' + file]);
      if (!blob.ok) throw new Error('missing trusted evaluator module: ' + file);
      const target = join(scratch, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob.stdout, { flag: 'wx' });
    }
    return import(pathToFileURL(join(scratch, ledgerModule)).href).then(({ verifyLedger }) => {
      const gitForHead = (args) => {
        const key = args.join('\0');
        if (key === ['show', head + ':' + ledgerPath].join('\0')) {
          return { ok: true, stdout: ledger.stdout.toString('utf8') };
        }
        if (key !== ['ls-tree', '-r', '-z', head].join('\0')) {
          throw new Error('base evaluator requires a different Git read contract');
        }
        const tree = git(args);
        return { ok: tree.ok, stdout: tree.stdout.toString('utf8') };
      };
      return verifyLedger({ git: gitForHead, rev: head, concernsBlock: true });
    }).finally(() => rmSync(scratch, { recursive: true, force: true }));
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

const [repo, base, head, ...extra] = process.argv.slice(2);
try {
  if (extra.length) throw new Error('unexpected extra arguments');
  const result = await evaluate(repo, base, head);
  const verdict = result.fault ? 'no-verdict' : result.problems.length ? 'refuse' : 'pass';
  console.log(JSON.stringify({ evaluator: 'designated-base', base, head, verdict, ...result }));
  process.exitCode = verdict === 'pass' ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ evaluator: 'designated-base', base, head, verdict: 'no-verdict', fault: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
