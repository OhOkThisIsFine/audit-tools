import { test, expect, describe } from "vitest";

// ---------------------------------------------------------------------------
// G3 — the operator's Gate-0 route DECISION must actually reach dispatch.
//
// The bug these pin: `buildSharedProviderConfirmation` computed a per-entry
// `excluded` boolean and persisted it, but NOTHING read it. Dispatch reads the
// confirmation only via `resolveConfirmedCostPositions` (model_id + cost_order),
// and `annotateConfirmedPool` assigns a cost_order to EVERY entry — including
// excluded ones. So an operator who excluded a provider at Gate-0 saw it
// rendered "excluded" and it still routed.
//
// The fix persists the operator's EXPLICIT, reach-free decision (`exclude` /
// `include`) as `policy`, and recomputes the reach half (self-spawn-blocked) in
// the READING process. Two properties matter and are easy to get backwards:
//
//   1. Policy is INHERITED (it is a rule the operator authored).
//   2. Reach is NOT inherited (it is the writing auditor's environment).
//
// A″ widens `exclude` from a provider-name list to the `provider:model` grammar,
// so the rules below are matched against a BACKEND, not looked up in a name set.
// ---------------------------------------------------------------------------

const {
  buildSharedProviderConfirmation,
  buildProviderConfirmationRender,
  resolveDispatchExclusion,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

/** The matcher's operand: a backend, not a name. */
const backend = (transport, model, endpoint, service) => ({ transport, model, endpoint, service });

describe("the operator's explicit decision is persisted reach-free", () => {
  test("exclude/include round-trip onto `policy`", () => {
    const confirmation = buildSharedProviderConfirmation(
      {},
      {},
      ["codex"],
      ["claude-code"],
    );

    expect(confirmation.policy).toEqual({
      exclude: ["codex"],
      include: ["claude-code"],
    });
  });

  test("absent when the operator named neither list — no empty shell", () => {
    const confirmation = buildSharedProviderConfirmation({}, {});

    expect(confirmation.policy).toBeUndefined();
  });

  test("the persisted policy carries NO reach — it names rules only", () => {
    // A writer INSIDE a claude-code session: claude-code is self-spawn-blocked
    // for THIS auditor. That assessment must not leak into the policy half.
    const confirmation = buildSharedProviderConfirmation(
      {},
      { CLAUDECODE: "1" },
      ["codex"],
    );

    expect(confirmation.policy).toEqual({ exclude: ["codex"] });
    expect(JSON.stringify(confirmation.policy)).not.toContain("claude-code");
  });

  test("a `transport:provider/model` rule marks the pool entry whose model it names", () => {
    // Display and routing must agree: the entry the operator sees marked
    // "excluded" is the one the routing filter will drop. `representativeModelId`
    // is the shared key, so a matching model marks — and a non-matching one does
    // not.
    const config = { openai_compatible: { model: "model-a", base_url: "https://x.invalid" } };

    // The `excluded` MARK is a render concern (B+D: never persisted), so this
    // drives the render builder — the persisted shape carries no such field.
    const hit = buildProviderConfirmationRender(config, {}, ["transport:openai-compatible/model-a"]);
    const miss = buildProviderConfirmationRender(config, {}, ["transport:openai-compatible/model-z"]);

    const entryOf = (c) => c.provider_pool.find((e) => e.name === "openai-compatible");
    expect(entryOf(hit)?.excluded).toBe(true);
    expect(entryOf(miss)?.excluded).toBe(false);
  });
});

describe("resolveDispatchExclusion — policy inherited, reach recomputed", () => {
  test("the operator's exclusions apply", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["codex"] }, {});
    expect(excluded.excludes(backend("codex", "some-model"))).toBe(true);
  });

  test("self-spawn-blocked is computed from THIS process's env, not inherited", () => {
    // Same policy, two different reading auditors.
    const policy = { exclude: ["opencode"] };

    const insideClaudeCode = resolveDispatchExclusion(policy, { CLAUDECODE: "1" });
    const insideCodex = resolveDispatchExclusion(policy, { CODEX: "1" });

    // Each auditor blocks only the agent it is itself running inside.
    expect(insideClaudeCode.excludes(backend("claude-code"))).toBe(true);
    expect(insideClaudeCode.excludes(backend("codex"))).toBe(false);

    expect(insideCodex.excludes(backend("codex"))).toBe(true);
    expect(insideCodex.excludes(backend("claude-code"))).toBe(false);

    // The operator's rule is inherited by both, unchanged.
    expect(insideClaudeCode.excludes(backend("opencode"))).toBe(true);
    expect(insideCodex.excludes(backend("opencode"))).toBe(true);
  });

  test("an auditor does NOT inherit another auditor's self-spawn block", () => {
    // Auditor A writes from inside claude-code; claude-code is blocked for A.
    const written = buildSharedProviderConfirmation({}, { CLAUDECODE: "1" });

    // Auditor B reads it from a codex host, where claude-code is perfectly
    // spawnable. B must NOT inherit A's environment-derived block.
    const excludedForB = resolveDispatchExclusion(written.policy, { CODEX: "1" });

    expect(excludedForB.excludes(backend("claude-code"))).toBe(false);
  });

  test("an explicit `include` opts a self-spawn-blocked provider back in", () => {
    const excluded = resolveDispatchExclusion(
      { include: ["claude-code"] },
      { CLAUDECODE: "1" },
    );
    expect(excluded.excludes(backend("claude-code"))).toBe(false);
  });

  test("no policy at all still excludes locally-blocked providers", () => {
    const excluded = resolveDispatchExclusion(null, { CLAUDECODE: "1" });
    expect(excluded.excludes(backend("claude-code"))).toBe(true);
  });

  test("a self-spawn block is PROVIDER-wide — blockedness is not per-model", () => {
    // The local reach half must not be narrowed by the model grammar: launching
    // ANY model of the agent you are running inside is the self-spawn.
    const excluded = resolveDispatchExclusion(null, { CODEX: "1" });
    expect(excluded.excludes(backend("codex", "model-a"))).toBe(true);
    expect(excluded.excludes(backend("codex", "model-b"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Axis-explicit exclusion GRAMMAR — transport: / service: / host:
// ---------------------------------------------------------------------------

describe("the exclusion grammar — transport / service / host", () => {
  const NIM_A = backend("openai-compatible", "model-a", "https://nim.invalid:8443/v1", "nim");
  const NIM_B = backend("openai-compatible", "model-b", "https://other.invalid/v1", "nim");

  test("`transport:provider/model` matches ONLY that model of that transport", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["transport:openai-compatible/model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(false);
    expect(excluded.excludes(backend("codex", "model-a"))).toBe(false);
  });

  test("`transport:provider` is the coarse transport tier — every model of it", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["transport:openai-compatible"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(true);
  });

  test("`service:vendor` excludes every transport reaching that vendor", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["service:nim"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(true);
    // A proxied claude-worker lane targeting nim is also excluded
    expect(excluded.excludes(backend("claude-worker", "model-a", "http://127.0.0.1:8791", "nim"))).toBe(true);
    // A different service is NOT excluded
    expect(excluded.excludes(backend("openai-compatible", "model-a", undefined, "openrouter"))).toBe(false);
  });

  test("`service:vendor/model` excludes one model from that vendor regardless of transport", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["service:nim/model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(backend("claude-worker", "model-a", undefined, "nim"))).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(false);
  });

  test("`transport:provider/model` does NOT match a modelless backend of that transport", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["transport:opencode/model-a"] }, {});

    expect(excluded.excludes(backend("opencode", undefined))).toBe(false);
    expect(excluded.excludes(backend("opencode", "model-a"))).toBe(true);
  });

  test("`host:endpoint` matches port-agnostically; `host:host:port` is port-specific", () => {
    const byHost = resolveDispatchExclusion({ exclude: ["host:nim.invalid"] }, {});
    expect(byHost.excludes(NIM_A)).toBe(true);
    expect(byHost.excludes(NIM_B)).toBe(false);

    const byHostPort = resolveDispatchExclusion({ exclude: ["host:nim.invalid:8443"] }, {});
    expect(byHostPort.excludes(NIM_A)).toBe(true);

    const local = resolveDispatchExclusion({ exclude: ["host:localhost:8000"] }, {});
    expect(local.excludes(backend("openai-compatible", "m", "http://localhost:8000/v1"))).toBe(true);
    expect(local.excludes(backend("openai-compatible", "m", "http://localhost:9000/v1"))).toBe(false);
  });

  test("a non-URL endpoint matches its literal pattern under host:", () => {
    const bare = resolveDispatchExclusion({ exclude: ["host:localhost:8000"] }, {});
    expect(bare.excludes(backend("openai-compatible", "m", "localhost:8000"))).toBe(true);

    const cmd = resolveDispatchExclusion({ exclude: ["host:c:\\tools\\codex.cmd"] }, {});
    expect(cmd.excludes(backend("codex", undefined, "c:\\tools\\codex.cmd"))).toBe(true);
    expect(cmd.excludes(backend("codex", undefined, "c:\\tools\\other.cmd"))).toBe(false);
  });

  test("a colon-bearing model id survives with / model delimiter", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["transport:openai-compatible/qwen2.5:7b"] }, {});

    expect(excluded.excludes(backend("openai-compatible", "qwen2.5:7b"))).toBe(true);
    expect(excluded.excludes(backend("openai-compatible", "qwen2.5"))).toBe(false);
  });

  test("an unknown axis prefix is INVALID — matches nothing", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["model:model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(false);
    expect(excluded.excludes(backend("not-a-real-provider", "model-a"))).toBe(false);
  });

  test("a bare un-prefixed pattern is migrated automatically in resolveDispatchExclusion", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["openai-compatible:model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — the properties above are worthless if the filter never reaches
// the pool build. These are the tests that actually fail if `excludedBackends`
// is dropped from `buildSourcePools` or from either orchestrator's call site.
// ---------------------------------------------------------------------------

const { buildSourcePools } = await import("../../src/shared/quota/apiPool.ts");
const { writeSharedProviderConfirmation, readConfirmedDispatchPolicy, readSharedProviderConfirmation } =
  await import("../../src/shared/providers/sharedProviderConfirmation.ts");

const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

/** Two openai-compatible sources (distinct models) + one under another provider. */
const MULTI_SOURCE_CONFIG = {
  sources: [
    {
      id: "nim-a",
      transport: "openai-compatible",
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "model-a",
      api_key_env: "NIM_KEY_A",
    },
    {
      id: "nim-b",
      transport: "openai-compatible",
      endpoint: "https://other.invalid/v1/chat/completions",
      model: "model-b",
      api_key_env: "NIM_KEY_B",
    },
    {
      id: "oc-a",
      transport: "opencode",
      model: "model-b",
    },
  ],
};

async function buildExcluding(patterns) {
  return await buildSourcePools({
    sessionConfig: MULTI_SOURCE_CONFIG,
    primaryProviderName: "claude-code",
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
    ...(patterns ? { excludedBackends: resolveDispatchExclusion({ exclude: patterns }, {}) } : {}),
  });
}

async function poolIdsExcluding(patterns) {
  const { pools } = await buildExcluding(patterns);
  return pools.map((p) => p.id);
}

describe("the exclusion actually reaches the built pools", () => {
  test("baseline: with no exclusions every source becomes a pool", async () => {
    expect(await poolIdsExcluding(undefined)).toEqual(["nim-a", "nim-b", "oc-a"]);
  });

  test("an excluded provider does NOT become a dispatchable pool", async () => {
    // THE BUG: before this fix the operator's exclusion was persisted, rendered
    // back to them as "excluded", and then routed to anyway.
    const ids = await poolIdsExcluding(["opencode"]);
    expect(ids).toContain("nim-a");
    expect(ids).not.toContain("oc-a");
  });

  test("A″: excluding ONE model leaves its sibling models routable", async () => {
    // THE A′ BUG THIS COMMIT FIXES: `exclude` was ResolvedProviderName[], so
    // ruling out one NIM model wrote `exclude: ["openai-compatible"]` and dropped
    // EVERY NIM source. Reaching the pool build is what makes the grammar real.
    const ids = await poolIdsExcluding(["openai-compatible:model-a"]);
    expect(ids).not.toContain("nim-a");
    expect(ids).toContain("nim-b");
    expect(ids).toContain("oc-a");
  });

  test("an endpoint-host rule drops exactly the source at that host", async () => {
    const ids = await poolIdsExcluding(["other.invalid"]);
    expect(ids).toContain("nim-a");
    expect(ids).not.toContain("nim-b");
  });

  test("an empty exclusion set is a no-op, not a wipe", async () => {
    expect(await poolIdsExcluding([])).toEqual(["nim-a", "nim-b", "oc-a"]);
  });

  test("excluding every provider leaves no source pools", async () => {
    expect(await poolIdsExcluding(["openai-compatible", "opencode"])).toEqual([]);
  });
});

const { mkdtemp } = await import("node:fs/promises");
const { readFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

describe("readConfirmedDispatchPolicy — the artifact round-trip", () => {
  async function rootWithConfirmation(exclude, include) {
    const root = await mkdtemp(join(tmpdir(), "dispatch-policy-"));
    await writeSharedProviderConfirmation(
      root,
      buildSharedProviderConfirmation({}, {}, exclude, include),
    );
    return root;
  }

  test("write → read returns the operator's decision", async () => {
    const root = await rootWithConfirmation(["opencode"], []);
    expect(await readConfirmedDispatchPolicy(root)).toEqual({
      exclude: ["opencode"],
    });
  });

  test("a `transport:model` pattern survives the round-trip verbatim", async () => {
    // The parser must not membership-check `exclude` against the provider-name
    // set: a model pattern is not a provider name and would be dropped, silently
    // un-excluding the backend the operator ruled out.
    const root = await rootWithConfirmation(["openai-compatible:model-a"], []);
    expect(await readConfirmedDispatchPolicy(root)).toEqual({
      exclude: ["openai-compatible:model-a"],
    });
  });

  test("policy SURVIVES a roster change — an exclusion is a rule, not a reach claim", async () => {
    // The design claim worth pinning: readConfirmedCostPositions drops everything
    // on a roster mismatch (positions are reach-derived). Policy must NOT — gating
    // it on freshness would silently un-exclude a backend the operator ruled out
    // the moment the discovered roster shifted. A future refactor copying the
    // `status !== "confirmed"` guard from its neighbour must fail here.
    const root = await mkdtemp(join(tmpdir(), "dispatch-policy-stale-"));
    const confirmation = buildSharedProviderConfirmation({}, {}, ["opencode"], []);
    // Force a roster that cannot match whatever this machine discovers.
    await writeSharedProviderConfirmation(root, {
      ...confirmation,
      roster: ["subprocess-template"],
    });

    expect(await readConfirmedDispatchPolicy(root)).toEqual({
      exclude: ["opencode"],
    });
  });

  test("absent artifact ⇒ null (no operator policy), never a throw", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-policy-empty-"));
    expect(await readConfirmedDispatchPolicy(root)).toBeNull();
  });

  test("an unrecognized `exclude` pattern is KEPT (open grammar), `include` is not", async () => {
    // Asymmetric on purpose: `exclude` is an open grammar whose endpoint tier is
    // never a provider name, so dropping unknowns would delete that tier — and an
    // unmatchable pattern is inert anyway. `include` overrides a self-spawn block
    // and keys on the CLOSED provider-name set, so an unknown name there must not
    // type-assert its way in.
    const root = await mkdtemp(join(tmpdir(), "dispatch-policy-bogus-"));
    const confirmation = buildSharedProviderConfirmation({}, {}, ["opencode"], []);
    await writeSharedProviderConfirmation(root, {
      ...confirmation,
      policy: {
        exclude: ["opencode", "nim.invalid", 42, ""],
        include: ["claude-code", "not-a-real-provider"],
      },
    });

    expect(await readConfirmedDispatchPolicy(root)).toEqual({
      exclude: ["opencode", "nim.invalid"],
      include: ["claude-code"],
    });
  });
});

describe("the call sites stay wired (guard — the filter is worthless unwired)", () => {
  // buildSourcePools' filter only fires if the orchestrators actually pass a
  // matcher. The behavioral tests above pass `excludedBackends` directly, so
  // they'd stay green if the wiring were dropped. This pins the wiring itself.
  test.each([
    ["src/audit/cli/nextStepHelpers.ts", "audit"],
    ["src/remediate/steps/nextStep.ts", "remediate"],
  ])("%s resolves and passes the operator's exclusions", async (path) => {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    // Reads the operator's decision, resolves it against THIS process's reach, and
    // hands the result to the pool build. All three, or the filter never fires.
    expect(source).toContain("readConfirmedDispatchPolicy");
    expect(source).toContain("resolveDispatchExclusion(");
    expect(source).toMatch(/excludedBackends:/);
  });
});

// ---------------------------------------------------------------------------
// B+D — reach never reaches disk, and a rejection is never silent.
//
// The bug this closes: the artifact carried the WRITING auditor's reach
// assessment (`capability_tier` / `self_spawn_blocked` / `excluded` /
// `blended_price_usd_per_mtok`), which a DIFFERENT auditor then read verbatim at
// dispatch. Reach is per-auditor capability; only the DECISION is inheritable.
// Enforced by TYPE via a producer split, not by a projection at the write site —
// so the fields cannot be put back by a future caller.
// ---------------------------------------------------------------------------

const REACH_FIELDS = [
  "capability_tier",
  "self_spawn_blocked",
  "excluded",
  "reason",
  "blended_price_usd_per_mtok",
];

describe("B+D — the persisted shape carries the decision, never the reach", () => {
  test("the persist builder emits NO reach field on any pool entry", () => {
    // Built from inside a claude-code session, so the writer genuinely HAS a
    // reach assessment to leak (claude-code is self-spawn-blocked for it).
    const persisted = buildSharedProviderConfirmation({}, { CLAUDECODE: "1" });

    expect(persisted.provider_pool.length).toBeGreaterThan(0);
    for (const entry of persisted.provider_pool) {
      for (const field of REACH_FIELDS) {
        expect(entry, `${entry.name} must not persist "${field}"`).not.toHaveProperty(field);
      }
      expect(Object.keys(entry).every((k) => ["name", "model_id", "cost_order"].includes(k))).toBe(true);
    }
  });

  test("…and the SERIALIZED bytes carry none either", async () => {
    // The type is the guard, but the artifact is what another auditor reads.
    const root = await mkdtemp(join(tmpdir(), "persist-reach-"));
    await writeSharedProviderConfirmation(
      root,
      buildSharedProviderConfirmation({}, { CLAUDECODE: "1" }),
    );
    const bytes = await readFile(
      join(root, ".audit-tools", "provider-confirmation.json"),
      "utf8",
    );
    for (const field of REACH_FIELDS) {
      expect(bytes, `"${field}" must not reach disk`).not.toContain(field);
    }
  });

  test("the RENDER builder still carries reach — the operator must SEE it", () => {
    // The other half of the split: dropping reach from the render DTO would blind
    // the operator at Gate-0 (they could no longer see WHY a backend is excluded).
    //
    // `detectCommand` is INJECTED. Without it, `discoverProviders` probes the real
    // PATH for the `claude` binary — so this test passed on a dev box with Claude Code
    // installed and FAILED on CI (no `claude` on PATH ⇒ no `claude-code` pool entry ⇒
    // `find` returns undefined ⇒ "expected undefined to be true"). The subject here is
    // the render DTO's SHAPE, not what happens to be installed on the runner.
    const rendered = buildProviderConfirmationRender(
      {},
      { CLAUDECODE: "1" },
      [],
      [],
      () => true,
    );
    const claude = rendered.provider_pool.find((e) => e.name === "claude-code");

    // Assert the entry resolved before reading through it — `claude?.excluded` on an
    // absent entry yields undefined, which is how the env-dependence hid as a
    // confusing "expected undefined to be true" instead of "no such pool entry".
    expect(claude).toBeDefined();
    expect(claude?.excluded).toBe(true);
    expect(claude?.self_spawn_blocked).toBe(true);
    expect(claude?.capability_tier).toBeTruthy();
  });

  test("a pre-B artifact still parses — its extra reach fields are ignored, not fatal", async () => {
    // Forward-tolerance: the gate requires `name` only. An artifact written before
    // B+D must not fail the gate (that would be the silent degrade D exists to fix).
    const root = await mkdtemp(join(tmpdir(), "persist-legacy-"));
    await writeSharedProviderConfirmation(root, {
      ...buildSharedProviderConfirmation({}, {}, ["opencode"], []),
      provider_pool: [
        { name: "codex", capability_tier: "capable", excluded: false, reason: "legacy", model_id: "m1", cost_order: 0 },
      ],
    });

    expect(await readConfirmedDispatchPolicy(root)).toEqual({ exclude: ["opencode"] });
  });
});

describe("B+D — a rejected confirmation is LOUD, never silent", () => {
  const rejectedFor = async (confirmation) => {
    const root = await mkdtemp(join(tmpdir(), "reject-"));
    await writeSharedProviderConfirmation(root, confirmation);
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      await readSharedProviderConfirmation(root);
    } finally {
      process.stderr.write = original;
    }
    return written.join("");
  };

  test("a schema_version drift warns, naming the version and the consequence", async () => {
    // `null` is indistinguishable from "no confirmation exists" at every call site,
    // and every consumer reads that as "no operator decision": empty cost order,
    // λ=0, and — worst — the A′ reconciliation gate goes BLIND. Silently.
    const warning = await rejectedFor({
      ...buildSharedProviderConfirmation({}, {}, ["opencode"], []),
      schema_version: "9.9.9",
    });

    expect(warning).toContain("9.9.9");
    expect(warning).toContain("1.0.0");
    expect(warning.toLowerCase()).toContain("not being applied");
  });

  test("a malformed pool warns too", async () => {
    const warning = await rejectedFor({
      ...buildSharedProviderConfirmation({}, {}),
      provider_pool: [{ oops: true }],
    });

    expect(warning.toLowerCase()).toContain("malformed");
  });

  test("an ABSENT confirmation is silent — absence is legitimate, not a degrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "absent-"));
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      expect(await readSharedProviderConfirmation(root)).toBeNull();
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toBe("");
  });
});

describe("B+D — the two builders stay wired to the right call sites", () => {
  // The render and persist builders take IDENTICAL parameter lists and differ by one
  // word. `PersistedPoolEntry` brands the reach half `never`, so a swap is a TYPE
  // error — but only at the write site's own boundary. These pin the wiring itself,
  // because the behavioral tests above call the builders directly and would stay
  // green if a call site were swapped.
  test("the PERSIST site (intakeExecutors) uses the persist builder, not the render one", async () => {
    const source = await readFile(
      new URL("../../src/audit/orchestrator/intakeExecutors.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("buildSharedProviderConfirmation(");
    // Match the CALL form (trailing paren), not the bare identifier. What is dangerous
    // is invoking the render builder here; NAMING it in a comment is not, and the bare
    // match forbade explaining the distinction this very test exists to protect — it
    // went red the moment a comment mentioned the function.
    expect(
      source,
      "persisting the render DTO would write the writing auditor's reach for another auditor to inherit — the exact bug B+D removes",
    ).not.toContain("buildProviderConfirmationRender(");
  });

  test("the RENDER site (nextStepCommand) uses the render builder", async () => {
    const source = await readFile(
      new URL("../../src/audit/cli/nextStepCommand.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("buildProviderConfirmationRender(");
    expect(
      source,
      "rendering the persisted projection would blind the operator: no tier, no price, no reason a backend is excluded",
    ).not.toContain("buildSharedProviderConfirmation(");
  });
});

describe("B+D — reach is UNREPRESENTABLE on the persisted type, not merely omitted", () => {
  // Two independent reviews proved the original split did NOT achieve this: a
  // structural subset means `ConfirmedPoolEntry` assigns cleanly to
  // `PersistedPoolEntry` (excess-property checks fire only on fresh literals), so
  // `writeSharedProviderConfirmation(root, renderedDTO)` typechecked and leaked the
  // whole reach half to disk. The `?: never` brands are what close it. Nothing else
  // pins them, so deleting them would silently re-open the hole.
  test("the persisted type brands every reach field `never`", async () => {
    const source = await readFile(
      new URL("../../src/shared/types/providerConfirmation.ts", import.meta.url),
      "utf8",
    );
    const persisted = source.slice(
      source.indexOf("export interface PersistedPoolEntry"),
      source.indexOf("export interface ConfirmedPoolEntry"),
    );
    for (const field of REACH_FIELDS) {
      expect(persisted, `PersistedPoolEntry must brand "${field}" as never`).toContain(
        `${field}?: never;`,
      );
    }
  });
});

describe("the capacity guard: a policy that zeroes ALL reach must not be silent", () => {
  test("rules removing every source report the zeroing AND name the culprit patterns", async () => {
    // The whole defect: before the guard this returned [] and said nothing, so a run
    // dispatched to nothing and no artifact recorded that a POLICY caused it.
    const { pools, zeroedByExclusion } = await buildExcluding([
      "openai-compatible",
      "opencode",
    ]);
    expect(pools).toEqual([]);
    expect(zeroedByExclusion).not.toBeNull();
    expect(zeroedByExclusion.gatheredCount).toBe(3);
    // Deduplicated + sorted: two of the three sources matched the SAME pattern, and a
    // re-derive must produce a byte-identical discriminator.
    expect(zeroedByExclusion.patterns).toEqual(["transport:openai-compatible", "transport:opencode"]);
  });

  test("a PARTIAL exclusion is normal operation and reports nothing", async () => {
    const { pools, zeroedByExclusion } = await buildExcluding(["opencode"]);
    expect(pools.length).toBeGreaterThan(0);
    expect(zeroedByExclusion).toBeNull();
  });

  test("no exclusion policy at all reports nothing", async () => {
    const { zeroedByExclusion } = await buildExcluding(undefined);
    expect(zeroedByExclusion).toBeNull();
  });

  test("a rule matching NOTHING leaves reach intact and reports nothing", async () => {
    const { pools, zeroedByExclusion } = await buildExcluding(["host:nonexistent.invalid"]);
    expect(pools.length).toBe(3);
    expect(zeroedByExclusion).toBeNull();
  });

  test("excludedBy names the pattern responsible, and never disagrees with excludes", async () => {
    const exclusion = resolveDispatchExclusion(
      { exclude: ["transport:openai-compatible/model-a", "transport:opencode"] },
      {},
    );
    const nimA = { transport: "openai-compatible", model: "model-a" };
    const nimB = { transport: "openai-compatible", model: "model-b" };
    const ocA = { transport: "opencode", model: "model-b" };
    expect(exclusion.excludedBy(nimA)).toBe("transport:openai-compatible/model-a");
    expect(exclusion.excludedBy(ocA)).toBe("transport:opencode");
    expect(exclusion.excludedBy(nimB)).toBeNull();
    // Derived, not a parallel implementation — the two verdicts cannot drift.
    for (const backend of [nimA, nimB, ocA]) {
      expect(exclusion.excludes(backend)).toBe(exclusion.excludedBy(backend) !== null);
    }
  });
});
