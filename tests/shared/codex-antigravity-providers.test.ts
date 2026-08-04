import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_NAMES,
  classifyProvider,
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
  CodexProvider,
  SubprocessTemplateProvider,
  OpenAiCompatibleProvider,
  discoverOutputConstraintCapability,
  AgyProvider,
} from "audit-tools/shared";
import type {
  FreshSessionProviderDeps,
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
  CodexConfig,
  OpenAiCompatibleConfig,
} from "audit-tools/shared";

// Minimal deps for the factory. Codex/antigravity never touch the claude-code /
// opencode options; every factory hook throws if called, since none of the
// codex/antigravity/agy construction paths below reach them.
const deps: FreshSessionProviderDeps = {
  orchestratorName: "test",
  createClaudeCodeProvider: () => {
    throw new Error("unexpected: createClaudeCodeProvider called in codex/antigravity/agy test");
  },
  createClaudeWorkerProvider: () => {
    throw new Error("unexpected: createClaudeWorkerProvider called in codex/antigravity/agy test");
  },
  createOpenCodeProvider: () => {
    throw new Error("unexpected: createOpenCodeProvider called in codex/antigravity/agy test");
  },
  createAgyProvider: () => {
    throw new Error("unexpected: createAgyProvider called in codex/antigravity/agy test");
  },
};

const noCommands = () => false;
const allCommands = () => true;

test("codex and antigravity are members of PROVIDER_NAMES", () => {
  expect(PROVIDER_NAMES.includes("codex")).toBeTruthy();
  expect(PROVIDER_NAMES.includes("antigravity")).toBeTruthy();
});

test("resolveFreshSessionProviderName passes codex through verbatim", () => {
  expect(resolveFreshSessionProviderName("codex", {})).toBe("codex");
});

test("resolveFreshSessionProviderName passes antigravity through verbatim", () => {
  expect(resolveFreshSessionProviderName("antigravity", {})).toBe("antigravity");
});

test("auto resolves to codex when inside a codex session", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: noCommands },
  );
  expect(resolved).toBe("codex");
});

test("auto resolves to codex from config when only codex is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { codex: { command: "codex" } },
    {
      // No claude/opencode session env, and only `codex` resolves on PATH.
      env: {},
      commandExists: (command) => command === "codex",
    },
  );
  expect(resolved).toBe("codex");
});

test("auto resolves to antigravity with the IDE marker and a template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  expect(resolved).toBe("antigravity");
});

test("auto does NOT resolve to antigravity with the marker but no template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  expect(resolved).not.toBe("antigravity");
});

test("createFreshSessionProvider constructs a CodexProvider", () => {
  const provider = createFreshSessionProvider("codex", {}, deps);
  expect(provider.name).toBe("codex");
  expect(provider instanceof CodexProvider).toBeTruthy();
});

test("codex construction succeeds with an absent codex config", () => {
  // No sessionConfig.codex at all — command defaults to "codex".
  const provider = createFreshSessionProvider("codex", {}, deps);
  expect(provider instanceof CodexProvider).toBeTruthy();
});

test("createFreshSessionProvider constructs a SubprocessTemplateProvider for antigravity", () => {
  const provider = createFreshSessionProvider(
    "antigravity",
    { antigravity: { command_template: ["ag", "--run"] } },
    deps,
  );
  expect(provider.name).toBe("antigravity");
  expect(provider instanceof SubprocessTemplateProvider).toBeTruthy();
});

test("antigravity throws when no command template is configured", () => {
  assert.throws(
    () => createFreshSessionProvider("antigravity", {}, deps),
    /antigravity.*command_template/i,
  );
});

test("antigravity throws when the command template is empty", () => {
  assert.throws(
    () =>
      createFreshSessionProvider(
        "antigravity",
        { antigravity: { command_template: [] } },
        deps,
      ),
    /antigravity.*command_template/i,
  );
});

