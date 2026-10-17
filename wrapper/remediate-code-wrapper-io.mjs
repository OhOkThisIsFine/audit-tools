// sites-pinned: tests/shared/wrapper-io-parity.test.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileExists } from './shared-wrapper-io.mjs';
export {
  fileExists,
  newestMtimeMs,
  readTextIfExists,
  readJson,
  writeGeneratedMarkdown,
  writeGeneratedJson,
  writeMergedGeneratedJson,
} from './shared-wrapper-io.mjs';

export const INSTALL_MARKER_START = '<!-- remediate-code:begin -->';
export const INSTALL_MARKER_END = '<!-- remediate-code:end -->';

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function upsertManagedBlock(existingContent, blockContent) {
  const normalized = normalizeNewlines(existingContent);
  const blockPattern = new RegExp(
    `${INSTALL_MARKER_START}[\\s\\S]*?${INSTALL_MARKER_END}`,
    'u',
  );

  if (blockPattern.test(normalized)) {
    return normalized.replace(blockPattern, blockContent);
  }

  if (normalized.trim().length === 0) {
    return `${blockContent}\n`;
  }

  return `${normalized.replace(/\s+$/u, '')}\n\n${blockContent}\n`;
}

export async function writeManagedMarkdown(targetPath, blockContent) {
  const existed = await fileExists(targetPath);
  const existingContent = existed ? await readFile(targetPath, 'utf8') : '';
  const nextContent = upsertManagedBlock(existingContent, blockContent);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, nextContent, 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}
