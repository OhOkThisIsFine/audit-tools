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
  resolveDispatchExclusion,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

/** The matcher's operand: a backend, not a name. */
const backend = (provider, model, endpoint) => ({ provider, model, endpoint });

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

  test("a `provider:model` rule marks the pool entry whose model it names", () => {
    // Display and routing must agree: the entry the operator sees marked
    // "excluded" is the one the routing filter will drop. `representativeModelId`
    // is the shared key, so a matching model marks — and a non-matching one does
    // not.
    const config = { openai_compatible: { model: "model-a", base_url: "https://x.invalid" } };

    const hit = buildSharedProviderConfirmation(config, {}, ["openai-compatible:model-a"]);
    const miss = buildSharedProviderConfirmation(config, {}, ["openai-compatible:model-z"]);

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
// A″ — the exclusion GRAMMAR. Three tiers, disambiguated by the head token
// against the closed provider-name set. The model tier is the point: the
// operator confirms *model* choices, so ruling out one model of a multi-model
// backend must leave that backend's other models routable (A′ dropped them all).
// ---------------------------------------------------------------------------

describe("the exclusion grammar — provider / provider:model / endpoint", () => {
  const NIM_A = backend("openai-compatible", "model-a", "https://nim.invalid:8443/v1");
  const NIM_B = backend("openai-compatible", "model-b", "https://other.invalid/v1");

  test("`provider:model` matches ONLY that model of that provider", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["openai-compatible:model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    // THE A″ FIX: A′'s provider-name list dropped this sibling too.
    expect(excluded.excludes(NIM_B)).toBe(false);
    // …and says nothing about a different provider that happens to share a model id.
    expect(excluded.excludes(backend("codex", "model-a"))).toBe(false);
  });

  test("a bare `provider` is the coarse tier — every model of it", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["openai-compatible"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(true);
    expect(excluded.excludes(NIM_B)).toBe(true);
  });

  test("`provider:model` does NOT match a modelless backend of that provider", () => {
    // A CLI's model arrives at the dispatch handshake, so it carries no model
    // here. The operator ruled out one MODEL, not the backend — ruling out the
    // backend is what the coarse `provider` tier is for. Matching it here would
    // silently widen a narrow rule.
    const excluded = resolveDispatchExclusion({ exclude: ["opencode:model-a"] }, {});

    expect(excluded.excludes(backend("opencode", undefined))).toBe(false);
    expect(excluded.excludes(backend("opencode", "model-a"))).toBe(true);
  });

  test("an endpoint host matches port-agnostically; `host:port` is port-specific", () => {
    const byHost = resolveDispatchExclusion({ exclude: ["nim.invalid"] }, {});
    expect(byHost.excludes(NIM_A)).toBe(true); // :8443 — the pattern named no port
    expect(byHost.excludes(NIM_B)).toBe(false);

    const byHostPort = resolveDispatchExclusion({ exclude: ["nim.invalid:8443"] }, {});
    expect(byHostPort.excludes(NIM_A)).toBe(true);
    // `localhost` is not a provider name, so `localhost:8000` can only ever parse
    // as the endpoint tier — the closed name set is what keeps the grammar
    // unambiguous.
    const local = resolveDispatchExclusion({ exclude: ["localhost:8000"] }, {});
    expect(local.excludes(backend("openai-compatible", "m", "http://localhost:8000/v1"))).toBe(true);
    expect(local.excludes(backend("openai-compatible", "m", "http://localhost:9000/v1"))).toBe(false);
  });

  test("a non-URL endpoint matches its literal pattern (URL parsing must not eat it)", () => {
    // `new URL()` accepts ANY scheme-shaped string, so it does NOT throw on
    // `localhost:8000` (protocol `localhost:`) or `C:\tools\codex.cmd` (protocol
    // `c:`) — both parse to an EMPTY hostname. Trusting the `catch` alone would
    // silently yield no hosts for exactly these, so the operator's
    // literal-identical rule would match nothing and the backend would still route.
    const bare = resolveDispatchExclusion({ exclude: ["localhost:8000"] }, {});
    expect(bare.excludes(backend("openai-compatible", "m", "localhost:8000"))).toBe(true);

    const cmd = resolveDispatchExclusion({ exclude: ["C:\\tools\\codex.cmd"] }, {});
    expect(cmd.excludes(backend("codex", undefined, "C:\\tools\\codex.cmd"))).toBe(true);
    expect(cmd.excludes(backend("codex", undefined, "C:\\tools\\other.cmd"))).toBe(false);
  });

  test("`provider:` (empty tail) is the PROVIDER tier — the head decides the tier", () => {
    // Reads as "codex, every model". Demoting a provider-name head to an
    // (unmatchable) endpoint rule on an empty tail would silently drop the
    // operator's intent and break the head-decides rule the grammar documents.
    const excluded = resolveDispatchExclusion({ exclude: ["codex:"] }, {});

    expect(excluded.excludes(backend("codex", "gpt-5-codex"))).toBe(true);
    expect(excluded.excludes(backend("codex", undefined))).toBe(true);
    expect(excluded.excludes(backend("opencode", "gpt-5-codex"))).toBe(false);
  });

  test("a colon-bearing model id survives (split on the FIRST colon only)", () => {
    const excluded = resolveDispatchExclusion({ exclude: ["openai-compatible:qwen2.5:7b"] }, {});

    expect(excluded.excludes(backend("openai-compatible", "qwen2.5:7b"))).toBe(true);
    expect(excluded.excludes(backend("openai-compatible", "qwen2.5"))).toBe(false);
  });

  test("an unmatchable pattern is INERT — it never widens to something else", () => {
    // The grammar is OPEN (an endpoint host is not a provider name), so an
    // unrecognized pattern cannot be "dropped as unknown" without deleting the
    // endpoint tier. It must simply match nothing — never fall back to a coarser
    // tier, which would exclude backends the operator never named.
    const excluded = resolveDispatchExclusion({ exclude: ["not-a-real-provider:model-a"] }, {});

    expect(excluded.excludes(NIM_A)).toBe(false);
    expect(excluded.excludes(backend("not-a-real-provider", "model-a"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — the properties above are worthless if the filter never reaches
// the pool build. These are the tests that actually fail if `excludedBackends`
// is dropped from `buildSourcePools` or from either orchestrator's call site.
// ---------------------------------------------------------------------------

const { buildSourcePools } = await import("../../src/shared/quota/apiPool.ts");
const { writeSharedProviderConfirmation, readConfirmedDispatchPolicy } =
  await import("../../src/shared/providers/sharedProviderConfirmation.ts");

const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

/** Two openai-compatible sources (distinct models) + one under another provider. */
const MULTI_SOURCE_CONFIG = {
  sources: [
    {
      id: "nim-a",
      provider: "openai-compatible",
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "model-a",
      api_key_env: "NIM_KEY_A",
    },
    {
      id: "nim-b",
      provider: "openai-compatible",
      endpoint: "https://other.invalid/v1/chat/completions",
      model: "model-b",
      api_key_env: "NIM_KEY_B",
    },
    {
      id: "oc-a",
      provider: "opencode",
      model: "model-b",
    },
  ],
};

async function poolIdsExcluding(patterns) {
  const pools = await buildSourcePools({
    sessionConfig: MULTI_SOURCE_CONFIG,
    primaryProviderName: "claude-code",
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
    ...(patterns ? { excludedBackends: resolveDispatchExclusion({ exclude: patterns }, {}) } : {}),
  });
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

  test("a `provider:model` pattern survives the round-trip verbatim", async () => {
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