test("CodexProvider.queryLimits resolves to null (best-effort no-op)", async () => {
  const provider = new CodexProvider(undefined);
  expect(await provider.queryLimits(null)).toBe(null);
  expect(await provider.queryLimits("some-model")).toBe(null);
});

// ── CodexProvider.launch — verified invocation shape (codex-cli 0.140.0) ───────
// The non-interactive entrypoint is `codex exec`, the prompt is delivered via
// stdin, the sandbox is rooted at the worktree (--cd) and the result dir is
// granted (--add-dir). Asserted on the flattened command so the Windows cmd.exe
// shim wrap and the POSIX direct form both pass.

function launchCodex(
  config: CodexConfig | undefined,
  overrides: Partial<LaunchFreshSessionInput> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "codex-prov-"));
  const promptPath = join(dir, "node.md");
  const taskPath = join(dir, "task.json");
  writeFileSync(promptPath, "IMPLEMENT THIS NODE");
  writeFileSync(taskPath, JSON.stringify({ timeout_ms: 1000 }));
  let captured: { command: string; args: string[]; input: LaunchFreshSessionInput } | null = null;
  const stub = (
    command: string,
    args: string[],
    input: LaunchFreshSessionInput,
  ): Promise<LaunchFreshSessionResult> => {
    captured = { command, args, input };
    return Promise.resolve({ accepted: true });
  };
  const provider = new CodexProvider(config, stub);
  const input: LaunchFreshSessionInput = {
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

test("CodexProvider.launch invokes `codex exec` with stdin prompt + worktree-rooted sandbox", async () => {
  const h = launchCodex(undefined);
  await h.promiseResult;
  const c = h.getCaptured();
  expect(c, "launchCommand was called").toBeTruthy();
  if (!c) throw new Error("unreachable: the expect above guarantees launchCommand was called");
  const flat = [c.command, ...c.args].join(" ");
  expect(flat).toMatch(/\bexec\b/);
  expect(flat).toMatch(/--sandbox/);
  expect(flat).toMatch(/workspace-write/);
  expect(flat).toMatch(/--cd/);
  expect(flat).toMatch(/--add-dir/);
  // Headless dispatch runs in untrusted temp dirs / fresh worktrees; without
  // this flag `codex exec` refuses to start and exits 1 before doing any work.
  expect(flat).toMatch(/--skip-git-repo-check/);
  // Prompt is delivered via stdin, never as an argv positional.
  expect(c.input.stdinText).toBe("IMPLEMENT THIS NODE");
  expect(!flat.includes("IMPLEMENT THIS NODE"), "prompt body must not appear in argv").toBeTruthy();
  // No bogus `--prompt`/`--ask-for-approval` (the old stub's unverified guesses).
  expect(!flat.includes("--prompt"), "no --prompt flag").toBeTruthy();
  expect(!flat.includes("--ask-for-approval"), "exec has no --ask-for-approval flag").toBeTruthy();
});

test("CodexProvider.launch honors sandbox_mode + model config (no hardcoded model)", async () => {
  const h = launchCodex({ sandbox_mode: "danger-full-access", model: "some-model-id" });
  await h.promiseResult;
  const c = h.getCaptured();
  if (!c) throw new Error("unreachable: launchCommand was called during the launch above");
  const flat = [c.command, ...c.args].join(" ");
  expect(flat).toMatch(/danger-full-access/);
  expect(!flat.includes("workspace-write"), "explicit sandbox_mode overrides the default").toBeTruthy();
  expect(flat).toMatch(/--model/);
  expect(flat).toMatch(/some-model-id/);
});

test("CodexProvider.launch omits --model when unset (codex default applies)", async () => {
  const h = launchCodex(undefined);
  await h.promiseResult;
  const c = h.getCaptured();
  if (!c) throw new Error("unreachable: launchCommand was called during the launch above");
  const flat = [c.command, ...c.args].join(" ");
  expect(!flat.includes("--model"), "no --model flag when config.model is unset").toBeTruthy();
});

test("classifyProvider maps codex to hosted and antigravity to unknown", () => {
  expect(classifyProvider("codex").hostClass).toBe("hosted");
  expect(classifyProvider("antigravity").hostClass).toBe("unknown");
});

// Guard: the bare-availability codex tie-break is last-resort only — it must NOT
// fire when claude or opencode is also available. With no provider configured and
// all three binaries on PATH, resolution preserves today's behavior (claude and
// opencode both available => neither bare tie-break fires => worker-command),
// so codex does not change existing setups.
test("codex tie-break does not preempt claude/opencode availability", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: {}, commandExists: allCommands },
  );
  expect(resolved).not.toBe("codex");
});

