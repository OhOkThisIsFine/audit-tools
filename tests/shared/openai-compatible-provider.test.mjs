import { test, expect } from "vitest";
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
} = await import("audit-tools/shared");

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
  expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonLoose("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
  expect(parseJsonLoose("Sure!\n{\"a\":3}\nDone.")).toEqual({ a: 3 });
  assert.throws(() => parseJsonLoose("no json here"));
});

test("parseJsonLoose balance scan tolerates trailing garbage after the object", () => {
  // A complete object followed by junk braces/brackets: the lastIndexOf-slice
  // approach would over-capture; the balance scan stops at the matched close.
  expect(parseJsonLoose('prefix {"a":1,"b":[2,3]} }]}')).toEqual({
    a: 1,
    b: [2, 3],
  });
});

test("parseJsonLoose returns the real object, not a trivial example before it", () => {
  // Reasoning models often emit an illustrative `{}` before the real payload.
  const text = 'Example: {} then the answer:\n{"files":[],"result":{"ok":true}}';
  expect(parseJsonLoose(text)).toEqual({ files: [], result: { ok: true } });
});

test("parseJsonLoose ignores braces inside strings", () => {
  // A `}` inside a string must not terminate the object early.
  expect(parseJsonLoose('{"msg":"a } b"}')).toEqual({ msg: "a } b" });
  // Escaped quote inside a string must not flip string state.
  expect(parseJsonLoose('{"msg":"she said \\"hi } bye\\""}')).toEqual({
    msg: 'she said "hi } bye"',
  });
});

test("parseJsonLoose throws on an unterminated object", () => {
  assert.throws(() => parseJsonLoose('garbage {"a":1, "b": {'));
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

  expect(res.accepted).toBe(true);
  expect(res.exitCode).toBe(0);
  expect(readFileSync(join(repoRoot, "src/foo.txt"), "utf8")).toBe("hello");
  expect(readFileSync(join(repoRoot, "bar.txt"), "utf8")).toBe("world");
  expect(JSON.parse(readFileSync(input.resultPath, "utf8"))).toEqual({
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
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/API key/);
  expect(fetchFn._calls, "must not call the endpoint without a key").toBe(0);
});

test("launch requires both base_url and model", async () => {
  const { input } = makeCtx();
  const noBase = new OpenAiCompatibleProvider(
    { model: "m", api_key: "k" },
    { fetchFn: fakeFetchReturning("{}") },
  );
  expect((await noBase.launch(input)).accepted).toBe(false);
  const noModel = new OpenAiCompatibleProvider(
    { base_url: "https://x/v1", api_key: "k" },
    { fetchFn: fakeFetchReturning("{}") },
  );
  expect((await noModel.launch(input)).accepted).toBe(false);
});

test("launch fails immediately on a terminal (non-transient) non-2xx HTTP response", async () => {
  const { input } = makeCtx();
  // 403 is neither a constraint rejection (400/422) nor a transient status — it is
  // terminal, so the launch fails on the first attempt with no retry.
  const fetchFn = fakeFetchReturning("forbidden", { ok: false, status: 403 });
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn, retryBackoffMs: 1 });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/HTTP 403/);
  expect(fetchFn._calls, "a terminal status must not retry").toBe(1);
});

test("launch fails when the completion is not parseable JSON", async () => {
  const { input } = makeCtx();
  const fetchFn = fakeFetchReturning("I cannot help with that.");
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/parseable JSON/);
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
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/outside the worktree/);
  expect(existsSync(join(repoRoot, "..", "escape.txt"))).toBe(false);
});

test("launch fails when the model returns files but omits the result", async () => {
  const { input } = makeCtx();
  const content = JSON.stringify({ files: [{ path: "a.txt", content: "hi" }] });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/result/);
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
  expect(res.accepted).toBe(true);
  expect(readFileSync(join(repoRoot, "src/real.ts"), "utf8")).toBe("export const x = 1;");
  expect(existsSync(join(repoRoot, ".audit-tools")), "a .audit-tools/ control-plane path must never be written into the worktree").toBe(false);
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
  expect(res.accepted).toBe(true);
  const userMsg = captured.messages.find((m) => m.role === "user").content;
  expect(userMsg).toMatch(/existing/);
  expect(userMsg).toMatch(/config\.json/);
});

