import { test, expect, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readValidatedRepoSessionIntent,
  validateRepoSessionIntent,
} from "../../src/shared/validation/sessionConfig.ts";

async function withTempConfig(contents, fn) {
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
      { sources: [{ provider: "codex", endpoint: "codex" }] },
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
      sources: [{ provider: "codex", endpoint: "codex" }],
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