test("configured codex wins auto resolution because Claude is explicit-only", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { claude_code: { command: "claude" }, codex: { command: "codex" } },
    { env: {}, commandExists: allCommands },
  );
  expect(resolved).toBe("codex");
});

// Minimal deps that satisfies FreshSessionProviderDeps for the auto path.
// The auto path resolves to worker-command or another non-claude/opencode
// provider in most test environments, so these branches are never called.
const autoDeps: FreshSessionProviderDeps = {
  orchestratorName: "test",
  createClaudeCodeProvider: () => {
    throw new Error("unexpected: createClaudeCodeProvider called in auto test");
  },
  createClaudeWorkerProvider: () => {
    throw new Error("unexpected: createClaudeWorkerProvider called in auto test");
  },
  createOpenCodeProvider: () => {
    throw new Error("unexpected: createOpenCodeProvider called in auto test");
  },
  createAgyProvider: () => {
    throw new Error("unexpected: createAgyProvider called in auto test");
  },
};

// The test's premise is that auto-resolution falls through to a NON-agent
// provider (worker-command), which only holds when NO agent CLI is detectable.
// If ANY auto-resolvable agent CLI is on PATH (claude / codex / opencode),
// auto-resolution picks it instead — claude/opencode hit the stubbed-throw deps,
// codex constructs a real provider and no "no capable agent" diagnostic is
// written — so skip rather than fail. (Generalises the old opencode-only guard
// that left the claude-on-PATH / codex-on-PATH true-green run red.)
function anyAgentCliOnPath(): boolean {
  const probe = (cmd: string): boolean =>
    spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: "pipe",
    }).status === 0;
  return probe("claude") || probe("codex") || probe("opencode");
}

test("createFreshSessionProvider auto path writes a structured stderr diagnostic", (ctx) => {
  ctx.skip(
    anyAgentCliOnPath(),
    "an auto-resolvable agent CLI (claude/codex/opencode) is on PATH in this environment",
  );
  const captured: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    createFreshSessionProvider(undefined, {}, autoDeps);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(captured.length, "exactly one stderr write expected").toBe(1);
  const line = captured[0];
  expect(line.startsWith("[shared] providers:"), `line should start with '[shared] providers:': ${line}`).toBeTruthy();
  expect(line.includes("test"), `line should contain orchestratorName 'test': ${line}`).toBeTruthy();
  expect(line.includes("auto-resolved provider"), `line should contain 'auto-resolved provider': ${line}`).toBeTruthy();
  expect(/auto-resolved provider '\w[\w-]*'/.test(line), `line should contain provider name in single quotes: ${line}`).toBeTruthy();
  expect(line.includes("fallback: none") || line.includes("no capable agent provider detected"), `line should contain either 'fallback: none' or 'no capable agent provider detected': ${line}`).toBeTruthy();
  expect(line.endsWith("\n"), `line should end with newline: ${JSON.stringify(line)}`).toBeTruthy();
});

test("createFreshSessionProvider with an explicit provider name does NOT write a stderr diagnostic", () => {
  const captured: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    createFreshSessionProvider("codex", {}, autoDeps);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(captured, "no stderr output expected for an explicitly named provider").toEqual([]);
});

