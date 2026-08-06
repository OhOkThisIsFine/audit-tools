import { test, expect, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readValidatedRepoSessionIntent,
  validateRepoSessionIntent,
  validateSessionConfig,
} from "../../src/shared/validation/sessionConfig.js";

async function withTempConfig<T>(
  contents: string | undefined,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rvsc-"));
  const path = join(dir, "session-config.json");
  if (contents !== undefined) {
    await writeFile(path, contents, "utf8");
  }
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The load-boundary chokepoint both orchestrators route their session-config reads
// through — validating the PERSISTED RepoSessionIntent (audit intent + policy only).
// Enforces two parity rules mechanically (not host discretion): reject a malformed
// config at load, and (G2) reject any dispatch-inventory field so a resolved
// backend/launch set is UNREPRESENTABLE on disk.
describe("readValidatedRepoSessionIntent", () => {
  test("returns undefined when the file is absent (a run with no config is legal)", async () => {
    await withTempConfig(undefined, async (path) => {
      expect(await readValidatedRepoSessionIntent(path)).toBeUndefined();
    });
  });

  test("returns the typed intent unchanged when valid", async () => {
    await withTempConfig(
      JSON.stringify({ timeout_ms: 60000, synthesis: { narrative: true } }),
      async (path) => {
        const intent = await readValidatedRepoSessionIntent(path);
        expect(intent).toEqual({ timeout_ms: 60000, synthesis: { narrative: true } });
      },
    );
  });

  test("THROWS on a malformed intent field (fails loud, not silent)", async () => {
    await withTempConfig(JSON.stringify({ timeout_ms: -5 }), async (path) => {
      await assert.rejects(
        () => readValidatedRepoSessionIntent(path),
        /Invalid .*timeout_ms/s,
      );
    });
  });

  test("THROWS on a dispatch-inventory field — unrepresentable on disk (G2)", async () => {
    // Each of these is per-auditor dispatch capability that rides the --auditor
    // descriptor and can no longer be persisted on session-config.json.
    for (const bad of [
      { provider: "claude-code" },
      { host_provider: "codex" },
      { sources: [{ transport: "codex", endpoint: "codex" }] },
      { openai_compatible: { base_url: "https://nim/v1", model: "m" } },
      { codex: { command: "codex" } },
      { parallel_workers: 4 },
      { dispatch: { rolling_engine: true } },
    ]) {
      await withTempConfig(JSON.stringify(bad), async (path) => {
        await assert.rejects(
          () => readValidatedRepoSessionIntent(path),
          /cannot be persisted/,
        );
      });
    }
  });

  test("intent dispatch.* knobs (confirm_threshold/max_packets) stay representable", async () => {
    await withTempConfig(
      JSON.stringify({ dispatch: { confirm_threshold: 5, max_packets: 9 } }),
      async (path) => {
        const intent = await readValidatedRepoSessionIntent(path);
        expect(intent).toEqual({ dispatch: { confirm_threshold: 5, max_packets: 9 } });
      },
    );
  });
});

describe("validateRepoSessionIntent", () => {
  test("rejects every dispatch-inventory field with a 'cannot be persisted' error", () => {
    const issues = validateRepoSessionIntent({
      provider: "claude-code",
      sources: [{ transport: "codex", endpoint: "codex" }],
      dispatch: { rolling_engine: true, max_packets: 3 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((i) => i.path === "provider")).toBe(true);
    expect(errors.some((i) => i.path === "sources")).toBe(true);
    expect(errors.some((i) => i.path === "dispatch.rolling_engine")).toBe(true);
    // The intent-side dispatch knob is NOT rejected.
    expect(errors.some((i) => i.path === "dispatch.max_packets")).toBe(false);
  });

  test("accepts an intent-only config with no issues", () => {
    expect(
      validateRepoSessionIntent({
        timeout_ms: 30000,
        synthesis: { narrative: false },
        analyzers: { gitleaks: "ephemeral" },
        block_quota: { host_model: "claude" },
      }),
    ).toEqual([]);
  });
});

// Deleting a field from a type is not retiring it: the validator used to ignore
// unknown keys entirely, so a typo'd or retired field left the operator believing
// a declaration was live while the load silently dropped it. Unknown keys now warn
// LOUDLY (naming each key) without failing the load — forward-compatibility
// survives, silence does not.
describe("unknown-key warnings", () => {
  function warnings(value: unknown) {
    return validateSessionConfig(value).filter((i) => i.severity === "warning");
  }

  test("an unknown top-level key warns by name and does not error", () => {
    const issues = validateSessionConfig({ timeout_msec: 5000 });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const w = issues.filter((i) => i.severity === "warning");
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toBe("timeout_msec");
    expect(w[0]!.message).toMatch(/unknown key|IGNORED/);
  });

  test("unknown keys warn at every walked level (source, quota, dispatch, section)", () => {
    const w = warnings({
      codex: { comand: "codex" },
      dispatch: { confirm_treshold: 2 },
      sources: [
        {
          transport: "codex",
          endpoint: "codex",
          modle: "gpt",
          quota: { contexttokens: 100000 },
        },
      ],
    });
    const paths = w.map((i) => i.path);
    expect(paths).toContain("codex.comand");
    expect(paths).toContain("dispatch.confirm_treshold");
    expect(paths).toContain("sources[0].modle");
    expect(paths).toContain("sources[0].quota.contexttokens");
  });

  test("a key with an explicit refusal reports ONCE (error), never error+warning", () => {
    const issues = validateSessionConfig({
      sources: [{ transport: "codex", endpoint: "codex", api_key: "sk-paste" }],
    });
    const forKey = issues.filter((i) => i.path === "sources[0].api_key");
    expect(forKey).toHaveLength(1);
    expect(forKey[0]!.severity).toBe("error");
    // Same for the legacy provider-shape refusal.
    const legacy = validateSessionConfig({
      sources: [{ provider: "codex", endpoint: "codex" }],
    });
    expect(
      legacy.filter((i) => i.path.endsWith(".provider") && i.severity === "warning"),
    ).toEqual([]);
  });

  test("$-prefixed and //-prefixed annotation keys are skipped silently", () => {
    expect(
      warnings({
        $schema: "https://example.invalid/schema.json",
        "// note": "editor annotation",
        timeout_ms: 1000,
      }),
    ).toEqual([]);
  });

  test("a warning-only config still LOADS (warnings surfaced, not thrown)", async () => {
    await withTempConfig(
      JSON.stringify({ timeout_ms: 1000, retired_field: true }),
      async (path) => {
        let surfaced: string[] = [];
        const intent = await readValidatedRepoSessionIntent(path, {
          onWarnings: (w) => {
            surfaced = w.map((i) => i.path);
          },
        });
        expect(intent).toBeDefined();
        expect(surfaced).toContain("retired_field");
      },
    );
  });
});
