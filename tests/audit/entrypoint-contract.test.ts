import { test, expect } from "vitest";
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

async function readText(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), 'utf8');
}

test('package bin points audit-code at the wrapper entrypoint', async () => {
  const packageJson = JSON.parse(await readText('package.json'));
  expect(packageJson.bin['audit-code']).toBe('audit-code.mjs');
});

test('product docs consistently present /audit-code as the canonical surface', async () => {
  const readme = await readText('README.md');
  const productDirection = await readText('docs/audit-pkg/product.md');
  const skill = await readText('skills/audit-code/SKILL.md');
  const prompt = await readText('skills/audit-code/audit-code.prompt.md');

  // Structural keyword checks rather than exact-prose literals, so doc copy
  // edits don't break the contract. Every doc must still present the canonical
  // /audit-code surface.
  for (const content of [readme, productDirection, skill]) {
    expect(content.includes('/audit-code')).toBeTruthy();
  }

  // Conversational slash-command usage is documented (concept, not a specific
  // heading string — the README's own section names have changed before).
  expect(readme.toLowerCase().includes('slash-command')).toBeTruthy();
  // The CLI is documented as a backend/fallback, not the primary product surface.
  expect(readme.toLowerCase().includes('backend') && readme.toLowerCase().includes('fallback')).toBeTruthy();
  const productDirectionLower = productDirection.toLowerCase();
  expect(productDirectionLower.includes('backend infrastructure')).toBeTruthy();
  expect(productDirectionLower.includes('repo-local') && productDirectionLower.includes('fallback')).toBeTruthy();
  const skillLower = skill.toLowerCase();
  expect(skillLower.includes('canonical entrypoint') && skill.includes('/audit-code')).toBeTruthy();
  expect(skillLower.includes("host's native subagent facilities")).toBeTruthy();
  expect(skillLower.includes('do not invent a smaller task') && skillLower.includes('alternate execution path')).toBeTruthy();
  // The prompt must document both invocation commands and the two stable
  // behavioral instructions (follow only the returned step; stop when told),
  // matched on durable keywords instead of whole sentences.
  expect(prompt.includes('audit-code ensure --quiet')).toBeTruthy();
  expect(prompt.includes('audit-code next-step')).toBeTruthy();
  expect(prompt.includes('follow only that prompt')).toBeTruthy();
  expect(prompt.includes('Stop when')).toBeTruthy();
});