// ── chooseAutoProvider: explicit priority table ───────────────────────────────

test("chooseAutoProvider: insideOpenCode wins over all other signals", () => {
  // All signals true — opencode (in-session) must still win.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {
      claude_code: { command: "claude" },
      opencode: { command: "opencode" },
      codex: { command: "codex" },
      vscode_task: { command_template: ["vscode-task"] },
      antigravity: { command_template: ["ag"] },
      subprocess_template: { command_template: ["sub"] },
    },
    {
      env: {
        OPENCODE: "1",
        CODEX: "1",
        TERM_PROGRAM: "vscode",
        ANTIGRAVITY: "1",
      },
      commandExists: allCommands,
    },
  );
  expect(resolved).toBe("opencode");
});

test("chooseAutoProvider: insideCodex wins when insideOpenCode is false", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: allCommands },
  );
  expect(resolved).toBe("codex");
});

test("chooseAutoProvider: vscode-task fires when in VSCode with a template and no in-session signals", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { vscode_task: { command_template: ["vscode-task"] } },
    { env: { TERM_PROGRAM: "vscode" }, commandExists: noCommands },
  );
  expect(resolved).toBe("vscode-task");
});

test("chooseAutoProvider: antigravity fires when in Antigravity with a template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  expect(resolved).toBe("antigravity");
});

test("chooseAutoProvider: subprocess-template fires with no IDE or in-session signals", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { subprocess_template: { command_template: ["my-sub"] } },
    { env: {}, commandExists: noCommands },
  );
  expect(resolved).toBe("subprocess-template");
});

// ── config-gated rungs take precedence over tie-breaks ────────────────────────

test("chooseAutoProvider: auto never selects claude-code from config or PATH", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { claude_code: { command: "claude" } },
    { env: {}, commandExists: (cmd) => cmd === "claude" },
  );
  expect(resolved).toBe("worker-command");
});

test("chooseAutoProvider: config-gated opencode fires when explicitly configured and available", () => {
  // No in-session signals; no claude config; opencode config + both available.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { opencode: { command: "opencode" } },
    { env: {}, commandExists: allCommands },
  );
  expect(resolved).toBe("opencode");
});

test("chooseAutoProvider: config-gated codex fires when configured and only codex available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { codex: { command: "codex" } },
    {
      env: {},
      commandExists: (cmd) => cmd === "codex",
    },
  );
  expect(resolved).toBe("codex");
});

// ── availability tie-breaks with no explicit config ───────────────────────────

test("chooseAutoProvider: bare claude availability does not enter auto ordering", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "claude",
    },
  );
  expect(resolved).toBe("worker-command");
});

test("PB-1: bare-PATH opencode (no config, no claude) is NOT tie-broken to; falls through to worker-command", () => {
  // A detected-on-PATH opencode is OPT-IN. There is no bare-availability opencode
  // tie-break rung, so with no opencode config and no claude, resolution falls
  // through to worker-command rather than launching opencode unprompted.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "opencode",
    },
  );
  expect(resolved).toBe("worker-command");
});

test("chooseAutoProvider: last-resort resolves codex when only codex is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "codex",
    },
  );
  expect(resolved).toBe("codex");
});

test("chooseAutoProvider: falls back to worker-command when nothing is available and no config", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: {}, commandExists: noCommands },
  );
  expect(resolved).toBe("worker-command");
});

// ── self-spawn guards ─────────────────────────────────────────────────────────

test("chooseAutoProvider: insideClaudeCode forces claudeAvailable=false, falls to worker-command with no other provider", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      // CLAUDECODE set, claude on PATH — claudeAvailable must be forced false.
      env: { CLAUDECODE: "1" },
      commandExists: (cmd) => cmd === "claude",
    },
  );
  expect(resolved).not.toBe("claude-code");
  expect(resolved).toBe("worker-command");
});

