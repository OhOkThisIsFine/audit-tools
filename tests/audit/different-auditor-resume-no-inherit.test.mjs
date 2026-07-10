import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

// The founding capability-inheritance bug: a run started under one auditor's
// provider (e.g. `codex`) and resumed by a DIFFERENT auditor (a Claude host fanning
// out subagents on the host-review path) must NOT size or charge the fan-out against
// the ORIGINAL provider's quota. The host-review dispatch pool is keyed to the
// conversation host, never the inherited `sessionConfig.provider`.
// [[capability-is-per-auditor-not-per-audit]]
const { resolveHostDispatchProviderName } = await import(
  "../../src/audit/cli/rollingAuditDispatch.ts"
);
const { renderSemanticReviewStep } = await import("../../src/audit/cli/semanticReviewStep.ts");

// The conversation-host resolver (B1) reads the run's own session env, so these
// unit assertions must control it rather than depend on whatever ambient host the
// suite runs under. `withHostEnv` clears every self-spawn signal, applies an
// explicit overlay, runs the body, and restores the prior values in a finally.
const HOST_ENV_KEYS = [
  "CLAUDECODE",
  "CODEX",
  "CODEX_SHELL",
  "CODEX_THREAD_ID",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
];
function withHostEnv(overlay, body) {
  const saved = {};
  for (const key of HOST_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overlay)) process.env[key] = value;
  try {
    return body();
  } finally {
    for (const key of HOST_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("resolveHostDispatchProviderName demotes an inherited backend to a non-driver", () => {
  it("a headless in-process backend resolves to the conversation host (claude-code by default)", () => {
    withHostEnv({}, () => {
      for (const provider of ["codex", "opencode", "openai-compatible"]) {
        expect(resolveHostDispatchProviderName({ provider })).toBe("claude-code");
      }
    });
  });

  it("unset / auto resolves to the conversation host (claude-code by default)", () => {
    withHostEnv({}, () => {
      expect(resolveHostDispatchProviderName(undefined)).toBe("claude-code");
      expect(resolveHostDispatchProviderName(null)).toBe("claude-code");
      expect(resolveHostDispatchProviderName({})).toBe("claude-code");
      expect(resolveHostDispatchProviderName({ provider: "auto" })).toBe("claude-code");
    });
  });

  it("an explicit conversation-host / IDE provider passes through (it IS a driver)", () => {
    withHostEnv({}, () => {
      for (const provider of [
        "claude-code",
        "worker-command",
        "vscode-task",
        "antigravity",
      ]) {
        expect(resolveHostDispatchProviderName({ provider })).toBe(provider);
      }
    });
  });

  // B1 host-identity sourcing: inside a Codex session the demoted-backend driver
  // is codex (its own meter), not the literal claude-code that mis-charged the
  // exhausted Claude pool. [[host-provider-misattribution-nim-codex]]
  it("inside a Codex session, a demoted backend / unset provider resolves to codex", () => {
    withHostEnv({ CODEX_THREAD_ID: "t-1" }, () => {
      expect(resolveHostDispatchProviderName({ provider: "openai-compatible" })).toBe("codex");
      expect(resolveHostDispatchProviderName({ provider: "codex" })).toBe("codex");
      expect(resolveHostDispatchProviderName(undefined)).toBe("codex");
      expect(resolveHostDispatchProviderName({ provider: "auto" })).toBe("codex");
    });
  });

  // The explicit override still wins over env detection (escape hatch for
  // ambiguous nesting) and an explicit conversation-host provider stays a driver.
  it("host_provider override wins over env detection for a demoted backend", () => {
    withHostEnv({ CODEX_THREAD_ID: "t-1" }, () => {
      expect(
        resolveHostDispatchProviderName({
          provider: "openai-compatible",
          host_provider: "claude-code",
        }),
      ).toBe("claude-code");
    });
  });
});

describe("host-review dispatch pool for a codex-configured run is keyed to claude-code, not codex", () => {
  let artifactsDir;
  let result;
  const savedHostEnv = {};

  beforeAll(async () => {
    // A CLAUDE host resumes this codex-provider run: pin the env to that (clear
    // every codex self-spawn signal, clear CLAUDECODE so the default applies) so
    // the B1 env detection deterministically resolves the conversation host to
    // claude-code regardless of the host the suite itself runs under.
    for (const key of HOST_ENV_KEYS) {
      savedHostEnv[key] = process.env[key];
      delete process.env[key];
    }
    artifactsDir = await mkdtemp(join(os.tmpdir(), "audit-no-inherit-"));
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    const runId = "test-run-no-inherit";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(join(runDir, "task-results"), { recursive: true });

    // A run whose STORED session config pins the ORIGINAL auditor's provider (codex).
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ provider: "codex", quota: {} }),
      "utf8",
    );

    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify([
        {
          task_id: "t-abc123",
          unit_id: "unit-abc",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_paths: ["src/foo/foo.ts"],
          file_line_counts: { "src/foo/foo.ts": 50 },
          rationale: "review foo",
          priority: "medium",
        },
      ]),
      "utf8",
    );

    const runDirPath = join(artifactsDir, "runs", runId);
    const activeReviewRun = {
      run_id: runId,
      task_path: join(runDirPath, "current-task.json"),
      prompt_path: join(runDirPath, "current-prompt.md"),
      pending_audit_tasks_path: join(runDirPath, "pending-audit-tasks.json"),
      audit_results_path: join(artifactsDir, "audit-results.jsonl"),
      worker_command: ["audit-code", "submit-packet", "--artifacts-dir", artifactsDir],
    };

    // A DIFFERENT auditor (a Claude host) resumes and fans out subagents.
    result = await renderSemanticReviewStep({
      root: artifactsDir,
      artifactsDir,
      activeReviewRun,
      hostCanDispatch: true,
      hostMaxActiveSubagents: null,
      hostContextTokens: 200000,
      hostOutputTokens: 32000,
      hostCanRestrictSubagentTools: false,
      hostCanSelectSubagentModel: false,
    });
  });

  afterAll(async () => {
    for (const key of HOST_ENV_KEYS) {
      if (savedHostEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedHostEnv[key];
    }
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it("emits a dispatch_review step", () => {
    expect(result.step_kind).toBe("dispatch_review");
  });

  it("every dispatch-quota capacity pool is keyed to claude-code, never the inherited codex", async () => {
    const quotaPath = result.artifact_paths?.dispatch_quota;
    expect(typeof quotaPath).toBe("string");
    const quota = JSON.parse(await readFile(quotaPath, "utf8"));
    const pools = quota.capacity_pools ?? [];
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) {
      expect(pool.pool_id.startsWith("claude-code")).toBe(true);
      expect(pool.pool_id.startsWith("codex")).toBe(false);
    }
  });

  it("the continue-command re-emits the current driver's handshake (descriptor rides it)", () => {
    const cont = result.allowed_commands.find((c) => /next-step/.test(c));
    expect(cont).toBeTruthy();
    expect(cont).toContain("--host-context-tokens");
    expect(cont).toContain("200000");
    expect(cont).toContain("--host-can-dispatch-subagents");
  });
});