test("defect-1 sub-3: system prompt overrides the write-then-reply-confirmation convention", async () => {
  // The audit review packet tells an interactive agent to WRITE a file then reply
  // "valid: <id>". A single-shot worker must instead put the array in `result`.
  const { input } = makeCtx("Write the AuditResult[] array to result_path, then reply exactly: valid: p1, findings=0");
  let captured;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: [] }) } }] }),
      text: async () => "",
    };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  const systemMsg = captured.messages.find((m) => m.role === "system").content;
  // The override must (a) forbid the confirmation string in `result`, (b) direct
  // structured data into `result`, (c) tell it to ignore reply/confirm/Write-tool steps.
  expect(systemMsg).toMatch(/NEVER the confirmation/i);
  expect(systemMsg).toMatch(/result. MUST be that array/i);
  expect(systemMsg).toMatch(/ignore any instruction to .reply./i);
});

test("defect-1 sub-3: referenced-files framing is read-neutral (review leaves files empty)", async () => {
  const { repoRoot, input } = makeCtx("Review reviewme.ts for correctness.");
  writeFileSync(join(repoRoot, "reviewme.ts"), "export const y = 2;");
  let captured;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: [] }) } }] }),
      text: async () => "",
    };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  await provider.launch(input);
  const userMsg = captured.messages.find((m) => m.role === "user").content;
  // Neutral framing: no "edit these" push; explicit read-only-review guidance.
  expect(userMsg).not.toMatch(/edit these/i);
  expect(userMsg).toMatch(/read-only review/i);
});

test("defect-1 sub-3: referenced-file byte cap is operator-configurable (read-heavy audit tuning)", async () => {
  const { repoRoot, input } = makeCtx("Review bigfile.ts for correctness.");
  const body = "x".repeat(2000);
  writeFileSync(join(repoRoot, "bigfile.ts"), body);
  const capture = async (_url, init) => ({
    ok: true,
    status: 200,
    _body: init.body,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: [] }) } }] }),
    text: async () => "",
  });

  // A tiny total cap SKIPS the file (coverage-safe: not inlined rather than crashing).
  let capturedSmall;
  await new OpenAiCompatibleProvider(
    { ...minimalConfig, referenced_files_total_byte_cap: 10 },
    { fetchFn: async (u, i) => { const r = await capture(u, i); capturedSmall = JSON.parse(i.body); return r; } },
  ).launch(input);
  const smallUser = capturedSmall.messages.find((m) => m.role === "user").content;
  expect(smallUser).not.toMatch(/xxxxxxxxxx/);

  // A generous cap INLINES the same file — the operator raised the ceiling.
  let capturedBig;
  await new OpenAiCompatibleProvider(
    { ...minimalConfig, referenced_files_total_byte_cap: 100_000 },
    { fetchFn: async (u, i) => { const r = await capture(u, i); capturedBig = JSON.parse(i.body); return r; } },
  ).launch(input);
  const bigUser = capturedBig.messages.find((m) => m.role === "user").content;
  expect(bigUser).toMatch(/xxxxxxxxxx/);
});

test("granted referencedFiles inline current contents deterministically (not via prose)", async () => {
  // The prompt names NO paths; the granted read set alone must drive inlining — this
  // is the deterministic fix for prompts authored paths-only for tool-using hosts.
  const { repoRoot, input } = makeCtx("Review the granted files for correctness.");
  writeFileSync(join(repoRoot, "hidden.ts"), "export const SECRET = 42;");
  input.referencedFiles = ["hidden.ts"];
  let captured;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: [] }) } }] }),
      text: async () => "",
    };
  };
  const res = await new OpenAiCompatibleProvider(minimalConfig, { fetchFn }).launch(input);
  expect(res.accepted).toBe(true);
  const userMsg = captured.messages.find((m) => m.role === "user").content;
  expect(userMsg).toMatch(/SECRET = 42/);
  expect(userMsg).toMatch(/hidden\.ts/);
});