test("chooseAutoProvider: insideCodex in-session rung fires before codexAvailable self-spawn guard", () => {
  // CODEX=1 → insideCodex fires (rung 2) before any availability check.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: noCommands },
  );
  expect(resolved).toBe("codex");
});

test("chooseAutoProvider: Codex Desktop session markers resolve codex", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {
        CODEX_SHELL: "1",
        CODEX_THREAD_ID: "thread-123",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
      },
      commandExists: noCommands,
    },
  );
  expect(resolved).toBe("codex");
});

// ── CE-004 schema-constraint lever (openai-compatible / NIM guided_json) ───────
// The AuditResult JSON schema is plumbed into the openai-compatible request as an
// ADDITIVE emit-time constraint: response_format json_schema (OpenAI/vLLM) plus
// guided_json / nvext.guided_json (NIM/vLLM). It is read ONCE from
// input.outputSchema (single-sourced from zod by the dispatch site — never forked
// here), degrades on a 400/422 down json_schema → json_object → none, and behaves
// exactly as before when no schema is supplied.

// A credential is NAMED, never pasted (inline `api_key` is retired), so the fixture
// declares an env var and this file populates it — an unset one rejects the launch
// before any POST, which would look like a schema-degradation failure.
const OAI_KEY_ENV = "AUDIT_TOOLS_TEST_OAI_KEY";
process.env[OAI_KEY_ENV] = "k";

const oaiConfig: OpenAiCompatibleConfig = {
  base_url: "https://nim.test/v1",
  model: "openai/gpt-oss-120b",
  api_key_env: OAI_KEY_ENV,
};

function launchOai(
  config: OpenAiCompatibleConfig,
  inputOverrides: Partial<LaunchFreshSessionInput> = {},
  fetchImpl: typeof fetch,
) {
  const dir = mkdtempSync(join(tmpdir(), "oai-schema-prov-"));
  const promptPath = join(dir, "prompt.txt");
  writeFileSync(promptPath, "Do the task.");
  const input: LaunchFreshSessionInput = {
    repoRoot: join(dir, "repo"),
    runId: "RID",
    obligationId: null,
    promptPath,
    taskPath: join(dir, "task.json"),
    resultPath: join(dir, "result.json"),
    stdoutPath: join(dir, "out.log"),
    stderrPath: join(dir, "err.log"),
    uiMode: "headless",
    timeoutMs: 5000,
    ...inputOverrides,
  };
  const provider = new OpenAiCompatibleProvider(config, { fetchFn: fetchImpl });
  return provider.launch(input);
}

// Fetch mocks below construct real `Response` objects (rather than a bare
// {ok,status,json,text} literal) so they structurally satisfy the full
// `typeof fetch` return contract — the same convention proxy-catalog.test.ts
// uses for the same reason.
const OK_COMPLETION = (_init?: RequestInit): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ files: [], result: {} }) } }],
    }),
    { status: 200 },
  );

const AUDIT_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { task_id: { type: "string" } },
  required: ["task_id"],
  additionalProperties: false,
};

test("CE-004: an outputSchema is plumbed into the request as json_schema + guided_json", async () => {
  let body: any;
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return OK_COMPLETION(init);
  };
  const res = await launchOai(oaiConfig, { outputSchema: AUDIT_RESULT_SCHEMA }, fetchFn);
  expect(res.accepted, res.error).toBe(true);
  // OpenAI / vLLM structured-output shape.
  expect(body.response_format?.type).toBe("json_schema");
  expect(body.response_format?.json_schema?.schema).toEqual(AUDIT_RESULT_SCHEMA);
  expect(body.response_format?.json_schema?.name, "json_schema requires a name").toBeTruthy();
  expect(body.response_format?.json_schema?.strict).toBe(true);
  // NIM / vLLM guided decoding — both top-level and nvext-nested.
  expect(body.guided_json).toEqual(AUDIT_RESULT_SCHEMA);
  expect(body.nvext?.guided_json).toEqual(AUDIT_RESULT_SCHEMA);
});

