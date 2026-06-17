import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  OpenAiCompatibleProvider,
  parseJsonLoose,
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
} = await import("@audit-tools/shared");

// Fresh isolated worktree + launch input per test (hermeticity).
function makeCtx(promptText) {
  const dir = mkdtempSync(join(tmpdir(), "oai-prov-"));
  const repoRoot = join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const promptPath = join(dir, "prompt.txt");
  writeFileSync(promptPath, promptText ?? "Do the task.");
  const input = {
    repoRoot,
    runId: "run-1",
    obligationId: "N-1",
    promptPath,
    taskPath: join(dir, "task.json"),
    resultPath: join(dir, "result.json"),
    stdoutPath: join(dir, "out.log"),
    stderrPath: join(dir, "err.log"),
    uiMode: "headless",
    timeoutMs: 30_000,
  };
  return { dir, repoRoot, input };
}

// Fake fetch returning a canned chat-completions body; counts invocations.
function fakeFetchReturning(content, { ok = true, status = 200 } = {}) {
  const fn = async () => {
    fn._calls += 1;
    return {
      ok,
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () =>
        typeof content === "string" ? content : JSON.stringify(content),
    };
  };
  fn._calls = 0;
  return fn;
}

const minimalConfig = {
  base_url: "https://nim.test/v1",
  model: "openai/gpt-oss-120b",
  api_key: "k",
};

test("parseJsonLoose parses direct, fenced, and prose-wrapped JSON", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose("```json\n{\"a\":2}\n```"), { a: 2 });
  assert.deepEqual(parseJsonLoose("Sure!\n{\"a\":3}\nDone."), { a: 3 });
  assert.throws(() => parseJsonLoose("no json here"));
});

test("launch applies files to the worktree and writes the result", async () => {
  const { repoRoot, input } = makeCtx();
  const content = JSON.stringify({
    files: [
      { path: "src/foo.txt", content: "hello" },
      { path: "bar.txt", content: "world" },
    ],
    result: { item_results: [{ finding_id: "N-1", status: "resolved" }] },
  });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);

  assert.equal(res.accepted, true);
  assert.equal(res.exitCode, 0);
  assert.equal(readFileSync(join(repoRoot, "src/foo.txt"), "utf8"), "hello");
  assert.equal(readFileSync(join(repoRoot, "bar.txt"), "utf8"), "world");
  assert.deepEqual(JSON.parse(readFileSync(input.resultPath, "utf8")), {
    item_results: [{ finding_id: "N-1", status: "resolved" }],
  });
});

test("launch degrades cleanly when the API key env var is unset", async () => {
  const { input } = makeCtx();
  const fetchFn = fakeFetchReturning("{}");
  const provider = new OpenAiCompatibleProvider(
    { base_url: "https://nim.test/v1", model: "m", api_key_env: "UNSET_KEY_XYZ" },
    { fetchFn, env: {} },
  );
  const res = await provider.launch(input);
  assert.equal(res.accepted, false);
  assert.match(res.error ?? "", /API key/);
  assert.equal(fetchFn._calls, 0, "must not call the endpoint without a key");
});

test("launch requires both base_url and model", async () => {
  const { input } = makeCtx();
  const noBase = new OpenAiCompatibleProvider(
    { model: "m", api_key: "k" },
    { fetchFn: fakeFetchReturning("{}") },
  );
  assert.equal((await noBase.launch(input)).accepted, false);
  const noModel = new OpenAiCompatibleProvider(
    { base_url: "https://x/v1", api_key: "k" },
    { fetchFn: fakeFetchReturning("{}") },
  );
  assert.equal((await noModel.launch(input)).accepted, false);
});

test("launch fails on a non-2xx HTTP response", async () => {
  const { input } = makeCtx();
  const fetchFn = fakeFetchReturning("rate limited", { ok: false, status: 429 });
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, false);
  assert.match(res.error ?? "", /HTTP 429/);
});

