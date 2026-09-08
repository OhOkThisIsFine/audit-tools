import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnHidden, spawnSyncHidden } from "../helpers/spawn.mjs";
import { checkpointPathForRequests } from "../../benchmarks/p0/runner.mjs";

const shared = { repo_commit: "0123456789abcdef0123456789abcdef01234567", host_build: "audit-tools@0.50.19", model: "pinned-model", reasoning_effort: "high", tool_inventory: ["codebase-memory"], budgets: { context: 100000, output: 12000, turns: 20, timeout_ms: 300000 } };
const pairs = (prefix: string) => Array.from({ length: 5 }, (_, index) => ({ id: `${prefix}-${index + 1}`, pinned: shared, control_prompt: "user standalone prompt verbatim codebase-memory", candidate_prompt: "ordinary comprehensive /audit-code P0 behavior" }));
const baseManifest = { version: 1, shared, primary: { pairs: pairs("primary") }, held_out: { pairs: pairs("held-out") }, graph_disabled_trial: { graph_enabled: false, expected_outcome: "abort_before_comprehensive", notice: "degraded/non-comprehensive" }, randomization: { pair_order: "randomized", masking: "A/B" }, evaluation: { independent_evaluators: 2, adjudicator: 1, private_gold_schema: "benchmarks/p0/private-gold.schema.json" }, axes: ["structural_recall", "philosophy_telos_recall", "grounding_precision", "telos_to_code_linkage", "reduction_value", "false_positive_discipline"] };
type Json = Record<string, unknown>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function writeAuditCode(path: string) {
  writeFileSync(path, [
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = process.argv[process.argv.indexOf("--root") + 1];',
    'const steps = join(root, ".audit-tools", "audit", "steps");',
    'mkdirSync(steps, { recursive: true });',
    'const state = join(steps, ".p0-step-count");',
    'const count = existsSync(state) ? Number(readFileSync(state, "utf8")) + 1 : 1;',
    'writeFileSync(state, String(count));',
    'const current = join(steps, "current-step.json");',
    'if (count <= 2) {',
    '  const prompt = join(".audit-tools", "audit", "steps", `candidate-${count}.md`);',
    '  writeFileSync(join(root, prompt), `backend prompt ${count}`);',
    '  writeFileSync(current, JSON.stringify({ step_kind: count === 1 ? "review" : "synthesis", prompt_path: prompt }));',
    '} else {',
    '  const report = join(root, ".audit-tools", "audit", "audit-report.md");',
    '  mkdirSync(join(root, ".audit-tools", "audit"), { recursive: true });',
    '  writeFileSync(report, "# Candidate report\\n");',
    '  writeFileSync(current, JSON.stringify({ step_kind: "present_report", status: "complete", complete: true, artifact_paths: { final_report: report } }));',
    '}',
    'console.log(JSON.stringify({ artifact_paths: { current_step: current } }));',
  ].join("\n"));
}