test("CE-004: with NO schema supplied the request is unchanged (json_object, no guided_json)", async () => {
  let body: any;
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return OK_COMPLETION(init);
  };
  const res = await launchOai(oaiConfig, {}, fetchFn);
  expect(res.accepted, res.error).toBe(true);
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.guided_json, "no guided_json without a schema").toBe(undefined);
  expect(body.nvext, "no nvext without a schema").toBe(undefined);
});

test("CE-004: guided_json:false forces the weaker json_object even when a schema is supplied", async () => {
  let body: any;
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return OK_COMPLETION(init);
  };
  const res = await launchOai(
    { ...oaiConfig, guided_json: false },
    { outputSchema: AUDIT_RESULT_SCHEMA },
    fetchFn,
  );
  expect(res.accepted, res.error).toBe(true);
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(body.guided_json).toBe(undefined);
});

test("CE-004: a 400 on json_schema degrades to json_object, then succeeds", async () => {
  const bodies: any[] = [];
  let call = 0;
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    call += 1;
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (call === 1) {
      return new Response("no json_schema mode", { status: 400 });
    }
    return OK_COMPLETION(init);
  };
  const res = await launchOai(oaiConfig, { outputSchema: AUDIT_RESULT_SCHEMA }, fetchFn);
  expect(res.accepted, res.error).toBe(true);
  expect(call, "one retry after the json_schema rejection").toBe(2);
  expect(bodies[0].response_format?.type).toBe("json_schema");
  expect(bodies[1].response_format).toEqual({ type: "json_object" });
  expect(bodies[1].guided_json, "the degraded retry drops guided_json").toBe(undefined);
});

test("CE-004: a 422 that persists through the whole ladder degrades to no response_format", async () => {
  const bodies: any[] = [];
  let call = 0;
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    call += 1;
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (call < 3) {
      return new Response("reject", { status: 422 });
    }
    return OK_COMPLETION(init);
  };
  const res = await launchOai(oaiConfig, { outputSchema: AUDIT_RESULT_SCHEMA }, fetchFn);
  expect(res.accepted, res.error).toBe(true);
  expect(call, "json_schema → json_object → none").toBe(3);
  expect(bodies[0].response_format?.type).toBe("json_schema");
  expect(bodies[1].response_format).toEqual({ type: "json_object" });
  expect(bodies[2].response_format, "final rung carries no response_format").toBe(undefined);
});

test("CE-004: discoverOutputConstraintCapability advertises json_schema_constrained by default", () => {
  const cap = discoverOutputConstraintCapability("openai-compatible", {});
  expect(cap.mode).toBe("json_schema_constrained");
  const structured = discoverOutputConstraintCapability("openai-compatible", {
    openai_compatible: { guided_json: false },
  });
  expect(structured.mode).toBe("structured_output");
});

// ── agy provider tests ────────────────────────────────────────────────────────