test("unroutable guard: an over-cap granted file refuses the dispatch before any POST", async () => {
  const { repoRoot, input } = makeCtx("Review bigfile.ts.");
  writeFileSync(join(repoRoot, "bigfile.ts"), "x".repeat(2000));
  input.referencedFiles = ["bigfile.ts"];
  const fetchFn = fakeFetchReturning(JSON.stringify({ files: [], result: [] }));
  const res = await new OpenAiCompatibleProvider(
    { ...minimalConfig, referenced_file_byte_cap: 10 },
    { fetchFn },
  ).launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error).toMatch(/unroutable/i);
  expect(res.error).toMatch(/bigfile\.ts/);
  // The guard fires BEFORE the request — no tokens are spent on a doomed packet.
  expect(fetchFn._calls).toBe(0);
});

test("unroutable guard: a granted file that does not exist is a to-be-created output, not a refusal", async () => {
  // A `touched_files` output the fix will CREATE is legitimately absent on disk; the
  // worker writes it from scratch, so it must NOT trip the guard.
  const { input } = makeCtx("Create newfile.ts with the fix.");
  input.referencedFiles = ["newfile.ts"];
  const fetchFn = fakeFetchReturning(
    JSON.stringify({ files: [{ path: "newfile.ts", content: "export const x = 1;" }], result: { item_results: [] } }),
  );
  const res = await new OpenAiCompatibleProvider(minimalConfig, { fetchFn }).launch(input);
  expect(res.accepted).toBe(true);
  expect(fetchFn._calls).toBe(1);
});

test("unroutable guard is skipped when the operator disables inlining (paths-only by choice)", async () => {
  const { repoRoot, input } = makeCtx("Review bigfile.ts.");
  writeFileSync(join(repoRoot, "bigfile.ts"), "x".repeat(2000));
  input.referencedFiles = ["bigfile.ts"];
  const fetchFn = fakeFetchReturning(JSON.stringify({ files: [], result: [] }));
  const res = await new OpenAiCompatibleProvider(
    { ...minimalConfig, referenced_file_byte_cap: 10, include_referenced_files: false },
    { fetchFn },
  ).launch(input);
  // include_referenced_files:false → no inlining, no guard: the launch proceeds.
  expect(res.accepted).toBe(true);
  expect(fetchFn._calls).toBe(1);
});

test("openai-compatible resolves verbatim and from config", () => {
  expect(resolveFreshSessionProviderName("openai-compatible", {})).toBe("openai-compatible");
  // Inside a CLAUDECODE session (claude can't self-spawn), a configured endpoint
  // becomes the automatic worker.
  expect(resolveFreshSessionProviderName(
      "auto",
      { openai_compatible: { base_url: "https://nim.test/v1", model: "m" } },
      { env: { CLAUDECODE: "1" }, commandExists: () => false },
    )).toBe("openai-compatible");
});

test("a configured endpoint beats the codex last-resort; without it codex wins", () => {
  const cfg = { openai_compatible: { base_url: "https://nim.test/v1", model: "m" } };
  const env = { CLAUDECODE: "1" };
  const onlyCodex = (c) => c === "codex";
  expect(resolveFreshSessionProviderName("auto", cfg, { env, commandExists: onlyCodex })).toBe("openai-compatible");
  expect(resolveFreshSessionProviderName("auto", {}, { env, commandExists: onlyCodex })).toBe("codex");
});

test("request body defaults response_format ON when not configured", async () => {
  const { input } = makeCtx();
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
  expect(res.accepted).toBe(true);
  expect(captured.response_format).toEqual({ type: "json_object" });
});

