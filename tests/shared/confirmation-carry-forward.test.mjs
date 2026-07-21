// Gate-0 carry-forward — the "a submission omits it ⇒ it is DESTROYED" defect class.
//
// `buildProviderConfirmationRender` rebuilds the WHOLE confirmation from the
// operator's submission alone: cost order, capability ranks, the host roster, λ and
// the `policy` exclusions are each reconstructed from `input` and from nothing else.
// So any field a submission omits was being wiped rather than left alone.
// `carryForwardConfirmationInput` closes that, on two rules:
//
//   (a) `undefined` on an input field means "said nothing" ⇒ reseed from the prior
//       confirmation. An EXPLICIT empty array means "delete" ⇒ do NOT reseed.
//       (`parseProviderConfirmationInput` preserves an explicit `host_models: []`
//       for exactly this reason — collapsing it to absent makes deletion
//       unrepresentable.)
//   (b) It applies when `input === null` too — the autonomous/headless
//       re-promotion path, which would otherwise wipe the decision and then report
//       convergence.
//
// The headline test drives the REAL seam end-to-end — a real
// `provider-confirmation.input.json` and a real prior `provider-confirmation.json`
// on disk, through read → parse → carry → build → persist — and asserts on what
// lands ON DISK. A prior review round found every test handing a constructed object
// straight to the function under test, which is precisely how the one genuinely
// broken link (the parser) survived.

