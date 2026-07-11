// Interactive Gate-0 provider-confirmation step (spec/cost-first-routing.md —
// follow-ups a/b/c). Covers the two hermetic halves of the flow: (1) the
// host-facing prompt render surfaces the priced pool + the input contract; (2) the
// executor consumes a seeded operator input and PROMOTES it into both canonical
// artifacts, so an operator reorder + host roster reach dispatch. The emit
// DECISION itself (≥2 dispatchable providers) is PATH-dependent and is exercised
// by the CLI-driver suites, not re-tested hermetically here.

import { test, describe, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { renderProviderConfirmationPrompt } = await import(
  "../../src/audit/cli/providerConfirmationStep.ts"
);
const { runProviderConfirmationAutoComplete } = await import(
  "../../src/audit/orchestrator/intakeExecutors.ts"
);
const { readConfirmedCostPositions, readSharedProviderConfirmation } = await import(
  "../../src/shared/providers/sharedProviderConfirmation.ts"
);
const { deriveSourcePoolDisplay } = await import(
  "../../src/shared/providers/providerConfirmation.ts"
);

describe("renderProviderConfirmationPrompt (a — visibility)", () => {
  const pool = [
    {
      name: "openai-compatible",
      capability_tier: "capable",
      excluded: false,
      model_id: "claude-haiku-4-5",
      blended_price_usd_per_mtok: 2.0,
      cost_order: 0,
    },
    {
      name: "claude-code",
      capability_tier: "frontier",
      excluded: false,
      cost_order: 1,
    },
    {
      name: "worker-command",
      capability_tier: "unknown",
      excluded: false,
      cost_order: 2,
    },
  ];

  const prompt = renderProviderConfirmationPrompt({
    providerPool: pool,
    inputPath: "/repo/.audit-tools/provider-confirmation.input.json",
    continueCommand: "audit-code next-step --root /repo",
  });

  test("surfaces the priced pool, the input path, and the continue command", () => {
    expect(prompt).toMatch(/Confirm Provider Cost Ordering/);
    // Priced entry shows model + blended price.
    expect(prompt).toMatch(/claude-haiku-4-5/);
    expect(prompt).toMatch(/\$2\.00/);
    // Host-native provider with no model row is flagged "resolved at dispatch".
    expect(prompt).toMatch(/resolved at dispatch/);
    expect(prompt).toMatch(/provider-confirmation\.input\.json/);
    expect(prompt).toMatch(/audit-code next-step --root \/repo/);
  });

  test("documents the input schema (accept-verbatim + reorder + host roster)", () => {
    expect(prompt).toMatch(/provider-confirmation-input\/v1/);
    expect(prompt).toMatch(/cost_order/);
    expect(prompt).toMatch(/host_models/);
  });

  test("orders rows ascending by cost_order (cheapest first)", () => {
    const haikuIdx = prompt.indexOf("claude-haiku-4-5");
    const localIdx = prompt.indexOf("worker-command");
    expect(haikuIdx).toBeGreaterThan(0);
    expect(haikuIdx).toBeLessThan(localIdx);
  });

  test("does not render the sources[] table when no sourcePools are passed", () => {
    expect(prompt).not.toMatch(/Configured `sources\[\]` pools/);
  });

  test("does not render the (c) codex note when codex is absent from the pool", () => {
    expect(prompt).not.toMatch(/codex shows/);
  });
});

describe("renderProviderConfirmationPrompt — sources[] pools + advisory notes (backlog a/b/c)", () => {
  test("(a) every sources[] pool renders in its own table, alongside the legacy/host/CLI pool", () => {
    const sessionConfig = {
      sources: [
        {
          id: "opencode-free",
          provider: "opencode",
          model: "free-model",
          cost_per_mtok: 0,
        },
      ],
    };
    const sourcePools = deriveSourcePoolDisplay(sessionConfig);
    const prompt = renderProviderConfirmationPrompt({
      providerPool: [
        { name: "claude-code", capability_tier: "frontier", excluded: false, cost_order: 0 },
      ],
      sourcePools,
      inputPath: "/repo/.audit-tools/provider-confirmation.input.json",
      continueCommand: "audit-code next-step --root /repo",
    });

    expect(prompt).toMatch(/Configured `sources\[\]` pools/);
    expect(prompt).toMatch(/opencode-free/);
    expect(prompt).toMatch(/free-model/);
    expect(prompt).toMatch(/\$0\.00 \(declared\)/);
  });

  test("(b) legacy openai_compatible pool gets an advisory note about the missing cost override", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: [
        {
          name: "openai-compatible",
          capability_tier: "capable",
          excluded: false,
          model_id: "nemotron-ultra",
          blended_price_usd_per_mtok: 1.0,
          cost_order: 0,
        },
      ],
      inputPath: "/repo/.audit-tools/provider-confirmation.input.json",
      continueCommand: "audit-code next-step --root /repo",
    });

    expect(prompt).toMatch(/no cost override/);
    expect(prompt).toMatch(/cost_per_mtok/);
  });

  test("(c) codex in the pool gets a note that a pinned sources[] roster is available", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: [
        { name: "codex", capability_tier: "capable", excluded: false, cost_order: 0 },
      ],
      inputPath: "/repo/.audit-tools/provider-confirmation.input.json",
      continueCommand: "audit-code next-step --root /repo",
    });

    expect(prompt).toMatch(/codex shows/);
    expect(prompt).toMatch(/model\/effort roster/);
    expect(prompt).toMatch(/extra_args/);
  });
});