test("request body omits response_format when explicitly disabled", async () => {
  const { input } = makeCtx();
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
  const provider = new OpenAiCompatibleProvider(
    { ...minimalConfig, response_format_json: false },
    { fetchFn },
  );
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(captured.response_format).toBe(undefined);
});

for (const status of [400, 422]) {
  test(`HTTP ${status} on the response_format request degrades to a no-format retry that succeeds`, async () => {
    const { input } = makeCtx();
    const bodies = [];
    let call = 0;
    const fetchFn = async (_url, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) {
        return { ok: false, status, json: async () => ({}), text: async () => "no json mode" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ files: [], result: { ok: true } }) } }],
        }),
        text: async () => "",
      };
    };
    const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
    const res = await provider.launch(input);
    expect(res.accepted, res.error).toBe(true);
    expect(call, "must retry exactly once").toBe(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format, "retry must drop response_format").toBe(undefined);
  });
}

test("a degrade-exhausted request (both attempts fail) is fatal", async () => {
  const { input } = makeCtx();
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    return { ok: false, status: 400, json: async () => ({}), text: async () => "still bad" };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/HTTP 400/);
  expect(call, "first attempt + one retry, no loop").toBe(2);
});

// ---------------------------------------------------------------------------
// C4 (NIM/Codex dispatch fix set): bounded fetch retry with backoff on TRANSIENT
// failures — a momentary 5xx/429/524 or a network reject self-heals within the
// attempt budget instead of stranding the packet. Constraint (400/422) and
// terminal (403) statuses are NOT retried (covered above).
// ---------------------------------------------------------------------------

test("C4: a transient 503 is retried with backoff, then succeeds", async () => {
  const { input } = makeCtx();
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "overloaded" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: { ok: true } }) } }] }),
      text: async () => "",
    };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn, retryBackoffMs: 1 });
  const res = await provider.launch(input);
  expect(res.accepted, res.error).toBe(true);
  expect(call, "one transient failure + one retry that succeeds").toBe(2);
});

test("C4: a transient network reject is retried, then succeeds", async () => {
  const { input } = makeCtx();
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) throw new Error("ECONNRESET");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [], result: { ok: true } }) } }] }),
      text: async () => "",
    };
  };
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn, retryBackoffMs: 1 });
  const res = await provider.launch(input);
  expect(res.accepted, res.error).toBe(true);
  expect(call, "network reject retried once, succeeds").toBe(2);
});

test("C4: a persistent transient status exhausts the retry budget and fails", async () => {
  const { input } = makeCtx();
  const fetchFn = fakeFetchReturning("still overloaded", { ok: false, status: 503 });
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn, retryBackoffMs: 1 });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/HTTP 503/);
  expect(fetchFn._calls, "1 initial + 2 retries = 3 attempts, then gives up").toBe(3);
});

// ---------------------------------------------------------------------------
// C2 (NIM/Codex dispatch fix set): tolerant `result` parse — when the model
// returns the result value DIRECTLY (bare array / bare object) instead of under
// `result`, relay the whole payload. Schema-gated downstream, so it can never
// ingest garbage; it only rescues the well-formed-top-level case.
// ---------------------------------------------------------------------------

test("C2: a bare result object at the top level is relayed as the result", async () => {
  const { input } = makeCtx();
  // No `{files,result}` wrapper — the model emitted the item-results object directly.
  const content = JSON.stringify({ item_results: [{ finding_id: "N-1", status: "resolved" }] });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted, res.error).toBe(true);
  expect(JSON.parse(readFileSync(input.resultPath, "utf8"))).toEqual({
    item_results: [{ finding_id: "N-1", status: "resolved" }],
  });
});

test("C2: a bare array at the top level is relayed as the result (audit findings shape)", async () => {
  const { input } = makeCtx();
  const content = JSON.stringify([{ task_id: "t1", findings: [] }]);
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted, res.error).toBe(true);
  expect(JSON.parse(readFileSync(input.resultPath, "utf8"))).toEqual([{ task_id: "t1", findings: [] }]);
});

