/**
 * brokered-dispatch-no-disk-io.test.mjs — the broker performs NO disk I/O.
 *
 * WHY THIS IS PINNED. `persistPoolCooldownBestEffort` used to write the cooldown to
 * durable quota state as a "best-effort durability layer". It did three things that
 * are individually reasonable and jointly a data-corruption bug:
 *
 *   1. it captured its LOCK path synchronously, from the state dir current at the
 *      moment it was called;
 *   2. it resolved the READ and WRITE targets LATE, inside the async body, via the
 *      module-global `getQuotaStatePath()`;
 *   3. it ran UNAWAITED (`void withFileLock(...)`), so it outlived its caller.
 *
 * So when anything called `setQuotaStateDir` while a write was in flight — which a
 * test suite does routinely between cases — it held a lock on the OLD file and
 * rewrote the NEW one, silently clobbering an entry that belonged to a different
 * run. It was diagnosed from a suite flake that only ever reproduced under full-suite
 * load: `tests/remediate/wave-scheduler.test.ts` drives the broker with
 * `providerName: "claude-code"`, whose pool key is `claude-code/*` — byte-identical
 * to the key a later test in the same file writes its own entry under.
 *
 * The fix was to delete the write, not to make it safe: the in-process registry is
 * already described in the module as "the authoritative readback", and the durability
 * the write claimed had no consumer.
 *
 * This test pins the ABSENCE structurally, because absence is what regresses
 * silently. A future "just persist it best-effort" will reintroduce the import, and
 * that is the thing to catch.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = readFileSync(join(REPO_ROOT, "src/shared/repair/brokeredDispatch.ts"), "utf8");

// Strip comments — the module deliberately NAMES these symbols in prose to explain
// why they are absent, and that explanation must not trip the assertions below.
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("the broker imports nothing from the quota-state or file-lock modules", () => {
  // A VALUE import from either is the shape the deleted write had. The type-only
  // `QuotaStateEntry` import is fine and deliberately still allowed: a type cannot
  // perform I/O.
  const valueImports = [...CODE.matchAll(/^\s*import\s+(?!type\b)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm)];
  const offenders = valueImports.filter(([, clause, spec]) => {
    if (!spec || !/quota\/(state|fileLock)\.js$/.test(spec)) return false;
    // `import { type X } from ...` is a type-only member list; allow it.
    const members = (clause ?? "").replace(/[{}]/g, "").split(",").map((m) => m.trim()).filter(Boolean);
    return members.some((m) => !m.startsWith("type "));
  });
  expect(
    offenders.map(([, , spec]) => spec),
    "brokeredDispatch must not import a runtime symbol from quota/state or quota/fileLock — " +
      "that is how the clobbering background write returns",
  ).toEqual([]);
});

test("the broker calls no file-lock, quota-state write, or unawaited promise", () => {
  for (const banned of ["withFileLock", "writeQuotaState", "readQuotaStateForUpdate", "getQuotaStatePath"]) {
    expect(CODE.includes(banned), `${banned} must not appear in broker code`).toBe(false);
  }
});

test("the broker fires no floating promise", () => {
  // `void <expr>(` is the exact shape that let the write outlive its caller. A
  // floating promise here is the mechanism, independent of which API it calls.
  expect(
    /\bvoid\s+\w+\s*\(/.test(CODE),
    "a floating `void fn(...)` call outlives its caller — that lifetime is the defect",
  ).toBe(false);
});
