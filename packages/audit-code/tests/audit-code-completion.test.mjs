import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertMatchesJsonSchema } from "./helpers/jsonSchemaAssert.mjs";
import { countLines } from "./helpers/countLines.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const schemaPath = join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json");
const responseSchema = JSON.parse(await readFile(schemaPath, "utf8"));

async function buildSyntheticResults(tasks, root) {
  return Promise.all(tasks.map(async (task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "smoke-reviewer",
    file_coverage: await Promise.all(
      task.file_paths.map(async (path) => ({
        path,
        total_lines: await countLines(root, path),
      })),
    ),
    findings: [],
    notes: ["Synthetic completion result for wrapper integration coverage."],
    requires_followup: false,
  })));
}

function runWrapper(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-completion-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "test-repo", version: "0.0.0" }, null, 2) + "\n",
    );
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(root, "src", "lib", "session.ts"),
      [
        "export interface Session {",
        "  id: string;",
        "}",
        "",
        "export function createSession(id: string): Session {",
        "  return { id };",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(root, "infra", "deploy.yml"),
      [
        "name: deploy",
        "on: [push]",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "",
      ].join("\n"),
    );

    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code wrapper reaches a blocked handoff by default and leaves only audit-report.md on completion", async () => {
  await withTempRepo(async (root) => {
    const blocked = JSON.parse((await runWrapper([], { cwd: root })).stdout);
    assertMatchesJsonSchema(responseSchema, blocked, "auditCodeResponse:blocked");
    assert.equal(blocked.audit_state.status, "blocked");
    assert.equal(blocked.selected_executor, "agent");

    const tasks = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
    );
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );

    const completed = JSON.parse(
      (await runWrapper(["--results", resultsPath], { cwd: root })).stdout,
    );
    assertMatchesJsonSchema(responseSchema, completed, "auditCodeResponse:completed");
    assert.equal(completed.audit_state.status, "complete");

    const auditReport = await readFile(join(root, "audit-report.md"), "utf8");
    assert.match(auditReport, /# Audit Report/);

    await assert.rejects(
      () => access(join(root, ".audit-artifacts")),
      /ENOENT/i,
    );
  });
});

test("audit-code wrapper can ingest a directory of batch result files and still collapse to audit-report.md", async () => {
  await withTempRepo(async (root) => {
    const blocked = JSON.parse((await runWrapper([], { cwd: root })).stdout);
    assert.equal(blocked.audit_state.status, "blocked");

    const tasks = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
    );
    const allResults = await buildSyntheticResults(tasks, root);
    const batchDir = join(root, "audit-results-batch");
    await mkdir(batchDir, { recursive: true });
    await writeFile(
      join(batchDir, "result-01.json"),
      JSON.stringify(allResults.slice(0, Math.ceil(allResults.length / 2)), null, 2),
    );
    await writeFile(
      join(batchDir, "result-02.json"),
      JSON.stringify(allResults.slice(Math.ceil(allResults.length / 2)), null, 2),
    );

    const completed = JSON.parse(
      (await runWrapper(["--batch-results", batchDir], { cwd: root })).stdout,
    );
    assertMatchesJsonSchema(responseSchema, completed, "auditCodeResponse:batchCompleted");
    assert.equal(completed.audit_state.status, "complete");
    assert.match(
      await readFile(join(root, "audit-report.md"), "utf8"),
      /## Work Blocks/,
    );
  });
});

test("audit-code wrapper promotes the final report when completion lands on max-runs", async () => {
  await withTempRepo(async (root) => {
    const blocked = JSON.parse((await runWrapper([], { cwd: root })).stdout);
    assert.equal(blocked.audit_state.status, "blocked");

    const tasks = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
    );
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );

    // result ingestion → synthesis → synthesis-narrative (omitted, deterministic)
    // is three bounded runs; completion must land on the final allowed run.
    const completed = JSON.parse(
      (
        await runWrapper(
          ["--results", resultsPath, "--max-runs", "3"],
          { cwd: root },
        )
      ).stdout,
    );
    assert.equal(completed.audit_state.status, "complete");
    assert.match(
      await readFile(join(root, "audit-report.md"), "utf8"),
      /# Audit Report/,
    );

    await assert.rejects(
      () => access(join(root, ".audit-artifacts")),
      /ENOENT/i,
    );
  });
});
