/**
 * 3b transport tests for `ClaudeWorkerProvider` — the proxied, ISOLATED,
 * per-packet-routed Claude-harness worker (the kind-1 launch transport,
 * docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md): constructor
 * invariants (endpoint/backend_provider/model), argv namespace-model composition,
 * the REQUIRED env overlay (proxy base url + dummy key + isolated per-launch
 * CLAUDE_CONFIG_DIR), mechanical trust pre-seeding, best-effort config-dir
 * cleanup, the factory/launch-bridge branch, and the auto-resolution guard
 * (claude-worker is source-pool-only — auto can never pick it).
 */
import { test, describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  ClaudeWorkerProvider,
  CLAUDE_WORKER_PROVIDER_NAME,
  CLAUDE_WORKER_DUMMY_API_KEY,
  claudeWorkerTrustProjectKey,
} = await import("audit-tools/shared/providers/claudeWorkerProvider");
const {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} = await import("audit-tools/shared/providers/providerFactory");
const { sourceProviderConfig, withSourceConfig } = await import(
  "audit-tools/shared/quota/apiPool"
);
const { commandExists } = await import(
  "audit-tools/shared/providers/providerPathGuard"
);

const PROXY_URL = "http://127.0.0.1:8791";

const WORKER_CONFIG = {
  endpoint: PROXY_URL,
  backend_provider: "nim",
  model: "z-ai/glm-5.2",
};

/** Launch harness mirroring the codex provider tests: injected launchCommand
 * captures (command, args, input, env); prompt/task live in a real temp dir so
 * the trust file seeded under env.CLAUDE_CONFIG_DIR can be read back. */
function launchWorker(config = WORKER_CONFIG, options = {}, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-worker-prov-"));
  const promptPath = join(dir, "node.md");
  const taskPath = join(dir, "task.json");
  writeFileSync(promptPath, "IMPLEMENT THIS NODE");
  writeFileSync(taskPath, JSON.stringify({ timeout_ms: 1000 }));
  let captured = null;
  const stub = (command, args, input, env) => {
    // Snapshot the trust file DURING the launch (before cleanup removes it).
    const trustPath = join(env.CLAUDE_CONFIG_DIR, ".claude.json");
    const trustRaw = existsSync(trustPath)
      ? readFileSync(trustPath, "utf8")
      : null;
    captured = { command, args, input, env, trustRaw };
    return Promise.resolve({ accepted: true });
  };
  const provider = new ClaudeWorkerProvider(config, options, stub);
  const input = {
    repoRoot: join(dir, "worktree"),
    runId: "RID",
    obligationId: null,
    promptPath,
    taskPath,
    resultPath: join(dir, "artifacts", "B1.result.json"),
    stdoutPath: join(dir, "out.txt"),
    stderrPath: join(dir, "err.txt"),
    uiMode: "headless",
    timeoutMs: 5000,
    ...overrides,
  };
  return { promiseResult: provider.launch(input), getCaptured: () => captured, input };
}

describe("ClaudeWorkerProvider construction invariants", () => {
  it("throws on a missing/empty endpoint (an isolated spawn with no proxy endpoint is impossible)", () => {
    for (const bad of [undefined, "", "   "]) {
      assert.throws(
        () => new ClaudeWorkerProvider({ ...WORKER_CONFIG, endpoint: bad }),
        /claude-worker provider requires a non-empty endpoint/,
      );
    }
  });

  it("throws on a missing/empty backend_provider", () => {
    assert.throws(
      () => new ClaudeWorkerProvider({ ...WORKER_CONFIG, backend_provider: "" }),
      /claude-worker provider requires a non-empty backend_provider/,
    );
  });

  it("throws on a missing/empty model", () => {
    assert.throws(
      () => new ClaudeWorkerProvider({ ...WORKER_CONFIG, model: undefined }),
      /claude-worker provider requires a non-empty model/,
    );
  });

  it("constructs with the three routing fields and carries the provider name", () => {
    const provider = new ClaudeWorkerProvider(WORKER_CONFIG);
    expect(provider.name).toBe(CLAUDE_WORKER_PROVIDER_NAME);
    expect(provider.name).toBe("claude-worker");
  });
});