import { describe, test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  sharedProviderConfirmationPath,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readSharedProviderConfirmation,
  readConfirmedCapabilityRanks,
  readConfirmedCostPositions,
  readConfirmedDispatchBias,
  readConfirmedDispatchPolicy,
  resolveDispatchExclusion,
  resolveUnevidencedCapabilityPools,
  parseProviderConfirmationInput,
  readProviderConfirmationInput,
  carryForwardConfirmationInput,
  PROVIDER_CONFIRMATION_INPUT_FILENAME,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");
const { PROVIDER_CONFIRMATION_INPUT_VERSION } = await import(
  "../../src/shared/types/providerConfirmation.ts"
);
// The REAL executor, not a mirror of it. The regression test below asserts on a
// specific call site inside this function, so re-implementing its body in the test
// would make the assertion unfalsifiable by a change to that call site.
const { runProviderConfirmationAutoComplete } = await import(
  "../../src/audit/orchestrator/intakeExecutors.ts"
);

// No CLAUDECODE/CODEX and no CLI on PATH — discovery is fully deterministic, so the
// confirmed pool is exactly what the session config + sources put in it.
const CLEAN_ENV = {};
const NO_CLI = () => false;

async function withTempRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), "carry-forward-"));
  try {
    await mkdir(join(dir, ".audit-tools"), { recursive: true });
    return await fn(dir);
  } finally {
    // Windows teardown hardening: the atomic writer's sibling lock file can still be
    // settling when the OS is asked to rmdir. Retry rather than sleep.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------
// The shared fixture: a prior confirmation that carries ALL of it at once
// ---------------------------------------------------------------------------

const CONFIG = {
  openai_compatible: { base_url: "http://nim.local/v1", model: "model-alpha" },
};

const SOURCES = [
  {
    id: "gamma-src",
    transport: "openai-compatible",
    model: "model-gamma",
    endpoint: "http://gamma.local/v1",
  },
];

// The operator's FIRST, full submission: a cost order, a host roster, exclusions,
// a capability order and a λ. Everything a later capability-only submission must
// not destroy.
const PRIOR_EXCLUDE = ["agy", "integrate.api.nvidia.com"];
const PRIOR_INPUT = {
  schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
  host_models: [{ model_id: "host-beta" }],
  cost_order: ["host-beta", "openai-compatible", "gamma-src"],
  capability_order: ["model-alpha", "host-beta", "model-gamma"],
  dispatch_bias: 0.4,
};

function buildPrior(input = PRIOR_INPUT, exclude = PRIOR_EXCLUDE) {
  return buildSharedProviderConfirmation(
    CONFIG,
    CLEAN_ENV,
    exclude,
    [],
    NO_CLI,
    input,
    SOURCES,
  );
}

/**
 * The executor's promotion path, replayed against real files:
 * read the input FILE → parse → read the prior confirmation → carry forward →
 * derive `exclude` FROM THE CARRIED INPUT → build → persist.
 * Mirrors `promoteProviderConfirmation` in src/audit/orchestrator/intakeExecutors.ts
 * (search `effectiveInput`).
 */
async function promote(root, artifactsDir) {
  const fromDisk = artifactsDir ? await readProviderConfirmationInput(artifactsDir) : null;
  const prior = await readSharedProviderConfirmation(root);
  const effectiveInput = carryForwardConfirmationInput(fromDisk, prior);
  const exclude = [...new Set(effectiveInput?.exclude ?? [])];
  await writeSharedProviderConfirmation(
    root,
    buildSharedProviderConfirmation(
      CONFIG,
      CLEAN_ENV,
      exclude,
      effectiveInput?.include ?? [],
      NO_CLI,
      effectiveInput ?? undefined,
      SOURCES,
    ),
  );
  return { fromDisk, prior, effectiveInput };
}

async function readPersisted(root) {
  return JSON.parse(await readFile(sharedProviderConfirmationPath(root), "utf8"));
}

// ---------------------------------------------------------------------------
// 1. HEADLINE — a capability-only submission, end to end, asserted on disk
// ---------------------------------------------------------------------------

// This is the case an operator hits EVERY time they answer the prompt as written:
// the Gate-0 capability example is `{"capability_order": [...]}`, so a compliant
// answer omits cost_order, host_models, exclude, include and dispatch_bias — and
// each omission used to be a deletion.
describe("HEADLINE: a capability-only submission destroys nothing (real files, real parser)", () => {
  const CAPABILITY_ONLY = {
    schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
    // Deliberately a DIFFERENT order than the prior one, so "the new answer applied"
    // and "the old answer survived" cannot be confused for one another.
    capability_order: ["model-gamma", "model-alpha", "host-beta"],
  };

  async function runHeadline(root) {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    // A real prior confirmation on disk.
    await writeSharedProviderConfirmation(root, buildPrior());
    // The exact JSON the Gate-0 prompt tells the operator to write, as a real file.
    await writeFile(
      join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
      JSON.stringify(CAPABILITY_ONLY),
      "utf8",
    );
    return promote(root, artifactsDir);
  }

  test("the prior COST ORDER survives (positions unchanged)", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildPrior());
      const before = [...(await readConfirmedCostPositions(root)).entries()].sort();
      await runHeadline(root);
      const after = [...(await readConfirmedCostPositions(root)).entries()].sort();
      expect(
        after,
        "the operator's confirmed cost ordering is POLICY — a capability answer says " +
          "nothing about it and must not reshuffle it",
      ).toEqual(before);
      // And it is genuinely the operator's order, not the tool's suggestion.
      const positions = await readConfirmedCostPositions(root);
      expect(positions.get("host-beta")).toBe(0);
      expect(positions.get("model-alpha")).toBe(1);
      expect(positions.get("model-gamma")).toBe(2);
    });
  });

  test("the prior HOST ROSTER survives on disk", async () => {
    await withTempRoot(async (root) => {
      await runHeadline(root);
      const raw = await readPersisted(root);
      expect(
        (raw.host_model_cost_order ?? []).map((e) => e.model_id),
        "a submission that never mentions host models is not a decision to delete them",
      ).toEqual(["host-beta"]);
    });
  });

  test("the prior EXCLUSIONS survive on disk (failing this is a fail-OPEN)", async () => {
    await withTempRoot(async (root) => {
      await runHeadline(root);
      const raw = await readPersisted(root);
      expect(
        (raw.policy?.exclude ?? []).slice().sort(),
        "losing an exclusion routes to a backend the operator explicitly ruled out — " +
          "the worst direction for this whole artifact to fail in",
      ).toEqual([...PRIOR_EXCLUDE].sort());
      // Through the real dispatch-side read, not just the raw JSON.
      const policy = await readConfirmedDispatchPolicy(root);
      expect(policy?.exclude?.slice().sort()).toEqual([...PRIOR_EXCLUDE].sort());
    });
  });

  test("the prior DISPATCH BIAS (λ) survives", async () => {
    await withTempRoot(async (root) => {
      await runHeadline(root);
      expect(await readConfirmedDispatchBias(root)).toBe(0.4);
    });
  });

  test("…and the NEW capability order is actually applied", async () => {
    await withTempRoot(async (root) => {
      await runHeadline(root);
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(
        [...ranks.entries()].sort(),
        "carry-forward fills gaps — it must never override what the operator DID say",
      ).toEqual([
        ["host-beta", 2],
        ["model-alpha", 1],
        ["model-gamma", 0],
      ]);
    });
  });

  test("the real PARSER preserves the file's shape into the carried input", async () => {
    await withTempRoot(async (root) => {
      const { fromDisk, effectiveInput } = await runHeadline(root);
      // The link a prior review round missed entirely: every other test handed a
      // constructed object to the function under test, so a parser that dropped the
      // field was invisible.
      expect(fromDisk?.capability_order).toEqual(CAPABILITY_ONLY.capability_order);
      expect(fromDisk?.cost_order, "the file said nothing about cost").toBeUndefined();
      expect(effectiveInput.capability_order).toEqual(CAPABILITY_ONLY.capability_order);
      // The operator's three named keys keep their confirmed positions, in order.
      // `worker-command` trails them: it is the always-present fallback entry, it
      // was never named by the operator, so `resolveFinalCostOrder` appended it —
      // and it therefore has a real `cost_order` that the reconstruction must
      // re-emit rather than drop.
      expect(effectiveInput.cost_order).toEqual([
        "host-beta",
        "openai-compatible",
        "gamma-src",
        "worker-command",
      ]);
      expect(effectiveInput.host_models).toEqual([{ model_id: "host-beta" }]);
      expect(effectiveInput.exclude?.slice().sort()).toEqual([...PRIOR_EXCLUDE].sort());
      expect(effectiveInput.dispatch_bias).toBe(0.4);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The AUTONOMOUS path — `input === null` must not wipe the decision
// ---------------------------------------------------------------------------

describe("input === null (autonomous re-promotion) carries the prior decision forward", () => {
  test("the whole persisted decision survives a no-submission re-promotion", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildPrior());
      const before = await readPersisted(root);
      // No artifacts dir ⇒ no input file at all ⇒ the executor's `input === null`.
      await promote(root, undefined);
      const after = await readPersisted(root);

      expect(after.host_model_cost_order).toEqual(before.host_model_cost_order);
      expect(after.source_pool_cost_order).toEqual(before.source_pool_cost_order);
      expect(after.provider_pool).toEqual(before.provider_pool);
      expect(after.policy).toEqual(before.policy);
      expect(after.dispatch_bias).toBe(before.dispatch_bias);
      // `confirmed_at` is a fresh timestamp by design — the only field expected to move.
      expect(typeof after.confirmed_at).toBe("string");
    });
  });

  test("carryForwardConfirmationInput(null, prior) synthesizes a full input", () => {
    const carried = carryForwardConfirmationInput(null, buildPrior());
    expect(
      carried,
      "short-circuiting on `input &&` is exactly what let an unattended re-promotion " +
        "wipe the decision and then report convergence",
    ).not.toBeNull();
    expect(carried.schema_version).toBe(PROVIDER_CONFIRMATION_INPUT_VERSION);
    expect(carried.host_models).toEqual([{ model_id: "host-beta" }]);
    expect(carried.exclude?.slice().sort()).toEqual([...PRIOR_EXCLUDE].sort());
    expect(carried.capability_order).toEqual([
      "model-alpha",
      "host-beta",
      "model-gamma",
    ]);
    expect(carried.dispatch_bias).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// 3+4. said-nothing vs delete — the `undefined` / `[]` distinction
// ---------------------------------------------------------------------------

describe("an explicit empty array means DELETE; omission means said-nothing", () => {
  test("the parser PRESERVES an explicit host_models: [] rather than dropping it", () => {
    const parsed = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      host_models: [],
    });
    expect(
      parsed?.host_models,
      "dropping `[]` to absent makes deletion unrepresentable — the two cases become " +
        "indistinguishable downstream and the carry-forward resurrects the roster",
    ).toEqual([]);
    expect(Object.hasOwn(parsed, "host_models")).toBe(true);
  });

  test("explicit host_models: [] ⇒ the roster is NOT resurrected", () => {
    const carried = carryForwardConfirmationInput(
      parseProviderConfirmationInput({
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        host_models: [],
      }),
      buildPrior(),
    );
    expect(carried.host_models).toEqual([]);
  });

  test("explicit host_models: [] ⇒ the deletion reaches DISK", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeSharedProviderConfirmation(root, buildPrior());
      await writeFile(
        join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
        JSON.stringify({
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          host_models: [],
        }),
        "utf8",
      );
      await promote(root, artifactsDir);
      const raw = await readPersisted(root);
      expect(
        raw.host_model_cost_order ?? [],
        "the operator deliberately emptied their roster — it must stay empty",
      ).toEqual([]);
      // The sibling decisions are untouched by that deletion.
      expect(raw.policy?.exclude?.slice().sort()).toEqual([...PRIOR_EXCLUDE].sort());
      expect(raw.dispatch_bias).toBe(0.4);
    });
  });

  test("OMITTED host_models ⇒ the roster IS carried forward", () => {
    const carried = carryForwardConfirmationInput(
      parseProviderConfirmationInput({
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        capability_order: ["model-alpha"],
      }),
      buildPrior(),
    );
    expect(carried.host_models).toEqual([{ model_id: "host-beta" }]);
  });

  test("the same undefined-vs-[] rule holds for cost_order and exclude", () => {
    const prior = buildPrior();
    const emptied = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION, cost_order: [], exclude: [] },
      prior,
    );
    expect(emptied.cost_order).toEqual([]);
    expect(emptied.exclude).toEqual([]);

    const omitted = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION },
      prior,
    );
    expect(omitted.cost_order?.length).toBeGreaterThan(0);
    expect(omitted.exclude?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Exclusions specifically — losing one is a fail-OPEN
// ---------------------------------------------------------------------------

describe("prior exclusions survive a submission that names no `exclude`", () => {
  test("carried forward verbatim at the function seam", () => {
    const carried = carryForwardConfirmationInput(
      {
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        capability_order: ["model-alpha"],
      },
      buildPrior(),
    );
    expect(
      carried.exclude?.slice().sort(),
      "an exclusion is a durable RULE; rebuilding the list from the submission alone " +
        "is what let a capability-only answer silently lift it",
    ).toEqual([...PRIOR_EXCLUDE].sort());
  });

  test("both exclusion TIERS survive — provider-name and endpoint-host", () => {
    const carried = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION },
      buildPrior(PRIOR_INPUT, [
        "agy", // provider tier
        "openai-compatible:model-alpha", // transport:model tier
        "integrate.api.nvidia.com", // endpoint tier (head is NOT a provider name)
      ]),
    );
    expect(carried.exclude?.slice().sort()).toEqual([
      "agy",
      "integrate.api.nvidia.com",
      "openai-compatible:model-alpha",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Precedence — an incoming field always WINS
// ---------------------------------------------------------------------------

describe("carry-forward fills gaps, never overrides", () => {
  test("every incoming field beats its carried counterpart", () => {
    // ⚠ `capability_order` is the ONE exception, and it is deliberate (BL-1). This
    // assertion used to read `toEqual(["model-gamma"])` — incoming REPLACES carried,
    // exactly like every other field. That was the livelock: the capability prompt is
    // delta-scoped (it renders only the unevidenced models, and must, because the
    // roster may be hundreds of models), so an incoming capability answer is a PARTIAL
    // answer by construction and letting it replace the ordering erased every rank the
    // operator gave before. The models it erased came straight back as the next delta,
    // and `provider_confirmation` is PRIORITY[0]. See `mergeCapabilityOrder`.
    // The other six fields are unchanged: incoming still wins outright.
    const carried = carryForwardConfirmationInput(
      {
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        cost_order: ["openai-compatible", "host-beta"],
        capability_order: ["model-gamma"],
        host_models: [{ model_id: "host-delta" }],
        exclude: ["codex"],
        include: ["claude-code"],
        dispatch_bias: 0.9,
      },
      buildPrior(),
    );
    expect(carried.cost_order).toEqual(["openai-compatible", "host-beta"]);
    expect(
      carried.capability_order,
      "the incoming answer is MERGED by anchored insertion, not substituted: " +
        "`model-gamma` is an anchor, so it holds its confirmed position and the two " +
        "models the submission said nothing about keep theirs",
    ).toEqual(["model-alpha", "host-beta", "model-gamma"]);
    expect(carried.host_models).toEqual([{ model_id: "host-delta" }]);
    expect(carried.exclude).toEqual(["codex"]);
    expect(carried.include).toEqual(["claude-code"]);
    expect(carried.dispatch_bias).toBe(0.9);
  });

  test("a partial submission mixes: named fields win, silent fields are seeded", () => {
    const carried = carryForwardConfirmationInput(
      {
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        dispatch_bias: 0.1,
      },
      buildPrior(),
    );
    expect(carried.dispatch_bias, "named ⇒ wins").toBe(0.1);
    expect(carried.host_models, "silent ⇒ seeded").toEqual([{ model_id: "host-beta" }]);
  });

  test("an incoming dispatch_bias of 0 is honored, not treated as absent", () => {
    const carried = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION, dispatch_bias: 0 },
      buildPrior(),
    );
    expect(
      carried.dispatch_bias,
      "0 is the cost-first operating point — a falsiness test would silently restore 0.4",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. First-time — no prior confirmation at all
// ---------------------------------------------------------------------------

describe("no prior confirmation: the input passes through untouched", () => {
  test("a submission is returned unchanged (same value, nothing invented)", () => {
    const input = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      capability_order: ["model-alpha"],
    };
    expect(carryForwardConfirmationInput(input, null)).toBe(input);
    expect(carryForwardConfirmationInput(input, undefined)).toEqual(input);
  });

  test("null stays null — a first-time headless run synthesizes nothing", () => {
    expect(
      carryForwardConfirmationInput(null, null),
      "with nothing on either side there is no decision to carry",
    ).toBeNull();
  });

  test("end to end: a first confirmation writes exactly what was submitted", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(
        join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
        JSON.stringify({
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          capability_order: ["model-gamma"],
        }),
        "utf8",
      );
      await promote(root, artifactsDir);
      const raw = await readPersisted(root);
      // `policy` is no longer undefined here: the operator's RAW capability answer is
      // persisted there by design (that is what stops the next carry-forward having to
      // re-derive it from ranks and laundering external evidence in). So assert the
      // real property — nothing was INVENTED — field by field, rather than asserting
      // the whole policy block is absent.
      expect(raw.policy?.exclude, "nothing to carry ⇒ no exclusions invented").toBeUndefined();
      expect(
        raw.policy?.auto_exclude,
        "no gate delta ⇒ no auto-exclusion invented",
      ).toBeUndefined();
      expect(raw.policy?.include, "nothing to carry ⇒ no include invented").toBeUndefined();
      expect(
        raw.policy?.capability_order,
        "the operator's answer IS persisted verbatim — that is the point",
      ).toEqual(["model-gamma"]);
      expect(raw.host_model_cost_order).toBeUndefined();
      expect(raw.dispatch_bias).toBeUndefined();
      expect((await readConfirmedCapabilityRanks(root)).get("model-gamma")).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 7b. REGRESSION — `include` was the sixth face, and it survived one call site
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. `runProviderConfirmationAutoComplete` threaded
// `effectiveInput` into every field of the rebuild EXCEPT `include`, which still read
// `input?.include ?? []` — the RAW submission. So a capability-only answer carried the
// operator's exclusions forward correctly and silently destroyed their `include`.
//
// This one fails CLOSED (a self-spawn-blocked provider the operator deliberately opted
// back in quietly drops out of the dispatchable pool again), which is why it outlived
// the fix for its five siblings: nothing misroutes, the pool just silently shrinks and
// the operator is never told.
//
// ⚠ This test MUST drive the real executor. Every other test in this file goes through
// the local `promote()` helper, which mirrors the executor's body — and a mirror cannot
// detect a defect in the thing it mirrors. Reverting the call site to
// `input?.include ?? []` was confirmed to turn this test RED, and restoring it GREEN.
// Do NOT reroute this test through `promote()`.
describe("REGRESSION: a capability-only submission preserves policy.include", () => {
  test("the operator's opt-back-in survives the real executor, on disk", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      // The prior decision: `claude-code` is self-spawn-blocked inside a Claude Code
      // session, and the operator deliberately ruled it back IN.
      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation(
          CONFIG,
          CLEAN_ENV,
          PRIOR_EXCLUDE,
          ["claude-code"],
          NO_CLI,
          PRIOR_INPUT,
          SOURCES,
        ),
      );
      expect(
        (await readSharedProviderConfirmation(root)).policy?.include,
        "precondition: the prior confirmation really does carry the opt-back-in",
      ).toEqual(["claude-code"]);

      // The operator answers EXACTLY what the Gate-0 capability prompt asks for.
      await writeFile(
        join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
        JSON.stringify({
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          capability_order: ["model-gamma", "model-alpha", "host-beta"],
        }),
        "utf8",
      );

      // `bundle` is only spread into the result, so `{}` is a faithful stand-in.
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, CONFIG);

      const raw = await readPersisted(root);
      expect(
        raw.policy?.include,
        "the submission said nothing about `include` — saying nothing is not a decision " +
          "to revoke it. Reverting the call site to `input?.include ?? []` makes this " +
          "assertion fail with `undefined`.",
      ).toEqual(["claude-code"]);

      // The five already-fixed faces must not regress alongside it.
      expect(raw.policy?.exclude?.slice().sort()).toEqual([...PRIOR_EXCLUDE].sort());
      expect((raw.host_model_cost_order ?? []).map((e) => e.model_id)).toEqual([
        "host-beta",
      ]);
      expect(raw.dispatch_bias).toBe(0.4);
      // …and the answer the operator DID give was applied. Keyed on the models this
      // executor genuinely has: it derives its OWN sources from session config
      // (`gatherDispatchableSources`) rather than taking the `SOURCES` fixture, so
      // `model-alpha` (the configured openai-compatible model) and `host-beta` (the
      // carried host roster) are the two that exist here.
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks.get("model-alpha")).toBeDefined();
      expect(ranks.get("host-beta")).toBeDefined();
      expect(
        ranks.get("model-alpha"),
        "the operator ordered model-alpha ahead of host-beta; LOWER rank = more capable",
      ).toBeLessThan(ranks.get("host-beta"));
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Key ordering — the two reconstructions use DIFFERENT keyspaces, deliberately
// ---------------------------------------------------------------------------

// `cost_order` is reconstructed over the CANDIDATE keyspace (provider NAME for a
// provider pool, `model_id` for a host tier, `source_id` for a source pool) while
// `capability_order` is reconstructed over the MODEL keyspace at every hop. Unifying
// them would silently drop every provider pool's cost position (a provider entry is
// cost-keyed by NAME) or emit capability keys the model-keyed dispatch read can never
// join. The reconstruction must therefore ROUND-TRIP: carry an untouched confirmation
// forward and rebuild it, and every position must land where it was.
describe("key ordering: cost_order (candidate keyspace) vs capability_order (model keyspace)", () => {
  test("the reconstruction round-trips: positions are preserved through carry → rebuild", async () => {
    await withTempRoot(async (root) => {
      await writeSharedProviderConfirmation(root, buildPrior());
      const costBefore = [...(await readConfirmedCostPositions(root)).entries()].sort();
      const capBefore = [...(await readConfirmedCapabilityRanks(root)).entries()].sort();

      // An EMPTY submission — everything must come from the carry-forward.
      const prior = await readSharedProviderConfirmation(root);
      const carried = carryForwardConfirmationInput(
        { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION },
        prior,
      );
      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation(
          CONFIG,
          CLEAN_ENV,
          carried.exclude ?? [],
          carried.include ?? [],
          NO_CLI,
          carried,
          SOURCES,
        ),
      );

      expect(
        [...(await readConfirmedCostPositions(root)).entries()].sort(),
        "cost keys are provider NAME / host model_id / source_id — reconstructing them " +
          "over the model keyspace would drop every provider pool's position",
      ).toEqual(costBefore);
      expect(
        [...(await readConfirmedCapabilityRanks(root)).entries()].sort(),
        "capability keys are the MODEL id at every hop — that is the only keyspace the " +
          "dispatch join can satisfy",
      ).toEqual(capBefore);
    });
  });

  test("the two carried lists are genuinely different keyspaces, not a copy", () => {
    const carried = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION },
      buildPrior(),
    );
    // Provider pools appear in cost_order under their provider NAME…
    expect(carried.cost_order).toContain("openai-compatible");
    // …and a source under its SOURCE ID…
    expect(carried.cost_order).toContain("gamma-src");
    // …while capability_order names the same two pools by MODEL id.
    expect(carried.capability_order).toContain("model-alpha");
    expect(carried.capability_order).toContain("model-gamma");
    expect(carried.capability_order).not.toContain("openai-compatible");
    expect(carried.capability_order).not.toContain("gamma-src");
  });

  test("carried cost_order is rank-ascending and de-duplicated", () => {
    const carried = carryForwardConfirmationInput(
      { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION },
      buildPrior(),
    );
    expect(new Set(carried.cost_order).size).toBe(carried.cost_order.length);
    // The operator put the host tier first; that must still be the head after a
    // reconstruction, or the carried order is not the confirmed one.
    expect(carried.cost_order[0]).toBe("host-beta");
  });
});

// ---------------------------------------------------------------------------
// 9. PROVENANCE — the two defects that only appear on the SECOND promotion
// ---------------------------------------------------------------------------

// ⚠ Every test below drives the REAL executor across TWO SUCCESSIVE promotions.
// Both defects were invisible to every pre-existing test because each of those
// exercises exactly ONE promotion on top of a hand-built prior — and a provenance
// defect is, by construction, a defect in what the SECOND promotion reads back off
// disk. A single-promotion test cannot see it, and neither can the local `promote()`
// mirror (it does not carry the executor's `autoExclude` split at all).
// Do NOT reroute these through `promote()`.

/** The executor's gate object. MUTABLE (the executor clears it) ⇒ a fresh one per use. */
// ATTENDED gate: these fixtures construct OPERATOR submissions, and R3-3 made the
// flag meaningful — on an autonomous gate a submission is LLM-authored and the
// executor strips its operator-only fields. Tests that mean an LLM submission pass
// an explicit `autonomous: true` gate inline.
const gateWith = (newlyReachable = []) => ({ newlyReachable, autonomous: false });

const NEW_BACKEND = {
  key: "brand-new-model",
  transport: "openai-compatible",
  exclusion_pattern: "openai-compatible:brand-new-model",
};

async function writeInputFile(artifactsDir, body) {
  await writeFile(
    join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
    JSON.stringify({ schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION, ...body }),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// B1 — a GATE-authored exclusion must never become permanent operator policy
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. Reverting `runProviderConfirmationAutoComplete` to the
// merged form — passing `[...exclude, ...autoExclude]` as the builder's `exclude`
// argument and `[]` as its `autoExclude` — turns the assertions below RED; restoring
// the split turns them GREEN.
//
// The defect: the gate's fail-closed pattern is a PLACEHOLDER for an answer the
// operator never gave. Merged into `policy.exclude` it is indistinguishable from a
// rule they authored, so `carryForwardConfirmationInput` reseeds it on the next
// promotion and the tool's guess becomes permanent — silently, because by then the
// backend is a confirmed key and the reconciliation delta never re-surfaces it.
describe("B1 PROVENANCE: an AUTO exclusion is superseded by the next submission; an OPERATOR one is not", () => {
  test("promotion 1 records it as auto_exclude; promotion 2 supersedes it, and the operator's own exclusion survives", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      // A prior decision carrying an OPERATOR-authored exclusion. This is the contrast
      // case: without it the test could pass vacuously by the carry-forward dropping
      // *every* exclusion rather than only the gate's placeholder.
      await writeSharedProviderConfirmation(root, buildPrior(PRIOR_INPUT, ["agy"]));

      // ── Promotion 1: AUTONOMOUS (no input file) with a delta on the gate ────────
      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, gateWith([NEW_BACKEND]),
      );

      const afterFirst = await readPersisted(root);
      expect(
        afterFirst.policy?.auto_exclude,
        "the gate authored this one — it must land in the provenance-tagged list",
      ).toEqual([NEW_BACKEND.exclusion_pattern]);
      expect(
        afterFirst.policy?.exclude ?? [],
        "merging it into the operator's list is what makes a tool guess permanent: " +
          "the carry-forward can no longer tell the two apart",
      ).not.toContain(NEW_BACKEND.exclusion_pattern);
      expect(
        afterFirst.policy?.exclude,
        "precondition for the contrast half: the operator's own rule really is here",
      ).toEqual(["agy"]);
      // Separating them weakens NOTHING at dispatch — both provenances still bite.
      expect(
        resolveDispatchExclusion(
          await readConfirmedDispatchPolicy(root),
          CLEAN_ENV,
        ).excludes({ transport: "openai-compatible", model: "brand-new-model" }),
        "the split governs LIFETIME, never enforcement",
      ).toBe(true);

      // ── Promotion 2: the operator submits a CAPABILITY-ONLY answer ─────────────
      //
      // ⚠ This half previously asserted the auto-exclusion was GONE here. That was the
      // round-3 fail-OPEN: `confirmedBackendKeys` counts an excluded entry as confirmed,
      // so the reach delta is empty from promotion 1 onward and `auto_exclude` was being
      // rebuilt from that empty delta — silently re-admitting a backend the operator
      // never confirmed. Worse on this exact path: the reach section no longer renders,
      // so the operator is never SHOWN the backend whose exclusion their capability
      // answer would be lifting. Silence is not confirmation.
      await writeInputFile(artifactsDir, {
        capability_order: ["model-gamma", "model-alpha", "host-beta"],
      });
      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, gateWith(),
      );

      const afterSecond = await readPersisted(root);
      expect(
        afterSecond.policy?.auto_exclude,
        "this submission says NOTHING about the backend, so the exclusion must SURVIVE",
      ).toEqual([NEW_BACKEND.exclusion_pattern]);
      expect(
        afterSecond.policy?.exclude ?? [],
        "surviving is not the same as being laundered — it stays provenance-tagged",
      ).not.toContain(NEW_BACKEND.exclusion_pattern);
      expect(
        afterSecond.policy?.exclude,
        "THE CONTRAST: an operator-authored exclusion is a durable RULE — losing it " +
          "here would be a fail-OPEN, and its survival is what stops this test passing " +
          "vacuously",
      ).toEqual(["agy"]);
      // …and it still BITES. A retained placeholder that stopped enforcing would be the
      // same fail-open wearing a different hat.
      expect(
        resolveDispatchExclusion(
          await readConfirmedDispatchPolicy(root),
          CLEAN_ENV,
        ).excludes({ transport: "openai-compatible", model: "brand-new-model" }),
        "retention is worthless unless it still rules the backend out",
      ).toBe(true);
    });
  });

  // The other half of the rule: a submission that ACTUALLY addresses the backend does
  // supersede the placeholder. Without this case the fix above could be "never clear
  // auto_exclude", which would strand a tool guess as permanent policy — the mirror-image
  // defect the provenance split exists to prevent.
  test("an OPT-BACK-IN supersedes the placeholder: the backend becomes dispatchable again", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeSharedProviderConfirmation(root, buildPrior(PRIOR_INPUT, ["agy"]));

      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, gateWith([NEW_BACKEND]),
      );
      expect((await readPersisted(root)).policy?.auto_exclude).toEqual([
        NEW_BACKEND.exclusion_pattern,
      ]);

      // The operator names the provider in `include` — an explicit decision about THIS
      // backend, which is exactly what the placeholder was standing in for.
      //
      // R3-3: the gate is ATTENDED here, deliberately — an opt-back-in is an OPERATOR
      // decision. The identical submission on an autonomous gate is LLM-authored and
      // gets its `include` STRIPPED (the sanitize test below) rather than honored.
      await writeInputFile(artifactsDir, { include: ["openai-compatible"] });
      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, { newlyReachable: [], autonomous: false },
      );

      const after = await readPersisted(root);
      expect(
        after.policy?.auto_exclude ?? [],
        "the operator answered the question the placeholder was holding open",
      ).not.toContain(NEW_BACKEND.exclusion_pattern);
      expect(
        resolveDispatchExclusion(
          await readConfirmedDispatchPolicy(root),
          CLEAN_ENV,
        ).excludes({ transport: "openai-compatible", model: "brand-new-model" }),
        "and the backend really is routable again — not merely untagged",
      ).toBe(false);
    });
  });

  // R3-3 SANITIZE: the reviewer-found exploit, pinned. Round 1 fail-closed-excludes a
  // backend on an autonomous run; round 2's LLM-authored ranking answer smuggles the
  // exact `include` (plus an `exclude`) that would supersede the placeholder. The
  // executor must strip every operator-only field from an LLM-authored submission —
  // honoring the capability_order alone — and say so in the progress summary. Without
  // the sanitize, `retainAutoExclusions` reads the raw input, drops the placeholder,
  // and a backend no human ever confirmed becomes dispatchable.
  test("an LLM-authored submission's include/exclude are STRIPPED: the fail-closed placeholder survives", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeSharedProviderConfirmation(root, buildPrior(PRIOR_INPUT, ["agy"]));

      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, { newlyReachable: [NEW_BACKEND], autonomous: true },
      );
      expect((await readPersisted(root)).policy?.auto_exclude).toEqual([
        NEW_BACKEND.exclusion_pattern,
      ]);

      // The LLM answers the ranking question — and "helpfully" opts the excluded
      // backend back in. Autonomous gate ⇒ authoredByLlm ⇒ everything but
      // capability_order must be dropped, loudly.
      await writeInputFile(artifactsDir, {
        capability_order: ["model-gamma", "model-alpha", "host-beta"],
        include: ["openai-compatible"],
        exclude: ["agy"],
      });
      const result = await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, CONFIG, { newlyReachable: [], autonomous: true },
      );

      const after = await readPersisted(root);
      expect(
        after.policy?.auto_exclude,
        "the LLM's include must NOT supersede the placeholder — only an attended " +
          "operator submission may (the contrast test above)",
      ).toEqual([NEW_BACKEND.exclusion_pattern]);
      expect(
        resolveDispatchExclusion(
          await readConfirmedDispatchPolicy(root),
          CLEAN_ENV,
        ).excludes({ transport: "openai-compatible", model: "brand-new-model" }),
        "and the backend really is still ruled out at dispatch",
      ).toBe(true);
      expect(
        after.policy?.exclude,
        "the LLM's exclude must not restate/replace the operator's list either way — " +
          "the operator's own rule survives untouched",
      ).toEqual(["agy"]);
      expect(
        after.policy?.capability_order,
        "the one question the LLM WAS asked still promotes",
      ).toContain("model-gamma");
      expect(
        result.progress_summary,
        "stripping must be loud — silent stripping leaves the host believing its " +
          "include took effect",
      ).toContain("Dropped operator-only field(s)");
    });
  });
});