test("resolveFreshSessionProviderName handles agy rules", () => {
  // agy is in PROVIDER_NAMES
  expect(PROVIDER_NAMES.includes("agy")).toBeTruthy();

  // verbatim pass-through
  expect(resolveFreshSessionProviderName("agy", {})).toBe("agy");

  // inside active sessions resolves to agy
  expect(
    resolveFreshSessionProviderName("auto", {}, { env: { AGY_CLI: "1" }, commandExists: noCommands })
  ).toBe("agy");
  expect(
    resolveFreshSessionProviderName("auto", {}, { env: { ANTIGRAVITY_CLI: "1" }, commandExists: noCommands })
  ).toBe("agy");
  // Post-sunset (2026-07-18): the legacy GEMINI_CLI in-session signal no longer
  // marks an agy session.
  expect(
    resolveFreshSessionProviderName("auto", {}, { env: { GEMINI_CLI: "1" }, commandExists: noCommands })
  ).not.toBe("agy");

  // config-gated resolution
  expect(
    resolveFreshSessionProviderName(
      "auto",
      { agy: { command: "agy" } },
      { env: {}, commandExists: (cmd) => cmd === "agy" }
    )
  ).toBe("agy");

  // Post-sunset (2026-07-18): a lone legacy gemini binary no longer resolves agy.
  expect(
    resolveFreshSessionProviderName(
      "auto",
      { agy: {} },
      { env: {}, commandExists: (cmd) => cmd === "gemini" }
    )
  ).not.toBe("agy");

  // tie-break when agy is available on PATH
  expect(
    resolveFreshSessionProviderName(
      "auto",
      {},
      { env: {}, commandExists: (cmd) => cmd === "agy" }
    )
  ).toBe("agy");

  // Post-sunset (2026-07-18): a lone legacy gemini binary no longer tie-breaks to agy.
  expect(
    resolveFreshSessionProviderName(
      "auto",
      {},
      { env: {}, commandExists: (cmd) => cmd === "gemini" }
    )
  ).not.toBe("agy");
});

test("createFreshSessionProvider constructs an AgyProvider", () => {
  const provider = createFreshSessionProvider(
    "agy",
    { agy: {} },
    {
      ...deps,
      createAgyProvider: (config) => new AgyProvider(config),
    }
  );
  expect(provider.name).toBe("agy");
  expect(provider instanceof AgyProvider).toBeTruthy();
});

// Shape used to launch an AgyProvider directly in these tests: the real
// LaunchFreshSessionInput contract plus the extra fields the original fixture
// carried (unused by AgyProvider.launch, but part of the literal it built).
type AgyTestLaunchInput = LaunchFreshSessionInput & {
  sessionStateDir: string;
  taskIndex: number;
  concurrencySlot: number;
};

