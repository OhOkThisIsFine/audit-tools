import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

async function readText(relativePath) {
  return await readFile(join(repoRoot, relativePath), 'utf8');
}

test('package bin points audit-code at the wrapper entrypoint', async () => {
  const packageJson = JSON.parse(await readText('package.json'));
  assert.equal(packageJson.bin['audit-code'], 'audit-code.mjs');
});

test('product docs consistently present /audit-code as the canonical surface', async () => {
  const readme = await readText('README.md');
  const productDirection = await readText('docs/product.md');
  const skill = await readText('skills/audit-code/SKILL.md');
  const prompt = await readText('skills/audit-code/audit-code.prompt.md');

  for (const content of [readme, productDirection, skill]) {
    assert.ok(content.includes('/audit-code'));
    assert.ok(
      content.includes(
        'advance the audit automatically until it completes or no further automatic progress is possible',
      ),
    );
  }

  assert.ok(readme.includes('Conversation Setup'));
  assert.ok(readme.includes('Repo-Local Backend Fallback'));
  assert.ok(productDirection.toLowerCase().includes('repo-local fallback'));
  assert.ok(skill.includes('conversational product surface first'));
  assert.ok(skill.includes('explicit user authorization to fan out'));
  assert.ok(skill.includes('probe alternate'));
  assert.ok(prompt.includes('audit-code ensure --quiet'));
  assert.ok(prompt.includes('audit-code next-step'));
  assert.ok(prompt.includes('follow only that prompt'));
  assert.ok(prompt.includes('Stop when the current step prompt tells you to stop'));
  assert.ok(!prompt.includes('prepare a dispatch plan by default'));
  assert.ok(!prompt.includes('choose the first pending task by array order only'));
});