// ---------------------------------------------------------------------------
// B2 — EXTERNAL evidence must not be laundered into the operator's answer
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. Reverting `carryForwardConfirmationInput` to reconstruct
// `priorCapabilityOrder` from the persisted `capability_rank`s (walking provider_pool
// + host_model_cost_order + source_pool_cost_order through `sortRankedKeys`) instead
// of reading `prior.policy.capability_order` verbatim turns both tests below RED;
// restoring the verbatim read turns them GREEN.
//
// The defect: a reconstruction cannot tell an operator-authored rank from EXTERNAL
// evidence (a source's own registry rank, which `annotateConfirmedPool` persists into
// `source_pool_cost_order[].capability_rank`). So the external number was read back as
// if the operator had said it — a genuine NO-OP promotion silently re-ranked the models
// they DID confirm, and the laundered id then read as evidenced forever, surviving even
// the disappearance of the evidence it came from.
describe("B2 PROVENANCE: external capability evidence never becomes the operator's answer", () => {
  const HOST = [{ model_id: "host-beta" }];
  const OPERATOR_ORDER = ["model-alpha", "host-beta"];
  // The external rank is 0 deliberately: it sorts AHEAD of the operator's own
  // head-of-list, so a reconstruction that folds it in shifts EVERY confirmed rank. An
  // external rank that happened to sort last would leave the operator's positions
  // coincidentally intact and the test would pass under the defect.
  const EXTERNAL_MODEL = "ext-registry-model";

  const source = (id, model, extra = {}) => ({
    id,
    transport: "openai-compatible",
    endpoint: `http://${id}.local/v1`,
    model,
    ...extra,
  });

  // `provider: "claude-code"` keeps the primary fold inert (a conversation host is
  // never a dispatchable SOURCE), so the executor gathers exactly these sources.
  const configWith = (sources) => ({ provider: "claude-code", sources });

  const WITH_EXTERNAL = configWith([
    source("alpha-src", "model-alpha"),
    source("ext-src", EXTERNAL_MODEL, { capability_rank: 0 }),
  ]);
  const WITHOUT_EXTERNAL = configWith([
    source("alpha-src", "model-alpha"),
    source("ext-src", EXTERNAL_MODEL),
  ]);

  /** Promotion 1: the operator's real answer, through the real executor. */
  async function seed(root, artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    await writeInputFile(artifactsDir, {
      host_models: HOST,
      capability_order: OPERATOR_ORDER,
    });
    await runProviderConfirmationAutoComplete(
      {}, root, artifactsDir, WITH_EXTERNAL, gateWith(),
    );
  }

  test("a NO-OP promotion re-ranks nothing, and the externally-ranked model stays out of the operator's answer", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await seed(root, artifactsDir);

      const before = await readConfirmedCapabilityRanks(root);
      expect(
        [before.get("model-alpha"), before.get("host-beta")],
        "precondition: the operator's positional answer became ranks 0 and 1",
      ).toEqual([0, 1]);
      expect(
        before.get(EXTERNAL_MODEL),
        "precondition: the source's OWN registry rank is persisted and read back — " +
          "that is the number the reconstruction was laundering",
      ).toBe(0);

      // ── Promotion 2: a genuine no-op. The operator says NOTHING. ───────────────
      await writeInputFile(artifactsDir, {});
      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, WITH_EXTERNAL, gateWith(),
      );

      const after = await readConfirmedCapabilityRanks(root);
      expect(
        after.get("model-alpha"),
        "a no-op promotion must not re-rank a model the operator confirmed — the " +
          "reconstruction folded the external rank 0 in ahead of it and shifted it down",
      ).toBe(0);
      expect(after.get("host-beta"), "same, one position down the operator's list").toBe(1);

      const raw = await readPersisted(root);
      expect(
        raw.policy?.capability_order,
        "the operator's RAW answer, verbatim — an external registry number is not " +
          "something they said",
      ).toEqual(OPERATOR_ORDER);
      expect(
        raw.policy?.capability_order ?? [],
        "laundering it in here is what made it read as operator-confirmed forever",
      ).not.toContain(EXTERNAL_MODEL);
    });
  });

  test("when the external evidence disappears, the model is UNEVIDENCED again — not permanently confirmed", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await seed(root, artifactsDir);

      // The source config no longer carries a registry rank for it (a roster change, an
      // endpoint swap — the evidence is simply gone). Promote again, saying nothing.
      await writeInputFile(artifactsDir, {});
      await runProviderConfirmationAutoComplete(
        {}, root, artifactsDir, WITHOUT_EXTERNAL, gateWith(),
      );

      const delta = await resolveUnevidencedCapabilityPools(root, WITHOUT_EXTERNAL);
      expect(
        delta,
        "with the evidence gone there is NO evidence: the capability floor would fail " +
          "OPEN on it. Reconstructing the operator's answer from ranks made the vanished " +
          "external number self-perpetuating — the model read as pinned by an operator " +
          "who never named it.",
      ).toContain(EXTERNAL_MODEL);
      // The discriminating half: the models the operator DID confirm stay evidenced, so
      // the assertion above is the laundering talking and not a blanket wipe.
      expect(delta).not.toContain("model-alpha");
      expect(delta).not.toContain("host-beta");
    });
  });
});

