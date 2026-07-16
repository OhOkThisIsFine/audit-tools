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
// ---------------------------------------------------------------------------

const {
  buildSharedProviderConfirmation,
  resolveExcludedProviders,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

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
});

describe("resolveExcludedProviders — policy inherited, reach recomputed", () => {
  test("the operator's exclusions apply", () => {
    const excluded = resolveExcludedProviders({ exclude: ["codex"] }, {});
    expect(excluded.has("codex")).toBe(true);
  });

  test("self-spawn-blocked is computed from THIS process's env, not inherited", () => {
    // Same policy, two different reading auditors.
    const policy = { exclude: ["opencode"] };

    const insideClaudeCode = resolveExcludedProviders(policy, { CLAUDECODE: "1" });
    const insideCodex = resolveExcludedProviders(policy, { CODEX: "1" });

    // Each auditor blocks only the agent it is itself running inside.
    expect(insideClaudeCode.has("claude-code")).toBe(true);
    expect(insideClaudeCode.has("codex")).toBe(false);

    expect(insideCodex.has("codex")).toBe(true);
    expect(insideCodex.has("claude-code")).toBe(false);

    // The operator's rule is inherited by both, unchanged.
    expect(insideClaudeCode.has("opencode")).toBe(true);
    expect(insideCodex.has("opencode")).toBe(true);
  });

  test("an auditor does NOT inherit another auditor's self-spawn block", () => {
    // Auditor A writes from inside claude-code; claude-code is blocked for A.
    const written = buildSharedProviderConfirmation({}, { CLAUDECODE: "1" });

    // Auditor B reads it from a codex host, where claude-code is perfectly
    // spawnable. B must NOT inherit A's environment-derived block.
    const excludedForB = resolveExcludedProviders(written.policy, { CODEX: "1" });

    expect(excludedForB.has("claude-code")).toBe(false);
  });

  test("an explicit `include` opts a self-spawn-blocked provider back in", () => {
    const excluded = resolveExcludedProviders(
      { include: ["claude-code"] },
      { CLAUDECODE: "1" },
    );
    expect(excluded.has("claude-code")).toBe(false);
  });

  test("no policy at all still excludes locally-blocked providers", () => {
    const excluded = resolveExcludedProviders(null, { CLAUDECODE: "1" });
    expect(excluded.has("claude-code")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration — the properties above are worthless if the filter never reaches
// the pool build. These are the tests that actually fail if `excludedProviders`
// is dropped from `buildSourcePools` or from either orchestrator's call site.
// ---------------------------------------------------------------------------

const { buildSourcePools } = await import("../../src/shared/quota/apiPool.ts");
const { writeSharedProviderConfirmation, readConfirmedDispatchPolicy } =
  await import("../../src/shared/providers/sharedProviderConfirmation.ts");

const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

/** Two dispatchable NIM sources under distinct providers. */
const TWO_SOURCE_CONFIG = {
  sources: [
    {
      id: "nim-a",
      provider: "openai-compatible",
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "model-a",
      api_key_env: "NIM_KEY_A",
    },
    {
      id: "oc-a",
      provider: "opencode",
      model: "model-b",
    },
  ],
};

async function poolIdsWith(excludedProviders) {
  const pools = await buildSourcePools({
    sessionConfig: TWO_SOURCE_CONFIG,
    primaryProviderName: "claude-code",
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
    ...(excludedProviders ? { excludedProviders } : {}),
  });
  return pools.map((p) => p.id);
}

describe("the exclusion actually reaches the built pools", () => {
  test("baseline: with no exclusions both sources become pools", async () => {
    const ids = await poolIdsWith(undefined);
    expect(ids).toContain("nim-a");
    expect(ids).toContain("oc-a");
  });

  test("an excluded provider does NOT become a dispatchable pool", async () => {
    // THE BUG: before this fix the operator's exclusion was persisted, rendered
    // back to them as "excluded", and then routed to anyway.
    const ids = await poolIdsWith(new Set(["opencode"]));
    expect(ids).toContain("nim-a");
    expect(ids).not.toContain("oc-a");
  });

  test("an empty exclusion set is a no-op, not a wipe", async () => {
    const ids = await poolIdsWith(new Set());
    expect(ids).toContain("nim-a");
    expect(ids).toContain("oc-a");
  });

  test("excluding every provider leaves no source pools", async () => {
    const ids = await poolIdsWith(new Set(["openai-compatible", "opencode"]));
    expect(ids).toEqual([]);
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

  test("an unknown provider name is dropped, not type-asserted into the filter", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-policy-bogus-"));
    const confirmation = buildSharedProviderConfirmation({}, {}, ["opencode"], []);
    await writeSharedProviderConfirmation(root, {
      ...confirmation,
      policy: { exclude: ["opencode", "not-a-real-provider"] },
    });

    expect(await readConfirmedDispatchPolicy(root)).toEqual({
      exclude: ["opencode"],
    });
  });
});

describe("the call sites stay wired (guard — the filter is worthless unwired)", () => {
  // buildSourcePools' filter only fires if the orchestrators actually pass a set.
  // The behavioral tests above pass `excludedProviders` directly, so they'd stay
  // green if the wiring were dropped. This pins the wiring itself.
  test.each([
    ["src/audit/cli/nextStepHelpers.ts", "audit"],
    ["src/remediate/steps/nextStep.ts", "remediate"],
  ])("%s resolves and passes the operator's exclusions", async (path) => {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    // Reads the operator's decision, resolves it against THIS process's reach, and
    // hands the result to the pool build. All three, or the filter never fires.
    expect(source).toContain("readConfirmedDispatchPolicy");
    expect(source).toContain("resolveExcludedProviders(");
    expect(source).toMatch(/excludedProviders:/);
  });
});
