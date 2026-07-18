/**
 * Commit 3c — Gate-0 fold for the repair-proxy lane, traced END-TO-END over the
 * EXISTING path (nothing bespoke): mock declaration + populate cache →
 * `resolveSessionConfig` (ambient resolve reads the cache) → `effective.sources` →
 * `gatherDispatchableSources` → `buildProviderConfirmationRender`/
 * `annotateConfirmedPool` (the SHARED Gate-0 path) → roster rows with cost/tier
 * attributes — plus the reconciliation gate's compare-key behavior over the
 * expanded sources. Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md
 * §"Gate-0 & the reconciliation gate".
 */

import { describe, expect, it } from "vitest";

const { resolveSessionConfig } = await import(
  "../../src/shared/config/resolveSessionConfig.ts"
);
const { ambientAuditorDescriptor } = await import(
  "../../src/shared/types/auditorDescriptor.ts"
);
const { gatherDispatchableSources } = await import(
  "../../src/shared/quota/apiPool.ts"
);
const { deriveSourcePoolDisplayFromSources, annotateConfirmedPool } = await import(
  "../../src/shared/providers/providerConfirmation.ts"
);
const {
  buildProviderConfirmationRender,
  buildSharedProviderConfirmation,
  computeNewlyReachableBackends,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

const PROXY = "http://127.0.0.1:8791";

/** Populate-cache expansion: top-K=2 models for backend `nim`, one for `openrouter`. */
const EXPANDED = [
  {
    id: "claude-worker:nim/z-ai/glm-5.2",
    provider: "claude-worker",
    endpoint: PROXY,
    backend_provider: "nim",
    model: "z-ai/glm-5.2",
    worker_kind: "agentic",
    cost_per_mtok: 0,
  },
  {
    id: "claude-worker:nim/meta/llama-4",
    provider: "claude-worker",
    endpoint: PROXY,
    backend_provider: "nim",
    model: "meta/llama-4",
    worker_kind: "agentic",
    cost_per_mtok: 0,
  },
  {
    id: "claude-worker:openrouter/deep/seek-r2",
    provider: "claude-worker",
    endpoint: PROXY,
    backend_provider: "openrouter",
    model: "deep/seek-r2",
    worker_kind: "agentic",
    cost_per_mtok: 1.5,
  },
];

/** Injected ambient deps: declared proxy lane, live probe, populated cache. */
function deps({ sources = EXPANDED } = {}) {
  return {
    env: {},
    homeDir: "/home/test",
    commandExists: () => false,
    fileReadable: () => false,
    readDeclarationFile: () =>
      JSON.stringify({ proxy: { endpoint: PROXY } }),
    probeHttpReachable: () => true,
    readCatalogFile: () =>
      JSON.stringify({ fetched_at: new Date().toISOString(), endpoint: PROXY, sources }),
  };
}

const noCli = () => false;

/** The effective config as `cmdNextStep` derives it (intent + ambient descriptor). */
function effectiveConfig() {
  return resolveSessionConfig({}, ambientAuditorDescriptor(), deps());
}

describe("Gate-0 fold — expanded claude-worker sources reach the roster on the EXISTING path", () => {
  it("resolveSessionConfig → effective.sources carries the cache expansion", () => {
    expect(effectiveConfig().sources).toEqual(EXPANDED);
  });

  it("gatherDispatchableSources folds every expanded source (what routes = what is confirmed)", async () => {
    const gathered = await gatherDispatchableSources(effectiveConfig(), "claude-code");
    expect(gathered).toEqual(EXPANDED);
  });

  it("buildProviderConfirmationRender ranks each expanded source with cost + model attributes", async () => {
    const effective = effectiveConfig();
    const gathered = await gatherDispatchableSources(effective, "claude-code");
    const rendered = buildProviderConfirmationRender(
      effective,
      {},
      [],
      [],
      noCli,
      undefined,
      gathered,
    );
    const byId = Object.fromEntries(
      (rendered.source_pool_cost_order ?? []).map((e) => [e.source_id, e]),
    );
    expect(Object.keys(byId).sort()).toEqual(
      EXPANDED.map((s) => s.id).sort(),
    );
    // Declared cost is authoritative (0 = free routes first; 1.5 declared beats catalog).
    expect(byId["claude-worker:nim/z-ai/glm-5.2"].blended_price_usd_per_mtok).toBe(0);
    expect(byId["claude-worker:nim/z-ai/glm-5.2"].price_declared).toBe(true);
    expect(byId["claude-worker:openrouter/deep/seek-r2"].blended_price_usd_per_mtok).toBe(1.5);
    // The free lanes rank ahead of the priced lane in the suggested order.
    expect(byId["claude-worker:nim/z-ai/glm-5.2"].cost_order).toBeLessThan(
      byId["claude-worker:openrouter/deep/seek-r2"].cost_order,
    );
    // Provider + model attributes thread through for the prompt table.
    expect(byId["claude-worker:nim/meta/llama-4"].provider).toBe("claude-worker");
    expect(byId["claude-worker:nim/meta/llama-4"].model_id).toBe("meta/llama-4");
  });

  it("deriveSourcePoolDisplayFromSources shows the expanded rows under their ids", async () => {
    const gathered = await gatherDispatchableSources(effectiveConfig(), "claude-code");
    const display = deriveSourcePoolDisplayFromSources(gathered);
    expect(display.map((e) => e.id)).toEqual(EXPANDED.map((s) => s.id));
    expect(display[0].declared_cost_per_mtok).toBe(0);
    expect(display[0].provider).toBe("claude-worker");
  });

  it("the audit PER-TOOL seam stays source-less — the asymmetry is deliberate", () => {
    // `confirmProviders` (src/audit/orchestrator/providerConfirmation.ts) calls
    // annotateConfirmedPool WITHOUT sources: the per-tool provider_confirmation.json
    // seam artifact is provider-granular; the SHARED confirmation (the only artifact
    // dispatch reads) is where the source fold lives. Pinned here so a future
    // "helpful" symmetric fold is a deliberate decision, not drift.
    const { source_pool_cost_order } = annotateConfirmedPool(
      [{ name: "worker-command", capability_tier: "unknown", excluded: false }],
      {},
    );
    expect(source_pool_cost_order).toEqual([]);
  });
});

describe("reconciliation gate over the expanded lane (compare key + cap)", () => {
  const emptyConfirmation = {
    schema_version: "1.0.0",
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: [],
  };

  it("K expanded models produce ≤K delta entries, keyed by model id", () => {
    const delta = computeNewlyReachableBackends(
      emptyConfirmation,
      {},
      EXPANDED,
      {},
      noCli,
    );
    // The populate top-K cap bounds the expansion, and the delta is at most one
    // entry per expanded source — never amplified.
    expect(delta.length).toBeLessThanOrEqual(EXPANDED.length);
    expect(delta.map((b) => b.key).sort()).toEqual(
      EXPANDED.map((s) => s.model).sort(),
    );
    // Each exclusion pattern rules out exactly that model at the provider tier the
    // routing filter matches (`claude-worker:<model>`).
    expect(delta.map((b) => b.exclusion_pattern).sort()).toEqual(
      EXPANDED.map((s) => `claude-worker:${s.model}`).sort(),
    );
  });

  it("a proxied lane and a direct lane to the same backend model are ONE backend to the gate", () => {
    const direct = {
      provider: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      model: "z-ai/glm-5.2",
      api_key_env: "NVIDIA_API_KEY",
      backend_provider: "nim",
    };
    const delta = computeNewlyReachableBackends(
      emptyConfirmation,
      {},
      [EXPANDED[0], direct],
      {},
      noCli,
    );
    // The compare key is `model_id ?? provider` — both lanes share the model, so
    // the gate sees ONE new backend, not two.
    expect(delta).toHaveLength(1);
    expect(delta[0].key).toBe("z-ai/glm-5.2");
  });

  it("KNOWN pre-existing collapse: two DIFFERENT backend_providers sharing a model string collapse to one delta entry", () => {
    // Documented in docs/backlog.md ("The gate's delta collapses two providers that
    // share a model id"): the gate key is the bare model when knowable, and fixing
    // it for claude-worker means moving gate key + confirmedBackendKeys +
    // the exclusion grammar together (a provider-qualified key that
    // confirmedBackendKeys cannot reproduce livelocks the PRIORITY[0] obligation).
    // NOT fixed in 3c — this pins the current behavior so the collapse is loud here
    // rather than rediscovered in dispatch.
    const twoBackendsOneModel = [
      EXPANDED[0],
      { ...EXPANDED[0], id: "claude-worker:openrouter/z-ai/glm-5.2", backend_provider: "openrouter" },
    ];
    const delta = computeNewlyReachableBackends(
      emptyConfirmation,
      {},
      twoBackendsOneModel,
      {},
      noCli,
    );
    expect(delta).toHaveLength(1);
  });

  it("promoting a confirmation built WITH the sources clears the delta (gate closure)", async () => {
    const effective = effectiveConfig();
    const gathered = await gatherDispatchableSources(effective, "claude-code");
    const confirmation = buildSharedProviderConfirmation(
      effective,
      {},
      [],
      [],
      noCli,
      undefined,
      gathered,
    );
    const delta = computeNewlyReachableBackends(
      confirmation,
      effective,
      gathered,
      {},
      noCli,
    );
    expect(delta).toEqual([]);
  });
});
