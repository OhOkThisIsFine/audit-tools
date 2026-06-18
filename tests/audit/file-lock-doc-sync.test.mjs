import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Lockstep guard: the file-lock description in CLAUDE.md must stay in step with
// the actual backoff/stale constants in the single source of truth
// (`audit-tools/shared` `quota/fileLock.ts`). The constants are read from the
// source text (RETRY_INTERVAL_INITIAL_MS / RETRY_INTERVAL_MAX_MS are module-
// private, STALE_LOCK_MS is exported) so the test needs no new exports and tracks
// the real values. This closes the drift that left the doc claiming a stale
// "20ms initial backoff, 250ms max, 20 retries" long after the lock moved to the
// shared exponential 50ms->500ms backoff with a 30s stale window.

const here = dirname(fileURLToPath(import.meta.url));
// tests/audit/ -> repo root
const repoRoot = join(here, "..", "..");
const claudeMdPath = join(repoRoot, "CLAUDE.md");
const fileLockSrcPath = join(repoRoot, "src", "shared", "quota", "fileLock.ts");

function readNumericConst(src, name) {
  // Matches e.g. `const RETRY_INTERVAL_INITIAL_MS = 50;` and
  // `export const STALE_LOCK_MS = 30_000;` — underscores stripped for Number().
  const m = src.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`));
  assert.ok(m, `Could not find numeric constant ${name} in fileLock.ts`);
  return Number(m[1].replace(/_/g, ""));
}

test("CLAUDE.md file-lock description matches the shared withFileLock constants", async () => {
  const [claudeMd, fileLockSrc] = await Promise.all([
    readFile(claudeMdPath, "utf8"),
    readFile(fileLockSrcPath, "utf8"),
  ]);

  const initialMs = readNumericConst(fileLockSrc, "RETRY_INTERVAL_INITIAL_MS");
  const maxMs = readNumericConst(fileLockSrc, "RETRY_INTERVAL_MAX_MS");
  const staleMs = readNumericConst(fileLockSrc, "STALE_LOCK_MS");

  // Sanity-check we parsed the live values (guards against a regex that silently
  // matched the wrong literal).
  assert.equal(initialMs, 50, "Expected RETRY_INTERVAL_INITIAL_MS === 50 in fileLock.ts");
  assert.equal(maxMs, 500, "Expected RETRY_INTERVAL_MAX_MS === 500 in fileLock.ts");
  assert.equal(staleMs, 30_000, "Expected STALE_LOCK_MS === 30000 in fileLock.ts");

  // Locate the single sentence in CLAUDE.md that documents store.ts's lock.
  const lockLine = claudeMd
    .split(/\r?\n/)
    .find((line) => line.includes("withFileLock") && line.includes("backoff"));
  assert.ok(
    lockLine,
    "Could not find the file-lock description sentence in CLAUDE.md (expected a line mentioning `withFileLock` and `backoff`)",
  );

  // doc == code: the exact backoff window and stale threshold appear in the doc.
  assert.ok(
    lockLine.includes(`${initialMs}ms`),
    `CLAUDE.md lock description must state the ${initialMs}ms initial backoff (from RETRY_INTERVAL_INITIAL_MS). Line: ${lockLine}`,
  );
  assert.ok(
    lockLine.includes(`${maxMs}ms`),
    `CLAUDE.md lock description must state the ${maxMs}ms max backoff (from RETRY_INTERVAL_MAX_MS). Line: ${lockLine}`,
  );
  const staleSeconds = staleMs / 1000;
  assert.ok(
    lockLine.includes(`${staleSeconds}s`),
    `CLAUDE.md lock description must state the ${staleSeconds}s stale-lock window (from STALE_LOCK_MS). Line: ${lockLine}`,
  );

  // Negative guard: the stale "20ms / 250ms / 20 retries" wording must never
  // creep back anywhere in CLAUDE.md.
  assert.ok(
    !/20ms initial backoff|250ms max|20 retries/.test(claudeMd),
    "CLAUDE.md still contains the stale '20ms/250ms/20 retries' lock wording; it must describe the shared withFileLock constants instead",
  );

  // The doc must also keep recording that store.ts adds no backoff of its own —
  // the durable invariant the single-sourcing established.
  assert.ok(
    /store\.ts`? adds no backoff/i.test(claudeMd),
    "CLAUDE.md must state that store.ts adds no backoff/retry logic of its own (the lock is single-sourced in shared)",
  );
});