describe("deriveSourcePoolDisplay (backlog a — data derivation)", () => {
  test("empty/absent sources[] yields an empty list", () => {
    expect(deriveSourcePoolDisplay({})).toEqual([]);
  });

  test("a declared cost_per_mtok is authoritative and skips the models.dev lookup", () => {
    const [entry] = deriveSourcePoolDisplay({
      sources: [{ provider: "opencode", model: "free-model", cost_per_mtok: 0 }],
    });
    expect(entry.declared_cost_per_mtok).toBe(0);
    expect(entry.blended_price_usd_per_mtok).toBeUndefined();
    expect(entry.id).toBe("opencode:free-model");
  });

  test("an explicit id wins over the derived default", () => {
    const [entry] = deriveSourcePoolDisplay({
      sources: [{ id: "my-pool", provider: "codex", model: "gpt-5-codex" }],
    });
    expect(entry.id).toBe("my-pool");
  });
});

describe("executor consumes seeded operator input (b/c — reorder + host roster)", () => {
  const NIM_CONFIG = {
    openai_compatible: { base_url: "http://nim.local/v1", model: "claude-haiku-4-5" },
  };

  test("promotes an operator input into the shared confirmation + dispatch map", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-conf-gate-"));
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });
      // A session config so a configured pool is priceable at the gate.
      await writeFile(
        join(artifactsDir, "session-config.json"),
        JSON.stringify(NIM_CONFIG, null, 2) + "\n",
      );
      // Operator submits a reorder + a host model roster (follow-up c). The host
      // model is a DISTINCT id from the configured pool's model so the two thread
      // to dispatch independently.
      await writeFile(
        join(artifactsDir, "provider-confirmation.input.json"),
        JSON.stringify({
          schema_version: "provider-confirmation-input/v1",
          host_models: [{ model_id: "host-frontier-model", tier: "frontier" }],
          cost_order: ["host-frontier-model", "openai-compatible"],
        }) + "\n",
      );

      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir);
      // Per-tool seam artifact was produced (obligation satisfied) and the summary
      // reflects the operator path, not the headless auto-complete.
      expect(result.artifacts_written).toContain("provider_confirmation.json");
      expect(result.progress_summary).toMatch(/operator/i);

      // The shared confirmation carries the host-model cost entry (follow-up c).
      const read = await readSharedProviderConfirmation(root, NIM_CONFIG);
      expect(read?.status).toBe("confirmed");
      const hostEntry = read.confirmation.host_model_cost_order?.find(
        (e) => e.model_id === "host-frontier-model",
      );
      expect(hostEntry).toBeTruthy();

      // Both tiers thread to dispatch by model_id at their operator-confirmed
      // positions: the host model first (0), then the configured pool's model (1).
      const positions = await readConfirmedCostPositions(root, NIM_CONFIG);
      expect(positions.get("host-frontier-model")).toBe(0);
      expect(positions.get("claude-haiku-4-5")).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
