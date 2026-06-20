/**
 * DC-2 (remediate read side) — remediate's gain of the shared session-level
 * provider confirmation.
 *
 * A prior audit run writes ONE confirmation to the SHARED location
 * `<root>/.audit-tools/provider-confirmation.json`. Remediate reads + honors it
 * through `honorSharedProviderConfirmation`, which folds the THREE-valued
 * accessor (CE-012) into a provider-selection decision:
 *   - absent / malformed → `{ exclusions: [], reconfirm: false }` — remediate
 *     self-resolves exactly as a standalone run (INV-DC1-6 never-block).
 *   - present + roster fresh → honor the recorded excluded providers.
 *   - present + roster stale → `{ exclusions: [], reconfirm: true }` — the
 *     distinct re-confirm signal (INV-DC2-3); the stale pool is NOT honored.
 *
 * Verifies the cross-tool honor (audit writes → remediate honors), the
 * malformed/absent never-block, and the roster-stale re-confirm.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHARED_PROVIDER_CONFIRMATION_VERSION,
  sharedProviderConfirmationPath,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  currentProviderRoster,
} from "audit-tools/shared";
import { honorSharedProviderConfirmation } from "../../src/remediate/providers/index.js";

// Clean env so the discovered roster isn't perturbed by a CLAUDECODE/CODEX
// self-spawn guard (the audit-code CLAUDECODE test gotcha).
const CLEAN_ENV: NodeJS.ProcessEnv = {};

describe("DC-2 shared provider confirmation — remediate read side", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dc2-remediate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cross-tool honor: honors the excluded providers recorded by a prior audit run", async () => {
    // Simulate audit's write, then mark one pool entry excluded (as a Gate-0
    // operator exclusion would).
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    const withExclusion = {
      ...built,
      provider_pool: built.provider_pool.map((entry) =>
        entry.name === "local-subprocess"
          ? { ...entry, excluded: true, reason: "operator-excluded at Gate-0" }
          : entry,
      ),
    };
    await writeSharedProviderConfirmation(root, withExclusion);

    const decision = await honorSharedProviderConfirmation(root, {}, CLEAN_ENV);
    expect(decision.reconfirm).toBe(false);
    expect(decision.exclusions).toContain("local-subprocess");
  });

  it("standalone (absent artifact) → self-resolve: no exclusions, no reconfirm", async () => {
    const decision = await honorSharedProviderConfirmation(root, {}, CLEAN_ENV);
    expect(decision).toEqual({ exclusions: [], reconfirm: false });
  });

  it("malformed artifact → self-resolve (never-block, never throws)", async () => {
    await mkdir(join(root, ".audit-tools"), { recursive: true });
    await writeFile(sharedProviderConfirmationPath(root), "not json {{{", "utf8");

    const decision = await honorSharedProviderConfirmation(root, {}, CLEAN_ENV);
    expect(decision).toEqual({ exclusions: [], reconfirm: false });
  });

  it("roster-stale → reconfirm: the stale pool's exclusions are NOT honored (INV-DC2-3)", async () => {
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    // Record an exclusion AND perturb the stored roster so it no longer matches
    // the current one — the re-confirm signal must take precedence over the
    // recorded exclusion.
    const staleWithExclusion = {
      ...built,
      provider_pool: built.provider_pool.map((entry) =>
        entry.name === "local-subprocess"
          ? { ...entry, excluded: true }
          : entry,
      ),
      roster: [...new Set([...built.roster, "openai-compatible"])].sort(),
    };
    // Guard: ensure the perturbation actually differs from the current roster.
    expect(staleWithExclusion.roster).not.toEqual(currentProviderRoster({}, CLEAN_ENV));

    await writeSharedProviderConfirmation(root, staleWithExclusion);

    const decision = await honorSharedProviderConfirmation(root, {}, CLEAN_ENV);
    expect(decision.reconfirm).toBe(true);
    expect(decision.exclusions).toEqual([]); // stale pool not honored
    expect(typeof decision.reason).toBe("string");
  });

  it("fresh roster round-trips the version stamp through the honor path", async () => {
    const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
    expect(built.schema_version).toBe(SHARED_PROVIDER_CONFIRMATION_VERSION);
    await writeSharedProviderConfirmation(root, built);
    const decision = await honorSharedProviderConfirmation(root, {}, CLEAN_ENV);
    // Nothing excluded by default → empty exclusions, honored (not reconfirm).
    expect(decision.reconfirm).toBe(false);
    expect(decision.exclusions).toEqual([]);
  });
});