// ---------------------------------------------------------------------------
// 10. BL-1 — the DELTA-SCOPED PROMPT vs TOTAL-REPLACEMENT livelock
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. Replacing the merge in `carryForwardConfirmationInput` with
// the previous total-replacement line —
//   `...(base.capability_order === undefined && priorCapabilityOrder.length > 0
//        ? { capability_order: priorCapabilityOrder } : {})`
// — turns "the delta reaches []" RED (it reports the models the prior answer ranked and
// this one did not restate); restoring `mergeCapabilityOrder` turns it GREEN.
//
// The defect: the capability prompt renders ONLY the unevidenced models — it is a
// delta-scoped ask by construction, and it must stay that way because the roster may be
// hundreds of models. But the answer was taken as the WHOLE ordering, so every answer
// erased the last: rank A, the delta asks C, rank C, A loses its rank, the delta asks A,
// forever. `provider_confirmation` is PRIORITY[0], so the run never advances.

const {
  mergeCapabilityOrder,
  selectCapabilityAnchors,
  DEFAULT_CAPABILITY_ANCHOR_COUNT,
  advanceCapabilityOrderLlmRanked,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

describe("R3-3: the total-replacement escape is OPERATOR-only", () => {
  // On a small roster the anchor sample can cover the ENTIRE prior ordering, so an
  // LLM answer over "new models + all anchors" is total by coverage. Honoring it
  // verbatim would let the LLM silently reorder operator ranks through the escape
  // hatch; the escape is therefore authorship-gated, and the LLM path treats prior
  // ids as immovable anchors with the attempted reorder detected and reported.
  test("an LLM-authored TOTAL submission does NOT replace — prior order holds, new ids interpolate", () => {
    expect(
      mergeCapabilityOrder(["a", "b"], ["b", "a", "x"], new Set(), true),
      "b/a reorder must be discarded; only x is the LLM's to place",
    ).toEqual(["a", "x", "b"]);
  });

  test("the same LLM-authored total submission's anchor reorder is REPORTED, not silent", () => {
    expect(
      detectDiscardedCapabilityReorder(["a", "b"], ["b", "a", "x"], new Set(), true).length,
      "merge did not honor the reorder, so the discard report must say so",
    ).toBeGreaterThan(0);
  });

  test("an OPERATOR total submission keeps the pre-existing verbatim-replacement behavior", () => {
    expect(mergeCapabilityOrder(["a", "b"], ["b", "a", "x"], new Set(), false)).toEqual([
      "b",
      "a",
      "x",
    ]);
    expect(detectDiscardedCapabilityReorder(["a", "b"], ["b", "a", "x"], new Set(), false)).toEqual([]);
  });

  test("LLM authorship-set advance marks ONLY genuinely new ids, even on a total answer", () => {
    expect(
      advanceCapabilityOrderLlmRanked([], ["a", "b"], ["b", "a", "x"], true),
      "a and b stay operator-authored — the LLM never moved them",
    ).toEqual(["x"]);
  });
});

describe("mergeCapabilityOrder: anchored insertion", () => {
  test("a model the submission never mentions KEEPS its prior rank (the livelock fix)", () => {
    expect(
      mergeCapabilityOrder(["a", "b", "c", "d"], ["a", "e", "d"]),
      "b and c were not restated — dropping them is what re-created the delta forever",
    ).toEqual(["a", "b", "e", "c", "d"]);
  });

  test("a new model before the first anchor lands above it", () => {
    expect(mergeCapabilityOrder(["a", "b", "c"], ["x", "b"])).toEqual([
      "a",
      "x",
      "b",
      "c",
    ]);
  });

  test("a new model after the last anchor lands below it", () => {
    expect(mergeCapabilityOrder(["a", "b", "c"], ["c", "x"])).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
  });

  test("consecutive new models keep their SUBMITTED relative order", () => {
    expect(mergeCapabilityOrder(["a", "d"], ["a", "x", "y", "z", "d"])).toEqual([
      "a",
      "x",
      "y",
      "z",
      "d",
    ]);
  });

  test("reordering ANCHORS against each other is NOT honored on a partial submission", () => {
    // The operator saw a sample of a possibly enormous ordering; a swap between two
    // anchors says nothing about the models between them.
    expect(mergeCapabilityOrder(["a", "b", "c", "d"], ["d", "a"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("a new model between REORDERED anchors still gets a determinate slot", () => {
    // Inverted span ⇒ degrade to "just after the preceding anchor", never descending
    // positions.
    expect(mergeCapabilityOrder(["a", "b", "c", "d"], ["d", "x", "a"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "x",
    ]);
  });

  test("a TOTAL submission IS honored verbatim — that is the only well-defined re-rank", () => {
    expect(mergeCapabilityOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      "c",
      "a",
      "b",
    ]);
    // …and a superset counts as total too.
    expect(mergeCapabilityOrder(["a", "b"], ["b", "x", "a"])).toEqual(["b", "x", "a"]);
  });

  test("NO anchors at all ⇒ the new models append after the whole prior ordering", () => {
    expect(
      mergeCapabilityOrder(["a", "b"], ["x", "y"]),
      "no coordinate to interpolate against; appending is conservative (less trusted)",
    ).toEqual(["a", "b", "x", "y"]);
  });

  test("empty prior order ⇒ the submission IS the ordering (first-ever answer)", () => {
    expect(mergeCapabilityOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("empty submission ⇒ the prior ordering is returned unchanged", () => {
    expect(mergeCapabilityOrder(["a", "b"], [])).toEqual(["a", "b"]);
    expect(mergeCapabilityOrder([], [])).toEqual([]);
  });

  test("a submitted id appearing twice: FIRST occurrence wins", () => {
    expect(mergeCapabilityOrder([], ["a", "b", "a"])).toEqual(["a", "b"]);
    expect(mergeCapabilityOrder(["p", "q"], ["p", "x", "x", "q"])).toEqual([
      "p",
      "x",
      "q",
    ]);
  });

  test("the result is deterministic and lossless", () => {
    const a = mergeCapabilityOrder(["p", "q"], ["p", "m", "q"]);
    const b = mergeCapabilityOrder(["p", "q"], ["p", "m", "q"]);
    expect(a).toEqual(b);
    expect(new Set(a).size, "no model is duplicated or lost").toBe(a.length);
  });

  test("neither input is mutated", () => {
    const prior = ["a", "b"];
    const submitted = ["b", "x"];
    mergeCapabilityOrder(prior, submitted);
    expect(prior).toEqual(["a", "b"]);
    expect(submitted).toEqual(["b", "x"]);
  });
});

describe("selectCapabilityAnchors: bounded and spread, never O(roster)", () => {
  test("a huge ordering yields at most the default anchor count", () => {
    const roster = Array.from({ length: 400 }, (_, i) => `m${String(i).padStart(3, "0")}`);
    const anchors = selectCapabilityAnchors(roster, []);
    expect(anchors.length).toBe(DEFAULT_CAPABILITY_ANCHOR_COUNT);
    // Endpoints included, so the operator sees the top and the bottom of the ranking.
    expect(anchors[0]).toBe(roster[0]);
    expect(anchors.at(-1)).toBe(roster.at(-1));
    // Spread, not clustered.
    expect(anchors).toEqual(["m000", "m100", "m200", "m299", "m399"]);
  });

  test("anchors preserve confirmed order and never include a model under question", () => {
    const anchors = selectCapabilityAnchors(["a", "b", "c"], ["b"]);
    expect(anchors, "an anchor must be settled, not the thing being ranked").toEqual([
      "a",
      "c",
    ]);
  });

  test("a short ordering is returned whole; an empty one yields nothing", () => {
    expect(selectCapabilityAnchors(["a", "b"], [])).toEqual(["a", "b"]);
    expect(selectCapabilityAnchors([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The headline: the REAL executor, real files, TWO successive deltas, each
// answered PARTIALLY. This is the exact case every prior round missed.
// ---------------------------------------------------------------------------

describe("BL-1 REGRESSION: two successive PARTIAL answers still converge to an empty delta", () => {
  const src = (model) => ({
    id: `${model}-src`,
    transport: "openai-compatible",
    endpoint: `http://${model}.local/v1`,
    model,
  });
  // `provider: "claude-code"` keeps the primary fold inert, so the executor gathers
  // exactly these sources. None carries a `capability_rank` ⇒ all are unevidenced.
  const configWith = (models) => ({
    provider: "claude-code",
    sources: models.map(src),
  });

  const WAVE_1 = configWith(["m-a", "m-b", "m-c", "m-d"]);
  const WAVE_2 = configWith(["m-a", "m-b", "m-c", "m-d", "m-e"]);
  const WAVE_3 = configWith(["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"]);

  async function promoteWith(root, artifactsDir, config, body) {
    await writeInputFile(artifactsDir, body);
    await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, gateWith());
  }

  test("the delta reaches [] and STAYS empty across two delta→partial-answer rounds", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      // ── Promotion 1: a confirmation exists, nothing is ranked yet. ────────────
      await promoteWith(root, artifactsDir, WAVE_1, {});
      expect(
        await resolveUnevidencedCapabilityPools(root, WAVE_1),
        "precondition: four dispatchable models, no rank source covers any of them",
      ).toEqual(["m-a", "m-b", "m-c", "m-d"]);

      // ── Promotion 2: the operator ranks all four. ─────────────────────────────
      await promoteWith(root, artifactsDir, WAVE_1, {
        capability_order: ["m-a", "m-b", "m-c", "m-d"],
      });
      expect(await resolveUnevidencedCapabilityPools(root, WAVE_1)).toEqual([]);

      // ── DELTA 1: a fifth model appears. The prompt asks about IT ALONE. ───────
      expect(
        await resolveUnevidencedCapabilityPools(root, WAVE_2),
        "the delta is scoped to what changed — that is what makes it O(new)",
      ).toEqual(["m-e"]);

      // Answered PARTIALLY: the new model plus two anchors. `m-b` and `m-c` are not
      // restated — and under total replacement that is exactly where they lost their
      // ranks and came straight back as the next delta.
      await promoteWith(root, artifactsDir, WAVE_2, {
        capability_order: ["m-a", "m-e", "m-d"],
      });
      expect(
        await resolveUnevidencedCapabilityPools(root, WAVE_2),
        "PRIORITY[0] LIVELOCK: a partial answer must not un-rank the models it did " +
          "not restate. Non-empty here means the gate re-prompts forever.",
      ).toEqual([]);
      expect(
        (await readSharedProviderConfirmation(root)).policy.capability_order,
        "the merged ordering is what persists — it is the only thing the NEXT " +
          "promotion can merge against",
      ).toEqual(["m-a", "m-b", "m-e", "m-c", "m-d"]);

      // ── DELTA 2: a sixth model. Answered partially AGAIN. ─────────────────────
      expect(await resolveUnevidencedCapabilityPools(root, WAVE_3)).toEqual(["m-f"]);
      await promoteWith(root, artifactsDir, WAVE_3, {
        capability_order: ["m-a", "m-f"],
      });
      expect(
        await resolveUnevidencedCapabilityPools(root, WAVE_3),
        "the second partial answer must converge too — one round of convergence is " +
          "not convergence",
      ).toEqual([]);

      // Every model carries a rank, and they are all distinct positions.
      const ranks = await readConfirmedCapabilityRanks(root);
      const models = ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"];
      for (const model of models) {
        expect(ranks.get(model), `${model} must be ranked`).toEqual(expect.any(Number));
      }
      expect(new Set(models.map((m) => ranks.get(m))).size).toBe(models.length);
      // The operator's original relative judgement survived both partial answers.
      expect(ranks.get("m-a")).toBeLessThan(ranks.get("m-b"));
      expect(ranks.get("m-b")).toBeLessThan(ranks.get("m-c"));
      expect(ranks.get("m-c")).toBeLessThan(ranks.get("m-d"));
      // …and each new model landed where the answer placed it.
      expect(ranks.get("m-b")).toBeLessThan(ranks.get("m-e"));
      expect(ranks.get("m-e")).toBeLessThan(ranks.get("m-c"));
      expect(ranks.get("m-a")).toBeLessThan(ranks.get("m-f"));
      expect(ranks.get("m-f")).toBeLessThan(ranks.get("m-b"));
    });
  });

  test("a partial answer does not disturb the other confirmed decisions either", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await promoteWith(root, artifactsDir, WAVE_1, {
        capability_order: ["m-a", "m-b", "m-c", "m-d"],
        exclude: ["agy"],
        dispatch_bias: 0.4,
      });
      await promoteWith(root, artifactsDir, WAVE_2, {
        capability_order: ["m-a", "m-e", "m-d"],
      });
      const persisted = await readSharedProviderConfirmation(root);
      expect(persisted.policy.exclude).toEqual(["agy"]);
      expect(persisted.dispatch_bias).toBe(0.4);
    });
  });
});

// ---------------------------------------------------------------------------
// SILENT DISCARD: a reorder of already-ranked models is not honored — say so
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. Making `detectDiscardedCapabilityReorder` return `[]`
// unconditionally turns the consistency table and both end-to-end tests below RED;
// restoring it turns them GREEN.
//
// The defect: `mergeCapabilityOrder` treats every submitted id already present in the
// prior ordering as a FIXED anchor, so a partial submission that swaps two of them
// (prior `[a,b,c,d]`, submitted `[b,a]`) returns the prior order unchanged. The
// promotion then reported success and the artifact was byte-identical — nothing
// anywhere said the operator's decision had been dropped.
//
// The detector REPORTS that limitation; it does not lift it. So the property under
// test is not "the detector fires" but "the detector and the merge AGREE": a detector
// that reports phantoms, or misses a real discard, makes the warning untrustworthy,
// which is worse than no warning at all.

const { detectDiscardedCapabilityReorder } = await import(
  "../../src/shared/providers/sharedProviderConfirmation.ts"
);

/**
 * The independent oracle: run the REAL merge and observe, from its OUTPUT alone,
 * whether an anchor reorder was actually discarded. Deliberately does not consult the
 * detector's reasoning — it re-derives the fact from the merge's behavior, so the two
 * can be COMPARED rather than asserted to agree by construction.
 */
function analyzeDiscard(prior, submitted) {
  const key = (ids) => ids.join(" ");
  const priorUnique = [...new Set(prior)];
  const anchors = [...new Set(submitted)].filter((id) => priorUnique.includes(id));
  const anchorSet = new Set(anchors);
  const merged = mergeCapabilityOrder(prior, submitted);
  const anchorsAsPrior = priorUnique.filter((id) => anchorSet.has(id));
  const anchorsAsMerged = merged.filter((id) => anchorSet.has(id));
  // The submission asked for a different relative anchor order…
  const asksForReorder = key(anchors) !== key(anchorsAsPrior);
  // …and the merge came out with the PRIOR relative order regardless.
  const mergeKeptPriorOrder = key(anchorsAsMerged) === key(anchorsAsPrior);
  // The anchors that actually CHANGED position relative to the confirmed order —
  // derived from the merge's own operands (prior order ∩ anchors), never from the
  // detector. An anchor sitting at the same index in the submission as it does in the
  // confirmed anchor sequence did not move, so naming it would tell the operator an
  // untouched entry was dropped.
  const movedAnchors = anchors.filter((id, i) => id !== anchorsAsPrior[i]);
  return {
    detected: detectDiscardedCapabilityReorder(prior, submitted),
    anchors,
    movedAnchors,
    merged,
    asksForReorder,
    mergeKeptPriorOrder,
    actuallyDiscarded: asksForReorder && mergeKeptPriorOrder,
  };
}

const DISCARD_CASES = [
  {
    name: "a swap of two anchors is detected",
    prior: ["a", "b", "c", "d"],
    submitted: ["b", "a"],
    expected: ["b", "a"],
  },
  {
    name: "anchors restated in their confirmed order ask for nothing",
    prior: ["a", "b", "c", "d"],
    submitted: ["a", "b"],
    expected: [],
  },
  {
    name: "a submission that only APPENDS new models is not a reorder",
    prior: ["a", "b", "c"],
    submitted: ["a", "b", "c", "x", "y"],
    expected: [],
  },
  {
    name: "new models interleaved between in-order anchors are not a reorder",
    prior: ["a", "b", "c", "d"],
    submitted: ["a", "x", "d"],
    expected: [],
  },
  {
    name: "a TOTAL submission IS honored, so nothing is discarded",
    prior: ["a", "b", "c"],
    submitted: ["c", "b", "a"],
    expected: [],
  },
  {
    name: "a TOTAL submission plus a new model is still honored verbatim",
    prior: ["a", "b", "c"],
    submitted: ["c", "x", "b", "a"],
    expected: [],
  },
  {
    name: "fewer than two anchors cannot express a reorder",
    prior: ["a", "b", "c", "d"],
    submitted: ["c", "x"],
    expected: [],
  },
  {
    name: "an empty prior ordering (the first-ever answer) discards nothing",
    prior: [],
    submitted: ["b", "a"],
    expected: [],
  },
  {
    name: "an empty submission discards nothing",
    prior: ["a", "b", "c"],
    submitted: [],
    expected: [],
  },
  {
    name: "a submission naming only models absent from prior discards nothing",
    prior: ["a", "b", "c"],
    submitted: ["x", "y"],
    expected: [],
  },
  {
    name: "duplicates in an in-order submission do not create a phantom detection",
    prior: ["a", "b", "c", "d"],
    submitted: ["a", "a", "b", "b"],
    expected: [],
  },
  {
    name: "a repeated id does not mask a real reorder either",
    prior: ["a", "b", "c", "d"],
    submitted: ["b", "b", "a"],
    expected: ["b", "a"],
  },
  {
    name: "a reorder alongside a new model is detected (the new model still lands)",
    prior: ["a", "b", "c", "d"],
    submitted: ["b", "a", "x"],
    expected: ["b", "a"],
  },
  {
    name: "a three-way anchor rotation is detected",
    prior: ["a", "b", "c", "d", "e"],
    submitted: ["c", "a", "b"],
    expected: ["c", "a", "b"],
  },
  // ── NARROWING: report only the anchors that MOVED ────────────────────────────
  // Every row above happens to move EVERY anchor it names, so "report all anchors"
  // and "report the moved ones" are indistinguishable on them — which is exactly why
  // the narrowing landed unpinned. These rows separate the two.
  {
    name: "NARROWING: an unchanged LEADING anchor is not reported, only the pair that moved",
    prior: ["a", "b", "c", "d"],
    submitted: ["a", "c", "b"],
    expected: ["c", "b"],
  },
  {
    name: "NARROWING: an unchanged TRAILING anchor is not reported either",
    prior: ["a", "b", "c", "d"],
    submitted: ["c", "b", "d"],
    expected: ["c", "b"],
  },
  {
    name: "NARROWING: a leading RUN of unchanged anchors survives a later swap",
    prior: ["a", "b", "c", "d", "e", "f"],
    submitted: ["a", "b", "d", "c"],
    expected: ["d", "c"],
  },
];

describe("detectDiscardedCapabilityReorder: unit cases", () => {
  for (const { name, prior, submitted, expected } of DISCARD_CASES) {
    test(name, () => {
      expect(detectDiscardedCapabilityReorder(prior, submitted)).toEqual(expected);
    });
  }
});

describe("detectDiscardedCapabilityReorder AGREES with mergeCapabilityOrder", () => {
  for (const { name, prior, submitted } of DISCARD_CASES) {
    test(`consistency: ${name}`, () => {
      const a = analyzeDiscard(prior, submitted);
      expect(
        a.detected.length > 0,
        `detector said ${JSON.stringify(a.detected)} but the merge of ` +
          `${JSON.stringify(prior)} + ${JSON.stringify(submitted)} produced ` +
          `${JSON.stringify(a.merged)} (asksForReorder=${a.asksForReorder}, ` +
          `mergeKeptPriorOrder=${a.mergeKeptPriorOrder}). A phantom warning and a ` +
          `missed discard are both worse than no warning at all.`,
      ).toBe(a.actuallyDiscarded);
      if (a.detected.length > 0) {
        // The reported ids are exactly the anchors that MOVED, in the order the
        // operator asked for — the warning names what the tool declined to do, and
        // nothing else. An anchor the operator left in place was not "not applied".
        expect(a.detected).toEqual(a.movedAnchors);
        // Never a superset: an unchanged anchor must never appear.
        const unchanged = a.anchors.filter((id) => !a.movedAnchors.includes(id));
        for (const id of unchanged) {
          expect(
            a.detected,
            `"${id}" kept its confirmed position, so reporting it as discarded is false`,
          ).not.toContain(id);
        }
        // …and the claim is TRUE: the merge really did keep the confirmed order.
        expect(a.mergeKeptPriorOrder).toBe(true);
      }
    });
  }

  test("the table really does contain positive cases (else [] would pass every row)", () => {
    const detecting = DISCARD_CASES.filter(
      ({ prior, submitted }) =>
        detectDiscardedCapabilityReorder(prior, submitted).length > 0,
    );
    expect(detecting.length).toBeGreaterThan(0);
    for (const { prior, submitted } of detecting) {
      const a = analyzeDiscard(prior, submitted);
      const anchorSet = new Set(a.anchors);
      expect(a.merged.filter((id) => anchorSet.has(id))).toEqual(
        [...new Set(prior)].filter((id) => anchorSet.has(id)),
      );
    }
  });
});

describe("END TO END: a discarded reorder is reported by the real executor", () => {
  const src = (model) => ({
    id: `${model}-src`,
    transport: "openai-compatible",
    endpoint: `http://${model}.local/v1`,
    model,
  });
  // `provider: "claude-code"` keeps the primary fold inert, so the executor gathers
  // exactly these sources and none of them carries a rank.
  const configWith = (models) => ({ provider: "claude-code", sources: models.map(src) });

  const BASE = configWith(["m-a", "m-b", "m-c"]);
  const PLUS_NEW = configWith(["m-a", "m-b", "m-c", "m-d"]);

  async function promote(root, artifactsDir, config, body) {
    await writeInputFile(artifactsDir, body);
    return await runProviderConfirmationAutoComplete(
      {},
      root,
      artifactsDir,
      config,
      gateWith(),
    );
  }

  test("the summary names the affected models AND the artifact really is unchanged", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      // ── Promotion 1: establish a capability order over three models. ─────────
      await promote(root, artifactsDir, BASE, {
        capability_order: ["m-a", "m-b", "m-c"],
      });
      expect(
        (await readSharedProviderConfirmation(root)).policy.capability_order,
      ).toEqual(["m-a", "m-b", "m-c"]);

      // ── Promotion 2: a partial submission REORDERING two of them. ────────────
      const result = await promote(root, artifactsDir, BASE, {
        capability_order: ["m-c", "m-a"],
      });

      // The summary must name the models and say the reorder was not applied.
      expect(result.progress_summary).toContain("m-c");
      expect(result.progress_summary).toContain("m-a");
      expect(result.progress_summary).toMatch(/NOT applied/);
      expect(result.progress_summary).toMatch(/capability_order/);

      // …and the claim must be TRUE — the anchors kept their confirmed positions.
      const persisted = await readSharedProviderConfirmation(root);
      expect(
        persisted.policy.capability_order,
        "the warning describes a discard, so the artifact must actually show one",
      ).toEqual(["m-a", "m-b", "m-c"]);
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks.get("m-a")).toBeLessThan(ranks.get("m-c"));
    });
  });

  test("a NEW model in the same submission is still placed, exactly as the warning says", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      await promote(root, artifactsDir, BASE, {
        capability_order: ["m-a", "m-b", "m-c"],
      });
      // A fourth model appears; the operator answers with it AND a swapped anchor pair.
      expect(await resolveUnevidencedCapabilityPools(root, PLUS_NEW)).toEqual(["m-d"]);
      const result = await promote(root, artifactsDir, PLUS_NEW, {
        capability_order: ["m-c", "m-a", "m-d"],
      });

      expect(result.progress_summary).toMatch(/NOT applied/);
      expect(result.progress_summary).toMatch(/new models .* still placed/i);

      const persisted = await readSharedProviderConfirmation(root);
      // The anchor reorder was discarded…
      expect(
        persisted.policy.capability_order.filter((id) => id !== "m-d"),
        "the anchors keep their confirmed relative order",
      ).toEqual(["m-a", "m-b", "m-c"]);
      // …but the new model IS in the ordering, and IS ranked — verify the claim, do
      // not trust the string.
      expect(persisted.policy.capability_order).toContain("m-d");
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks.get("m-d"), "m-d must be ranked, not merely mentioned").toEqual(
        expect.any(Number),
      );
      expect(ranks.get("m-a")).toBeLessThan(ranks.get("m-d"));
      expect(ranks.get("m-d")).toBeLessThan(ranks.get("m-b"));
      // …and the gate converges: nothing is left unevidenced.
      expect(
        await resolveUnevidencedCapabilityPools(root, PLUS_NEW),
        "a discarded reorder must not also block convergence",
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// CO-OCCURRENCE: the summary ACCUMULATES — one outcome must not silence another
// ---------------------------------------------------------------------------

// ⚠ RED-GREEN VALIDATED. Reverting `renderConfirmationSummary` in
// src/audit/orchestrator/intakeExecutors.ts to its if/return chain (each branch
// `return message` instead of `parts.push(message)`) turns the co-occurrence test
// below RED; restoring the accumulate-then-join form turns it GREEN.
//
// The defect: a discarded anchor reorder and `unrankedOnPromotion` genuinely
// CO-OCCUR — an attended submission can reorder two already-ranked models while the
// same promotion clears a capability delta containing a model that submission never
// ranks. Under the chain the discard was reported FIRST and returned, so the
// no-evidence clearing went silent even though the gate cleared the delta regardless.
// Each of these lines exists precisely so the operator never has to notice; a line
// that suppresses its sibling defeats the other one.
describe("renderConfirmationSummary ACCUMULATES: co-occurring outcomes are ALL reported", () => {
  const src = (model) => ({
    id: `${model}-src`,
    transport: "openai-compatible",
    endpoint: `http://${model}.local/v1`,
    model,
  });
  // `provider: "claude-code"` keeps the primary fold inert, so the executor gathers
  // exactly these sources and none of them carries an external rank.
  const CONFIG_3 = {
    provider: "claude-code",
    sources: ["m-a", "m-b", "m-c"].map(src),
  };
  /** A model the capability gate flagged that no submission here ever ranks. */
  const UNRANKED = "m-unranked";

  /** Fresh gate per use — the executor MUTATES it (clears both deltas). */
  const gate = (unevidencedCapability = []) => ({
    newlyReachable: [],
    unevidencedCapability,
    autonomous: true,
  });

  async function promote(root, artifactsDir, body, gateObj = gate()) {
    await writeInputFile(artifactsDir, body);
    return await runProviderConfirmationAutoComplete(
      {},
      root,
      artifactsDir,
      CONFIG_3,
      gateObj,
    );
  }

  /** Promotion 1: establish a confirmed capability ordering over three models. */
  async function seed(root, artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    await promote(root, artifactsDir, { capability_order: ["m-a", "m-b", "m-c"] });
    expect(
      (await readSharedProviderConfirmation(root)).policy.capability_order,
      "the co-occurrence case needs a real prior ordering to reorder against",
    ).toEqual(["m-a", "m-b", "m-c"]);
  }

  test("a discarded reorder AND an unranked-on-promotion model are BOTH stated", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await seed(root, artifactsDir);

      // Promotion 2: the submission reorders two ALREADY-RANKED models (partial ⇒
      // discarded) while the gate carries a capability delta for a model the
      // submission never mentions (⇒ cleared with no evidence). Both at once.
      const g = gate([UNRANKED]);
      const result = await promote(
        root,
        artifactsDir,
        { capability_order: ["m-c", "m-a"] },
        g,
      );

      // Both outcomes really did happen — assert the FACTS before the strings, so a
      // summary assertion can never pass against a promotion that did neither.
      const persisted = await readSharedProviderConfirmation(root);
      expect(
        persisted.policy.capability_order,
        "the reorder must actually have been discarded",
      ).toEqual(["m-a", "m-b", "m-c"]);
      expect(
        persisted.policy.capability_order,
        "…and the flagged model must actually be unranked",
      ).not.toContain(UNRANKED);
      expect(
        g.unevidencedCapability,
        "the gate's capability delta must actually have been cleared",
      ).toEqual([]);

      // STATEMENT 1 — the discarded reorder, naming the reordered ids.
      expect(result.progress_summary).toMatch(/NOT applied/);
      expect(result.progress_summary).toContain("m-c");
      expect(result.progress_summary).toContain("m-a");

      // STATEMENT 2 — the no-capability-evidence clearing, naming the model. This is
      // the one the old if/return chain swallowed.
      expect(
        result.progress_summary,
        "the discard branch must not suppress the no-evidence report — they co-occur",
      ).toMatch(/NO capability evidence/);
      expect(result.progress_summary).toContain(UNRANKED);
    });
  });

  test("a discard ALONE yields only the discard sentence", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await seed(root, artifactsDir);

      const result = await promote(root, artifactsDir, {
        capability_order: ["m-c", "m-a"],
      });

      expect(result.progress_summary).toMatch(/NOT applied/);
      expect(result.progress_summary).not.toMatch(/NO capability evidence/);
      expect(result.progress_summary).not.toMatch(/newly-reachable/);
    });
  });

  test("an unranked-alone promotion reads exactly as it did before", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await seed(root, artifactsDir);

      // An IN-ORDER partial submission — no reorder to discard — while the gate still
      // carries an unevidenced model.
      const result = await promote(
        root,
        artifactsDir,
        { capability_order: ["m-a", "m-b"] },
        gate([UNRANKED]),
      );

      expect(result.progress_summary).toMatch(/NO capability evidence/);
      expect(result.progress_summary).toContain(UNRANKED);
      expect(result.progress_summary).not.toMatch(/NOT applied/);
    });
  });
});

