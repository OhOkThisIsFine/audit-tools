import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { countLines } from "./helpers/countLines.mjs";

// Step contracts normalize host-facing paths to forward slashes (drift-plan R3).
const { toPromptPathToken } = await import("@audit-tools/shared");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const distCliPath = join(repoRoot, "dist", "cli.js");

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

function runNode(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
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
      reject(new Error(stderr || stdout || `child exited with ${code}`));
    });
  });
}

function runWrapper(args, options = {}) {
  return runNode([wrapperPath, ...args], options);
}

// Run a dist CLI command directly (e.g. ingest-results, which is intentionally
// not a wrapper passthrough — workers must not trigger ingestion).
function runDistCli(args, options = {}) {
  return runNode([distCliPath, ...args], options);
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

// Pause step kinds that next-step can emit before review dispatch is ready
// (analyzer install decision, intent confirmation, design review passes,
// optional edge reasoning), each at most once; allow extra headroom.
const MAX_PRE_DISPATCH_PAUSES = 8;

// Drive `next-step` past the host pause steps that precede review dispatch by
// answering each pause headlessly (skip analyzer installs, confirm the default
// scope, submit empty design-review findings). Returns the first
// dispatch-ready step (dispatch_review or single_task_fallback).
async function advanceToDispatchReady(root) {
  const incomingDir = join(root, ".audit-tools/audit", "incoming");
  for (let i = 0; i < MAX_PRE_DISPATCH_PAUSES; i++) {
    const step = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root })).stdout,
    );
    if (step.step_kind === "analyzer_install") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.analyzer_decisions,
        JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "confirm_intent") {
      await writeFile(
        step.artifact_paths.intent_checkpoint,
        JSON.stringify(
          {
            schema_version: "intent-checkpoint/v1",
            confirmed_at: "2026-04-22T00:00:00Z",
            confirmed_by: "host",
            scope_summary: "test scope",
            intent_summary: "full-audit",
          },
          null,
          2,
        ) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_parallel") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        "[]\n",
      );
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        "[]\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_contract") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        "[]\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_conceptual") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        "[]\n",
      );
      continue;
    }
    if (
      step.step_kind === "edge_reasoning" ||
      step.step_kind === "edge_reasoning_dispatch"
    ) {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(step.artifact_paths.edge_reasoning_results, "[]\n");
      continue;
    }
    if (
      step.step_kind === "dispatch_review" ||
      step.step_kind === "single_task_fallback"
    ) {
      return step;
    }
    throw new Error(
      `advanceToDispatchReady: unexpected step kind '${step.step_kind}' (iteration ${i})`,
    );
  }
  throw new Error("next-step did not reach a dispatch-ready step");
}

// Disable the synthesis narrative so finalization stays fully deterministic
// (no synthesis_narrative host pause). Merges into any session config that the
// run has already persisted (e.g. analyzer skip decisions).
async function disableNarrative(artifactsDir) {
  const configPath = join(artifactsDir, "session-config.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    // No session config yet — start fresh.
  }
  config.synthesis = { ...(config.synthesis ?? {}), narrative: false };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

// Bound the number of next-step calls needed to finalize after ingestion.
const MAX_FINALIZE_STEPS = 5;

async function nextStepUntilPresentReport(root, extraArgs = []) {
  for (let i = 0; i < MAX_FINALIZE_STEPS; i++) {
    const step = JSON.parse(
      (await runWrapper(["next-step", ...extraArgs], { cwd: root })).stdout,
    );
    if (step.step_kind === "present_report") {
      return step;
    }
  }
  throw new Error(
    `next-step did not reach present_report within ${MAX_FINALIZE_STEPS} calls`,
  );
}

test("next-step reaches dispatch_review, ingest-results consumes synthetic results, and completion promotes the report bundle", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    const step = await advanceToDispatchReady(root);
    assert.equal(step.contract_version, "audit-code-step/v1alpha1");
    assert.equal(step.status, "ready");

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    assert.ok(tasks.length > 0);
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );
    await disableNarrative(artifactsDir);

    const ingested = JSON.parse(
      (
        await runDistCli(
          [
            "ingest-results",
            "--root",
            root,
            "--artifacts-dir",
            artifactsDir,
            "--results",
            resultsPath,
          ],
          { cwd: root },
        )
      ).stdout,
    );
    assert.equal(ingested.selected_executor, "result_ingestion_executor");

    const presented = await nextStepUntilPresentReport(root);
    assert.equal(presented.status, "complete");

    // Completion promotes the machine contract and the human render to the
    // artifacts dir's parent (.audit-tools/).
    const auditReport = await readFile(
      join(root, ".audit-tools", "audit-report.md"),
      "utf8",
    );
    assert.match(auditReport, /# Audit Report/);
    await access(join(root, ".audit-tools", "audit-findings.json"));

    // The audit working state is cleaned out (promotion removes the artifact
    // bundle); only the present_report step scaffolding remains so the host
    // can read and follow `prompt_path`.
    await assert.rejects(
      () => access(join(artifactsDir, "audit_tasks.json")),
      /ENOENT/i,
    );
    assert.match(await readFile(presented.prompt_path, "utf8"), /present report/i);
  });
});

test("next-step presents the rendered report instead of a run-limit block", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    await disableNarrative(artifactsDir);
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );
    // Ingest the results without finishing finalization, leaving the audit a
    // few deterministic runs short of complete with artifacts intact.
    await runDistCli(
      [
        "ingest-results",
        "--root",
        root,
        "--artifacts-dir",
        artifactsDir,
        "--results",
        resultsPath,
      ],
      { cwd: root },
    );

    const reportPath = join(artifactsDir, "audit-report.md");
    const reportExists = async () =>
      access(reportPath).then(() => true).catch(() => false);

    // Starve each next-step call to a single internal run so it repeatedly lands
    // on the run-limit backstop while finalization is still in flight. The
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
    // Completion promotes the canonical report to .audit-tools/ (parent of the
    // artifacts dir). The step contract normalizes the path to forward slashes.
    assert.equal(
      presented.artifact_paths.final_report,
      toPromptPathToken(join(root, ".audit-tools", "audit-report.md")),
    );
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

test("ingest-results accepts a directory of batch result files and next-step still collapses to audit-report.md", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
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
    await disableNarrative(artifactsDir);

    const ingested = JSON.parse(
      (
        await runDistCli(
          [
            "ingest-results",
            "--root",
            root,
            "--artifacts-dir",
            artifactsDir,
            "--batch-results",
            batchDir,
          ],
          { cwd: root },
        )
      ).stdout,
    );
    assert.equal(ingested.imported_files.length, 2);

    const presented = await nextStepUntilPresentReport(root);
    assert.equal(presented.status, "complete");
    assert.match(
      await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8"),
      /## Work Blocks/,
    );
  });
});