test("C2: a bare JSON primitive is rejected, not relayed as the result", async () => {
  // A bare number/string/boolean/null is never valid worker output — fail cleanly
  // rather than writing a garbage primitive result deferred to downstream validation.
  for (const primitive of ["42", '"hello"', "true", "null"]) {
    const { input } = makeCtx();
    const fetchFn = fakeFetchReturning(primitive);
    const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
    const res = await provider.launch(input);
    expect(res.accepted, `bare ${primitive} must not be accepted`).toBe(false);
    expect(res.error ?? "").toMatch(/bare JSON/);
  }
});

test("C2: a wrapper that carries files but drops result still fails (not tolerated)", async () => {
  const { input } = makeCtx();
  // `files` present = the model used the wrapper contract but omitted `result`;
  // this is a genuine omission, NOT a bare-payload relay case.
  const content = JSON.stringify({ files: [{ path: "a.txt", content: "hi" }] });
  const fetchFn = fakeFetchReturning(content);
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(false);
  expect(res.error ?? "").toMatch(/result/);
});

// ---------------------------------------------------------------------------
// CP-NODE-10 (CE-004 NIM guided-decoding lever): the provider attaches the
// worker's JSON Schema supplied via `input.outputSchema` through the constraint
// ladder (json_schema -> json_object -> none), the `guided_json` kill-switch
// suppresses it, and a 400/422 rejection of the schema form degrades to a plain
// json_object retry rather than failing. These pin the emit-time build lever.
// ---------------------------------------------------------------------------

const sampleSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  items: { type: "object" },
};

function captureBodyFetch(onBody, response) {
  const fn = async (_url, init) => {
    onBody(JSON.parse(init.body));
    return (
      response ?? {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ files: [], result: {} }) } }],
        }),
        text: async () => "",
      }
    );
  };
  return fn;
}

test("CP-NODE-10: outputSchema is attached via response_format json_schema + guided_json/nvext.guided_json", async () => {
  const { input } = makeCtx();
  let captured;
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: captureBodyFetch((b) => { captured = b; }),
  });
  const res = await provider.launch({ ...input, outputSchema: sampleSchema });
  expect(res.accepted, res.error).toBe(true);
  // Strongest form: response_format json_schema with the schema inlined + strict.
  expect(captured.response_format.type).toBe("json_schema");
  expect(captured.response_format.json_schema.schema).toEqual(sampleSchema);
  expect(captured.response_format.json_schema.strict).toBe(true);
  // NIM / vLLM guided decoding: schema at top level AND under nvext.
  expect(captured.guided_json).toEqual(sampleSchema);
  expect(captured.nvext).toEqual({ guided_json: sampleSchema });
});

test("CP-NODE-10: no outputSchema => plain json_object, never a guided_json body", async () => {
  const { input } = makeCtx();
  let captured;
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: captureBodyFetch((b) => { captured = b; }),
  });
  await provider.launch(input); // no outputSchema on the input
  expect(captured.response_format).toEqual({ type: "json_object" });
  expect(captured.guided_json, "no schema => no guided_json").toBe(undefined);
  expect(captured.nvext, "no schema => no nvext").toBe(undefined);
});

test("CP-NODE-10: guided_json:false kill-switch suppresses the schema form even when a schema is supplied", async () => {
  const { input } = makeCtx();
  let captured;
  const provider = new OpenAiCompatibleProvider(
    { ...minimalConfig, guided_json: false },
    { fetchFn: captureBodyFetch((b) => { captured = b; }) },
  );
  const res = await provider.launch({ ...input, outputSchema: sampleSchema });
  expect(res.accepted, res.error).toBe(true);
  // Kill-switch on: falls back to the weaker json_object, no schema attached.
  expect(captured.response_format).toEqual({ type: "json_object" });
  expect(captured.guided_json).toBe(undefined);
  expect(captured.nvext).toBe(undefined);
});