test("AgyProvider: launches agy command with correct arguments and pipes stdin", async () => {
  // A holder object (rather than a reassigned `let`) so the value read back
  // after `await provider.launch(...)` is a fresh `const` the compiler can
  // narrow normally — reassigning a `let` from inside a nested closure defeats
  // TypeScript's control-flow narrowing of that same `let` in the outer scope.
  const capturedLaunch: { value: { command: string; args: string[]; options: LaunchFreshSessionInput } | null } = { value: null };
  const mockLauncher = async (command: string, args: string[], options: LaunchFreshSessionInput) => {
    capturedLaunch.value = { command, args, options };
    return { accepted: true, exitCode: 0, stdout: "agy run complete", stderr: "" };
  };

  const tempDir = mkdtempSync(join(tmpdir(), "agy-test-"));
  const promptPath = join(tempDir, "prompt.txt");
  const taskPath = join(tempDir, "task.json");
  writeFileSync(promptPath, "Hello agy!");
  writeFileSync(taskPath, JSON.stringify({ id: "task-1", type: "remediate" }));

  const provider = new AgyProvider(
    {
      command: "agy",
      model: "gemini-1.5-pro",
      dangerously_skip_permissions: true,
      extra_args: ["--foo", "bar"],
    },
    { skipPermissionsDefault: false },
    mockLauncher,
  );

  const launchInput: AgyTestLaunchInput = {
    repoRoot: tempDir,
    runId: "RID",
    obligationId: null,
    promptPath,
    taskPath,
    resultPath: join(tempDir, "result.json"),
    stdoutPath: join(tempDir, "out.log"),
    stderrPath: join(tempDir, "err.log"),
    uiMode: "headless",
    timeoutMs: 5000,
    sessionStateDir: tempDir,
    taskIndex: 0,
    concurrencySlot: 0,
  };
  const res = await provider.launch(launchInput);
  const launched = capturedLaunch.value;
  if (!launched) throw new Error("unreachable: mockLauncher was invoked by the launch above");

  expect(res.exitCode).toBe(0);
  if (process.platform === "win32") {
    expect(launched.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(launched.args[3]).toBe('agy --model gemini-1.5-pro --dangerously-skip-permissions --foo bar');
  } else {
    expect(launched.command).toBe("agy");
    expect(launched.args).toEqual([
      "--model",
      "gemini-1.5-pro",
      "--dangerously-skip-permissions",
      "--foo",
      "bar",
    ]);
  }
  expect(launched.options.stdinText).toBe("Hello agy!");
});

test("AgyProvider: an explicit custom command keeps the agy flag dialect (gemini fallback sunset)", async () => {
  // See the holder-object rationale in the previous test.
  const capturedLaunch: { value: { command: string; args: string[]; options: LaunchFreshSessionInput } | null } = { value: null };
  const mockLauncher = async (command: string, args: string[], options: LaunchFreshSessionInput) => {
    capturedLaunch.value = { command, args, options };
    return { accepted: true, exitCode: 0, stdout: "custom run complete", stderr: "" };
  };

  const tempDir = mkdtempSync(join(tmpdir(), "gemini-test-"));
  const promptPath = join(tempDir, "prompt.txt");
  const taskPath = join(tempDir, "task.json");
  writeFileSync(promptPath, "Hello gemini!");
  writeFileSync(taskPath, JSON.stringify({ id: "task-1", type: "remediate" }));

  const provider = new AgyProvider(
    {
      // A custom launcher outside the shim allowlist and not on PATH: spawned
      // verbatim on every platform (no cmd.exe wrapper), agy flag dialect.
      command: "my-agy-wrapper.exe",
      model: "gemini-1.5-flash",
      dangerously_skip_permissions: true,
    },
    { skipPermissionsDefault: false },
    mockLauncher,
  );

  const launchInput: AgyTestLaunchInput = {
    repoRoot: tempDir,
    runId: "RID",
    obligationId: null,
    promptPath,
    taskPath,
    resultPath: join(tempDir, "result.json"),
    stdoutPath: join(tempDir, "out.log"),
    stderrPath: join(tempDir, "err.log"),
    uiMode: "headless",
    timeoutMs: 5000,
    sessionStateDir: tempDir,
    taskIndex: 0,
    concurrencySlot: 0,
  };
  await provider.launch(launchInput);
  const launched = capturedLaunch.value;
  if (!launched) throw new Error("unreachable: mockLauncher was invoked by the launch above");

  // Post-sunset: the explicit command is honored verbatim, but the legacy
  // -m/-y gemini dialect is gone — agy flags are the only dialect.
  expect(launched.command).toBe("my-agy-wrapper.exe");
  expect(launched.args).toEqual(["--model", "gemini-1.5-flash", "--dangerously-skip-permissions"]);
  expect(launched.options.stdinText).toBe("Hello gemini!");
});

test("AgyProvider: active session throws error", async () => {
  const provider = new AgyProvider({}, { activeSessionMessage: "custom-active-error" });
  const input: AgyTestLaunchInput = {
    repoRoot: "repo",
    runId: "RID",
    obligationId: null,
    promptPath: "prompt.txt",
    taskPath: "task.json",
    resultPath: "result.json",
    stdoutPath: "out.log",
    stderrPath: "err.log",
    uiMode: "headless",
    timeoutMs: 5000,
    sessionStateDir: "dir",
    taskIndex: 0,
    concurrencySlot: 0,
  };

  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, AGY_CLI: "1" };
    await expect(provider.launch(input)).rejects.toThrow("custom-active-error");

    process.env = { ...originalEnv, ANTIGRAVITY_CLI: "1" };
    await expect(provider.launch(input)).rejects.toThrow("custom-active-error");
  } finally {
    process.env = originalEnv;
  }
});
