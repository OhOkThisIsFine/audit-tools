// sites-pinned: tests/shared/stored-nightly-queue.test.ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Publish complete bytes so an interrupted write leaves the old file readable. */
export function writeQueueFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