describe("ClaudeWorkerProvider.launch — argv composition", () => {
  it("REGRESSION PIN (i): passes --model <alias> VERBATIM to the proxy", async () => {
    // PRE-SWAP: composed as `${backend_provider}/${model}` = "nim/z-ai/glm-5.2"
    // POST-SWAP: passes the alias verbatim = "z-ai/glm-5.2"
    const h = launchWorker();
    await h.promiseResult;
    const c = h.getCaptured();
    expect(c, "launchCommand was called").toBeTruthy();
    expect(c.command).toBe("claude");
    // Model is the alias VERBATIM, NOT composed from backend_provider
    expect(c.args.slice(0, 3)).toEqual(["-p", "--model", "z-ai/glm-5.2"]);
    // Prompt is delivered via stdin, never as an argv positional.
    expect(c.input.stdinText).toBe("IMPLEMENT THIS NODE");
    expect(c.args.join(" ").includes("IMPLEMENT THIS NODE")).toBeFalsy();
    // Per-task timeout honored (mirrors the shared workerTaskLaunch policy).
    expect(c.input.timeoutMs).toBe(1000);
  });

  it("honors command/prompt_flag/extra_args config, extra_args after --model", async () => {
    const h = launchWorker({
      ...WORKER_CONFIG,
      command: "claude-custom",
      prompt_flag: "--print",
      extra_args: ["--verbose"],
    });
    await h.promiseResult;
    const c = h.getCaptured();
    expect(c.command).toBe("claude-custom");
    expect(c.args).toEqual([
      "--print",
      "--model",
      "z-ai/glm-5.2", // Model is the alias VERBATIM, not composed
      "--verbose",
    ]);
  });

  it("skip-permissions: safe default off; option default on; explicit config wins both ways", async () => {
    const flat = async (config, options) => {
      const h = launchWorker(config, options);
      await h.promiseResult;
      return h.getCaptured().args;
    };
    expect(await flat(WORKER_CONFIG, {})).not.toContain(
      "--dangerously-skip-permissions",
    );
    expect(
      await flat(WORKER_CONFIG, { skipPermissionsDefault: true }),
    ).toContain("--dangerously-skip-permissions");
    expect(
      await flat(
        { ...WORKER_CONFIG, dangerously_skip_permissions: false },
        { skipPermissionsDefault: true },
      ),
    ).not.toContain("--dangerously-skip-permissions");
    expect(
      await flat(
        { ...WORKER_CONFIG, dangerously_skip_permissions: true },
        { skipPermissionsDefault: false },
      ),
    ).toContain("--dangerously-skip-permissions");
  });
});

