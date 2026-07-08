import { test, expect, describe, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readValidatedSessionConfig } from "../../src/shared/validation/sessionConfig.ts";

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

// The load-boundary chokepoint both orchestrators route their session-config
// reads through. Enforces the "reject malformed config at load, never degrade
// silently to a floor" parity rule mechanically (not host discretion).
describe("readValidatedSessionConfig", () => {
  test("returns undefined when the file is absent (a run with no config is legal)", async () => {
    await withTempConfig(undefined, async (path) => {
      expect(await readValidatedSessionConfig(path)).toBeUndefined();
    });
  });

  test("returns the typed config unchanged when valid", async () => {
    await withTempConfig(
      JSON.stringify({ provider: "claude-code", timeout_ms: 60000 }),
      async (path) => {
        const config = await readValidatedSessionConfig(path);
        expect(config).toEqual({ provider: "claude-code", timeout_ms: 60000 });
      },
    );
  });

  test("THROWS on an error-severity issue (malformed config fails loud, not silent)", async () => {
    await withTempConfig(
      JSON.stringify({ provider: "not-a-real-provider" }),
      async (path) => {
        await assert.rejects(
          () => readValidatedSessionConfig(path),
          /Invalid .*Unsupported provider/s,
        );
      },
    );
  });

  test("THROWS on a bad sources[] quota (the C1 admission-budget concern)", async () => {
    await withTempConfig(
      JSON.stringify({ sources: [{ provider: "codex", quota: { context_tokens: -1 } }] }),
      async (path) => {
        await assert.rejects(
          () => readValidatedSessionConfig(path),
          /context_tokens must be a positive integer/,
        );
      },
    );
  });

  test("does NOT throw on a warning-only config; surfaces it via onWarnings", async () => {
    await withTempConfig(
      JSON.stringify({ claude_code: { dangerously_skip_permissions: true } }),
      async (path) => {
        let warnings = [];
        const config = await readValidatedSessionConfig(path, {
          onWarnings: (w) => {
            warnings = w;
          },
        });
        // The config loads (the flag is a legitimate operator choice)...
        expect(config).toEqual({ claude_code: { dangerously_skip_permissions: true } });
        // ...but the security-sensitive setting is surfaced, never silently honored.
        expect(warnings.length).toBe(1);
        expect(warnings[0].severity).toBe("warning");
        expect(warnings[0].message.toLowerCase()).toContain("dangerously_skip_permissions");
      },
    );
  });

  test("default (no onWarnings) surfaces the warning to stderr and still loads — never silently honored", async () => {
    await withTempConfig(
      JSON.stringify({ claude_code: { dangerously_skip_permissions: true } }),
      async (path) => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const config = await readValidatedSessionConfig(path);
          expect(config).toEqual({
            claude_code: { dangerously_skip_permissions: true },
          });
          expect(spy).toHaveBeenCalledTimes(1);
          expect(String(spy.mock.calls[0][0]).toLowerCase()).toContain(
            "dangerously_skip_permissions",
          );
        } finally {
          spy.mockRestore();
        }
      },
    );
  });
});
