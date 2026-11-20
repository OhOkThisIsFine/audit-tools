import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPEN_ITEMS_RELPATH } from "../../scripts/nightly/items.mjs";
import { writeInbox } from "../../scripts/nightly/render-inbox.mjs";

type StoredQueue = { items: unknown[]; applied?: string[]; run?: unknown };

export function writeStoredQueueFixture(root: string, state: StoredQueue) {
  const path = join(root, OPEN_ITEMS_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ generated_at: null, run: null, applied: [], skipped: [], ...state }));
}

/** Load a stored queue fixture and exercise the production projection. */
export function seedStoredQueue(root: string, state: StoredQueue) {
  writeStoredQueueFixture(root, state);
  writeInbox(root);
}
