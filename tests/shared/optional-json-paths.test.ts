import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, readNdjsonFile, readOptionalJsonFile, readOptionalNdjsonFile, readOptionalTextFile } from '../../src/shared/io/json.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(readFile).mockClear(); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe('optional JSON and NDJSON path availability', () => {
  it('tolerates missing files and non-directory ancestors only in optional readers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'optional-path-')); roots.push(root);
    const ancestor = join(root, 'file'); await writeFile(ancestor, 'plain file');
    for (const read of [readOptionalJsonFile, readOptionalNdjsonFile, readOptionalTextFile]) {
      await expect(read(join(root, 'missing'))).resolves.toBeUndefined();
      await expect(read(join(ancestor, 'child'))).resolves.toBeUndefined();
    }
    for (const read of [readJsonFile, readNdjsonFile]) {
      await expect(read(join(root, 'missing'))).rejects.toThrow();
      await expect(read(join(ancestor, 'child'))).rejects.toThrow();
    }
  });

  it('preserves directory, parse and permission failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'optional-errors-')); roots.push(root);
    const malformed = join(root, 'bad.json'); await writeFile(malformed, '{');
    for (const read of [readOptionalJsonFile, readOptionalNdjsonFile]) {
      await expect(read(root)).rejects.toThrow();
      await expect(read(malformed)).rejects.toThrow();
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      await expect(read(join(root, 'denied'))).rejects.toThrow('permission denied');
    }
  });
});