test("launch fails when the completion is not parseable JSON", async () => {
  const { input } = makeCtx();
  const fetchFn = fakeFetchReturning("I cannot help with that.");
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, false);
  assert.match(res.error ?? "", /parseable JSON/);
});

test("launch rejects a file path escaping the worktree", async () => {
  const { repoRoot, input } = makeCtx();
  const content = JSON.stringify({
    files: [{ path: "../escape.txt", content: "x" }],
    result: {},
  });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, false);
  assert.match(res.error ?? "", /outside the worktree/);
  assert.equal(existsSync(join(repoRoot, "..", "escape.txt")), false);
});

test("launch fails when the model returns files but omits the result", async () => {
  const { input } = makeCtx();
  const content = JSON.stringify({ files: [{ path: "a.txt", content: "hi" }] });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, false);
  assert.match(res.error ?? "", /result/);
});

test("launch skips control-plane (.audit-tools) paths echoed into files[]", async () => {
  const { repoRoot, input } = makeCtx();
  // Models frequently echo the result file into files[] (the prompt says "write
  // your result to <path>"). Those must be skipped, not committed into the worktree.
  const content = JSON.stringify({
    files: [
      { path: "src/real.ts", content: "export const x = 1;" },
      {
        path: ".audit-tools/remediation/runs/R/implement/B.result.json",
        content: "{}",
      },
    ],
    result: { ok: true },
  });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, true);
  assert.equal(readFileSync(join(repoRoot, "src/real.ts"), "utf8"), "export const x = 1;");
  assert.equal(
    existsSync(join(repoRoot, ".audit-tools")),
    false,
    "a .audit-tools/ control-plane path must never be written into the worktree",
  );
});

test("launch inlines current contents of prompt-referenced files", async () => {
  const { repoRoot, input } = makeCtx("Modify config.json to add a field.");
  writeFileSync(join(repoRoot, "config.json"), '{"existing":true}');
  let captured;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ files: [], result: {} }) } }],
      }),
      text: async () => "",
    };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  assert.equal(res.accepted, true);
  const userMsg = captured.messages.find((m) => m.role === "user").content;
  assert.match(userMsg, /existing/);
  assert.match(userMsg, /config\.json/);
});

test("openai-compatible resolves verbatim and from config", () => {
  assert.equal(
    resolveFreshSessionProviderName("openai-compatible", {}),
    "openai-compatible",
  );
  // Inside a CLAUDECODE session (claude can't self-spawn), a configured endpoint
  // becomes the automatic worker.
  assert.equal(
    resolveFreshSessionProviderName(
      "auto",
      { openai_compatible: { base_url: "https://nim.test/v1", model: "m" } },
      { env: { CLAUDECODE: "1" }, commandExists: () => false },
    ),
    "openai-compatible",
  );
});

test("a configured endpoint beats the codex last-resort; without it codex wins", () => {
  const cfg = { openai_compatible: { base_url: "https://nim.test/v1", model: "m" } };
  const env = { CLAUDECODE: "1" };
  const onlyCodex = (c) => c === "codex";
  assert.equal(
    resolveFreshSessionProviderName("auto", cfg, { env, commandExists: onlyCodex }),
    "openai-compatible",
  );
  assert.equal(
    resolveFreshSessionProviderName("auto", {}, { env, commandExists: onlyCodex }),
    "codex",
  );
});

test("createFreshSessionProvider constructs the openai-compatible provider", () => {
  const deps = {
    orchestratorName: "test",
    createClaudeCodeProvider: () => ({
      name: "claude-code",
      launch: async () => ({ accepted: false }),
    }),
    createOpenCodeProvider: () => ({
      name: "opencode",
      launch: async () => ({ accepted: false }),
    }),
  };
  const provider = createFreshSessionProvider(
    "openai-compatible",
    { openai_compatible: { base_url: "https://x/v1", model: "m" } },
    deps,
  );
  assert.equal(provider.name, "openai-compatible");
});
