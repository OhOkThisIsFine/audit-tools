import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { ProviderName } from "audit-tools/shared";

// The founding capability-inheritance bug: a run started under one auditor's
// provider (e.g. `codex`) and resumed by a DIFFERENT auditor (a Claude host fanning
// out subagents on the host-review path) must NOT size or charge the fan-out against
// the ORIGINAL provider's quota. The host-review dispatch pool is keyed to the
// conversation host, never the inherited `sessionConfig.provider`.
// [[capability-is-per-auditor-not-per-audit]]
const { resolveHostDispatchProviderName } = await import(
  "../../src/audit/cli/rollingAuditDispatch.js"
);
const { renderSemanticReviewStep } = await import("../../src/audit/cli/semanticReviewStep.js");

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
function withHostEnv<T>(overlay: Record<string, string>, body: () => T): T {
  const saved: Record<string, string | undefined> = {};
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
      const providers: ProviderName[] = ["codex", "opencode", "openai-compatible"];
      for (const provider of providers) {
        expect(resolveHostDispatchProviderName({ provider }, { env: {} })).toBe("worker-command");
      }
    });
  });

  it("unset / auto resolves to the conversation host (claude-code by default)", () => {
    withHostEnv({}, () => {
      expect(resolveHostDispatchProviderName(undefined, { env: {} })).toBe("worker-command");
      expect(resolveHostDispatchProviderName(null, { env: {} })).toBe("worker-command");
      expect(resolveHostDispatchProviderName({}, { env: {} })).toBe("worker-command");
      expect(resolveHostDispatchProviderName({ provider: "auto" }, { env: {} })).toBe("worker-command");
    });
  });

  it("an explicit conversation-host / IDE provider passes through (it IS a driver)", () => {
    withHostEnv({}, () => {
      const providers: ProviderName[] = [
        "claude-code",
        "worker-command",
        "vscode-task",
        "antigravity",
      ];
      for (const provider of providers) {
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

describe("host-review dispatch for a codex-configured run never inherits the codex identity", () => {
  let artifactsDir: string;
  let result: Awaited<ReturnType<typeof renderSemanticReviewStep>>;
  const savedHostEnv: Record<string, string | undefined> = {};

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

    // G2: a provider can NO LONGER be stored on the repo config (dispatch capability
    // rides the per-auditor --auditor descriptor, never the repo config) — so the
    // "inherited codex provider" the original bug leaked is now STRUCTURALLY
    // impossible. The stored config carries INTENT only; the resuming Claude host's
    // identity comes from its descriptor + env below.
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ quota: {} }),
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

    // A DIFFERENT auditor (a Claude host) resumes and fans out subagents. Its
    // descriptor identifies its current host explicitly — desktop hosts do not
    // reliably expose an env marker. That identity, never a stored codex value,
    // rides every continue-command.
    const hostDescriptor = {
      self: {
        provider: "claude-code" as const,
        can_dispatch_subagents: true,
        context_tokens: 200000,
        output_tokens: 32000,
      },
    };
    result = await renderSemanticReviewStep({
      root: artifactsDir,
      artifactsDir,
      activeReviewRun,
      hostMaxActiveSubagents: null,
      hostContextTokens: 200000,
      hostOutputTokens: 32000,
      descriptor: hostDescriptor,
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

  it("host-owned dispatch writes no admission quota artifact and inherits no codex identity", async () => {
    // Post dispatch-inversion the attended host (and llm-relay) own admission:
    // finalizeDispatchQuota is headless-only, so this path emits NO dispatch_quota
    // artifact — the inherited-codex-pool leak the original bug charged against is
    // structurally impossible because no capacity pool is persisted at all.
    expect(result.artifact_paths?.dispatch_quota).toBeUndefined();
    // The dispatch plan that IS written carries the neutral bookkeeping identity,
    // never the stored run's codex provider.
    const planPath = result.artifact_paths?.dispatch_plan;
    expect(typeof planPath).toBe("string");
    const planRaw = await readFile(planPath!, "utf8");
    expect(planRaw.includes("codex")).toBe(false);
  });

  it("the continue-command re-emits the current driver's handshake (descriptor rides it)", () => {
    const cont = result.allowed_commands.find((c) => /next-step/.test(c));
    expect(cont).toBeTruthy();
    expect(cont).toContain("--auditor");

    // The command string has the format:
    // ... --auditor "{"self":{...}}"
    // Extract the JSON that comes after --auditor
    const auditorIdx = cont!.indexOf("--auditor");
    expect(auditorIdx).toBeGreaterThanOrEqual(0);

    // Find the opening quote
    const openQuoteIdx = cont!.indexOf('"', auditorIdx);
    expect(openQuoteIdx).toBeGreaterThanOrEqual(0);

    // The JSON string ends at the last quote (we scan backwards from the end)
    // because the command should end with the JSON string
    const closeQuoteIdx = cont!.lastIndexOf('"');
    expect(closeQuoteIdx).toBeGreaterThan(openQuoteIdx);

    // Extract the JSON part (between the quotes)
    const jsonWithEscapes = cont!.substring(openQuoteIdx + 1, closeQuoteIdx);

    // Unescape the JSON string (replace \" with ")
    const jsonStr = jsonWithEscapes.replace(/\\"/g, '"');

    const descriptor = JSON.parse(jsonStr);

    // Verify the handshake values are preserved
    expect(descriptor.self).toBeDefined();
    expect(descriptor.self.context_tokens).toBe(200000);
    expect(descriptor.self.output_tokens).toBe(32000);
    expect(descriptor.self.can_dispatch_subagents).toBe(true);
  });
});
