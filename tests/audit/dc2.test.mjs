import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// DC-2 — shared, session-scoped provider confirmation (Gate-0).
//
// The first tool (audit) writes ONE route DECISION to the SHARED location
// `<root>/.audit-tools/provider-confirmation.json`; the second tool (remediate)
// reads + honors it. The accessor is TWO-valued:
//   - absent / malformed → null (INV-DC1-6 never-block: self-resolve)
//   - present           → the parsed decision (honor)
//
// G3: the read is REACH-FREE. The former roster-staleness check (and its CE-012
// three-valued `reconfirm`) is gone — it compared the WRITING auditor's roster
// against the reader's, which is meaningless cross-auditor, and answered a real
// event by silently discarding the operator's cost order + λ. INV-DC2-3's real
// property — a backend the operator never confirmed must NOT be silently honored
// — now lives in the reconciliation gate (`computeNewlyReachableBackends`), which
// compares the DECISION against THIS auditor's reach. Those tests are below.
//
// Writes are atomic temp-then-rename under withFileLock, so a lockless reader
// never observes a torn file (CE-003).
// ---------------------------------------------------------------------------

const {
  SHARED_PROVIDER_CONFIRMATION_VERSION,
  SHARED_PROVIDER_CONFIRMATION_FILENAME,
  sharedProviderConfirmationPath,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readSharedProviderConfirmation,
  computeNewlyReachableBackends,
  confirmedBackendKeys,
} = await import("audit-tools/shared");

const { runProviderConfirmationAutoComplete } = await import(
  "../../src/audit/orchestrator/intakeExecutors.ts"
);

// A clean env with no CLAUDECODE/CODEX so the self-spawn guard never perturbs
// discovery (CLAUDECODE=1 in a Claude session would otherwise change it — the
// audit-code CLAUDECODE test gotcha).
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
  expect(p.replace(/\\/g, "/")).toMatch(/\/repo\/\.audit-tools\/provider-confirmation\.json$/);
  expect(SHARED_PROVIDER_CONFIRMATION_FILENAME).toBe("provider-confirmation.json");
});

await test("a built confirmation stamps schema_version / session_level / confirmed_at", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  expect(built.schema_version).toBe(SHARED_PROVIDER_CONFIRMATION_VERSION);
  expect(built.session_level).toBe(true);
  expect(Date.parse(built.confirmed_at) > 0, "confirmed_at is an ISO-8601 timestamp").toBeTruthy();
  expect(Array.isArray(built.provider_pool), "carries a provider pool").toBeTruthy();
});

// G3: the persisted shape carries POLICY, not the writing auditor's reach. The
// roster snapshot was exactly that inherited-reach field, so its absence is the
// contract now — a re-added `roster` would resurrect the cross-auditor comparison
// the gate replaced.
await test("G3: a built confirmation carries NO roster snapshot (reach is never persisted)", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  expect(built.roster, "the writing auditor's reach must not be persisted").toBe(undefined);
});

await test("worker-command fallback is always present in the pool (it is never PATH-detected)", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const local = built.provider_pool.find((e) => e.name === "worker-command");
  expect(local, "worker-command is always in the confirmed pool").toBeTruthy();
});

// ── cross-tool honor: audit writes, remediate-side reads the same pool ───────

await test("cross-tool honor: a confirmation written by audit is read + honored verbatim", async () => {
  await withTempRoot(async (root) => {
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    await writeSharedProviderConfirmation(root, built);

    const read = await readSharedProviderConfirmation(root);
    expect(read, "a written confirmation is read back, not null").toBeTruthy();
    // Compare against the JSON-normalized form: writeJsonFile drops keys whose
    // value is `undefined` (a `reason: undefined` entry round-trips without the
    // key), so the durable artifact is the JSON projection of the built pool.
    const persisted = JSON.parse(JSON.stringify(built));
    expect(read.provider_pool).toEqual(persisted.provider_pool);
    expect(read.session_level).toBe(true);
  });
});

