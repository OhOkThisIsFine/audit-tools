import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import * as auditInstaller from '../wrapper/audit-code-wrapper-install-hosts.mjs';
import { findLegacyAuditCodeSurfaceFiles } from '../wrapper/audit-code-wrapper-legacy.mjs';
import { findLegacyRemediateCodeSurfaceFiles } from '../wrapper/remediate-code-wrapper-legacy.mjs';
import { normalizeNewlines, splitFrontmatter } from '../wrapper/shared-install-hosts.mjs';

const project = join(import.meta.dirname, '..');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'installer-cycle6-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };
  return {
    root,
    run(tool, ...args) {
      return execFileSync(process.execPath, [
        join(project, tool + '.mjs'), ...args, '--host', 'antigravity', '--root', root,
      ], { cwd: root, env, encoding: 'utf8' });
    },
  };
}

async function seed(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

for (const [tool, discover] of [
  ['audit-code', findLegacyAuditCodeSurfaceFiles],
  ['remediate-code', findLegacyRemediateCodeSurfaceFiles],
]) {
  test(tool + ' only reports and removes attributable legacy skills', async (t) => {
    const { root, run } = await fixture(t);
    const codex = join(root, '.codex', 'skills', tool, 'SKILL.md');
    const opencode = join(root, '.opencode', 'skills', tool, 'SKILL.md');
    const source = normalizeNewlines(await readFile(join(project, 'skills', tool, 'SKILL.md'), 'utf8'));
    const authored = Buffer.from('---\r\nname: ' + tool + '\r\n---\r\nMy own review instructions.\r\n');
    const modified = Buffer.from(source + '\nA user-added paragraph.\n');

    run(tool, 'ensure', '--quiet');
    await seed(codex, source.replaceAll('\n', '\r\n'));
    await seed(opencode, modified);
    assert.deepEqual(await discover(root), [codex]);
    run(tool, 'ensure', '--quiet');
    await assert.rejects(readFile(codex), { code: 'ENOENT' });
    assert.deepEqual(await readFile(opencode), modified);

    await seed(codex, authored);
    assert.deepEqual(await discover(root), []);
    assert.equal(JSON.parse(run(tool, 'ensure')).action, 'skipped');
    assert.equal(JSON.parse(run(tool, 'verify-install')).status, 'ok');
    // Exercise the removal routine again, not just the skip path.
    run(tool, 'ensure', '--quiet', '--force');
    assert.deepEqual(await readFile(codex), authored);
    assert.deepEqual(await readFile(opencode), modified);
  });
}

test('audit quiet ensure refreshes only-stale Gemini TOML and accepts CRLF equivalence', async (t) => {
  const { root, run } = await fixture(t);
  const tool = 'audit-code';
  const commandPath = join(root, '.gemini', 'commands', 'audit-code.toml');
  const source = await readFile(join(project, 'skills', tool, 'audit-code.prompt.md'), 'utf8');
  const canonical = auditInstaller._renderGeminiCommandToml(splitFrontmatter(source).body);
  run(tool, 'ensure', '--quiet');
  assert.equal(await readFile(commandPath, 'utf8'), canonical);
  assert.equal(await auditInstaller.detectBootstrapRefreshReason(root, 'antigravity'), null);

  await writeFile(commandPath, canonical.replace('prompt =', 'obsolete ='));
  assert.equal(
    await auditInstaller.detectBootstrapRefreshReason(root, 'antigravity'),
    'stale_host_asset:antigravity:geminiCommandPath',
  );
  assert.equal(run(tool, 'ensure', '--quiet'), '');
  assert.equal(await readFile(commandPath, 'utf8'), canonical);
  assert.equal(JSON.parse(run(tool, 'ensure')).action, 'skipped');

  const equivalent = canonical.replaceAll('\n', '\r\n');
  await writeFile(commandPath, equivalent);
  assert.equal(JSON.parse(run(tool, 'ensure')).action, 'skipped');
  assert.equal(await readFile(commandPath, 'utf8'), equivalent);
});
