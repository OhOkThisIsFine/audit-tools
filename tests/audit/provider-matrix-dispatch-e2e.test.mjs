/**
 * Provider-matrix live dispatch e2e — ONE generalized test that runs the SAME
 * bounded in-process audit-dispatch round-trip through EVERY available dispatch
 * provider, instead of a separate hardcoded test per provider. This supersedes
 * the former per-provider gated tests (the a7 codex dispatch e2e and
 * nim-rolling-audit-e2e): adding a new in-process backend needs no new test —
 * it appears in the matrix automatically once `discoverProviders` surfaces it.
 *
 * The candidate set is the in-process dispatch providers (read-only review, no
 * worktree): openai-compatible / codex / opencode. Availability is decided by the
 * PRODUCTION discovery layer (`discoverProviders`) plus, for the API provider,
 * the configured `api_key_env` being populated — never a hand-maintained "is X
 * installed" guess. Unavailable providers are skipped with the discovery layer's
 * own reason; available ones run live and must round-trip a real review result.
 *
 * SKIPPED unless RUN_PROVIDER_MATRIX_E2E=1: available providers hit real backends
 * (codex CLI auth, the configured NIM endpoint + NVIDIA_API_KEY, …), so it must
 * never run in the normal suite / CI. Run it with:
 *   RUN_PROVIDER_MATRIX_E2E=1 [NVIDIA_API_KEY=…] \
 *     node --import tsx --test tests/audit/provider-matrix-dispatch-e2e.test.mjs
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { discoverProviders } from "audit-tools/shared";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning } from "./helpers/fixture.mjs";

const RUN = process.env.RUN_PROVIDER_MATRIX_E2E === "1";

// One row per in-process dispatch provider: its minimal session config. The
// session config is the ONLY per-provider knowledge here — the driver, fixture,
// dispatch routing, and result-landing contract are all provider-agnostic.
const CANDIDATES = [
  {
    name: "codex",
    build: () => ({
      provider: "codex",
      dispatch: { rolling_engine: true },
      timeout_ms: 180_000,
    }),
  },
  {
    name: "opencode",
    build: () => ({
      provider: "opencode",
      dispatch: { rolling_engine: true },
      timeout_ms: 180_000,
    }),
  },
  {
    name: "openai-compatible",
    build: () => ({
      provider: "openai-compatible",
      openai_compatible: {
        base_url: "https://integrate.api.nvidia.com/v1",
        model: "openai/gpt-oss-120b",
        api_key_env: "NVIDIA_API_KEY",
        response_format_json: true,
      },
      dispatch: { rolling_engine: true },
      timeout_ms: 180_000,
    }),
  },
];

// Decide availability from the production discovery layer. CLI providers
// (codex/opencode) are PATH-probed + self-spawn-guarded by discoverProviders;
// the API provider is surfaced when configured, plus we require its api_key_env
// to be populated (a launch-time concern discovery does not check).
function availability(candidate) {
  const sessionConfig = candidate.build();
  const entry = discoverProviders(sessionConfig).find((p) => p.name === candidate.name);
  if (candidate.name === "openai-compatible") {
    const keyEnv = sessionConfig.openai_compatible.api_key_env;
    if (!process.env[keyEnv]) {
      return { available: false, reason: `${keyEnv} not set` };
    }
  }
  return {
    available: Boolean(entry?.detected),
    reason: entry?.reason ?? "not available",
  };
}

describe.skipIf(!RUN)(
  "provider-matrix: in-process audit dispatch round-trips for every available provider",
  () => {
    const availabilities = CANDIDATES.map((c) => ({ c, ...availability(c) }));

    // A gate that ran but exercised no provider validated nothing — fail loudly
    // rather than read green when no live backend was reachable.
    it("has at least one available in-process dispatch provider", () => {
      expect(availabilities.some((a) => a.available), "no in-process dispatch provider was available — the matrix validated nothing " +
          `(${availabilities.map((a) => `${a.c.name}: ${a.reason}`).join("; ")})`).toBeTruthy();
    });

    for (const { c, available, reason } of availabilities) {
      it.skipIf(!available)(
        available ? c.name : `${c.name} (skipped: ${reason})`,
        async () => {
          const { runInProcessAuditDispatch } = await import(
            "../../src/audit/cli/nextStepCommand.ts"
          );
          const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");

          await withTempDir(`provider-matrix-${c.name}-`, async (root) => {
            // Advance the deterministic chain to planning so the next obligation
            // is the host-delegation dispatch (audit_tasks_completed) — the only
            // point the in-process rolling engine takes over.
            await writeFixtureRepo(root);
            const { planning } = await advanceFixtureToPlanning(root);
            const artifactsDir = join(root, ".audit-tools", "audit");
            await writeCoreArtifacts(artifactsDir, planning.updated_bundle, { prune: true });

            const outcome = await runInProcessAuditDispatch({
              root,
              sessionConfig: c.build(),
            });
            expect(outcome && outcome.dispatched, `${c.name} in-process dispatch must round-trip one bounded audit step`).toBeTruthy();
          });
        },
      );
    }
  },
);