await test("audit's provider-confirmation executor WRITES the shared artifact when root is known", async () => {
  await withTempRoot(async (root) => {
    const result = await runProviderConfirmationAutoComplete({}, root);
    expect(result.artifacts_written.includes("provider-confirmation.json"), "the shared artifact is reported as written").toBeTruthy();
    // The file is on disk and re-reads as a valid confirmation.
    const onDisk = JSON.parse(
      await readFile(sharedProviderConfirmationPath(root), "utf8"),
    );
    expect(onDisk.schema_version).toBe(SHARED_PROVIDER_CONFIRMATION_VERSION);
    expect(onDisk.session_level).toBe(true);
    expect(await readSharedProviderConfirmation(root)).toBeTruthy();
  });
});

// 2a-ii (adversarial-review Finding A): the executor CONSUMES + PERSISTS the routed
// pool, so it must build from the EFFECTIVE dispatch config (the per-auditor handshake
// inventory threaded in as the 4th arg) — NOT a re-read of the repo session-config,
// which would persist another auditor's backends into the shared, session-level pool.
await test("the executor persists from the EFFECTIVE config, not a disk re-read (no cross-contamination)", async () => {
  await withTempRoot(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    // Repo config on disk carries a source the current auditor did NOT report.
    // (`id` becomes the durable source_id in the persisted cost order.)
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({
        sources: [{ id: "repo-disk-src", transport: "openai-compatible", endpoint: "https://d/v1", model: "m", api_key: "public", cost_per_mtok: 1 }],
      }),
    );
    // The per-auditor handshake inventory (effective config) reports a DIFFERENT source.
    const effectiveConfig = {
      sources: [{ id: "handshake-src", transport: "openai-compatible", endpoint: "https://h/v1", model: "m", api_key: "public", cost_per_mtok: 1 }],
    };
    await runProviderConfirmationAutoComplete({}, root, artifactsDir, effectiveConfig);
    const persisted = await readFile(sharedProviderConfirmationPath(root), "utf8");
    expect(persisted, "the handshake source is what routes").toContain("handshake-src");
    expect(persisted, "the repo-disk source must NOT leak into the persisted pool").not.toContain("repo-disk-src");
  });
});

// G2: dispatch sources are UNREPRESENTABLE on the repo config (the validator rejects
// them at load). With no effective config threaded (the legacy headless advance-audit
// entrypoint, which carries no handshake), the fallback resolves the repo INTENT to
// driver-self-only — so a repo config can no longer leak dispatch sources into the
// persisted pool. (This is the structural guarantee that replaced the old
// repo-config-is-the-fallback behavior.)
await test("without an effective config the fallback is driver-self-only — repo dispatch sources cannot leak", async () => {
  await withTempRoot(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    // A repo config carrying dispatch sources is now INVALID (rejected at load); the
    // executor's fallback swallows the load error and resolves to driver-self-only.
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({
        sources: [{ id: "repo-disk-src", transport: "openai-compatible", endpoint: "https://d/v1", model: "m", api_key: "public", cost_per_mtok: 1 }],
      }),
    );
    await runProviderConfirmationAutoComplete({}, root, artifactsDir);
    const persisted = await readFile(sharedProviderConfirmationPath(root), "utf8");
    expect(persisted, "repo dispatch sources cannot be persisted, so none leak into the pool").not.toContain("repo-disk-src");
  });
});

await test("audit's executor without a root does NOT write the shared artifact (headless, root-less)", async () => {
  await withTempRoot(async (root) => {
    const result = await runProviderConfirmationAutoComplete({});
    expect(!result.artifacts_written.includes("provider-confirmation.json")).toBeTruthy();
    // Nothing was written under root.
    expect(await readSharedProviderConfirmation(root)).toBe(null);
  });
});

// ── absent / malformed → null (INV-DC1-6 never-block) ────────────────────────

await test("absent artifact → null (never-block: remediate self-resolves)", async () => {
  await withTempRoot(async (root) => {
    expect(await readSharedProviderConfirmation(root)).toBe(null);
  });
});