for (const status of [400, 422]) {
  test(`CP-NODE-10: HTTP ${status} on the json_schema request degrades to a json_object retry`, async () => {
    const { input } = makeCtx();
    const bodies = [];
    let call = 0;
    const fetchFn = async (_url, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) {
        return { ok: false, status, json: async () => ({}), text: async () => "no guided decoding" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ files: [], result: { ok: true } }) } }],
        }),
        text: async () => "",
      };
    };
    const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn });
    const res = await provider.launch({ ...input, outputSchema: sampleSchema });
    expect(res.accepted, res.error).toBe(true);
    expect(call, "schema attempt + one json_object retry").toBe(2);
    // First attempt carried the schema; the retry stepped down to json_object.
    expect(bodies[0].response_format.type).toBe("json_schema");
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].guided_json, "the degrade drops guided_json").toBe(undefined);
  });
}

test("CP-NODE-10: with guided_json wanted but json_object disabled, a schema-form rejection degrades straight to none", async () => {
  const { input } = makeCtx();
  const bodies = [];
  let call = 0;
  const fetchFn = async (_url, init) => {
    call += 1;
    bodies.push(JSON.parse(init.body));
    if (call === 1) {
      return { ok: false, status: 400, json: async () => ({}), text: async () => "no schema" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ files: [], result: {} }) } }],
      }),
      text: async () => "",
    };
  };
  // response_format_json:false means json_object is NOT a wanted intermediate step.
  const provider = new OpenAiCompatibleProvider(
    { ...minimalConfig, response_format_json: false },
    { fetchFn },
  );
  const res = await provider.launch({ ...input, outputSchema: sampleSchema });
  expect(res.accepted, res.error).toBe(true);
  expect(call, "schema attempt + a straight-to-none retry").toBe(2);
  expect(bodies[0].response_format.type).toBe("json_schema");
  expect(bodies[1].response_format, "skips json_object, goes to no response_format").toBe(undefined);
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
  expect(provider.name).toBe("openai-compatible");
});

// ---------------------------------------------------------------------------
// Reactive cost verification (arbitrage increment 2)
// ---------------------------------------------------------------------------

const { extractReportedCostUsd, extractObservedUsage } = await import(
  "../../src/shared/providers/openAiCompatibleProvider.ts"
);

test("extractReportedCostUsd — reads opencode's top-level string cost", () => {
  expect(extractReportedCostUsd({ cost: "0" })).toBe(0);
  expect(extractReportedCostUsd({ cost: "0.02" })).toBe(0.02);
  expect(extractReportedCostUsd({ cost: "1.5" })).toBe(1.5);
});

test("extractReportedCostUsd — reads a numeric cost", () => {
  expect(extractReportedCostUsd({ cost: 0 })).toBe(0);
  expect(extractReportedCostUsd({ cost: 0.5 })).toBe(0.5);
});

test("extractReportedCostUsd — falls back to usage.cost / usage.total_cost", () => {
  expect(extractReportedCostUsd({ usage: { cost: "0.01" } })).toBe(0.01);
  expect(extractReportedCostUsd({ usage: { total_cost: 0.03 } })).toBe(0.03);
  // Top-level cost wins over nested when both are present.
  expect(extractReportedCostUsd({ cost: "0", usage: { cost: "9" } })).toBe(0);
});

test("extractReportedCostUsd — absent / garbage cost yields undefined (no false signal)", () => {
  expect(extractReportedCostUsd({})).toBeUndefined();
  expect(extractReportedCostUsd({ cost: null })).toBeUndefined();
  expect(extractReportedCostUsd({ cost: "" })).toBeUndefined();
  expect(extractReportedCostUsd({ cost: "free" })).toBeUndefined();
  expect(extractReportedCostUsd({ cost: -0.5 })).toBeUndefined();
  expect(extractReportedCostUsd({ cost: NaN })).toBeUndefined();
});

