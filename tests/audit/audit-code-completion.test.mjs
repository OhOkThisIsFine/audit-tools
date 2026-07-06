import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";
import { countLines } from "./helpers/countLines.mjs";

// Step contracts normalize host-facing paths to forward slashes (drift-plan R3).
const { toPromptPathToken } = await import("audit-tools/shared");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const distCliPath = join(repoRoot, "dist", "audit", "cli.js");

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
    if (step.step_kind === "provider_confirmation") {
      await writeFile(
        step.artifact_paths.provider_confirmation_input,
        JSON.stringify(
          { schema_version: "provider-confirmation-input/v1" },
          null,
          2,
        ) + "\n",
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
const MAX_FINALIZE_STEPS = 10;

async function nextStepUntilPresentReport(root, extraArgs = []) {
  for (let i = 0; i < MAX_FINALIZE_STEPS; i++) {
    const step = JSON.parse(
      (await runWrapper(["next-step", ...extraArgs], { cwd: root })).stdout,
    );
    if (step.step_kind === "present_report") {
      // Friction triage pending: the tool materialized the record and set status
      // "ready" so the host can add open_observations. Simulate the host adding
      // one observation, then loop so the next call emits status:"complete".
      if (step.status === "ready" && step.artifact_paths?.friction_record) {
        let record = {};
        try {
          record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8"));
        } catch { /* new record, start empty */ }
        record.category_attestations = [
          { category: "ambiguous_direction", note: "none this run" },
          { category: "tool_should_decide", note: "none this run" },
          { category: "inefficient_feeding", note: "none this run" },
        ];
        // promoteFinalAuditReport deletes artifactsDir; recreate the friction
        // subdir so the write and the subsequent next-step call both succeed.
        await mkdir(dirname(step.artifact_paths.friction_record), { recursive: true });
        await writeFile(step.artifact_paths.friction_record, JSON.stringify(record) + "\n");
        continue;
      }
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
    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    expect(tasks.length > 0).toBeTruthy();
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
    expect(ingested.selected_executor).toBe("result_ingestion_executor");

    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");

    // Completion promotes the machine contract and the human render to the
    // artifacts dir's parent (.audit-tools/).
    const auditReport = await readFile(
      join(root, ".audit-tools", "audit-report.md"),
      "utf8",
    );
    expect(auditReport).toMatch(/# Audit Report/);
    await access(join(root, ".audit-tools", "audit-findings.json"));

    // The audit working state is cleaned out (promotion removes the artifact
    // bundle); only the present_report step scaffolding remains so the host
    // can read and follow `prompt_path`.
    await assert.rejects(
      () => access(join(artifactsDir, "audit_tasks.json")),
      /ENOENT/i,
    );
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
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

    // Drive next-step repeatedly while finalization is still in flight. The
    // invariant: once the report is rendered, the terminal must present it
    // (present_report) — it must never surface a completed audit as `blocked`,
    // whether the fold reaches completion in one call or stops at the cycle
    // terminal. (The fold now runs to completion per call via the shared
    // `advance` engine; the loop tolerates either a direct present_report or an
    // interim blocked step with no report yet.)
    let presented = null;
    for (let i = 0; i < 15 && !presented; i++) {
      const step = JSON.parse(
        (await runWrapper(["next-step"], { cwd: root })).stdout,
      );
      if (step.step_kind === "present_report") {
        // Friction triage pending: seed an observation and loop so next call
        // returns status:"complete".
        if (step.status === "ready" && step.artifact_paths?.friction_record) {
          let record = {};
          try { record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8")); } catch { /* new */ }
          record.category_attestations = [{ category: "ambiguous_direction" }, { category: "tool_should_decide" }, { category: "inefficient_feeding" }];
          await mkdir(dirname(step.artifact_paths.friction_record), { recursive: true });
          await writeFile(step.artifact_paths.friction_record, JSON.stringify(record) + "\n");
          continue;
        }
        presented = step;
        break;
      }
      expect(step.step_kind, `expected only blocked/present_report while finalizing, got ${step.step_kind}`).toBe("blocked");
      expect(await reportExists(), "a rendered report must be presented, never surfaced as a run-limit block").toBe(false);
    }

    expect(presented, "next-step must reach present_report").toBeTruthy();
    expect(presented.status).toBe("complete");
    // Completion promotes the canonical report to .audit-tools/ (parent of the
    // artifacts dir). The step contract normalizes the path to forward slashes.
    expect(presented.artifact_paths.final_report).toBe(toPromptPathToken(join(root, ".audit-tools", "audit-report.md")));
    expect(await readFile(presented.artifact_paths.final_report, "utf8")).toMatch(/# Audit Report/);
    // The audit working state is cleaned out (promotion removes the artifact
    // bundle), but next-step still leaves the present_report step scaffolding so
    // the host can read and follow `prompt_path`. Assert the working artifacts
    // are gone while the prompt the host must follow remains readable.
    expect(await access(join(artifactsDir, "audit_tasks.json"))
        .then(() => true)
        .catch(() => false), "audit working artifacts must be cleaned on completion").toBe(false);
    expect(await readFile(presented.prompt_path, "utf8")).toMatch(/present report/i);
  });
});

test("force-synthesis strands a wedged task, stamps an operator_forced terminal, and drives synthesis from the partial ledger", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    expect(tasks.length >= 2, "need >=2 tasks so one can stay pending").toBeTruthy();
    await disableNarrative(artifactsDir);

    // Ingest results for ALL BUT the last task → the last stays pending, wedging
    // the run on `audit_tasks_completed` (it can never reach present_report on its
    // own; that's the recovery scenario force-synthesis exists for).
    const partial = tasks.slice(0, -1);
    const pendingTask = tasks[tasks.length - 1];
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(partial, root), null, 2),
    );
    await runDistCli(
      ["ingest-results", "--root", root, "--artifacts-dir", artifactsDir, "--results", resultsPath],
      { cwd: root },
    );

    const forced = JSON.parse(
      (
        await runDistCli(
          ["force-synthesis", "--root", root, "--artifacts-dir", artifactsDir],
          { cwd: root },
        )
      ).stdout,
    );
    expect(forced.selected_executor).toBe("synthesis_executor");
    expect(forced.forced_stranded_task_ids, "the pending task is stranded").toContain(
      pendingTask.task_id,
    );
    expect(forced.newly_stranded_count >= 1).toBeTruthy();

    // The terminal is stamped DURABLY on active-dispatch.json (a special-loaded
    // artifact) — this run had none (host-subagent path never wrote one), so the
    // absent-active_dispatch branch minted a minimal state carrying the terminal.
    const active = JSON.parse(
      await readFile(join(artifactsDir, "active-dispatch.json"), "utf8"),
    );
    expect(active.partial_completion_terminal.reason).toBe("operator_forced");
    expect(active.partial_completion_terminal.stranded_ids).toContain(pendingTask.task_id);

    // The run is now unblocked: next-step reaches present_report on partial
    // coverage and promotes the report rendered from the intact ledger.
    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");
    expect(
      await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8"),
    ).toMatch(/# Audit Report/);
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
    // Batch files must use the canonical "<stem>_<12-hex>.json" result naming
    // so they are admitted by the canonical-filename filter (stray sidecars are
    // ignored). The 12-hex digest stands in for a real artifact digest.
    await writeFile(
      join(batchDir, "result-01_0123456789ab.json"),
      JSON.stringify(allResults.slice(0, Math.ceil(allResults.length / 2)), null, 2),
    );
    await writeFile(
      join(batchDir, "result-02_cdef01234567.json"),
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
    expect(ingested.imported_files.length).toBe(2);

    const presented = await nextStepUntilPresentReport(root);
    expect(presented.status).toBe("complete");
    expect(await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8")).toMatch(/## Work Blocks/);
  });
});