await test("malformed artifacts → null (never-block, never throws)", async () => {
  await withTempRoot(async (root) => {
    const p = sharedProviderConfirmationPath(root);
    await mkdir(join(root, ".audit-tools"), { recursive: true });

    const malformedCases = [
      "not json at all {{{",
      JSON.stringify({}), // missing required fields
      JSON.stringify({ schema_version: "9.9.9", session_level: true, confirmed_at: "x", provider_pool: [] }), // version drift
      JSON.stringify({ schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION, session_level: false, confirmed_at: "x", provider_pool: [] }), // session_level not true
      JSON.stringify({ schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION, session_level: true, confirmed_at: "x", provider_pool: "nope" }), // pool wrong type
      JSON.stringify([1, 2, 3]), // array, not object
    ];

    for (const body of malformedCases) {
      await writeFile(p, body, "utf8");
      const read = await readSharedProviderConfirmation(root);
      expect(read, `malformed body should read as null: ${body.slice(0, 40)}`).toBe(null);
    }
  });
});

// G3: a confirmation WITHOUT a roster must parse. The old parser hard-required the
// field, so this is the pin that the required-field gate really went with it —
// otherwise every post-G3 confirmation would fail its own reader and degrade to
// "absent" (empty cost positions, λ=0) silently.
await test("G3: a roster-less confirmation parses (the required-field gate is gone)", async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, ".audit-tools"), { recursive: true });
    await writeFile(
      sharedProviderConfirmationPath(root),
      JSON.stringify({
        schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
        session_level: true,
        confirmed_at: new Date().toISOString(),
        provider_pool: [{ name: "worker-command", capability_tier: "unknown", excluded: false }],
      }),
      "utf8",
    );
    const read = await readSharedProviderConfirmation(root);
    expect(read, "no roster field ⇒ still a valid decision").toBeTruthy();
    expect(read.provider_pool).toHaveLength(1);
  });
});

// ── G3: the reconciliation gate (replaces roster-staleness) ──────────────────

// The CONFIRMED half. All three pools contribute, and each is load-bearing:
// `annotateConfirmedPool` folds a source away when a provider entry already claims
// its model, so a source can be represented ONLY by provider_pool[].model_id.
await test("G3: confirmed keys span provider_pool + source_pool_cost_order + host_model_cost_order", () => {
  const keys = confirmedBackendKeys({
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: [
      { name: "worker-command", capability_tier: "unknown", excluded: false },
      { name: "openai-compatible", capability_tier: "capable", excluded: false, model_id: "cfg-model" },
    ],
    source_pool_cost_order: [
      { source_id: "s1", transport: "codex", model_id: "src-model", blended_price_usd_per_mtok: null, cost_order: 0 },
    ],
    host_model_cost_order: [
      { model_id: "host-model", provider: "claude-code", blended_price_usd_per_mtok: null, cost_order: 1 },
    ],
  });
  // `(service ?? transport):model` where the model is knowable, else the
  // coarse provider name.
  expect([...keys].sort()).toEqual(
    ["claude-code:host-model", "codex:src-model", "openai-compatible:cfg-model", "worker-command"],
  );
});

// The fail-SAFE half of the host-tier rule: a confirmation written before
// HostModelCostEntry carried a provider cannot say WHICH backend the operator
// confirmed, so it contributes no key at all. Falling back to the bare model id is
// precisely the bypass — it would approve any identically-named model on any
// provider. Contributing nothing can only make the gate ASK again.
await test("G3: a host tier with no recorded provider contributes NO confirmed key", () => {
  const keys = confirmedBackendKeys({
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: [],
    host_model_cost_order: [
      { model_id: "legacy-host-model", blended_price_usd_per_mtok: null, cost_order: 0 },
    ],
  });
  expect([...keys]).toEqual([]);
});

await test("G3: a backend the operator confirmed produces an EMPTY delta (no phantom re-prompt)", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const delta = computeNewlyReachableBackends(built, {}, [], CLEAN_ENV);
  expect(delta, "reach == what was just confirmed ⇒ nothing to reconcile").toEqual([]);
});

// The gate's REASON TO EXIST: a source that is reachable now but absent from the
// decision must surface — this is what the roster check answered by silently
// discarding the operator's cost order instead.
await test("G3: a newly-reachable SOURCE appears in the delta, keyed by its model", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const delta = computeNewlyReachableBackends(
    built,
    {},
    [{ id: "new-nim", transport: "openai-compatible", endpoint: "https://x/v1", model: "brand-new-model" }],
    CLEAN_ENV,
  );
  // A″: the backend carries the exclusion PATTERN that rules out exactly it,
  // built beside the key it was compared on. The autonomous fail-closed write
  // persists this verbatim rather than re-deriving it, so the rule cannot drift
  // from the delta — and at `provider:model` it no longer drops the backend's
  // sibling models (the A′ intermediate state).
  expect(delta).toEqual([
    {
      key: "openai-compatible:brand-new-model",
      provider: "openai-compatible",
      service: "openai-compatible",
      exclusion_pattern: "transport:openai-compatible/brand-new-model",
      service_exclusion_pattern: "service:openai-compatible/brand-new-model",
    },
  ]);
});