// A fetch that returns a completion body carrying an explicit `cost`, so the
// provider surfaces the endpoint-reported cost on its launch result.
function fakeFetchWithCost(content, cost) {
  const fn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      ...(cost !== undefined ? { cost } : {}),
    }),
    text: async () => (typeof content === "string" ? content : JSON.stringify(content)),
  });
  return fn;
}

test("launch surfaces observedCostUsd from the response cost field", async () => {
  const { input } = makeCtx();
  const body = JSON.stringify({ files: [], result: { ok: true } });
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: fakeFetchWithCost(body, "0.02"),
  });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(res.observedCostUsd).toBe(0.02);
});

test("launch surfaces observedCostUsd 0 for a free (cost:'0') response", async () => {
  const { input } = makeCtx();
  const body = JSON.stringify({ files: [], result: { ok: true } });
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: fakeFetchWithCost(body, "0"),
  });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(res.observedCostUsd).toBe(0);
});

test("launch omits observedCostUsd when the endpoint reports no cost", async () => {
  const { input } = makeCtx();
  const body = JSON.stringify({ files: [], result: { ok: true } });
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: fakeFetchWithCost(body, undefined),
  });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(res.observedCostUsd).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Observed token usage (score-tokens cost counterpart, A2-track item 3)
// ---------------------------------------------------------------------------

test("extractObservedUsage — reads the OpenAI dialect (prompt/completion tokens, nested cached_tokens)", () => {
  expect(
    extractObservedUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    }),
  ).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 });
});

test("extractObservedUsage — reads the Anthropic-native dialect (cache_read/cache_creation_input_tokens)", () => {
  expect(
    extractObservedUsage({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 90,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    }),
  ).toEqual({ inputTokens: 500, outputTokens: 90, cacheReadTokens: 100, cacheCreationTokens: 20 });
});

test("extractObservedUsage — a numeric-string usage field is coerced (some gateways stringify like they do cost)", () => {
  expect(
    extractObservedUsage({
      usage: { prompt_tokens: "800", completion_tokens: "150" },
    }),
  ).toEqual({ inputTokens: 800, outputTokens: 150 });
});

test("extractObservedUsage — absent usage / cache fields yields undefined per-field, never fabricated 0", () => {
  expect(extractObservedUsage({})).toBeUndefined();
  expect(extractObservedUsage({ usage: {} })).toBeUndefined();
  // Only prompt_tokens present — the rest simply absent from the returned object.
  expect(extractObservedUsage({ usage: { prompt_tokens: 10 } })).toEqual({ inputTokens: 10 });
});

test("extractObservedUsage — malformed usage fields are dropped, not thrown on", () => {
  expect(
    extractObservedUsage({
      usage: {
        prompt_tokens: "not-a-number",
        completion_tokens: -5,
        cache_read_input_tokens: null,
        prompt_tokens_details: { cached_tokens: NaN },
      },
    }),
  ).toBeUndefined();
  // usage itself malformed (not an object) — never throws.
  expect(extractObservedUsage({ usage: "nope" })).toBeUndefined();
  expect(extractObservedUsage({ usage: null })).toBeUndefined();
});

test("launch surfaces observedUsage from the response usage field", async () => {
  const { input } = makeCtx();
  const body = JSON.stringify({ files: [], result: { ok: true } });
  const fn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: body } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
    }),
    text: async () => body,
  });
  const provider = new OpenAiCompatibleProvider(minimalConfig, { fetchFn: fn });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(res.observedUsage).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 });
});

test("launch omits observedUsage when the endpoint reports no usage (byte-identical to pre-change behavior)", async () => {
  const { input } = makeCtx();
  const body = JSON.stringify({ files: [], result: { ok: true } });
  const provider = new OpenAiCompatibleProvider(minimalConfig, {
    fetchFn: fakeFetchReturning(body),
  });
  const res = await provider.launch(input);
  expect(res.accepted).toBe(true);
  expect(res.observedUsage).toBeUndefined();
  expect("observedUsage" in res).toBe(false);
});