// ---------------------------------------------------------------------------
// R3-3 — headless promotion via LLM ranker: executor authorship + supersession
// ---------------------------------------------------------------------------
//
// The mechanism: on an autonomous run, `authoredByLlm = gate.autonomous === true &&
// input != null` (intakeExecutors.ts). It decides two things at once — the reach
// fail-closed keying (an LLM submission must NEVER supersede a reach delta, the one
// sharp edge) and which side of the `capability_order_llm_ranked` provenance split
// (rule 1 vs rule 2) this promotion falls on. These tests drive the REAL executor.

const configWithModels = (models) => ({
  provider: "claude-code",
  sources: models.map((model) => ({
    id: `${model}-src`,
    transport: "openai-compatible",
    endpoint: `http://${model}.local/v1`,
    model,
  })),
});

describe("R3-3: executor authorship — capability_order_llm_ranked + the reach sharp edge", () => {
  test("autonomous + input with capability_order ⇒ ranks stamped, models recorded LLM-ranked, AND newlyReachable STILL fail-closed-excluded", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeInputFile(artifactsDir, { capability_order: ["m-a", "m-b"] });
      const gate = {
        newlyReachable: [NEW_BACKEND],
        unevidencedCapability: ["m-a", "m-b"],
        autonomous: true,
      };
      const result = await runProviderConfirmationAutoComplete(
        {},
        root,
        artifactsDir,
        configWithModels(["m-a", "m-b"]),
        gate,
      );

      // Ranks stamped exactly as an operator's would be.
      const ranks = await readConfirmedCapabilityRanks(root);
      expect(ranks.get("m-a")).toBe(0);
      expect(ranks.get("m-b")).toBe(1);

      // Authorship recorded.
      const raw = await readPersisted(root);
      expect(
        raw.policy?.capability_order_llm_ranked?.slice().sort(),
        "the LLM's submission is tagged, not laundered as an operator decision",
      ).toEqual(["m-a", "m-b"]);

      // THE SHARP EDGE: reach is fail-closed-excluded regardless — an LLM ranking
      // capability never also confirms a newly-reachable backend on the operator's
      // behalf, even though a submission (the LLM's) genuinely existed this round.
      expect(raw.policy?.auto_exclude).toEqual([NEW_BACKEND.exclusion_pattern]);
      expect(
        raw.policy?.exclude ?? [],
        "never laundered into an operator-authored exclusion either",
      ).not.toContain(NEW_BACKEND.exclusion_pattern);
      expect(
        gate.newlyReachable,
        "cleared by the fail-closed write, not by silently honoring it",
      ).toEqual([]);
      expect(result.progress_summary).toMatch(/fail-closed/i);
    });
  });

  test("attended + input ⇒ reach SUPERSEDES (today's behavior, unchanged); nothing marked llm-ranked", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      await writeInputFile(artifactsDir, { capability_order: ["m-a", "m-b"] });
      const gate = {
        newlyReachable: [NEW_BACKEND],
        unevidencedCapability: ["m-a", "m-b"],
        autonomous: false,
      };
      await runProviderConfirmationAutoComplete(
        {},
        root,
        artifactsDir,
        configWithModels(["m-a", "m-b"]),
        gate,
      );

      const raw = await readPersisted(root);
      expect(
        raw.policy?.auto_exclude ?? [],
        "an ATTENDED submission is the operator's decision and supersedes the reach delta",
      ).not.toContain(NEW_BACKEND.exclusion_pattern);
      expect(
        raw.policy?.capability_order_llm_ranked ?? [],
        "an attended submission is operator-authored — nothing is ever tagged llm-ranked",
      ).toEqual([]);
    });
  });
});