describe("ClaudeWorkerProvider.launch — env overlay + isolated config dir", () => {
  it("REGRESSION PIN (ii): ANTHROPIC_AUTH_TOKEN overlay (sentinel when keyless)", async () => {
    // PRE-SWAP: ANTHROPIC_AUTH_TOKEN was not set; only ANTHROPIC_API_KEY existed.
    // POST-SWAP: ANTHROPIC_AUTH_TOKEN set from api_key_env (or sentinel when keyless).
    // ANTHROPIC_API_KEY still set to sentinel (never leak ambient real key).
    const h = launchWorker();
    await h.promiseResult;
    const env = h.getCaptured().env;
    // Keyless proxy: ANTHROPIC_AUTH_TOKEN = sentinel
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDE_WORKER_DUMMY_API_KEY);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("audit-tools-claude-worker");
    // ANTHROPIC_API_KEY also set to sentinel (never leak ambient key)
    expect(env.ANTHROPIC_API_KEY).toBe(CLAUDE_WORKER_DUMMY_API_KEY);
  });

  it("overlays proxy base url, auth tokens, and an isolated config dir", async () => {
    const h = launchWorker();
    await h.promiseResult;
    const env = h.getCaptured().env;
    expect(env.ANTHROPIC_BASE_URL).toBe(PROXY_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDE_WORKER_DUMMY_API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(CLAUDE_WORKER_DUMMY_API_KEY);
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.CLAUDE_CONFIG_DIR).toContain("audit-tools-claude-worker");
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CONFIG_DIR",
    ]);
  });

  it("uses a DISTINCT isolated config dir per launch", async () => {
    const a = launchWorker();
    await a.promiseResult;
    const b = launchWorker();
    await b.promiseResult;
    const dirA = a.getCaptured().env.CLAUDE_CONFIG_DIR;
    const dirB = b.getCaptured().env.CLAUDE_CONFIG_DIR;
    expect(dirA).not.toBe(dirB);
  });

  it("pre-seeds trust for the normalized (forward-slash) repo root before the spawn", async () => {
    const h = launchWorker();
    await h.promiseResult;
    const c = h.getCaptured();
    expect(c.trustRaw, "trust file existed at spawn time").toBeTruthy();
    const trust = JSON.parse(c.trustRaw);
    const key = claudeWorkerTrustProjectKey(h.input.repoRoot);
    // Forward slashes on every platform (live-probed CLI trust-key shape).
    expect(key.includes("\\")).toBeFalsy();
    expect(key).toBe(h.input.repoRoot.replace(/\\/g, "/"));
    expect(trust.projects[key]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("cleans the per-launch config dir up after the launch resolves (best-effort)", async () => {
    const h = launchWorker();
    await h.promiseResult;
    expect(existsSync(h.getCaptured().env.CLAUDE_CONFIG_DIR)).toBeFalsy();
  });

  it("cleans up and propagates the original error when the spawn rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-worker-prov-"));
    writeFileSync(join(dir, "node.md"), "P");
    writeFileSync(join(dir, "task.json"), "{}");
    let seenEnv = null;
    const provider = new ClaudeWorkerProvider(WORKER_CONFIG, {}, (c, a, i, env) => {
      seenEnv = env;
      return Promise.reject(new Error("spawn exploded"));
    });
    await assert.rejects(
      provider.launch({
        repoRoot: dir,
        runId: "RID",
        obligationId: null,
        promptPath: join(dir, "node.md"),
        taskPath: join(dir, "task.json"),
        resultPath: join(dir, "r.json"),
        stdoutPath: join(dir, "out.txt"),
        stderrPath: join(dir, "err.txt"),
        uiMode: "headless",
        timeoutMs: 5000,
      }),
      /spawn exploded/,
    );
    expect(existsSync(seenEnv.CLAUDE_CONFIG_DIR)).toBeFalsy();
  });
});

describe("claudeWorkerTrustProjectKey", () => {
  it("normalizes win32 backslashes to forward slashes and strips trailing separators", () => {
    expect(claudeWorkerTrustProjectKey("C:\\Code\\audit-tools")).toBe(
      "C:/Code/audit-tools",
    );
    expect(claudeWorkerTrustProjectKey("C:\\Code\\audit-tools\\")).toBe(
      "C:/Code/audit-tools",
    );
    expect(claudeWorkerTrustProjectKey("/home/user/repo/")).toBe(
      "/home/user/repo",
    );
    expect(claudeWorkerTrustProjectKey("/")).toBe("/");
  });
});