function writeExecutor(path: string, logPath: string) {
  writeFileSync(path, [
    'import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    'import { dirname, join } from "node:path";',
    'const get = (flag) => process.argv[process.argv.indexOf(flag) + 1];',
    'const request = JSON.parse(readFileSync(get("--request"), "utf8"));',
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(request) + "\\n");`,
    'const holdPath = process.env.P0_HOLD_ONCE_PATH;',
    'if (holdPath && !existsSync(holdPath)) { writeFileSync(holdPath, "held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750); }',
    'const kill = process.env.P0_KILL_MODE;',
    'const target = process.env.P0_KILL_TARGET;',
    'const matches = target && (request.request_id === target || request.candidate_request_digest === target);',
    'if (matches && process.env.P0_TAMPER_SOURCE && request.snapshot_root) writeFileSync(join(request.snapshot_root, "fixture.js"), "tampered source\\n");',
    'if (matches && process.env.P0_CREATE_ROOT_OUTPUT && request.snapshot_root) writeFileSync(join(request.snapshot_root, "project.json"), "{\\"generated\\":true}\\n");',
    'const later = kill !== "candidate-later" || request.step_kind === "synthesis";',
    'if (matches && kill === "missing") { process.kill(process.ppid, "SIGKILL"); process.exit(0); }',
    'const responsePath = get("--response");',
    'const suffix = String(request.step_id ?? "control").replaceAll(/[^a-z0-9_.-]/gi, "_");',
    'const artifactPath = join(dirname(responsePath), `${request.request_id ?? "candidate"}-${suffix}.md`);',
    'const bytes = Buffer.from("# Executor artifact\\n");',
    'writeFileSync(artifactPath, bytes);',
    'mkdirSync(dirname(responsePath), { recursive: true });',
    'writeFileSync(responsePath, JSON.stringify({ protocol: "p0-executor-response-v1", request_digest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), pinned_profile: request.pinned_profile, artifact_path: artifactPath, artifact_sha256: createHash("sha256").update(bytes).digest("hex") }));',
    'if (matches && kill && later) process.kill(process.ppid, "SIGKILL");',
  ].join("\n"));
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "p0-real-crash-"));
  const repoRoot = resolve(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  writeAuditCode(resolve(repoRoot, "audit-code.mjs"));
  const sourceFixture = resolve(repoRoot, "fixture.js");
  writeFileSync(sourceFixture, "export const fixture = true;\n");
  for (const args of [["init"], ["config", "user.email", "p0@example.invalid"], ["config", "user.name", "P0 Test"], ["add", "."], ["commit", "-m", "fixture"]]) {
    const result = spawnSyncHidden("git", args, { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, `${result.stderr}`).toBe(0);
  }
  const commit = (spawnSyncHidden("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout as string).trim();
  const profile = { ...shared, repo_commit: commit };
  const corpus = resolve(root, "held-out-corpus");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(resolve(corpus, "fixture.js"), "export const heldOut = true;\n");
  const corpusDigest = createHash("sha256").update("fixture.js").update("\0").update(readFileSync(resolve(corpus, "fixture.js"))).update("\0").digest("hex");
  const manifest = { ...baseManifest, shared: profile, primary: { pairs: baseManifest.primary.pairs.map((pair) => ({ ...pair, pinned: profile })) }, held_out: { pairs: baseManifest.held_out.pairs.map((pair) => ({ ...pair, pinned: profile })), corpus: { path: corpus, deterministic_tree_digest: true, sha256: corpusDigest } } };
  const manifestPath = resolve(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const runner = resolve("benchmarks/p0/runner.mjs");
  const preparedRoot = resolve(root, "prepared");
  const prepared = spawnSyncHidden(process.execPath, [runner, "prepare", "--manifest", manifestPath, "--output", preparedRoot], { cwd: repoRoot, encoding: "utf8" });
  expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0);
  const requestsPath = resolve(preparedRoot, "requests.public.json");
  const identityPath = resolve(preparedRoot, "identity.private.json");
  const executor = resolve(root, "executor.mjs");
  const logPath = resolve(root, "executor.jsonl");
  writeExecutor(executor, logPath);
  return { root, repoRoot, sourceFixture, manifestPath, requestsPath, identityPath, executor, logPath, runner, requests: JSON.parse(readFileSync(requestsPath, "utf8")) as { requests: Json[] }, identity: JSON.parse(readFileSync(identityPath, "utf8")) as { arms: Record<string, Record<string, string>> } };
}
type Fixture = ReturnType<typeof fixture>;
function kindOf(f: Fixture, request: Json) { return f.identity.arms[String(request.pair_id)][String(request.arm)]; }
function targetOf(f: Fixture, kind: string) { const request = f.requests.requests.find((item) => kindOf(f, item) === kind); if (!request) throw Error(`missing ${kind} request`); return request; }
function run(f: Fixture, env: Record<string, string> = {}) { return spawnSyncHidden(process.execPath, [f.runner, "run", "--manifest", f.manifestPath, "--requests", f.requestsPath, "--identity", f.identityPath, "--executor", process.execPath, "--executor-arg", f.executor], { cwd: f.repoRoot, encoding: "utf8", env: { ...process.env, ...env } }); }
function runAsync(f: Fixture, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawnHidden(process.execPath, [f.runner, "run", "--manifest", f.manifestPath, "--requests", f.requestsPath, "--identity", f.identityPath, "--executor", process.execPath, "--executor-arg", f.executor], { cwd: f.repoRoot, env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => done({ status, stderr }));
  });
}
async function waitFor(path: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error(`timed out waiting for ${path}`);
}
function calls(f: Fixture) { return existsSync(f.logPath) ? readFileSync(f.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json) : [] as Json[]; }
function expectKilled(result: ReturnType<typeof run>) {
  // Windows reports a SIGKILLed child as exit code 1 through spawnSyncHidden.
  expect(result.status).not.toBe(0);
}

describe("P0 checkpoint interruption around dispatch/result handoff", () => {
  test("a real control dispatch kill resumes its durable response without relaunch", () => {
    const f = fixture();
    try {
      const target = targetOf(f, "control");
      expectKilled(run(f, { P0_KILL_MODE: "control", P0_KILL_TARGET: String(target.request_id) }));
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      expect((checkpoint.in_progress as Json).request_id).toBe(target.request_id);
      expect(existsSync(String(((checkpoint.in_progress as Json).pending as Json).response_path))).toBe(true);
      const before = calls(f).filter((call) => call.request_id === target.request_id).length;
      const resumed = run(f);
      expect(resumed.status, `${resumed.stderr}\n${resumed.stdout}`).toBe(0);
      expect(calls(f).filter((call) => call.request_id === target.request_id)).toHaveLength(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test.each(["candidate-first", "candidate-later"])("a real %s kill resumes the exact candidate step", (mode) => {
    const f = fixture();
    try {
      const target = targetOf(f, "candidate");
      const targetDigest = digest(target);
      expectKilled(run(f, { P0_KILL_MODE: mode, P0_KILL_TARGET: targetDigest }));
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      const progress = checkpoint.in_progress as Json;
      expect(progress.request_id).toBe(target.request_id);
      expect(existsSync(String(progress.snapshot_root))).toBe(true);
      expect(readFileSync(f.sourceFixture, "utf8")).toBe("export const fixture = true;\n");
      const stepKind = mode === "candidate-first" ? "review" : "synthesis";
      const before = calls(f).filter((call) => call.candidate_request_digest === targetDigest && call.step_kind === stepKind).length;
      const resumed = run(f);
      expect(resumed.status, `${resumed.stderr}\n${resumed.stdout}`).toBe(0);
      expect(calls(f).filter((call) => call.candidate_request_digest === targetDigest && call.step_kind === stepKind)).toHaveLength(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("missing pending evidence refuses replay and preserves its fixture", () => {
    const f = fixture();
    try {
      const target = targetOf(f, "control");
      expectKilled(run(f, { P0_KILL_MODE: "missing", P0_KILL_TARGET: String(target.request_id) }));
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      const pending = (checkpoint.in_progress as Json).pending as Json;
      expect(existsSync(String(pending.request_path))).toBe(true);
      expect(existsSync(String(pending.response_path))).toBe(false);
      const before = calls(f).length;
      const resumed = run(f);
      expect(resumed.status).not.toBe(0);
      expect(`${resumed.stderr}\n${resumed.stdout}`).toMatch(/unresolved invocation/i);
      expect(calls(f)).toHaveLength(before);
      expect(existsSync(String(pending.request_path))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a tampered pending response profile is rejected before any replay", () => {
    const f = fixture();
    try {
      const target = targetOf(f, "control");
      expectKilled(run(f, { P0_KILL_MODE: "control", P0_KILL_TARGET: String(target.request_id) }));
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      const responsePath = String((((checkpoint.in_progress as Json).pending as Json).response_path));
      const response = JSON.parse(readFileSync(responsePath, "utf8")) as Json;
      writeFileSync(responsePath, `${JSON.stringify({ ...response, pinned_profile: { tampered: true } })}\n`);
      const before = calls(f).length;
      const resumed = run(f);
      expect(resumed.status).not.toBe(0);
      expect(`${resumed.stderr}\n${resumed.stdout}`).toMatch(/binding mismatch/i);
      expect(calls(f)).toHaveLength(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a real executor source tamper refuses completion and later replay", () => {
    const f = fixture();
    try {
      const target = targetOf(f, "candidate");
      const tampered = run(f, { P0_TAMPER_SOURCE: "1", P0_KILL_TARGET: digest(target) });
      expect(tampered.status).not.toBe(0);
      expect(`${tampered.stderr}\n${tampered.stdout}`).toMatch(/source binding/i);
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      expect((checkpoint.in_progress as Json).request_id).toBe(target.request_id);
      expect(checkpoint.failures).toEqual([]);
      const before = calls(f).length;
      const resumed = run(f);
      expect(resumed.status).not.toBe(0);
      expect(`${resumed.stderr}\n${resumed.stdout}`).toMatch(/source binding/i);
      expect(calls(f)).toHaveLength(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a new root artifact does not invalidate the original source inventory", () => {
    const f = fixture();
    try {
      const target = targetOf(f, "candidate");
      const result = run(f, { P0_CREATE_ROOT_OUTPUT: "1", P0_KILL_TARGET: digest(target) });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(readFileSync(f.sourceFixture, "utf8")).toBe("export const fixture = true;\n");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("concurrent resumers cannot both reclaim one dead runner lock", async () => {
    const f = fixture();
    try {
      const target = targetOf(f, "control");
      expectKilled(run(f, { P0_KILL_MODE: "control", P0_KILL_TARGET: String(target.request_id) }));
      const holdPath = resolve(f.root, "executor-held");
      const first = runAsync(f, { P0_HOLD_ONCE_PATH: holdPath });
      await waitFor(holdPath);
      const second = await runAsync(f, { P0_HOLD_ONCE_PATH: holdPath });
      const firstResult = await first;
      expect(firstResult.status, firstResult.stderr).toBe(0);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/checkpoint is busy/i);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("post-completion orphan cleanup does not poison durable results", () => {
    const f = fixture();
    try {
      const first = run(f);
      expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0);
      const checkpoint = JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")) as Json;
      const heldOut = (checkpoint.completed as Json[]).find((record) => {
        const request = f.requests.requests.find((item) => item.request_id === record.request_id);
        return request?.snapshot === "held-out";
      });
      expect(heldOut).toBeDefined();
      const orphanRoot = join(String(checkpoint.snapshot_base), String(heldOut?.request_id), "repo");
      mkdirSync(orphanRoot, { recursive: true });
      writeFileSync(join(orphanRoot, "cleanup-debt.txt"), "cleanup debt\n");
      const resumed = run(f);
      expect(resumed.status, `${resumed.stderr}\n${resumed.stdout}`).toBe(0);
      expect(JSON.parse(resumed.stdout as string)).toEqual(JSON.parse(first.stdout as string));
      expect(JSON.parse(readFileSync(checkpointPathForRequests(f.requestsPath), "utf8")).status).toBe("complete");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