describe("R3-3: supersession — an operator submission repositions a previously LLM-ranked id", () => {
  test("repositioning two LLM-ranked ids is HONORED (not discarded) and removes them from capability_order_llm_ranked; a third, un-named, LLM-ranked id is untouched", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      const config = { provider: "claude-code" };

      // Promotion 1 — an autonomous run's LLM ranks all three.
      await writeInputFile(artifactsDir, {
        capability_order: ["m-a", "m-b", "m-c"],
      });
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, {
        newlyReachable: [],
        unevidencedCapability: ["m-a", "m-b", "m-c"],
        autonomous: true,
      });
      const afterLlm = await readPersisted(root);
      expect(afterLlm.policy.capability_order).toEqual(["m-a", "m-b", "m-c"]);
      expect(afterLlm.policy.capability_order_llm_ranked.slice().sort()).toEqual([
        "m-a",
        "m-b",
        "m-c",
      ]);

      // Promotion 2 — an ATTENDED operator submits a PARTIAL answer that swaps two
      // of the three LLM-ranked ids. Under the old (operator-only) anchor rule this
      // would be a discarded reorder; under R3-3 rule 2 the two named ids are NOT
      // anchors for an operator, so the reposition is honored.
      await writeInputFile(artifactsDir, { capability_order: ["m-b", "m-a"] });
      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, {
        newlyReachable: [],
        unevidencedCapability: [],
        autonomous: false,
      });

      const afterOperator = await readPersisted(root);
      expect(
        afterOperator.policy.capability_order.indexOf("m-b"),
        "the operator's reorder of the two llm-ranked ids is honored, not discarded",
      ).toBeLessThan(afterOperator.policy.capability_order.indexOf("m-a"));
      expect(
        result.progress_summary,
        "honored, not discarded — no discard warning",
      ).not.toMatch(/NOT applied/);
      expect(
        afterOperator.policy.capability_order_llm_ranked ?? [],
        "both named ids are operator-authored from here on",
      ).not.toContain("m-a");
      expect(afterOperator.policy.capability_order_llm_ranked ?? []).not.toContain(
        "m-b",
      );
      expect(
        afterOperator.policy.capability_order_llm_ranked,
        "m-c was never named by this submission — untouched, still LLM-ranked",
      ).toContain("m-c");
    });
  });

  test("an operator reordering two GENUINELY operator-ranked anchors still gets the discard report (rule unchanged)", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      const config = { provider: "claude-code" };

      // Promotion 1 — an ATTENDED operator ranks all three themselves.
      await writeInputFile(artifactsDir, {
        capability_order: ["m-a", "m-b", "m-c"],
      });
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, {
        newlyReachable: [],
        unevidencedCapability: [],
        autonomous: false,
      });
      expect(
        (await readPersisted(root)).policy.capability_order_llm_ranked ?? [],
      ).toEqual([]);

      // Promotion 2 — the SAME operator swaps two of their own anchors.
      await writeInputFile(artifactsDir, { capability_order: ["m-c", "m-a"] });
      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, {
        newlyReachable: [],
        unevidencedCapability: [],
        autonomous: false,
      });

      expect(result.progress_summary).toMatch(/NOT applied/);
      expect((await readPersisted(root)).policy.capability_order).toEqual([
        "m-a",
        "m-b",
        "m-c",
      ]);
    });
  });
});