describe("factory / launch bridge", () => {
  // Minimal deps for the factory — only the claude-worker branch is exercised.
  const deps = {
    orchestratorName: "test",
    createClaudeCodeProvider: () => {
      throw new Error("unexpected: createClaudeCodeProvider called");
    },
    createClaudeWorkerProvider: (config) =>
      new ClaudeWorkerProvider(config, { skipPermissionsDefault: false }),
    createOpenCodeProvider: () => {
      throw new Error("unexpected: createOpenCodeProvider called");
    },
    createAgyProvider: () => {
      throw new Error("unexpected: createAgyProvider called");
    },
  };

  it("sourceProviderConfig bridges a claude-worker source to the claude_worker block", () => {
    const cfg = sourceProviderConfig({
      provider: "claude-worker",
      endpoint: PROXY_URL,
      backend_provider: "nim",
      model: "z-ai/glm-5.2",
      parameters: { extra_args: ["--verbose"] },
    });
    expect(cfg).toEqual({
      claude_worker: {
        endpoint: PROXY_URL,
        backend_provider: "nim",
        model: "z-ai/glm-5.2",
        extra_args: ["--verbose"],
      },
    });
  });

  it("constructProvider builds the worker FROM the source via withSourceConfig", () => {
    const source = {
      provider: "claude-worker",
      endpoint: PROXY_URL,
      backend_provider: "nim",
      model: "z-ai/glm-5.2",
    };
    const cfg = withSourceConfig({}, source);
    const provider = createFreshSessionProvider("claude-worker", cfg, deps);
    expect(provider instanceof ClaudeWorkerProvider).toBeTruthy();
    expect(provider.name).toBe("claude-worker");
    // Agentic CLI: no API-level output constraint — degrades to emit-validate-repair.
    expect(provider.outputConstraint?.mode).toBe("none");
  });

  it("construction fails LOUDLY when no claude_worker block reached the factory", () => {
    assert.throws(
      () => createFreshSessionProvider("claude-worker", {}, deps),
      /claude-worker provider requires a non-empty endpoint/,
    );
  });

  it("auto-resolution can NEVER pick claude-worker (source-pool-only worker class)", () => {
    // Even with every command on PATH, every in-session marker unset, and a
    // composed claude_worker block present, auto never lands on claude-worker.
    // (The rule table's `name` type excludes it — this pins the behavior.)
    for (const commandLookup of [() => true, () => false]) {
      const resolved = resolveFreshSessionProviderName(
        "auto",
        { claude_worker: { ...WORKER_CONFIG } },
        { env: {}, commandExists: commandLookup },
      );
      expect(resolved).not.toBe("claude-worker");
    }
  });
});

// ── Gated live smoke — a REAL nested `claude -p` spawn against a fake loopback
// /v1/messages endpoint (ground-truth 1 of the plan turned into a fixture).
// Skipped unless `claude` is on PATH AND RUN_CLAUDE_WORKER_SMOKE=1.
const smokeEnabled =
  process.env.RUN_CLAUDE_WORKER_SMOKE === "1" && commandExists("claude");

test.skipIf(!smokeEnabled)(
  "live smoke: proxied isolated spawn round-trips the namespace model",
  async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        let model = "unknown";
        try {
          model = JSON.parse(body).model;
        } catch {
          // Non-JSON body (e.g. a GET probe) — keep the sentinel.
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_smoke",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: "pong" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const dir = mkdtempSync(join(tmpdir(), "claude-worker-smoke-"));
      writeFileSync(join(dir, "node.md"), "Reply with exactly: pong");
      writeFileSync(join(dir, "task.json"), "{}");
      const provider = new ClaudeWorkerProvider({
        ...WORKER_CONFIG,
        endpoint,
      });
      const stdoutPath = join(dir, "out.txt");
      const result = await provider.launch({
        repoRoot: dir,
        runId: "SMOKE",
        obligationId: null,
        promptPath: join(dir, "node.md"),
        taskPath: join(dir, "task.json"),
        resultPath: join(dir, "r.json"),
        stdoutPath,
        stderrPath: join(dir, "err.txt"),
        uiMode: "headless",
        timeoutMs: 120_000,
      });
      expect(result.accepted, `spawn failed: ${result.error ?? ""}`).toBeTruthy();
      // The namespace routing key reached the endpoint VERBATIM.
      const messageHits = requests.filter(
        (r) => r.method === "POST" && r.url.startsWith("/v1/messages"),
      );
      expect(messageHits.length).toBeGreaterThan(0);
      expect(
        messageHits.some((r) => r.body.includes('"model":"nim/z-ai/glm-5.2"')),
      ).toBeTruthy();
      // The fake endpoint's reply round-tripped to the worker's stdout log.
      expect(await readFile(stdoutPath, "utf8")).toContain("pong");
    } finally {
      server.close();
    }
  },
  180_000,
);
