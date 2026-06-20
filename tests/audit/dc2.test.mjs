import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// DC-2 — shared, session-scoped provider confirmation (Gate-0).
//
// The first tool (audit) writes ONE confirmation to the SHARED location
// `<root>/.audit-tools/provider-confirmation.json`; the second tool (remediate)
// reads + honors it. The accessor is THREE-valued (CE-012):
//   - absent / malformed → null (INV-DC1-6 never-block: self-resolve)
//   - present + roster fresh → { status: 'confirmed' } (honor)
//   - present + roster stale → { status: 'reconfirm' } (INV-DC2-3 re-confirm)
// Writes are atomic temp-then-rename under withFileLock, so a lockless reader
// never observes a torn file (CE-003).
// ---------------------------------------------------------------------------

const {
  SHARED_PROVIDER_CONFIRMATION_VERSION,
  SHARED_PROVIDER_CONFIRMATION_FILENAME,
  sharedProviderConfirmationPath,
  currentProviderRoster,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readSharedProviderConfirmation,
} = await import("audit-tools/shared");

const { runProviderConfirmationAutoComplete } = await import(
  "../../src/audit/orchestrator/intakeExecutors.ts"
);

// A clean env with no CLAUDECODE/CODEX so the self-spawn guard never perturbs
// the discovered roster (CLAUDECODE=1 in a Claude session would otherwise change
// it — the audit-code CLAUDECODE test gotcha).
const CLEAN_ENV = {};

async function withTempRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dc2-shared-conf-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── path + stamps ───────────────────────────────────────────────────────────

await test("the shared artifact lives at <root>/.audit-tools/provider-confirmation.json", () => {
  const p = sharedProviderConfirmationPath("/repo");
  assert.match(p.replace(/\\/g, "/"), /\/repo\/\.audit-tools\/provider-confirmation\.json$/);
  assert.equal(SHARED_PROVIDER_CONFIRMATION_FILENAME, "provider-confirmation.json");
});

await test("a built confirmation stamps schema_version / session_level / confirmed_at and the roster", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  assert.equal(built.schema_version, SHARED_PROVIDER_CONFIRMATION_VERSION);
  assert.equal(built.session_level, true);
  assert.ok(Date.parse(built.confirmed_at) > 0, "confirmed_at is an ISO-8601 timestamp");
  assert.ok(Array.isArray(built.roster), "carries a roster snapshot");
  assert.ok(Array.isArray(built.provider_pool), "carries a provider pool");
  // The roster is sorted + de-duplicated.
  assert.deepEqual([...built.roster].sort(), built.roster);
});

await test("local-subprocess fallback is always present in the pool (it is never PATH-detected)", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const local = built.provider_pool.find((e) => e.name === "local-subprocess");
  assert.ok(local, "local-subprocess is always in the confirmed pool");
  // It is the always-available fallback, not part of the discovered roster.
  assert.ok(!built.roster.includes("local-subprocess"), "local-subprocess is not in the PATH roster");
});

// ── cross-tool honor: audit writes, remediate-side reads the same pool ───────

await test("cross-tool honor: a confirmation written by audit is read + honored verbatim", async () => {
  await withTempRoot(async (root) => {
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    await writeSharedProviderConfirmation(root, built);

    const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.ok(read, "a written confirmation is read back, not null");
    assert.equal(read.status, "confirmed", "matching roster → confirmed (honored)");
    // Compare against the JSON-normalized form: writeJsonFile drops keys whose
    // value is `undefined` (a `reason: undefined` entry round-trips without the
    // key), so the durable artifact is the JSON projection of the built pool.
    const persisted = JSON.parse(JSON.stringify(built));
    assert.deepEqual(read.confirmation.provider_pool, persisted.provider_pool);
    assert.deepEqual(read.confirmation.roster, persisted.roster);
    assert.equal(read.confirmation.session_level, true);
  });
});

await test("audit's provider-confirmation executor WRITES the shared artifact when root is known", async () => {
  await withTempRoot(async (root) => {
    const result = await runProviderConfirmationAutoComplete({}, root);
    assert.ok(
      result.artifacts_written.includes("provider-confirmation.json"),
      "the shared artifact is reported as written",
    );
    // The file is on disk and re-reads as a valid confirmation.
    const onDisk = JSON.parse(
      await readFile(sharedProviderConfirmationPath(root), "utf8"),
    );
    assert.equal(onDisk.schema_version, SHARED_PROVIDER_CONFIRMATION_VERSION);
    assert.equal(onDisk.session_level, true);
    const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.ok(read && read.status === "confirmed");
  });
});

await test("audit's executor without a root does NOT write the shared artifact (headless, root-less)", async () => {
  await withTempRoot(async (root) => {
    const result = await runProviderConfirmationAutoComplete({});
    assert.ok(!result.artifacts_written.includes("provider-confirmation.json"));
    // Nothing was written under root.
    const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.equal(read, null);
  });
});

// ── absent / malformed → null (INV-DC1-6 never-block) ────────────────────────

await test("absent artifact → null (never-block: remediate self-resolves)", async () => {
  await withTempRoot(async (root) => {
    const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.equal(read, null);
  });
});

