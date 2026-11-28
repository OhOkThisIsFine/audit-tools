import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { test } from 'node:test';

import { renderGeminiCommandToml } from '../wrapper/remediate-code-wrapper-install-renderers.mjs';
import { normalizeNewlines, splitFrontmatter } from '../wrapper/shared-install-hosts.mjs';

const project = join(import.meta.dirname, '..');

test('generated Gemini recipes keep ensure and next-step rooted in the same repository', async (t) => {
  const canonical = await readFile(join(project, 'skills', 'remediate-code', 'remediate-code.prompt.md'), 'utf8');
  const generated = normalizeNewlines(await readFile(join(project, '.gemini', 'commands', 'remediate-code.toml'), 'utf8'));
  assert.equal(generated, renderGeminiCommandToml(splitFrontmatter(canonical).body));
  const recipes = [...generated.matchAll(/^remediate-code (ensure|next-step)([^\n]*)$/gm)]
    .map(([, command, args]) => [command, args.replaceAll('\\"', '"')]);
  assert.deepEqual(recipes, [
    ['ensure', ' --quiet'],
    ['ensure', ' --quiet --root "<path>"'],
    ['next-step', ''],
    ['next-step', ' --root "<path>"'],
  ]);
  assert.ok(generated.indexOf('Resolve the target repository') < generated.indexOf('remediate-code ensure'));

  const home = await mkdtemp(join(tmpdir(), 'installer-cycle6-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const caller = join(home, 'caller repo');
  const target = join(home, 'target repo');
  const nested = join(caller, 'nested');
  await mkdir(join(caller, '.git'), { recursive: true });
  await mkdir(join(target, '.git'), { recursive: true });
  await mkdir(nested);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };
  function run([command, args]) {
    const argv = [command];
    if (args.includes('--quiet')) argv.push('--quiet');
    if (args.includes('--root "<path>"')) argv.push('--root', target);
    return execFileSync(process.execPath, [join(project, 'remediate-code.mjs'), ...argv], {
      cwd: nested, env, encoding: 'utf8',
    });
  }

  const manifest = (root) => join(root, '.remediate-code', 'install', 'manifest.json');
  const currentStep = (root) => join(root, '.audit-tools', 'remediation', 'steps', 'current-step.json');
  const [insideEnsure, outsideEnsure, insideNext, outsideNext] = recipes;
  assert.equal(run(outsideEnsure), '');
  assert.equal(await readFile(join(target, '.gemini', 'commands', 'remediate-code.toml'), 'utf8'), generated);
  for (const [dir, file] of [['prompts', 'remediate-code.prompt.md'], ['agents', 'remediator.agent.md']]) {
    const checkedIn = await readFile(join(project, '.github', dir, file), 'utf8');
    assert.equal(await readFile(join(target, '.github', dir, file), 'utf8'), normalizeNewlines(checkedIn));
  }
  assert.ok(await readFile(manifest(target), 'utf8'));
  const outsideStep = JSON.parse(run(outsideNext));
  assert.ok(await readFile(outsideStep.prompt_path, 'utf8'));
  assert.equal(normalize(outsideStep.repo_root), target);
  assert.deepEqual(
    JSON.parse(await readFile(currentStep(target), 'utf8')),
    outsideStep,
  );
  await assert.rejects(readFile(manifest(caller)), { code: 'ENOENT' });
  await assert.rejects(readFile(currentStep(caller)), { code: 'ENOENT' });

  assert.equal(run(insideEnsure), '');
  assert.ok(await readFile(manifest(caller), 'utf8'));
  const insideStep = JSON.parse(run(insideNext));
  assert.ok(await readFile(insideStep.prompt_path, 'utf8'));
  assert.equal(normalize(insideStep.repo_root), caller);
});
