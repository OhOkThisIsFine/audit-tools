// Capability evidence as an OBLIGATION — the shared-layer half.
//
// The feature: a dispatchable pool that no external rank source covers must be
// PINNED (an LLM-proposed / operator-authored RELATIVE ordering) rather than
// silently fail-opening at the admission capability floor, where an unranked pool
// is eligible for `deep` work it may be entirely unfit for.
//
// The road the evidence travels:
//   the operator's input FILE                   (parseProviderConfirmationInput)
//   ProviderConfirmationInput.capability_order   (most-capable-FIRST, positional)
//     → annotateConfirmedPool                    (index ⇒ capability_rank)
//     → toPersistedPoolEntry / *_cost_order      (persisted — a DECISION, not reach)
//     → readConfirmedCapabilityRanks             (model-keyed Map)
//     → buildHostModelPool / buildSourcePool     (pool.declaredCapabilityRank)
//     → buildCapabilityFloorCapable              (tercile bands ⇒ the floor)
//
// These pin: the schema stayed ADDITIVE, the field round-trips without opening a
// reach leak, BOTH pool constructors honor the map (and external evidence still
// wins), and the LOWER = more capable sign convention holds end-to-end.

import { describe, test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SHARED_PROVIDER_CONFIRMATION_VERSION,
  sharedProviderConfirmationPath,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readConfirmedCapabilityRanks,
  resolveUnevidencedCapabilityPools,
  readConfirmedCostPositions,
  readConfirmedDispatchBias,
  parseProviderConfirmationInput,
  readProviderConfirmationInput,
  PROVIDER_CONFIRMATION_INPUT_FILENAME,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");
const { PROVIDER_CONFIRMATION_INPUT_VERSION } = await import(
  "../../src/shared/types/providerConfirmation.ts"
);
const { buildHostModelPool, buildSourcePool } = await import(
  "../../src/shared/quota/apiPool.ts"
);
const { buildCapabilityFloorCapable } = await import(
  "../../src/shared/dispatch/admissionLoop.ts"
);
const { tierRank } = await import("../../src/shared/dispatch/tierRank.ts");

// No CLAUDECODE/CODEX, and no CLI on PATH — discovery is fully deterministic, so
// the confirmed pool is exactly {worker-command, openai-compatible}.
const CLEAN_ENV = {};
const NO_CLI = () => false;

const STUB_QUOTA = {
  name: "stub",
  async queryCurrentUsage() {
    return null;
  },
};

async function withTempRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), "capability-evidence-"));
  try {
    await mkdir(join(dir, ".audit-tools"), { recursive: true });
    return await fn(dir);
  } finally {
    // Windows teardown hardening: the atomic writer's sibling lock file can still
    // be settling when the OS is asked to rmdir (ENOTEMPTY/EBUSY). Retry rather
    // than sleep — it is a teardown race, not a product defect.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------
// 1. Additive schema — a pre-capability artifact still reads correctly
// ---------------------------------------------------------------------------

describe("additive schema: a confirmation written before capability_rank existed", () => {
  // A hand-written 1.0.0 artifact carrying NO capability field anywhere. The
  // version is deliberately NOT bumped by this feature — bumping it would make
  // every existing confirmation parse to `null`, which degrades SILENTLY to empty
  // cost positions and λ=0 (the exact B+D failure mode the parser's comments call
  // out). This test is what makes an accidental bump red.
  const LEGACY = {
    schema_version: "1.0.0",
    session_level: true,
    confirmed_at: "2026-01-01T00:00:00.000Z",
    provider_pool: [
      { name: "openai-compatible", model_id: "legacy-model", cost_order: 0 },
      { name: "worker-command" },
    ],
    host_model_cost_order: [
      { model_id: "legacy-host", blended_price_usd_per_mtok: null, cost_order: 1 },
    ],
    source_pool_cost_order: [
      {
        source_id: "legacy-src-id",
        transport: "openai-compatible",
        model_id: "legacy-src",
        blended_price_usd_per_mtok: null,
        price_declared: false,
        cost_order: 2,
      },
    ],
    dispatch_bias: 0.25,
  };

  async function writeLegacy(root) {
    await writeFile(
      sharedProviderConfirmationPath(root),
      JSON.stringify(LEGACY),
      "utf8",
    );
  }

  test("the shared schema version is unchanged by the capability field", () => {
    expect(
      SHARED_PROVIDER_CONFIRMATION_VERSION,
      "an additive field must NOT bump the version — a bump silently discards every " +
        "existing operator decision (cost order + λ) via the parser's null path",
    ).toBe("1.0.0");
    expect(LEGACY.schema_version).toBe(SHARED_PROVIDER_CONFIRMATION_VERSION);
  });

  test("it still parses: the cost-order map is complete across all three lists", async () => {
    await withTempRoot(async (root) => {
      await writeLegacy(root);
      const positions = await readConfirmedCostPositions(root);
      expect(
        [...positions.entries()].sort(),
        "provider pool + host tier + source pool, all model-keyed, all still read",
      ).toEqual([
        ["legacy-host", 1],
        ["legacy-model", 0],
        ["legacy-src", 2],
      ]);
    });
  });

  test("it still parses: λ survives", async () => {
    await withTempRoot(async (root) => {
      await writeLegacy(root);
      expect(await readConfirmedDispatchBias(root)).toBe(0.25);
    });
  });

  test("readConfirmedCapabilityRanks returns an EMPTY map — not a throw, not a partial", async () => {
    await withTempRoot(async (root) => {
      await writeLegacy(root);
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks).toBeInstanceOf(Map);
      expect(ranks.size, "no capability field anywhere ⇒ nothing is claimed").toBe(0);
      // Explicitly NOT a partial: every model that DOES have a cost position must
      // still be absent from the capability map, so a downstream join can never
      // mistake a cost position for evidence.
      for (const model of ["legacy-model", "legacy-host", "legacy-src"]) {
        expect(ranks.has(model)).toBe(false);
      }
    });
  });

  test("an absent artifact yields an empty map rather than throwing", async () => {
    await withTempRoot(async (root) => {
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip — the field persists; the reach brand still does NOT
// ---------------------------------------------------------------------------

// One session config + input that exercises ALL THREE source lists at once:
//   provider_pool           ← the configured openai-compatible entry (model-alpha)
//   host_model_cost_order   ← the host roster entry            (host-model-beta)
//   source_pool_cost_order  ← an explicit dispatchable source  (model-gamma)
const RT_CONFIG = {
  openai_compatible: { base_url: "http://nim.local/v1", model: "model-alpha" },
};
const RT_SOURCES = [
  {
    id: "gamma-src",
    transport: "openai-compatible",
    model: "model-gamma",
    endpoint: "http://gamma.local/v1",
  },
];
const RT_INPUT = {
  schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
  host_models: [{ model_id: "host-model-beta" }],
  // Most-capable-FIRST, named by MODEL id — the one keyspace the delta, the
  // prompt, the persisted rank and the dispatch join all share. A provider name or
  // an internal source candidate key would not match, by design.
  capability_order: ["model-alpha", "host-model-beta", "model-gamma"],
};

function buildRoundTrip() {
  return buildSharedProviderConfirmation(
    RT_CONFIG,
    CLEAN_ENV,
    [],
    [],
    NO_CLI,
    RT_INPUT,
    RT_SOURCES,
  );
}

describe("round-trip: capability_rank survives persist → read, keyed by model_id", () => {
  test("all three source lists carry their confirmed rank into the model-keyed map", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildRoundTrip());
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(
        [...ranks.entries()].sort(),
        "index in capability_order ⇒ capability_rank, keyed by the pool's MODEL id " +
          "(the same keyspace the dispatch join uses)",
      ).toEqual([
        ["host-model-beta", 1],
        ["model-alpha", 0],
        ["model-gamma", 2],
      ]);
    });
  });

  test("a pool with no model_id contributes nothing (unjoinable ⇒ unrankable)", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildRoundTrip());
      const ranks = await readConfirmedCapabilityRanks(root);
      // `worker-command` is in the persisted pool but has no representative model.
      const raw = JSON.parse(await readFile(sharedProviderConfirmationPath(root), "utf8"));
      expect(raw.provider_pool.map((e) => e.name)).toContain("worker-command");
      expect(ranks.has("worker-command")).toBe(false);
      expect(ranks.size, "exactly the three model-keyed pools, nothing else").toBe(3);
    });
  });

  test("the reach brand is STILL not persisted — the new field opened no leak", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildRoundTrip());
      const raw = JSON.parse(await readFile(sharedProviderConfirmationPath(root), "utf8"));
      // `toPersistedPoolEntry` reconstructs field-by-field, so adding a field there
      // is exactly where a reach field could be reinstated by accident.
      const REACH_FIELDS = [
        "capability_tier",
        "excluded",
        "blended_price_usd_per_mtok",
        "self_spawn_blocked",
        "reason",
      ];
      for (const entry of raw.provider_pool) {
        for (const field of REACH_FIELDS) {
          expect(
            Object.hasOwn(entry, field),
            `provider_pool[${entry.name}].${field} is the WRITING auditor's reach ` +
              `assessment and must never be inherited by a reading auditor`,
          ).toBe(false);
        }
        // And the decision half is genuinely there (so the check above cannot pass
        // merely because the pool serialized as empty objects).
        expect(typeof entry.name).toBe("string");
      }
      const alpha = raw.provider_pool.find((e) => e.name === "openai-compatible");
      expect(alpha.model_id).toBe("model-alpha");
      expect(alpha.capability_rank, "the DECISION half persists").toBe(0);
      expect(raw.host_model_cost_order[0].capability_rank).toBe(1);
      expect(raw.source_pool_cost_order[0].capability_rank).toBe(2);
      expect(raw.source_pool_cost_order[0].model_id).toBe("model-gamma");
    });
  });

  // REGRESSION GUARD. The capability delta is emitted as MODEL ids
  // (`resolveUnevidencedCapabilityPools` collects `source.model` /
  // `host_model_cost_order[].model_id`) and the Gate-0 prompt tells the operator to
  // answer `{"capability_order": ["<model id>", …]}`. `annotateConfirmedPool` must
  // therefore MATCH on the model too. It briefly did not — it keyed a source on its
  // internal `source::<id>` candidate key and a provider on its provider NAME — so
  // the operator's answer landed nowhere, the map stayed empty for that model, and
  // this PRIORITY[0] obligation re-prompted the identical question forever. That is
  // the exact infinite-re-prompt trap the model keyspace exists to prevent.
  // Do NOT weaken this assertion.
  test("a source is rankable by the MODEL id the delta+prompt actually name", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation({}, CLEAN_ENV, [], [], NO_CLI, {
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          capability_order: ["model-gamma"],
        }, RT_SOURCES),
      );
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(
        ranks.get("model-gamma"),
        "the operator answered exactly what the prompt asked for — it must land",
      ).toBe(0);
    });
  });

  test("first occurrence wins on a duplicated capability_order key", async () => {
    await withTempRoot(async (root) => {
      const built = buildSharedProviderConfirmation(
        RT_CONFIG,
        CLEAN_ENV,
        [],
        [],
        NO_CLI,
        {
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          capability_order: ["model-alpha", "unmatched-model", "model-alpha"],
        },
        [],
      );
      await writeSharedProviderConfirmation(root, built);
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(
        ranks.get("model-alpha"),
        "the HEAD of a typo'd list stays authoritative over its tail",
      ).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. BOTH constructors honor the confirmed rank
// ---------------------------------------------------------------------------

// Asserted independently per constructor, on purpose: `declaredCapabilityRank` had
// a single writer on the SOURCE path before this feature, so every HOST pool banded
// to `null` and took the floor's fail-open branch on every ordinary wave. A test
// that passes with only one side wired would not have caught that.
describe("resolveDeclaredCapabilityRank is applied by BOTH pool constructors", () => {
  const CONFIRMED = new Map([
    ["host-model-beta", 3],
    ["model-gamma", 5],
  ]);

  test("buildHostModelPool stamps the confirmed rank joined on its hostModel", async () => {
    const pool = await buildHostModelPool({
      poolKey: "claude-code/host-model-beta",
      providerName: "claude-code",
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSource: STUB_QUOTA,
      capabilityRanks: CONFIRMED,
    });
    expect(pool.hostModel).toBe("host-model-beta");
    expect(pool.declaredCapabilityRank).toBe(3);
  });

  test("buildHostModelPool leaves the field ABSENT when nothing joins", async () => {
    const unjoined = await buildHostModelPool({
      poolKey: "claude-code/model-nobody-ranked",
      providerName: "claude-code",
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSource: STUB_QUOTA,
      capabilityRanks: CONFIRMED,
    });
    expect(unjoined.declaredCapabilityRank).toBeUndefined();

    const noMap = await buildHostModelPool({
      poolKey: "claude-code/host-model-beta",
      providerName: "claude-code",
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSource: STUB_QUOTA,
      capabilityRanks: null,
    });
    expect(
      noMap.declaredCapabilityRank,
      "`null` is the explicit no-confirmation-in-scope answer",
    ).toBeUndefined();
  });

  test("buildSourcePool stamps the confirmed rank joined on its model", async () => {
    const pool = await buildSourcePool({
      source: {
        id: "gamma-src",
        transport: "openai-compatible",
        model: "model-gamma",
        endpoint: "http://gamma.local/v1",
      },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
      capabilityRanks: CONFIRMED,
    });
    expect(pool.hostModel).toBe("model-gamma");
    expect(pool.declaredCapabilityRank).toBe(5);
  });

  test("buildSourcePool resolves to null when nothing joins", async () => {
    const pool = await buildSourcePool({
      source: {
        id: "delta-src",
        transport: "openai-compatible",
        model: "model-nobody-ranked",
        endpoint: "http://delta.local/v1",
      },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
      capabilityRanks: CONFIRMED,
    });
    expect(pool.declaredCapabilityRank).toBe(null);
  });

  // PRECEDENCE. A registry/roster rank is someone-else-maintained data ABOUT the
  // model; the confirmed map is only the gap-filler for models no rank source
  // covers. If the confirmed map could override it, an LLM-proposed ordering would
  // outrank real external evidence — the inversion the plan explicitly forbids.
  test("external evidence WINS: a source's own capability_rank is not overridden", async () => {
    const pool = await buildSourcePool({
      source: {
        id: "gamma-src",
        transport: "openai-compatible",
        model: "model-gamma",
        endpoint: "http://gamma.local/v1",
        capability_rank: 42,
      },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
      capabilityRanks: CONFIRMED, // says 5 for model-gamma
    });
    expect(
      pool.declaredCapabilityRank,
      "the external value, NOT the confirmed map's 5",
    ).toBe(42);
  });

  test("a non-finite external rank degrades to the confirmed map, never poisons it", async () => {
    const pool = await buildSourcePool({
      source: {
        id: "gamma-src",
        transport: "openai-compatible",
        model: "model-gamma",
        endpoint: "http://gamma.local/v1",
        capability_rank: Number.NaN,
      },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
      capabilityRanks: CONFIRMED,
    });
    expect(pool.declaredCapabilityRank).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. Sign convention — LOWER = more capable, end to end
// ---------------------------------------------------------------------------

// ⚠ SIGN. `capability_order` is MOST-CAPABLE-FIRST, so array index ⇒
// `capability_rank` with LOWER = more capable. That convention is shared all the
// way down: `AdmissionPool.capabilityScore` (registry composite_rank) and
// `CapacityPool.declaredCapabilityRank` are both LOWER = better, and
// `buildCapabilityFloorCapable` terciles ascending so band 0 = top third.
//
// NOT every external source uses this sign. OpenRouter's `agentic_index`, for
// example, is HIGHER = better — any ranker feeding this field MUST invert before
// it lands here, or a deep packet routes to the weakest pool in the roster.
describe("sign convention: capability_order is most-capable-first ⇒ LOWER rank", () => {
  const SIGN_SOURCES = [
    {
      id: "strong-src",
      transport: "openai-compatible",
      model: "model-strong",
      endpoint: "http://strong.local/v1",
    },
    {
      id: "weak-src",
      transport: "openai-compatible",
      model: "model-weak",
      endpoint: "http://weak.local/v1",
    },
  ];

  test("the FIRST-listed model gets the LOWER rank and wins a deep-tier packet", async () => {
    await withTempRoot(async (root) => {
      // The operator/LLM orders them most-capable-first. Note the two are otherwise
      // indistinguishable — same provider, no declared cost, no external rank — so
      // ONLY the ordering can decide, and inverting the mapping flips the outcome.
      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation(
          {},
          CLEAN_ENV,
          [],
          [],
          NO_CLI,
          {
            schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
            capability_order: ["model-strong", "model-weak"],
          },
          SIGN_SOURCES,
        ),
      );

      const confirmed = await readConfirmedCapabilityRanks(root);
      expect(
        confirmed.get("model-strong"),
        "first listed = most capable = LOWEST rank",
      ).toBe(0);
      expect(confirmed.get("model-weak")).toBe(1);
      expect(confirmed.get("model-strong")).toBeLessThan(confirmed.get("model-weak"));

      // …through pool construction…
      const pools = await Promise.all(
        SIGN_SOURCES.map((source) =>
          buildSourcePool({
            source,
            quotaSource: STUB_QUOTA,
            quotaEntries: {},
            capabilityRanks: confirmed,
          }),
        ),
      );
      const [strongPool, weakPool] = pools;
      expect(strongPool.hostModel).toBe("model-strong");
      expect(strongPool.declaredCapabilityRank).toBe(0);
      expect(weakPool.declaredCapabilityRank).toBe(1);

      // …into the admission capability floor. Two scored pools tercile to bands
      // 0 and 1; a `deep` packet admits band 0 only.
      const admissionPools = pools.map((p) => ({
        poolId: p.id,
        resourceKey: p.id,
        budget: Number.POSITIVE_INFINITY,
        declaredCap: null,
        costRank: 0,
        capabilityRank: tierRank(undefined), // neutral — the SCORE must decide
        capabilityScore: p.declaredCapabilityRank,
        throughputConcurrency: Number.POSITIVE_INFINITY,
        capacityTokens: Number.POSITIVE_INFINITY,
      }));
      const capable = buildCapabilityFloorCapable(admissionPools);
      const deepPacket = { id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" };
      const [strongAdmission, weakAdmission] = admissionPools;

      expect(
        capable(strongAdmission, deepPacket),
        "the first-listed (most capable) pool is the one a deep packet may use",
      ).toBe(true);
      expect(
        capable(weakAdmission, deepPacket),
        "the last-listed pool is BELOW the deep floor — if this is true, the sign " +
          "convention has been inverted somewhere on the path",
      ).toBe(false);

      // A `small` packet has no floor, so both stay eligible — this is what proves
      // the assertion above is the FLOOR talking and not some unrelated rejection.
      const smallPacket = { id: "easy", cost: 1000, complexity: 0.1, requiredTier: "small" };
      expect(capable(strongAdmission, smallPacket)).toBe(true);
      expect(capable(weakAdmission, smallPacket)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The PARSER seam — the first link in the road, and the one that broke
// ---------------------------------------------------------------------------

// ⚠ This is where the feature died once, and every other test in this file missed
// it because they all hand a raw JS object straight to `buildSharedProviderConfirmation`.
// `parseProviderConfirmationInput` reconstructs the input FIELD-BY-FIELD, so an
// unlisted field is dropped silently — and dropping THIS one is not a degrade, it is
// a livelock: the operator answers the prompt, the answer never reaches
// `annotateConfirmedPool`, no rank is written, the delta recomputes identical, and
// `provider_confirmation` (PRIORITY[0]) re-prompts the same question forever.
// Any new ProviderConfirmationInput field needs a case here.
describe("the operator's answer survives the input PARSER", () => {
  test("capability_order round-trips through parseProviderConfirmationInput", () => {
    const parsed = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      capability_order: ["model-strong", "model-weak"],
    });
    expect(
      parsed?.capability_order,
      "the field the Gate-0 prompt tells the operator to write must not be dropped",
    ).toEqual(["model-strong", "model-weak"]);
  });

  test("a non-string-array capability_order degrades to absent, never throws", () => {
    for (const bad of [42, "model-a", [1, 2], [{}], null]) {
      const parsed = parseProviderConfirmationInput({
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        capability_order: bad,
        cost_order: ["keep-me"],
      });
      expect(parsed, `malformed capability_order (${JSON.stringify(bad)}) must not null the whole input`).not.toBeNull();
      expect(parsed.capability_order).toBeUndefined();
      // A malformed capability answer must not discard a well-formed cost answer.
      expect(parsed.cost_order).toEqual(["keep-me"]);
    }
  });

  test("END TO END from the input FILE on disk to a ranked pool", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      // Exactly the JSON the Gate-0 prompt prints for the operator.
      await writeFile(
        join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
        JSON.stringify({
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          capability_order: ["model-strong", "model-weak"],
        }),
        "utf8",
      );
      const fromDisk = await readProviderConfirmationInput(artifactsDir);
      expect(fromDisk?.capability_order).toEqual(["model-strong", "model-weak"]);

      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation({}, CLEAN_ENV, [], [], NO_CLI, fromDisk, [
          { id: "strong-src", transport: "openai-compatible", model: "model-strong", endpoint: "http://s/v1" },
          { id: "weak-src", transport: "openai-compatible", model: "model-weak", endpoint: "http://w/v1" },
        ]),
      );
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(
        ranks.get("model-strong"),
        "an answer written to the real input file must reach the dispatch join",
      ).toBe(0);
      expect(ranks.get("model-weak")).toBe(1);

      // …and the delta this answer was meant to clear is now genuinely empty.
      const pool = await buildSourcePool({
        source: { id: "strong-src", transport: "openai-compatible", model: "model-strong", endpoint: "http://s/v1" },
        quotaSource: STUB_QUOTA,
        quotaEntries: {},
        capabilityRanks: ranks,
      });
      expect(pool.declaredCapabilityRank).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The DELTA itself — `resolveUnevidencedCapabilityPools`
// ---------------------------------------------------------------------------

// This is the gate's producing half, and its failure mode is a LIVELOCK, not a
// degrade: `provider_confirmation` is PRIORITY[0], so a delta that can never empty
// re-selects the same obligation and re-prompts the identical question forever.
//
// ⚠ Every test here writes a REAL confirmation file to a temp root and lets the
// function read it back through `readSharedProviderConfirmation`. Handing it a
// constructed object would skip the disk read + parse — which is precisely the link
// that has broken before on this path.
describe("resolveUnevidencedCapabilityPools: the capability delta", () => {
  // `provider: "claude-code"` keeps the primary fold inert (the conversation host is
  // never a dispatchable SOURCE), so `gatherDispatchableSources` returns exactly the
  // configured `sources[]` — the delta under test, and nothing incidental.
  const configWith = (sources) => ({ provider: "claude-code", sources });

  const src = (model, extra = {}) => ({
    id: `${model ?? "no-model"}-src`,
    transport: "openai-compatible",
    endpoint: `http://${model ?? "nomodel"}.local/v1`,
    ...(model ? { model } : {}),
    ...extra,
  });

  /** Write a REAL confirmation artifact to disk, exactly as the writer does. */
  async function writeConfirmation(root, overrides = {}) {
    await writeSharedProviderConfirmation(root, {
      schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
      session_level: true,
      confirmed_at: "2026-01-01T00:00:00.000Z",
      provider_pool: [{ name: "worker-command" }],
      ...overrides,
    });
  }

  test("a model with NO capability rank anywhere APPEARS in the delta", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root);
      const delta = await resolveUnevidencedCapabilityPools(
        root,
        configWith([src("model-unranked")]),
      );
      expect(
        delta,
        "no external rank, no confirmed rank ⇒ the floor would fail OPEN on it",
      ).toEqual(["model-unranked"]);
    });
  });

  test("a model with EXTERNAL evidence (source.capability_rank) does NOT appear", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root);
      const delta = await resolveUnevidencedCapabilityPools(
        root,
        configWith([src("model-external", { capability_rank: 7 })]),
      );
      expect(
        delta,
        "external evidence counts — a fully-ranked roster must never fire the gate",
      ).toEqual([]);
    });
  });

  test("a model with a CONFIRMED rank on disk does NOT appear", async () => {
    await withTempRoot(async (root) => {
      // The rank is read back off the real file by `readConfirmedCapabilityRanks`,
      // keyed on model_id — the same join the pool constructors take.
      await writeConfirmation(root, {
        provider_pool: [
          { name: "worker-command" },
          { name: "openai-compatible", model_id: "model-pinned", capability_rank: 0 },
        ],
      });
      const delta = await resolveUnevidencedCapabilityPools(
        root,
        configWith([src("model-pinned")]),
      );
      expect(
        delta,
        "the operator already pinned it — re-asking is the livelock",
      ).toEqual([]);
    });
  });

  // ⚠ THE LIVELOCK GUARD. A source with no model is UNJOINABLE: the confirmed map is
  // model-keyed, so no answer the operator could give would ever satisfy it. Admitting
  // it to the delta would re-open PRIORITY[0] on every single `next-step`, forever.
  // Do NOT weaken this assertion.
  test("a source with NO model id does NOT appear (unjoinable ⇒ unpinnable)", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root);
      const delta = await resolveUnevidencedCapabilityPools(
        root,
        configWith([src(null), src("model-real")]),
      );
      expect(
        delta,
        "the model-less source must be skipped ENTIRELY — only the joinable one is askable",
      ).toEqual(["model-real"]);
      // And the discriminating half: the model-less source really was gathered, so
      // the assertion above is the skip talking and not an empty source list.
      const { gatherDispatchableSources } = await import(
        "../../src/shared/quota/apiPool.ts"
      );
      const gathered = await gatherDispatchableSources(
        configWith([src(null), src("model-real")]),
        "claude-code",
      );
      expect(gathered.some((s) => !s.model)).toBe(true);
    });
  });

  test("a model-less source ALONE yields an empty delta, so the gate converges", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root);
      expect(
        await resolveUnevidencedCapabilityPools(root, configWith([src(null)])),
        "an all-unjoinable roster must leave NOTHING open — this is the wedge case",
      ).toEqual([]);
    });
  });

  test("an ABSENT confirmation yields [] (the `missing` case pauses on its own)", async () => {
    await withTempRoot(async (root) => {
      // Nothing written at all.
      expect(
        await resolveUnevidencedCapabilityPools(
          root,
          configWith([src("model-unranked")]),
        ),
        "folding a second question into a prompt that has not asked the first is wrong",
      ).toEqual([]);
    });
  });

  test("a MALFORMED confirmation on disk also yields [] rather than throwing", async () => {
    await withTempRoot(async (root) => {
      await writeFile(
        sharedProviderConfirmationPath(root),
        JSON.stringify({ schema_version: "9.9.9", session_level: true }),
        "utf8",
      );
      expect(
        await resolveUnevidencedCapabilityPools(
          root,
          configWith([src("model-unranked")]),
        ),
      ).toEqual([]);
    });
  });

  test("an unranked HOST model appears; a host entry with no model_id does not", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root, {
        host_model_cost_order: [
          { model_id: "host-unranked", blended_price_usd_per_mtok: null, cost_order: 0 },
          {
            model_id: "host-pinned",
            blended_price_usd_per_mtok: null,
            cost_order: 1,
            capability_rank: 0,
          },
        ],
      });
      const delta = await resolveUnevidencedCapabilityPools(root, configWith([]));
      expect(
        delta,
        "the host is NOT a special case — its roster carries no capability field, so " +
          "the confirmed map is its only evidence road",
      ).toEqual(["host-unranked"]);
    });
  });

  test("the delta is deduplicated and sorted (stable, content-derived order)", async () => {
    await withTempRoot(async (root) => {
      await writeConfirmation(root, {
        // `model-b` is BOTH a gathered source and a host tier — it must appear once.
        host_model_cost_order: [
          { model_id: "model-b", blended_price_usd_per_mtok: null, cost_order: 0 },
          { model_id: "model-a", blended_price_usd_per_mtok: null, cost_order: 1 },
        ],
      });
      const delta = await resolveUnevidencedCapabilityPools(
        root,
        configWith([src("model-c"), src("model-b")]),
      );
      expect(
        delta,
        "this list reaches the obligation reason + prompt; gather order would churn " +
          "downstream content hashes",
      ).toEqual(["model-a", "model-b", "model-c"]);
    });
  });
});
