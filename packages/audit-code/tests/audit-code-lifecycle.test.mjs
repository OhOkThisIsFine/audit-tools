import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

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
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-lifecycle-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });

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

test("audit-code wrapper supports repeated bounded invocations in single-step mode with a stable artifact directory", async () => {
  await withTempRepo(async (root) => {
    const first = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(first.selected_executor, "intake_executor");
    assert.equal(first.next_likely_step, "auto_fixes_applied");

    const second = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(second.selected_executor, "auto_fix_executor");
    assert.equal(second.next_likely_step, "syntax_resolved");

    const third = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(third.selected_executor, "syntax_resolution_executor");
    assert.equal(third.next_likely_step, "structure_artifacts");

    const fourth = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(fourth.selected_executor, "structure_executor");
    assert.equal(fourth.next_likely_step, "graph_enrichment_current");

    // Graph enrichment runs between structure and design assessment. In
    // single-step mode it never prompts: optional analyzers resolve or fall
    // back to the regex floor, then the chain proceeds.
    const enrichment = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(enrichment.selected_executor, "graph_enrichment_executor");
    assert.equal(enrichment.next_likely_step, "design_assessment_current");

    const fifth = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(fifth.selected_executor, "design_assessment_executor");
    assert.equal(fifth.next_likely_step, "design_review_completed");

    const sixth = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(sixth.selected_executor, "design_review");
    assert.equal(sixth.next_likely_step, "intent_checkpoint_current");

    // Intent checkpoint auto-completes headlessly in single-step mode.
    const seventh = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(seventh.selected_executor, "intent_checkpoint_executor");
    assert.equal(seventh.next_likely_step, "planning_artifacts");

    const eighth = JSON.parse(
      (await runWrapper(["--single-step"], { cwd: root })).stdout,
    );
    assert.equal(eighth.selected_executor, "planning_executor");
    assert.ok(Array.isArray(eighth.artifacts_written));
    assert.ok(eighth.artifacts_written.includes("audit_tasks.json"));
    assert.ok(eighth.artifacts_written.includes("requeue_tasks.json"));
  });
});

test("audit-code wrapper accepts external analyzer evidence on the same product surface in single-step mode", async () => {
  await withTempRepo(async (root) => {
    const analyzerPath = join(root, "external_analyzer_results.json");
    await writeFile(
      analyzerPath,
      JSON.stringify(
        {
          tool: "semgrep",
          generated_at: "2026-03-23T00:00:00Z",
          results: [
            {
              id: "sg-1",
              category: "security",
              severity: "warning",
              path: "src/api/auth.ts",
              line_start: 1,
              line_end: 3,
              summary: "Potentially missing auth logging.",
            },
          ],
        },
        null,
        2,
      ),
    );

    const imported = JSON.parse(
      (
        await runWrapper(
          ["--single-step", "--external-analyzer-results", analyzerPath],
          { cwd: root },
        )
      ).stdout,
    );
    assert.equal(
      imported.selected_executor,
      "external_analyzer_import_executor",
    );
    assert.equal(imported.progress_made, true);
    assert.ok(
      imported.artifacts_written.includes("external_analyzer_results.json"),
    );
  });
});
