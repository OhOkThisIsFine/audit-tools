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
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: cleanEnv,
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

test("run-to-completion completes on a rendered report even when finalization overruns max-runs", async () => {
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

    // Ingestion (1) + synthesis (2) renders the report, but the deterministic
    // narrative-omit completion run (3) is one past max-runs=2 — so the loop
    // hits the backstop with the report already rendered. It must still finish
    // on the report (complete + promote), never strand it behind a bare
    // "max run limit" non-completion.
    const completed = JSON.parse(
      (
        await runWrapper(["--results", resultsPath, "--max-runs", "2"], {
          cwd: root,
        })
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

test("next-step presents the rendered report instead of a run-limit block", async () => {
  await withTempRepo(async (root) => {
    const blocked = JSON.parse((await runWrapper([], { cwd: root })).stdout);
    assert.equal(blocked.audit_state.status, "blocked");

    const artifactsDir = join(root, ".audit-artifacts");
    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    // Disable the narrative so next-step's finalization stays fully
    // deterministic (no synthesis_narrative host pause to interrupt the loop).
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ synthesis: { narrative: false } }, null, 2),
    );
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );
    // Ingest the results without finishing finalization, leaving the audit one
    // (or a few) deterministic runs short of complete with artifacts intact.
    await runWrapper(["--results", resultsPath, "--max-runs", "1"], { cwd: root });

    const reportPath = join(artifactsDir, "audit-report.md");
    const reportExists = async () =>
      access(reportPath).then(() => true).catch(() => false);

    // Starve each next-step call to a single internal run so it repeatedly lands
    // on the run-limit backstop while finalization is still in flight. The fix's
    // invariant: once the report is rendered, the backstop must present it
    // (present_report) — it must never surface a completed audit as `blocked`.
    let presented = null;
    for (let i = 0; i < 15 && !presented; i++) {
      const step = JSON.parse(
        (await runWrapper(["next-step", "--max-runs", "1"], { cwd: root })).stdout,
      );
      if (step.step_kind === "present_report") {
        presented = step;
        break;
      }
      assert.equal(
        step.step_kind,
        "blocked",
        `expected only blocked/present_report while finalizing, got ${step.step_kind}`,
      );
      assert.equal(
        await reportExists(),
        false,
        "a rendered report must be presented, never surfaced as a run-limit block",
      );
    }

    assert.ok(presented, "next-step must reach present_report");
    assert.equal(presented.status, "complete");
    // Completion promotes the canonical report to the repo root.
    assert.equal(presented.artifact_paths.final_report, join(root, "audit-report.md"));
    assert.match(
      await readFile(presented.artifact_paths.final_report, "utf8"),
      /# Audit Report/,
    );
    // The audit working state is cleaned out (promotion removes the artifact
    // bundle), but next-step still leaves the present_report step scaffolding so
    // the host can read and follow `prompt_path`. Assert the working artifacts
    // are gone while the prompt the host must follow remains readable.
    assert.equal(
      await access(join(artifactsDir, "audit_tasks.json"))
        .then(() => true)
        .catch(() => false),
      false,
      "audit working artifacts must be cleaned on completion",
    );
    assert.match(await readFile(presented.prompt_path, "utf8"), /present report/i);
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
