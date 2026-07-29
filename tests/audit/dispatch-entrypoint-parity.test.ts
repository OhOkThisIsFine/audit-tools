/**
 * dispatch-entrypoint-parity.test.ts
 *
 * audit-code has two dispatch entry points: `prepare-dispatch` (builds the real
 * dispatch artifacts) and `quota` (its read-only capacity preview). Both resolve
 * the same thing — WHICH driver the fan-out is keyed to and charged against —
 * and both load the same `session-config.json` to do it.
 *
 * The two properties guarded here:
 *
 *   1. FAIL CLOSED. An invalid/tampered session-config aborts BOTH entry points.
 *      Each used to wrap the load in a try/catch that degraded to `{}` ("using
 *      defaults"), so a misconfigured run proceeded fail-OPEN — sizing and
 *      charging dispatch against an attacker-influenced config — while every
 *      sibling caller (advanceAuditCommand / nextStepCommand / dispatch /
 *      semanticReviewStep) failed closed.
 *
 *   2. ONE driver identity. The preview must key on the SAME (provider, model)
 *      the real dispatch does. `quota` resolved the host model from the
 *      `--host-model` flag alone, so a repo-configured `block_quota.host_model`
 *      (or `AUDIT_CODE_HOST_MODEL`) made it report `provider/*` while the pool
 *      it previewed — and prepare-dispatch — keyed `provider/<model>`.
 */

import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// Import the .ts sources so these commands and setQuotaStateDir share the SAME
// module singleton — mixing dist + src would give each its own quota-state slot.
const { cmdQuota } = await import(
  pathToFileURL(join(repoRoot, "src", "audit", "cli", "quotaCommand.ts")).href
);
const { cmdPrepareDispatch } = await import(
  pathToFileURL(join(repoRoot, "src", "audit", "cli", "prepareDispatchCommand.ts"))
    .href
);
const { setQuotaStateDir } = await import(
  pathToFileURL(join(repoRoot, "src", "shared", "quota", "state.ts")).href
);

// A config that fails validation at the load boundary:
// `dangerously_skip_permissions` must be a boolean.
const INVALID_SESSION_CONFIG = {
  claude_code: { dangerously_skip_permissions: "yes" },
};

/**
 * Sandbox both axes every dispatch entry point writes on: the quota-state dir
 * and the artifacts dir (loadSessionConfig materializes a default config on
 * read, which must never land in the repo's own .audit-tools).
 */