describe("R3-3: an LLM-authored submission's anchor-reorder still lands in the discarded-reorder report", () => {
  test("an autonomous run's LLM reordering two anchors is discarded AND reported, exactly like an operator's would be", async () => {
    await withTempRoot(async (root) => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      const config = { provider: "claude-code" };

      // Promotion 1 — establish a confirmed ordering (attended, for a clean setup).
      await writeInputFile(artifactsDir, {
        capability_order: ["m-a", "m-b", "m-c"],
      });
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, config, {
        newlyReachable: [],
        unevidencedCapability: [],
        autonomous: false,
      });

      // Promotion 2 — an AUTONOMOUS run's LLM submits a partial answer swapping two
      // already-ranked anchors ("m-c", "m-a") instead of leaving them alone. The LLM
      // must not move an anchor any more than an operator may on a partial answer —
      // same honesty rule, same report.
      await writeInputFile(artifactsDir, { capability_order: ["m-c", "m-a"] });
      const reorderResult = await runProviderConfirmationAutoComplete(
        {},
        root,
        artifactsDir,
        config,
        { newlyReachable: [], unevidencedCapability: [], autonomous: true },
      );

      expect(reorderResult.progress_summary).toMatch(/NOT applied/);
      expect(reorderResult.progress_summary).toContain("m-c");
      expect(reorderResult.progress_summary).toContain("m-a");
      const persisted = await readPersisted(root);
      expect(
        persisted.policy.capability_order,
        "the anchors keep their confirmed positions — the LLM's reorder was discarded",
      ).toEqual(["m-a", "m-b", "m-c"]);
    });
  });
});