await test("malformed artifacts → null (never-block, never throws)", async () => {
  await withTempRoot(async (root) => {
    const p = sharedProviderConfirmationPath(root);
    await mkdir(join(root, ".audit-tools"), { recursive: true });

    const malformedCases = [
      "not json at all {{{",
      JSON.stringify({}), // missing required fields
      JSON.stringify({ schema_version: "9.9.9", session_level: true, confirmed_at: "x", provider_pool: [], roster: [] }), // version drift
      JSON.stringify({ schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION, session_level: false, confirmed_at: "x", provider_pool: [], roster: [] }), // session_level not true
      JSON.stringify({ schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION, session_level: true, confirmed_at: "x", provider_pool: "nope", roster: [] }), // pool wrong type
      JSON.stringify([1, 2, 3]), // array, not object
    ];

    for (const body of malformedCases) {
      await writeFile(p, body, "utf8");
      const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
      assert.equal(read, null, `malformed body should read as null: ${body.slice(0, 40)}`);
    }
  });
});

// ── roster-stale → reconfirm (INV-DC2-3 / CE-012 third state) ────────────────

await test("roster-stale → a DISTINCT reconfirm signal (not null, not confirmed)", async () => {
  await withTempRoot(async (root) => {
    // Write a valid confirmation whose stored roster deliberately differs from
    // the current discovered roster (a provider that has since 'disappeared').
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    const stale = {
      ...built,
      roster: [...new Set([...built.roster, "openai-compatible"])].sort(),
    };
    // Guard: the perturbed roster must actually differ from the current one for
    // this env, otherwise the test would be vacuous.
    const current = currentProviderRoster({}, CLEAN_ENV);
    assert.notDeepEqual(stale.roster, current, "stored roster must differ from current");

    await writeSharedProviderConfirmation(root, stale);
    const read = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.ok(read, "stale confirmation is not null");
    assert.equal(read.status, "reconfirm", "roster change → reconfirm");
    assert.ok(typeof read.reason === "string" && read.reason.length > 0, "carries a reason");
    // The third state is DISTINCT from both null and 'confirmed'.
    assert.notEqual(read.status, "confirmed");
    assert.notEqual(read, null);
    // The stale confirmation is still surfaced (so a caller can diff it).
    assert.deepEqual(read.confirmation.roster, stale.roster);
  });
});

await test("CE-012: roster-stale is distinguishable from absent — they return different shapes", async () => {
  await withTempRoot(async (root) => {
    // Absent → null.
    assert.equal(await readSharedProviderConfirmation(root, {}, CLEAN_ENV), null);

    // Present-but-stale → object with status:'reconfirm'.
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    await writeSharedProviderConfirmation(root, {
      ...built,
      roster: [...new Set([...built.roster, "openai-compatible"])].sort(),
    });
    const stale = await readSharedProviderConfirmation(root, {}, CLEAN_ENV);
    assert.notEqual(stale, null, "stale is NOT collapsed into the never-block null");
    assert.equal(stale.status, "reconfirm");
  });
});

// ── PB-1: opencode opt-in is inherited from discoverProviders ────────────────

await test("PB-1: a bare-PATH opencode is NOT in the roster unless explicitly configured", () => {
  // Without opencode config, opencode must never be surfaced into the roster
  // (discoverProviders withholds a bare-PATH opencode). With a configured
  // command it would be eligible. We assert the opt-in direction holds for the
  // unconfigured case regardless of whether opencode is on PATH.
  const unconfigured = currentProviderRoster({}, CLEAN_ENV);
  assert.ok(!unconfigured.includes("opencode"), "bare-PATH opencode is opt-in, not in the roster");
});

// ── CE-003: concurrent-writer torn read ──────────────────────────────────────

await test("CE-003: a lockless read never observes a torn file under a concurrent writer", async () => {
  await withTempRoot(async (root) => {
    // Seed a valid confirmation so the very first reads always have a complete
    // file to observe.
    const base = buildSharedProviderConfirmation({}, CLEAN_ENV);
    await writeSharedProviderConfirmation(root, base);

    // Drive many sequential atomic overwrites through the real API while a burst
    // of LOCKLESS reads runs concurrently. The writes deliberately vary in byte
    // length (a growing pad) so a torn write — old prefix + new suffix — would
    // parse as invalid JSON (→ null) or a wrong shape; the atomic temp-then-
    // rename guarantees every read instead sees one whole file. Writes go one at
    // a time (await in a loop) so the single lock is never starved — CE-003 is
    // about reader-vs-writer atomicity (the rename), proven by overlapping the
    // read burst with the rename stream, not by writer-vs-writer contention.
    const confFor = (i) => ({
      ...base,
      confirmed_at: new Date(Date.now() + i).toISOString(),
      provider_pool: [
        ...base.provider_pool,
        ...Array.from({ length: i }, (_, k) => ({
          name: "local-subprocess",
          capability_tier: "unknown",
          excluded: false,
          reason: `pad-${k}-${"x".repeat(k * 8)}`,
        })),
      ],
    });

    // Each lockless read re-derives the roster (PATH probes), so keep the counts
    // modest — atomicity is a deterministic OS-rename property, not a flaky race
    // that needs thousands of iterations to surface.
    const writeStorm = (async () => {
      for (let i = 1; i <= 15; i++) {
        await writeSharedProviderConfirmation(root, confFor(i));
      }
    })();

    const readers = [];
    for (let i = 0; i < 60; i++) {
      readers.push(readSharedProviderConfirmation(root, {}, CLEAN_ENV));
    }

    const [, ...readResults] = await Promise.all([writeStorm, ...readers]);

    for (const r of readResults) {
      assert.notEqual(r, null, "no read saw a torn/invalid file (would parse to null)");
      assert.equal(r.status, "confirmed", "every read observed a complete, fresh-roster confirmation");
      assert.equal(r.confirmation.schema_version, SHARED_PROVIDER_CONFIRMATION_VERSION);
      assert.equal(r.confirmation.session_level, true);
    }
  });
});