async function withSandbox<T>(fn: (artifactsDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), "dispatch-entrypoint-"));
  setQuotaStateDir(stateDir);
  const artifactsDir = join(stateDir, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  try {
    return await fn(artifactsDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function writeSessionConfig(artifactsDir: string, config: unknown): Promise<void> {
  await writeFile(
    join(artifactsDir, "session-config.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

function quotaArgv(artifactsDir: string, extra: string[] = []): string[] {
  return [process.execPath, "cli.js", "quota", "--artifacts-dir", artifactsDir, ...extra];
}

function prepareDispatchArgv(artifactsDir: string, extra: string[] = []): string[] {
  return [
    process.execPath,
    "cli.js",
    "prepare-dispatch",
    "--run-id",
    "entrypoint-parity-run",
    "--artifacts-dir",
    artifactsDir,
    ...extra,
  ];
}

// ── 1. Fail closed on an invalid session-config ─────────────────────────────

test("prepare-dispatch fails closed on an invalid session-config", async () => {
  await withSandbox(async (artifactsDir) => {
    await writeSessionConfig(artifactsDir, INVALID_SESSION_CONFIG);
    await expect(
      captureConsole(() => cmdPrepareDispatch(prepareDispatchArgv(artifactsDir))),
      "prepare-dispatch must abort on a config that fails validation, never build dispatch against a permissive default",
    ).rejects.toThrow(/session-config\.json/i);
  });
});

test("quota fails closed on an invalid session-config", async () => {
  await withSandbox(async (artifactsDir) => {
    await writeSessionConfig(artifactsDir, INVALID_SESSION_CONFIG);
    await expect(
      captureConsole(() => cmdQuota(quotaArgv(artifactsDir))),
      "quota must abort on a config that fails validation, never preview a pool built from a permissive default",
    ).rejects.toThrow(/session-config\.json/i);
  });
});

// ── 2. One driver identity across both entry points ─────────────────────────

test("quota keys its preview on block_quota.host_model, like prepare-dispatch does", async () => {
  await withSandbox(async (artifactsDir) => {
    await writeSessionConfig(artifactsDir, {
      block_quota: { host_model: "vendor/model-x" },
    });
    const { stdout } = await captureConsole(() =>
      cmdQuota(quotaArgv(artifactsDir, ["--provider", "codex"])),
    );
    const preview = JSON.parse(stdout);
    expect(
      preview.model,
      "the preview's driver model must resolve the same way prepare-dispatch resolves it",
    ).toBe("vendor/model-x");
    expect(
      preview.provider_model_key,
      "the previewed quota key must be the key the real dispatch pool builds",
    ).toBe("codex/vendor/model-x");
  });
});

test("both entry points read the AUDIT_CODE_HOST_MODEL hint the pool builder reads", async () => {
  const previous = process.env.AUDIT_CODE_HOST_MODEL;
  process.env.AUDIT_CODE_HOST_MODEL = "env/model-y";
  try {
    await withSandbox(async (artifactsDir) => {
      const { stdout } = await captureConsole(() =>
        cmdQuota(quotaArgv(artifactsDir, ["--provider", "codex"])),
      );
      const preview = JSON.parse(stdout);
      expect(
        preview.provider_model_key,
        "buildHostPoolPreamble resolves the env hint, so the reported key must too",
      ).toBe("codex/env/model-y");
    });
  } finally {
    if (previous === undefined) delete process.env.AUDIT_CODE_HOST_MODEL;
    else process.env.AUDIT_CODE_HOST_MODEL = previous;
  }
});

test("an explicit --host-model still outranks config and env on the preview", async () => {
  const previous = process.env.AUDIT_CODE_HOST_MODEL;
  process.env.AUDIT_CODE_HOST_MODEL = "env/model-y";
  try {
    await withSandbox(async (artifactsDir) => {
      await writeSessionConfig(artifactsDir, {
        block_quota: { host_model: "vendor/model-x" },
      });
      const { stdout } = await captureConsole(() =>
        cmdQuota(
          quotaArgv(artifactsDir, [
            "--provider",
            "codex",
            "--host-model",
            "flag/model-z",
          ]),
        ),
      );
      expect(JSON.parse(stdout).provider_model_key).toBe("codex/flag/model-z");
    });
  } finally {
    if (previous === undefined) delete process.env.AUDIT_CODE_HOST_MODEL;
    else process.env.AUDIT_CODE_HOST_MODEL = previous;
  }
});

// ── 3. The identity is single-sourced, so it cannot drift apart again ───────

/**
 * Strip block and line comments so the prose describing these invariants does not
 * trip the scans below — only CODE may name the shapes being banned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("both dispatch entry points resolve driver identity through the one resolver", async () => {
  const names = ["prepareDispatchCommand.ts", "quotaCommand.ts"];
  const sources = await Promise.all(
    names.map(async (name) =>
      stripComments(await readFile(join(repoRoot, "src", "audit", "cli", name), "utf8")),
    ),
  );
  for (const [index, source] of sources.entries()) {
    const name = names[index];
    expect(
      source,
      `${name} must resolve the driver through resolveDispatchDriverIdentity, not its own copy of the precedence`,
    ).toContain("resolveDispatchDriverIdentity");
    // A re-inlined `block_quota?.host_model` is exactly how the two drifted: one
    // spelled the precedence out (and still missed the env leg), the other did not.
    expect(
      source,
      `${name} must not re-inline the host-model precedence — it lives in resolveHostModel`,
    ).not.toMatch(/block_quota/);
    // A try/catch around the load is the fail-open shape that must not return.
    expect(
      source,
      `${name} must let loadSessionConfig's validation error propagate (fail closed)`,
    ).not.toMatch(/try\s*\{[\s\S]*?loadSessionConfig[\s\S]*?\}\s*catch/);
  }
});