// A modelless CLI is the case a bare-`model_id` key would miss entirely: it must
// still delta (keyed by provider), and its rule must be the COARSE provider tier —
// a `provider:model` rule would never match a backend whose model only arrives at
// the dispatch handshake, so the gate would fail-closed-exclude and then dispatch
// it anyway.
await test("G3/A″: a modelless backend deltas by provider and rules out at the provider tier", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const delta = computeNewlyReachableBackends(
    built,
    {},
    [{ id: "cli", transport: "opencode" }],
    CLEAN_ENV,
  );
  expect(delta).toEqual([
    {
      key: "opencode",
      provider: "opencode",
      service: "opencode",
      exclusion_pattern: "transport:opencode",
      service_exclusion_pattern: "service:opencode",
    },
  ]);
});

// Model granularity is the POINT, not a refinement: the operator confirms *model*
// choices, so a SECOND model under an already-confirmed provider is a new choice.
// A provider-name-granular gate would report an empty delta here and dispatch it.
await test("G3: a second model of an ALREADY-confirmed provider still deltas (model granularity)", () => {
  const config = { openai_compatible: { base_url: "https://x/v1", model: "confirmed-model", api_key_env: "K" } };
  const built = buildSharedProviderConfirmation(config, { K: "public" });
  const delta = computeNewlyReachableBackends(
    built,
    config,
    [{ id: "second", transport: "openai-compatible", endpoint: "https://x/v1", model: "a-second-model" }],
    { K: "public" },
  );
  expect(delta.map((b) => b.key), "the new MODEL is the delta, not the provider").toEqual([
    "openai-compatible:a-second-model",
  ]);
});

// The opposite direction is the harmless SUBSET case and must stay silent — this is
// why the synthetic `worker-command` entry and host tiers need no special-casing.
await test("G3: a CONFIRMED backend that is no longer reachable is silent (subset case)", () => {
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  const withGhost = {
    ...built,
    source_pool_cost_order: [
      { source_id: "ghost", transport: "codex", model_id: "vanished-model", blended_price_usd_per_mtok: null, cost_order: 0 },
    ],
  };
  const delta = computeNewlyReachableBackends(withGhost, {}, [], CLEAN_ENV);
  expect(delta, "confirmed-but-unreachable is a subset, not a new backend").toEqual([]);
});

// ── PB-1: opencode opt-in is inherited from discoverProviders ────────────────

await test("PB-1: a bare-PATH opencode is NOT in the confirmed pool unless explicitly configured", () => {
  // Without opencode config, opencode must never be surfaced (discoverProviders
  // withholds a bare-PATH opencode). We assert the opt-in direction holds for the
  // unconfigured case regardless of whether opencode is on PATH.
  const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
  expect(
    built.provider_pool.some((e) => e.name === "opencode"),
    "bare-PATH opencode is opt-in, not in the pool",
  ).toBe(false);
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
          name: "worker-command",
          capability_tier: "unknown",
          excluded: false,
          reason: `pad-${k}-${"x".repeat(k * 8)}`,
        })),
      ],
    });

    const writeStorm = (async () => {
      for (let i = 1; i <= 15; i++) {
        await writeSharedProviderConfirmation(root, confFor(i));
      }
    })();

    const readers = [];
    for (let i = 0; i < 60; i++) {
      readers.push(readSharedProviderConfirmation(root));
    }

    const [, ...readResults] = await Promise.all([writeStorm, ...readers]);

    for (const r of readResults) {
      expect(r, "no read saw a torn/invalid file (would parse to null)").not.toBe(null);
      expect(r.schema_version).toBe(SHARED_PROVIDER_CONFIRMATION_VERSION);
      expect(r.session_level).toBe(true);
    }
  });
});
