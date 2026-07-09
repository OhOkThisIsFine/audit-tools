import { test, expect } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  stat,
  writeFile,
  readFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";
import { AuditCodeResponseSchema } from "../../src/audit/contracts/wrapperResponse.ts";
import {
  shouldBuildDistForPaths,
  assertWorkspaceInstalled,
} from "../../wrapper/audit-code-wrapper-lib.mjs";
import {
  shouldBuildDistForPaths as shouldBuildDistForPathsDirect,
  assertWorkspaceInstalled as assertWorkspaceInstalledDirect,
} from "../../wrapper/audit-code-wrapper-build.mjs";
import {
  INSTALL_HOST_DEFINITIONS,
  INSTALL_HOST_ORDER,
  getInstallHostKeys,
  getInstallProfile,
  _INSTALL_HOST_ORDER,
  _INSTALL_HOST_DEFINITIONS,
  _getInstallHostKeys,
  _getInstallProfile,
} from "../../wrapper/audit-code-wrapper-install-hosts.mjs";
import {
  assertOpenCodeAuditPermissionConfig,
  buildMergedOpenCodeProjectConfig,
  OPENCODE_AUDIT_BASH_PERMISSION,
  OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION,
  renderOpenCodePermissionConfig,
} from "../../wrapper/audit-code-wrapper-opencode.mjs";
const { isCanonicalResultFilename } = await import("../../src/audit/cli/args.ts");
// Step contracts normalize host-facing paths to forward slashes (drift-plan
// R3); compare step path fields against the normalized form so the assertions
// hold on Windows as well as Linux CI.
const { toPromptPathToken } = await import("audit-tools/shared");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const packageJsonPath = join(repoRoot, "package.json");
function assertMatchesResponseSchema(value, label) {
  const result = AuditCodeResponseSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditCodeResponseSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
}
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;

function spawnWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  const stdoutRef = { value: "" };
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [wrapperPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: cleanEnv,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.input !== undefined) {
    child.stdin.end(options.input);
  }
  child.stdout.on("data", (chunk) => {
    stdoutRef.value += String(chunk);
    options.onStdoutChunk?.(stdoutRef.value);
  });
  child.stderr.on("data", (chunk) => {
    stdoutRef; // keep ref in scope; only stderr is updated here
    stderrRef.value += String(chunk);
  });
  child.on("error", (error) => options.onError?.(error));
  return { child, stdoutRef, stderrRef };
}

function runWrapper(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { child, stdoutRef, stderrRef } = spawnWrapper(args, {
      ...options,
      onError: reject,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutRef.value, stderr: stderrRef.value });
        return;
      }
      reject(
        new Error(
          stderrRef.value || stdoutRef.value || `wrapper exited with ${code}`,
        ),
      );
    });
  });
}

function runWrapperJsonOutput(args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          stderrRef.value || stdoutRef.value || "wrapper JSON output timed out",
        ),
      );
    }, options.timeoutMs ?? 30_000);

    function settle(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        complete();
        return;
      }
      child.once("exit", complete);
      child.kill();
    }

    const { child, stdoutRef, stderrRef } = spawnWrapper(args, {
      ...options,
      onStdoutChunk: (accumulated) => {
        try {
          const parsed = JSON.parse(accumulated);
          settle(null, { stdout: accumulated, stderr: stderrRef.value, parsed });
        } catch {
          // Wait until the wrapper has emitted a complete JSON object.
        }
      },
      onError: (error) => settle(error),
    });

    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) {
        try {
          settle(null, {
            stdout: stdoutRef.value,
            stderr: stderrRef.value,
            parsed: JSON.parse(stdoutRef.value),
          });
        } catch {
          settle(
            new Error(
              stderrRef.value || stdoutRef.value || "wrapper exited without JSON",
            ),
          );
        }
        return;
      }
      settle(
        new Error(
          stderrRef.value || stdoutRef.value || `wrapper exited with ${code}`,
        ),
      );
    });
  });
}

function assertOpenCodeAuditPermissions(config) {
  expect(config.permission?.read).toBe("allow");
  expect(config.permission?.glob).toBe("allow");
  expect(config.permission?.grep).toBe("allow");
  expect(typeof config.permission?.external_directory).toBe("object");
  expect(config.permission?.edit?.[".audit-code/**"]).toBe("allow");
  expect(config.permission?.edit?.[".audit-tools/**"]).toBe("allow");
  expect(config.permission?.bash?.["audit-code"]).toBe("allow");
  expect(config.permission?.bash?.["audit-code ensure*"]).toBe("allow");
  expect(config.permission?.bash?.["audit-code next-step*"]).toBe("allow");
  expect(config.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
  expect(config.permission?.bash?.["audit-code cleanup*"]).toBe("deny");
  expect(config.permission?.bash?.["audit-code requeue*"]).toBe("deny");
  expect(config.permission?.bash?.["audit-code ingest-results*"]).toBe("deny");
  expect(config.permission?.bash?.["*audit-code.mjs* submit-packet*"]).toBe("allow");
  expect(config.permission?.bash?.["*audit-code.mjs* worker-run*"]).toBe("allow");
  expect(config.permission?.bash?.["*audit-code.mjs* synthesize*"]).toBe("deny");
  expect(config.permission?.bash?.["Select-String *"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.read).toBe("allow");
  expect(config.agent?.auditor?.permission?.glob).toBe("allow");
  expect(config.agent?.auditor?.permission?.grep).toBe("allow");
  expect(typeof config.agent?.auditor?.permission?.external_directory).toBe("object");
  expect(config.agent?.auditor?.permission?.edit?.[".audit-tools/**"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["audit-code next-step*"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["*audit-code.mjs* merge-and-ingest*"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-wrapper-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
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
    await mkdir(join(root, ".audit-tools/audit"), { recursive: true });
    await writeFile(
      join(root, ".audit-tools/audit", "session-config.json"),
      JSON.stringify(
        {
          provider: "worker-command",
          // Skip-all analyzer policy so the deterministic-frontier drain is
          // reproducible regardless of the host analyzer cache. Under the default
          // `auto` policy, an optional analyzer dependency that is absent from the
          // cache (typescript for the .ts fixtures) owes an analyzer-install
          // CONSENT decision — a genuine fold-level host-input pause the default
          // drain correctly halts at (graph_enrichment_executor, CP-NODE-7). That
          // makes the drain's stopping point cache-dependent (dev-with-cache
          // reaches structure decomposition; clean CI pauses at structure). `skip`
          // resolves every analyzer to `skip` (not `absent`+`auto`), so no consent
          // is owed and the drain reaches structure decomposition everywhere.
          analyzers: {
            typescript: "skip",
            python: "skip",
            html: "skip",
            css: "skip",
            sql: "skip",
          },
        },
        null,
        2,
      ) + "\n",
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function validAuditResultForTask(task, overrides = {}) {
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts?.[path] ?? 0,
    })),
    findings: [],
    ...overrides,
  };
}

// Pause step kinds that next-step can emit before review dispatch is ready
// (analyzer install decision, intent confirmation, design review passes,
// optional edge reasoning), each at most once; allow extra headroom.
const MAX_PRE_DISPATCH_PAUSES = 8;

// Drive `next-step` past the host pause steps that precede review dispatch by
// answering each pause headlessly (skip analyzer installs, confirm the default
// scope, submit empty design-review findings). Returns the first
// dispatch-ready step (dispatch_review or single_task_fallback).
async function startDispatchRun(root) {
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
      `startDispatchRun: unexpected step kind '${step.step_kind}' (iteration ${i})`,
    );
  }
  throw new Error("next-step did not reach a dispatch-ready step");
}

async function setupDispatchFixture(root) {
  const step = await startDispatchRun(root);
  const runId = step.run_id;
  const artifactsDir = step.artifacts_dir;

  expect(runId).toBeTruthy();
  expect(artifactsDir).toBeTruthy();

  await runWrapper(
    ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
    { cwd: root },
  );

  const runDir = join(artifactsDir, "runs", runId);
  const tasks = JSON.parse(
    await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
  );
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const plan = JSON.parse(
    await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
  );
  const resultMap = JSON.parse(
    await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
  );

  return { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap };
}

async function setupMergeFixture(root) {
  return setupDispatchFixture(root);
}

async function submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById) {
  for (const packet of plan) {
    const packetResults = resultMap.entries
      .filter((item) => item.packet_id === packet.packet_id)
      .map((entry) => validAuditResultForTask(taskById.get(entry.task_id)));
    await runWrapper(
      ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
      { cwd: root, input: JSON.stringify(packetResults) },
    );
  }
}

async function setupSubmitPacketFixture(root) {
  const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
    await setupDispatchFixture(root);

  const packet = plan.find(
    (candidate) =>
      resultMap.entries.filter((entry) => entry.packet_id === candidate.packet_id)
        .length >= 2,
  );
  expect(packet, "expected a dispatch packet with at least two tasks").toBeTruthy();
  const entries = resultMap.entries.filter(
    (entry) => entry.packet_id === packet.packet_id,
  );
  const packetTasks = entries.map((entry) => taskById.get(entry.task_id));
  expect(packetTasks.every(Boolean), "expected task metadata for every packet entry").toBe(true);

  return { runId, artifactsDir, packet, entries, packetTasks, tasks };
}

async function assertPacketResultFilesMissing(entries) {
  for (const entry of entries) {
    await assert.rejects(() => stat(entry.result_path));
  }
}

function repoLocalHostInstallPaths(root) {
  return {
    installedPromptPath: join(root, ".audit-code", "install", "audit-code.import.md"),
    legacyInstalledPromptPath: join(root, ".audit-code", "install", "audit-code.prompt.md"),
    installGuidePath: join(root, ".audit-code", "install", "GETTING-STARTED.md"),
    installManifestPath: join(root, ".audit-code", "install", "manifest.json"),
    vscodePromptPath: join(root, ".github", "prompts", "audit-code.prompt.md"),
    vscodeAgentPath: join(root, ".github", "agents", "auditor.agent.md"),
    opencodeConfigPath: join(root, "opencode.json"),
    legacyOpenCodeCommandPath: join(root, ".opencode", "commands", "audit-code.md"),
    legacyCodexSkillPath: join(root, ".codex", "skills", "audit-code", "SKILL.md"),
    legacyCodexPromptPath: join(root, ".codex", "skills", "audit-code", "audit-code.prompt.md"),
    agentsPath: join(root, "AGENTS.md"),
    copilotInstructionsPath: join(root, ".github", "copilot-instructions.md"),
    antigravityPlanningGuidePath: join(root, ".audit-code", "install", "antigravity", "PLANNING-MODE.md"),
    geminiCommandPath: join(root, ".gemini", "commands", "audit-code.toml"),
    antigravitySkillPath: join(root, ".agent", "skills", "audit-code", "SKILL.md"),
  };
}

function hostGuidance(parsed, host) {
  const guidance = parsed.host_guidance.find((entry) => entry.host === host);
  expect(guidance, `expected guidance for ${host}`).toBeTruthy();
  return guidance;
}

async function setupRepoLocalHostInstallFixture(root) {
  const paths = repoLocalHostInstallPaths(root);
  await mkdir(dirname(paths.legacyInstalledPromptPath), { recursive: true });
  await writeFile(paths.legacyInstalledPromptPath, "legacy prompt\n");

  const parsed = JSON.parse((await runWrapper(["install"], { cwd: root })).stdout);

  return { parsed, paths };
}

function assertSharedHostInstallResponse(parsed, root, paths) {
  expect(parsed.host).toBe("all");
  expect(parsed.repo_root).toBe(root);
  expect(parsed.installed_prompt_path).toBe(paths.installedPromptPath);
  expect(parsed.install_guide_path).toBe(paths.installGuidePath);
  expect(parsed.install_manifest_path).toBe(paths.installManifestPath);
  // The MCP surface was removed: install no longer emits an MCP server launcher.
  expect(parsed.mcp_server_launcher_path).toBe(undefined);
  expect(parsed.slash_command_surfaces.vscode_prompt).toBe(paths.vscodePromptPath);
  expect(parsed.slash_command_surfaces.opencode_config).toBe(paths.opencodeConfigPath);
  expect(parsed.instruction_surfaces.agents).toBe(paths.agentsPath);
  expect(parsed.instruction_surfaces.copilot_instructions).toBe(paths.copilotInstructionsPath);
  expect(parsed.host_guidance.length).toBe(4);
  expect(parsed.host_guidance.map((entry) => entry.host)).toEqual(["codex", "opencode", "vscode", "antigravity"]);
  expect(parsed.unsupported_hosts.length).toBe(0);
}

test.concurrent("audit-code wrapper advance-audit drains the deterministic regen frontier to the first host-input pause and prints the execution envelope", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    // advance-audit now SAFELY DRAINS the consecutive deterministic regen frontier
    // in one call (the fold-aware drain is the default): the provider gate
    // auto-completes headlessly, then intake → auto-fix → syntax → analyzer
    // acquisition → structure → graph enrichment → design assessment → structure
    // decomposition all run, halting at the intent_checkpoint host-input boundary.
    const { stdout: stdout0 } = await runWrapper(["advance-audit"], { cwd: root });
    const step0 = JSON.parse(stdout0);

    const info = await stat(artifactsDir);
    expect(info.isDirectory()).toBe(true);
    assertMatchesResponseSchema(step0, "auditCodeResponse");
    expect(step0.contract_version).toBe("audit-code/v1alpha1");
    // The drain resolved the whole deterministic frontier and stopped at the first
    // host-input pause (the intent checkpoint), so the last executor it ran is the
    // final deterministic step and the next step it hands back is a host boundary.
    expect(step0.selected_executor).toBe("structure_decomposition_executor");
    expect(step0.progress_made).toBe(true);
    expect(step0.next_likely_step).toBe("intent_checkpoint_current");
    expect(step0.handoff.status).toBe("active");
    // Every deterministic artifact across the drained frontier is present + the
    // artifact directory is reused (stable) — not one-executor-per-invocation.
    expect(step0.artifacts_written.includes("repo_manifest.json")).toBe(true);
    expect(step0.artifacts_written.includes("graph_bundle.json")).toBe(true);
    expect(step0.artifacts_written.includes("structure_decomposition.json")).toBe(true);

    // A second advance from the same artifact directory continues past the intent
    // checkpoint (auto-completed headlessly) and drains onward, still making
    // progress against the same stable artifact dir.
    const { stdout: stdout1 } = await runWrapper(["advance-audit"], { cwd: root });
    const step1 = JSON.parse(stdout1);

    assertMatchesResponseSchema(step1, "auditCodeResponse");
    expect(step1.progress_made).toBe(true);
    expect(step1.handoff.status).toBe("active");
    expect(step1.handoff.suggested_commands.length).toBe(0);
  });
});

test.concurrent("audit-code wrapper can explain a resolved task id", async () => {
  await withTempRepo(async (root) => {
    await startDispatchRun(root);
    const tasks = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "audit_tasks.json"), "utf8"),
    );
    const taskId = tasks[0].task_id;

    const explained = JSON.parse(
      (await runWrapper(["explain-task", taskId], { cwd: root })).stdout,
    );

    expect(explained.task_id).toBe(taskId);
    expect(Array.isArray(explained.coverage_entries)).toBeTruthy();
    expect(explained.coverage_entries.length > 0).toBeTruthy();
  });
});

test.concurrent("next-step reaches a ready review dispatch step from repo root under worker-command", async () => {
  await withTempRepo(async (root) => {
    const step = await startDispatchRun(root);

    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");
    expect(step.step_kind).toMatch(/^(dispatch_review|single_task_fallback)$/);
    expect(step.run_id).toBeTruthy();
    expect(step.repo_root).toBe(toPromptPathToken(root));
    expect(step.artifacts_dir).toBe(toPromptPathToken(join(root, ".audit-tools/audit")));

    // The printed contract matches the persisted current-step.json, so the host
    // can act on steps/current-step.json without a second next-step round-trip.
    const currentStep = JSON.parse(
      await readFile(
        join(root, ".audit-tools/audit", "steps", "current-step.json"),
        "utf8",
      ),
    );
    expect(currentStep.step_kind).toBe(step.step_kind);
    expect(currentStep.run_id).toBe(step.run_id);

    // The dispatch run covers every planned audit task.
    const allAuditTasks = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "audit_tasks.json"), "utf8"),
    );
    expect(allAuditTasks.length > 0).toBeTruthy();
    const pendingRunTasks = JSON.parse(
      await readFile(
        join(root, ".audit-tools/audit", "runs", step.run_id, "pending-audit-tasks.json"),
        "utf8",
      ),
    );
    expect(pendingRunTasks.length).toBe(allAuditTasks.length);

    // The step prompt is the host's sole instruction surface.
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/merge-and-ingest|exactly one AuditResult/i);
  });
});

test.concurrent("merge-and-ingest blocks when assigned task results are missing", async () => {
  await withTempRepo(async (root) => {
    const step = await startDispatchRun(root);
    const runId = step.run_id;
    const artifactsDir = step.artifacts_dir;

    expect(runId).toBeTruthy();
    expect(artifactsDir).toBeTruthy();

    await runWrapper(
      ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );

    await assert.rejects(
      runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      ),
      /missing or invalid|blocked before ingestion/i,
    );
  });
});

test.concurrent("merge-and-ingest accepts packet task result files as the legacy result array", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    const merge = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const mergeSummary = JSON.parse(merge.stdout);
    expect(mergeSummary.status).toBe("completed");
    expect(mergeSummary.accepted_count).toBe(tasks.length);
    expect(mergeSummary.rejected_count).toBe(0);
    expect(mergeSummary.finding_count).toBe(0);
    expect(mergeSummary.selected_executor).toBe("result_ingestion_executor");
    expect("next_likely_step" in mergeSummary).toBeTruthy();

    const merged = JSON.parse(
      await readFile(join(runDir, "run-results.json"), "utf8"),
    );
    expect(merged.map((result) => result.task_id).sort()).toEqual(tasks.map((task) => task.task_id).sort());
    // Structured observability logs (e.g. selectiveDeepening strategy_summary) are
    // emitted to stderr at info level; only reject lines that indicate actual errors.
    const stderrLines = merge.stderr.split("\n").filter((l) => l.trim());
    for (const line of stderrLines) {
      try {
        const parsed = JSON.parse(line);
        expect(parsed.level, `Unexpected error-level stderr: ${line}`).not.toBe("error");
      } catch {
        assert.fail(`Unexpected non-JSON stderr from merge-and-ingest: ${line}`);
      }
    }
  });
});

test.concurrent("merge-and-ingest is idempotent on re-run and never truncates results", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    const first = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    expect(JSON.parse(first.stdout).status).toBe("completed");
    const resultsPath = join(runDir, "run-results.json");
    const mergedAfterFirst = await readFile(resultsPath, "utf8");

    // A fully-merged run advances to the next round, which rewrites this run
    // dir's pending-audit-tasks.json to the *next* round's tasks. A stray
    // re-invocation must be a clean no-op (exit 0, replayed summary) and must
    // NOT truncate the transient results file to an empty array.
    const second = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const replaySummary = JSON.parse(second.stdout);
    expect(replaySummary.idempotent_replay).toBe(true);
    expect(replaySummary.status).toBe("completed");
    expect(replaySummary.accepted_count).toBe(tasks.length);
    expect(await readFile(resultsPath, "utf8"), "the second merge must not rewrite the transient results file").toBe(mergedAfterFirst);
  });
});

test.concurrent("merge-and-ingest self-heals a stale completion marker by re-ingesting a stranded on-disk result", async () => {
  await withTempRepo(async (root) => {
    const fileExists = async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    };
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;
    const runDir = join(artifactsDir, "runs", runId);
    const pendingPath = join(runDir, "pending-audit-tasks.json");
    const resultMapPath = join(runDir, "dispatch-result-map.json");
    const markerPath = join(runDir, "merge-complete.json");

    await runWrapper(
      ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const tasks = JSON.parse(await readFile(pendingPath, "utf8"));
    const taskById = new Map(tasks.map((task) => [task.task_id, task]));
    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    const resultMap = JSON.parse(await readFile(resultMapPath, "utf8"));
    for (const packet of plan) {
      const packetResults = resultMap.entries
        .filter((item) => item.packet_id === packet.packet_id)
        .map((entry) => validAuditResultForTask(taskById.get(entry.task_id)));
      await runWrapper(
        ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
        { cwd: root, input: JSON.stringify(packetResults) },
      );
    }
    const first = JSON.parse(
      (await runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      )).stdout,
    );
    expect(first.status).toBe("completed");
    expect(await fileExists(markerPath), "a fully-merged round writes the completion marker").toBeTruthy();

    // Reproduce the no-progress-loop precondition: selective deepening re-derives
    // follow-up tasks onto the SAME run-id, so an already-answered task is
    // re-listed as pending while its result file is still on disk, and a 0-packet
    // re-plan blanks the dispatch result map. Without the stale-marker guard the
    // next merge replays idempotently and strands that answer forever.
    const victim = tasks[0];
    const victimEntry = resultMap.entries.find((e) => e.task_id === victim.task_id);
    expect(victimEntry, "victim task was dispatched in round 1").toBeTruthy();
    expect(await fileExists(victimEntry.result_path), "victim's answer is on disk").toBeTruthy();
    await writeFile(pendingPath, JSON.stringify([victim], null, 2));
    await writeFile(
      resultMapPath,
      JSON.stringify({ ...resultMap, entries: [] }, null, 2),
    );
    expect(await fileExists(markerPath), "the completion marker persists into the stuck state").toBeTruthy();

    const reheal = JSON.parse(
      (await runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      )).stdout,
    );
    expect(reheal.idempotent_replay, "a stale completion marker must re-process, not replay").not.toBe(true);
    expect(reheal.accepted_count >= 1, "the stranded on-disk result is recovered by task_id and ingested").toBeTruthy();
  });
});

test.concurrent("all packets dispatched in one round, merge ingests everything", async () => {
  await withTempRepo(async (root) => {
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;
    expect(runId).toBeTruthy();
    expect(artifactsDir).toBeTruthy();
    await runWrapper(
      ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const runDir = join(artifactsDir, "runs", runId);

    // Submit every packet currently in the plan (reads the live result map).
    async function submitPlannedPackets() {
      const tasks = JSON.parse(
        await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
      );
      const taskById = new Map(tasks.map((task) => [task.task_id, task]));
      const plan = JSON.parse(
        await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
      );
      const resultMap = JSON.parse(
        await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
      );
      for (const packet of plan) {
        const packetResults = resultMap.entries
          .filter((item) => item.packet_id === packet.packet_id)
          .map((entry) => validAuditResultForTask(taskById.get(entry.task_id)));
        await runWrapper(
          ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
          { cwd: root, input: JSON.stringify(packetResults) },
        );
      }
      return plan;
    }

    // All packets dispatch in one round.
    const active = JSON.parse(
      await readFile(join(artifactsDir, "active-dispatch.json"), "utf8"),
    );
    expect(active.packet_count >= 1).toBeTruthy();
    await submitPlannedPackets();

    // Merge ingests everything, no tasks held back.
    const mergeResult = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const summary = JSON.parse(mergeResult.stdout);
    expect(summary.rejected_count).toBe(0);
    expect(summary.not_dispatched_count, "no tasks held back").toBe(0);
    expect(summary.accepted_count >= 1).toBeTruthy();
  });
});

test.concurrent("submit-packet rejects duplicate task result ids", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks } =
      await setupSubmitPacketFixture(root);
    const [firstTask] = packetTasks;
    const packetResults = [
      validAuditResultForTask(firstTask),
      validAuditResultForTask(firstTask),
    ];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /Duplicate audit result for assigned task/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("submit-packet rejects task results outside the packet", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks, tasks } =
      await setupSubmitPacketFixture(root);
    const outsideTask = tasks.find(
      (task) => !entries.some((entry) => entry.task_id === task.task_id),
    );
    expect(outsideTask, "expected a task outside the selected packet").toBeTruthy();
    const packetResults = [
      validAuditResultForTask(packetTasks[0]),
      validAuditResultForTask(outsideTask),
    ];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /not assigned to packet/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("submit-packet rejects missing assigned task results", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks } =
      await setupSubmitPacketFixture(root);
    const packetResults = [validAuditResultForTask(packetTasks[0])];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /Missing audit result for assigned task/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("merge-and-ingest proceeds despite unexpected files in task-results/", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    // Write a spurious file into task-results/ as a subagent might do
    const taskResultsDir = join(runDir, "task-results");
    await writeFile(
      join(taskResultsDir, "packet_spurious_results.json"),
      JSON.stringify({ unexpected: true }),
    );

    const merge = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const mergeSummary = JSON.parse(merge.stdout);
    expect(mergeSummary.status).toBe("completed");
    expect(mergeSummary.accepted_count).toBe(tasks.length);
    expect(mergeSummary.rejected_count).toBe(0);
    expect(mergeSummary.spurious_file_count).toBe(1);
    expect(merge.stderr).toMatch(/unexpected file.*packet_spurious_results\.json/i);
  });
});

test.concurrent("isCanonicalResultFilename separates canonical results from stray files", () => {
  // Canonical per-task result name: <stem>_<12-hex digest>.json (artifactNameForId).
  expect(isCanonicalResultFilename("unit_foo_0123456789ab.json")).toBe(true);
  expect(isCanonicalResultFilename("lens_security_packet-1_a1b2c3d4e5f6.json")).toBe(true);
  // Stray files a subagent might leave — no _<12hex> suffix, so a prior round's
  // canonical results never inflate spurious_file_count while these still do.
  expect(isCanonicalResultFilename("packet-23-results.json")).toBe(false);
  expect(isCanonicalResultFilename("packet_spurious_results.json")).toBe(false);
  expect(isCanonicalResultFilename("tmp-packet-87-result.json")).toBe(false);
  expect(isCanonicalResultFilename("audit_result_packet1.json")).toBe(false);
});

test.concurrent("merge-and-ingest rejects swapped task result files", async () => {
  await withTempRepo(async (root) => {
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;

    expect(runId).toBeTruthy();
    expect(artifactsDir).toBeTruthy();

    await runWrapper(
      ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );

    const runDir = join(artifactsDir, "runs", runId);
    const tasks = JSON.parse(
      await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
    );
    expect(tasks.length >= 2).toBeTruthy();
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    const entryByTaskId = new Map(
      resultMap.entries.map((entry) => [entry.task_id, entry]),
    );
    const [first, second] = tasks;

    await writeFile(
      entryByTaskId.get(first.task_id).result_path,
      JSON.stringify(validAuditResultForTask(second), null, 2) + "\n",
    );
    await writeFile(
      entryByTaskId.get(second.task_id).result_path,
      JSON.stringify(validAuditResultForTask(first), null, 2) + "\n",
    );

    await assert.rejects(
      runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      ),
      /assigned to|blocked before ingestion/i,
    );
  });
});

test.concurrent("wrapper build freshness ignores package metadata churn when dist is newer than source inputs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-build-freshness-"));
  try {
    const sourceDir = join(tempDir, "src");
    const distDir = join(tempDir, "dist");
    const tsconfigFile = join(tempDir, "tsconfig.json");
    const sourceFile = join(sourceDir, "index.ts");
    const distFile = join(distDir, "index.js");
    const packageJsonFile = join(tempDir, "package.json");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(sourceFile, "export const value = 1;\n");
    await writeFile(tsconfigFile, "{\n  \"compilerOptions\": {\"outDir\": \"dist\"}\n}\n");
    await writeFile(distFile, "export const value = 1;\n");
    await writeFile(packageJsonFile, "{\n  \"name\": \"fixture\"\n}\n");

    const sourceTime = new Date("2026-04-23T14:00:00.000Z");
    const distTime = new Date("2026-04-23T14:05:00.000Z");
    const packageTime = new Date("2026-04-23T14:10:00.000Z");
    await utimes(sourceDir, sourceTime, sourceTime);
    await utimes(sourceFile, sourceTime, sourceTime);
    await utimes(tsconfigFile, sourceTime, sourceTime);
    await utimes(distDir, distTime, distTime);
    await utimes(distFile, distTime, distTime);
    await utimes(packageJsonFile, packageTime, packageTime);

    const shouldBuild = await shouldBuildDistForPaths({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });

    expect(shouldBuild).toBe(false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("assertWorkspaceInstalled flags missing or foreign audit-tools/shared", () => {
  const checkoutRoot = join(here, "fixture-checkout");

  // Not resolvable at all → dependencies were never installed.
  assert.throws(
    () => assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath: null }),
    /Dependencies are not installed/,
  );

  // Resolves into a *different* checkout — the fresh-git-worktree trap.
  assert.throws(
    () =>
      assertWorkspaceInstalled({
        checkoutRoot,
        sharedManifestPath: join(
          here,
          "other-checkout",
          "node_modules",
          "@audit-tools",
          "shared",
          "package.json",
        ),
      }),
    /outside this checkout/,
  );

  // Resolves inside this checkout → installed correctly, no throw.
  assert.doesNotThrow(() =>
    assertWorkspaceInstalled({
      checkoutRoot,
      sharedManifestPath: join(
        checkoutRoot,
        "node_modules",
        "@audit-tools",
        "shared",
        "package.json",
      ),
    }),
  );
});

test.concurrent("audit-code wrapper prints help text", async () => {
  const { stdout } = await runWrapper(["--help"]);
  expect(stdout.includes("Usage: node audit-code.mjs <command>")).toBeTruthy();
  expect(stdout.includes("Primary usage (conversation-first):")).toBeTruthy();
  expect(stdout.includes("next-step advances deterministic audit state")).toBeTruthy();
  expect(stdout.includes("advance-audit runs exactly one deterministic advance")).toBeTruthy();
  expect(stdout.includes("explain-task <task_id>")).toBeTruthy();
  expect(stdout.includes("ensure lazily bootstraps repo-local")).toBeTruthy();
  expect(stdout.includes("install bootstraps /audit-code")).toBeTruthy();
  expect(stdout.includes("install-host --host copilot")).toBeTruthy();
  // The batch loop and its flags are gone from the product surface.
  expect(!stdout.includes("--single-step")).toBeTruthy();
  expect(!stdout.includes("run-to-completion")).toBeTruthy();
});

test.concurrent("audit-code wrapper bare invocation prints help and exits 0 without starting an audit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-bare-help-"));
  try {
    const { stdout } = await runWrapper([], { cwd: tempDir });
    expect(stdout.includes("Usage: node audit-code.mjs <command>")).toBeTruthy();
    expect(stdout.includes("next-step advances deterministic audit state")).toBeTruthy();
    // The help path must not create audit state.
    await assert.rejects(() => stat(join(tempDir, ".audit-tools")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper rejects unknown commands with exit 1 and authoritative guidance", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-unknown-cmd-"));
  try {
    const { child, stderrRef } = spawnWrapper(["definitely-not-a-command"], {
      cwd: tempDir,
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(code).toBe(1);
    // The wrapper forwards every non-special command to the dist CLI, so an
    // unknown command surfaces dist's authoritative error + available-commands
    // list (the single source of truth), not a wrapper-local message that can
    // drift from the real command set.
    expect(stderrRef.value).toMatch(/Unknown command: definitely-not-a-command/);
    expect(stderrRef.value).toMatch(/Available commands:/);
    // The failure path must not create audit state.
    await assert.rejects(() => stat(join(tempDir, ".audit-tools")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper forwards any dist command through the passthrough (no per-command branch)", async () => {
  // Drift guard: a command that has NO explicit wrapper branch (here `status`,
  // which was cli.ts-only and historically unreachable through the packaged bin
  // — the same class of gap as the `cleanup` regression) must still reach the
  // dist CLI via the passthrough default, never fall through to an
  // unknown-command failure. This is what makes wrapper/CLI parity structural
  // rather than a hand-maintained dispatch table.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-passthrough-"));
  try {
    const { child, stderrRef } = spawnWrapper(["status"], { cwd: tempDir });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(stderrRef.value).not.toMatch(/Unknown command: status/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper routes `cleanup` to the dist command (not an unknown-command failure)", async () => {
  // Regression: `cleanup` had a full case in src/audit/cli.ts but was never wired
  // into the wrapper dispatch table, so the documented `audit-code cleanup` was
  // unreachable through the packaged bin (fell through to "Unknown command").
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cleanup-"));
  try {
    const { child, stdoutRef, stderrRef } = spawnWrapper(["cleanup", "--dry-run"], {
      cwd: tempDir,
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    // The dispatch table recognizes it: no "Unknown command: cleanup".
    expect(stderrRef.value).not.toMatch(/Unknown command: cleanup/);
    // It reaches the real cleanup executor, which emits its structured result.
    expect(stdoutRef.value).toMatch(/"artifacts_dir"/);
    expect(stdoutRef.value).toMatch(/"dry_run":\s*true/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper prints package version", async () => {
  const { stdout } = await runWrapper(["--version"]);
  expect(stdout.trim()).toBe(packageVersion);
});

test.concurrent("audit-code wrapper prints the canonical prompt asset path", async () => {
  const { stdout } = await runWrapper(["prompt-path"]);
  const promptPath = stdout.trim();

  expect(promptPath.length > 0).toBeTruthy();
  expect(promptPath.replaceAll("\\", "/")).toMatch(/skills\/audit-code\/audit-code\.prompt\.md$/);

  const info = await stat(promptPath);
  expect(info.isFile()).toBe(true);
});

test.concurrent("slash prompt is a tiny next-step loader without dispatch branches", async () => {
  const prompt = await readFile(
    join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
    "utf8",
  );

  expect(prompt).toMatch(/audit-code ensure --quiet/);
  expect(prompt).toMatch(/audit-code next-step/);
  expect(prompt).toMatch(/follow only.*prompt_path/is);
  expect(prompt).not.toMatch(/prepare-dispatch/);
  expect(prompt).not.toMatch(/single-task fallback/i);
  expect(prompt).not.toMatch(/Step 2/i);
});

test.concurrent("audit-code ensure lazily bootstraps and refreshes repo-local host assets", async () => {
  await withTempRepo(async (root) => {
    const quiet = await runWrapper(["ensure", "--quiet"], { cwd: root });
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toBe("");

    const installManifestPath = join(
      root,
      ".audit-code",
      "install",
      "manifest.json",
    );
    const installManifest = JSON.parse(
      await readFile(installManifestPath, "utf8"),
    );
    expect(installManifest.contract_version).toBe("audit-code-install/v1alpha1");
    expect(installManifest.hosts.length).toBe(4);

    const skipped = JSON.parse(
      (await runWrapper(["ensure"], { cwd: root })).stdout,
    );
    expect(skipped.status).toBe("ok");
    expect(skipped.action).toBe("skipped");

    const installedPromptPath =
      installManifest.asset_paths.installedPromptPath;
    await writeFile(installedPromptPath, "stale prompt\n");

    const refreshed = JSON.parse(
      (await runWrapper(["ensure"], { cwd: root })).stdout,
    );
    expect(refreshed.status).toBe("ok");
    expect(refreshed.action).toBe("installed");
    expect(refreshed.reason).toBe("stale_installed_prompt");
    expect(refreshed.host_count).toBe(4);

    const sourcePrompt = await readFile(
      join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
      "utf8",
    );
    expect(await readFile(installedPromptPath, "utf8")).toBe(sourcePrompt);

  });
});

test.concurrent("audit-code ensure refreshes stale OpenCode audit permissions", async () => {
  await withTempRepo(async (root) => {
    await runWrapper(["install"], { cwd: root });
    const opencodeConfigPath = join(root, "opencode.json");
    const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
    opencodeConfig.permission.read = "deny";
    opencodeConfig.permission.grep = "ask";
    opencodeConfig.permission.external_directory = {};
    opencodeConfig.permission.edit = "ask";
    opencodeConfig.agent.auditor.permission.read = "deny";
    opencodeConfig.agent.auditor.permission.grep = "ask";
    opencodeConfig.agent.auditor.permission.external_directory = {};
    opencodeConfig.agent.auditor.permission.edit = "ask";
    delete opencodeConfig.permission.bash["audit-code ensure*"];
    delete opencodeConfig.permission.bash["audit-code next-step*"];
    delete opencodeConfig.agent.auditor.permission.bash["*audit-code.mjs* submit-packet*"];
    await writeFile(
      opencodeConfigPath,
      JSON.stringify(opencodeConfig, null, 2) + "\n",
    );

    const refreshed = JSON.parse(
      (await runWrapper(["ensure"], { cwd: root })).stdout,
    );
    expect(refreshed.status).toBe("ok");
    expect(refreshed.action).toBe("installed");
    expect(refreshed.reason).toBe("stale_host_asset:opencode:permissions");

    const repairedConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
    assertOpenCodeAuditPermissions(repairedConfig);
  });
});

const repoLocalHostCases = [
  {
    name: "Codex",
    host: "codex",
    async assertHost(root, parsed, paths) {
      expect(hostGuidance(parsed, "codex").primary_path).toBe(paths.agentsPath);
      expect(await readFile(paths.agentsPath, "utf8")).toMatch(/When the user enters `\/audit-code`/);
      expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/## Codex/);
    },
  },
  {
    name: "VS Code",
    host: "vscode",
    async assertHost(root, parsed, paths) {
      expect(hostGuidance(parsed, "vscode").primary_path).toBe(paths.vscodePromptPath);
      expect(await readFile(paths.vscodePromptPath, "utf8")).toMatch(/^---\nname: audit-code\ndescription: Autonomous local loop code auditing\nagent: auditor/m);
      expect(await readFile(paths.vscodePromptPath, "utf8")).toMatch(/\/audit-code/);
      // The VS Code agent file now derives from the one canonical loader body
      // (E1 single-source), so it carries the next-step capability handshake
      // including --host-models rather than bespoke abbreviated prose.
      const vscodeAgent = await readFile(paths.vscodeAgentPath, "utf8");
      expect(vscodeAgent).toMatch(/# Audit Code Agent/);
      expect(vscodeAgent).toMatch(/--host-models/);
      expect(vscodeAgent).toMatch(/node audit-code\.mjs/);
      // The MCP surface was removed: install no longer writes .vscode/mcp.json.
      await assert.rejects(() => stat(join(root, ".vscode", "mcp.json")));
      expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/## VS Code/);
    },
  },
  {
    name: "OpenCode",
    host: "opencode",
    async assertHost(root, parsed, paths) {
      expect(hostGuidance(parsed, "opencode").primary_path).toBe(paths.opencodeConfigPath);
      const opencodeConfig = JSON.parse(
        await readFile(paths.opencodeConfigPath, "utf8"),
      );
      expect(opencodeConfig.command?.["audit-code"], "project opencode.json must not define the global /audit-code command").toBe(undefined);
      expect(opencodeConfig.mcp?.auditor, "project opencode.json must not define mcp.auditor (global config owns it)").toBe(undefined);
      assertOpenCodeAuditPermissions(opencodeConfig);
      expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/## OpenCode/);
    },
  },
  {
    name: "Antigravity",
    host: "antigravity",
    async assertHost(root, parsed, paths) {
      const guidance = hostGuidance(parsed, "antigravity");
      expect(guidance.primary_path).toBe(paths.antigravitySkillPath);
      expect(guidance.supporting_paths.includes(paths.geminiCommandPath)).toBeTruthy();
      expect(guidance.supporting_paths.includes(paths.antigravityPlanningGuidePath)).toBeTruthy();
      expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/## Antigravity/);
    },
  },
];

for (const { name, assertHost } of repoLocalHostCases) {
  test.concurrent(`audit-code wrapper bootstraps repo-local ${name} host integration`, async () => {
    await withTempRepo(async (root) => {
      const { parsed, paths } = await setupRepoLocalHostInstallFixture(root);

      assertSharedHostInstallResponse(parsed, root, paths);
      await assertHost(root, parsed, paths);
    });
  });
}

test.concurrent("repo-local host install writes shared manifest and cleanup behavior", async () => {
  await withTempRepo(async (root) => {
    const { parsed, paths } = await setupRepoLocalHostInstallFixture(root);
    const installedPromptContent = await readFile(paths.installedPromptPath, "utf8");
    const promptContent = await readFile(
      join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
      "utf8",
    );
    const skillContent = await readFile(
      join(repoRoot, "skills", "audit-code", "SKILL.md"),
      "utf8",
    );
    const installManifest = JSON.parse(
      await readFile(paths.installManifestPath, "utf8"),
    );

    assertSharedHostInstallResponse(parsed, root, paths);
    expect(installedPromptContent).toBe(promptContent);
    expect((await readFile(join(root, ".audit-code", "install", "SKILL.md"), "utf8"))
        .replace(/\r\n/g, "\n")).toBe(skillContent.replace(/\r\n/g, "\n"));
    // The MCP surface was removed: install must not write the MCP server
    // launcher or the Claude Desktop bundle.
    await assert.rejects(() =>
      stat(join(root, ".audit-code", "install", "run-mcp-server.mjs")),
    );
    await assert.rejects(() =>
      stat(join(root, ".audit-code", "install", "claude-desktop")),
    );
    await assert.rejects(() => stat(paths.legacyInstalledPromptPath));
    await assert.rejects(() => stat(paths.legacyOpenCodeCommandPath));
    await assert.rejects(() => stat(paths.legacyCodexSkillPath));
    await assert.rejects(() => stat(paths.legacyCodexPromptPath));
    expect(installManifest.contract_version).toBe("audit-code-install/v1alpha1");
    expect(installManifest.source_prompt_path).toBe(join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"));
    expect(installManifest.source_skill_path).toBe(join(repoRoot, "skills", "audit-code", "SKILL.md"));
    expect(installManifest.hosts.length).toBe(4);
    expect(installManifest.hosts.map((entry) => entry.host)).toEqual(parsed.host_guidance.map((entry) => entry.host));
    expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/refresh every generated host surface from the shared prompt and skill assets together/);
  });
});

test.concurrent("verify-install summarizes repo-local host integration status", async () => {
  await withTempRepo(async (root) => {
    const { parsed } = await setupRepoLocalHostInstallFixture(root);
    const { parsed: verifiedInstall } = await runWrapperJsonOutput(
      ["verify-install"],
      { cwd: root },
    );

    expect(verifiedInstall.status).toBe("ok");
    expect(verifiedInstall.issue_count).toBe(0);
    expect(verifiedInstall.hosts.length).toBe(4);
    expect(verifiedInstall.hosts.map((entry) => entry.host)).toEqual(parsed.host_guidance.map((entry) => entry.host));
    for (const host of verifiedInstall.hosts) {
      expect(host.status).toBe("ok");
    }
  });
});

test.concurrent("audit-code install removes legacy generated repo-local Codex skill copies", async () => {
  await withTempRepo(async (root) => {
    const sourceSkill = await readFile(
      join(repoRoot, "skills", "audit-code", "SKILL.md"),
      "utf8",
    );
    const sourcePrompt = await readFile(
      join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
      "utf8",
    );
    const legacySkillPath = join(root, ".codex", "skills", "audit-code", "SKILL.md");
    const legacyPromptPath = join(
      root,
      ".codex",
      "skills",
      "audit-code",
      "audit-code.prompt.md",
    );
    await mkdir(dirname(legacySkillPath), { recursive: true });
    await writeFile(legacySkillPath, sourceSkill);
    await writeFile(legacyPromptPath, sourcePrompt);

    const parsed = JSON.parse(
      (await runWrapper(["install", "--host", "codex"], { cwd: root })).stdout,
    );

    expect(parsed.files.some(
        (file) => file.path === legacySkillPath && file.mode === "removed",
      )).toBe(true);
    expect(parsed.files.some(
        (file) => file.path === legacyPromptPath && file.mode === "removed",
      )).toBe(true);
    await assert.rejects(() => stat(legacySkillPath));
    await assert.rejects(() => stat(legacyPromptPath));
  });
});

test.concurrent("audit-code installer merges existing host config instead of clobbering it", async () => {
  await withTempRepo(async (root) => {
    await mkdir(join(root, ".vscode"), { recursive: true });
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify(
        {
          mcp: {
            existing: {
              type: "local",
              command: ["node", "existing-server.mjs"],
            },
          },
          command: {
            "audit-code": {
              template: "stale local prompt",
              agent: "auditor",
            },
            keepMe: {
              template: "custom command",
            },
          },
          agent: {
            existingAgent: {
              description: "Keep me",
            },
            auditor: {
              customAgentSetting: true,
              permission: {
                bash: {
                  "*": "ask",
                  "git log*": "allow",
                },
                edit: {
                  "*": "deny",
                  "docs/notes.md": "allow",
                },
              },
            },
          },
          permission: {
            bash: {
              "*": "ask",
              "npm test*": "allow",
            },
            edit: {
              "*": "deny",
              "docs/**": "allow",
            },
            webfetch: "deny",
          },
          customSetting: true,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          servers: {
            existing: {
              type: "stdio",
              command: "node",
              args: ["existing-server.mjs"],
            },
          },
          inputs: [],
        },
        null,
        2,
      ) + "\n",
    );

    await runWrapper(["install"], { cwd: root });

    const opencodeConfig = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    );
    expect(opencodeConfig.customSetting).toBe(true);
    expect(opencodeConfig.permission.webfetch).toBe("deny");
    expect(opencodeConfig.permission.bash["npm test*"]).toBe("allow");
    expect(opencodeConfig.permission.edit["docs/**"]).toBe("allow");
    expect(opencodeConfig.command["audit-code"]).toBe(undefined);
    expect(opencodeConfig.command.keepMe.template).toBe("custom command");
    assertOpenCodeAuditPermissions(opencodeConfig);
    expect(opencodeConfig.mcp.existing.command).toEqual([
      "node",
      "existing-server.mjs",
    ]);
    expect(opencodeConfig.mcp.auditor, "project config must not define mcp.auditor after install").toBe(undefined);
    expect(opencodeConfig.agent.existingAgent.description).toBe("Keep me");
    expect(opencodeConfig.agent.auditor.description).toBe("Read-heavy audit orchestration agent for the /audit-code workflow.");
    expect(opencodeConfig.agent.auditor.customAgentSetting).toBe(true);
    expect(opencodeConfig.agent.auditor.permission.bash["git log*"]).toBe("allow");
    expect(opencodeConfig.agent.auditor.permission.edit["docs/notes.md"]).toBe("allow");

    // The MCP surface was removed: install no longer touches .vscode/mcp.json,
    // so a pre-existing file is left untouched and no auditor server is injected.
    const vscodeConfig = JSON.parse(
      await readFile(join(root, ".vscode", "mcp.json"), "utf8"),
    );
    expect(vscodeConfig.servers.existing.args).toEqual([
      "existing-server.mjs",
    ]);
    expect(vscodeConfig.servers.auditor).toBe(undefined);
    expect(vscodeConfig.inputs).toEqual([]);
  });
});

test.concurrent("audit-code wrapper updates managed compatibility blocks without clobbering existing instructions", async () => {
  await withTempRepo(async (root) => {
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# Existing Team Instructions\n");

    await runWrapper(["install", "--host", "opencode"], { cwd: root });
    const firstPass = await readFile(agentsPath, "utf8");
    expect(firstPass).toMatch(/Existing Team Instructions/);
    expect(firstPass).toMatch(/audit-code:begin/);

    await writeFile(
      agentsPath,
      firstPass.replace(
        "When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.",
        "When the user enters `/audit-code`, use the managed install block.",
      ),
    );

    await runWrapper(["install", "--host", "opencode"], { cwd: root });
    const secondPass = await readFile(agentsPath, "utf8");
    expect(secondPass).toMatch(/Existing Team Instructions/);
    expect((secondPass.match(/audit-code:begin/g) ?? []).length).toBe(1);
    expect(secondPass).toMatch(/When the user enters `\/audit-code`, treat it as this repository's autonomous audit workflow\./);
  });
});

test.concurrent("audit-code wrapper keeps the Copilot-specific installer as a compatibility alias", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper(
      ["install-host", "--host", "copilot"],
      { cwd: root },
    );
    const parsed = JSON.parse(stdout);

    expect(parsed.host).toBe("copilot");
    expect(parsed.slash_command_surfaces.vscode_prompt).toBe(join(root, ".github", "prompts", "audit-code.prompt.md"));
    expect(parsed.instruction_surfaces.copilot_instructions).toBe(join(root, ".github", "copilot-instructions.md"));
    expect(parsed.instruction_surfaces.agents).toBe(null);
    expect(parsed.slash_command_surfaces.opencode_config).toBe(null);
    expect(parsed.host_guidance.length).toBe(1);
    expect(parsed.host_guidance[0].host).toBe("vscode");

    const verified = JSON.parse(
      (await runWrapper(["verify-install", "--host", "copilot"], { cwd: root }))
        .stdout,
    );
    expect(verified.status).toBe("ok");
    expect(verified.issue_count).toBe(0);
    expect(verified.hosts.length).toBe(1);
    expect(verified.hosts[0].host).toBe("vscode");
  });
});

test.concurrent("build helpers are isolated from install helpers", async () => {
  // shouldBuildDistForPaths and assertWorkspaceInstalled are importable directly
  // from audit-code-wrapper-build.mjs and produce the same results as the
  // re-exports from audit-code-wrapper-lib.mjs.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-build-isolation-"));
  try {
    const sourceDir = join(tempDir, "src");
    const distDir = join(tempDir, "dist");
    const tsconfigFile = join(tempDir, "tsconfig.json");
    const sourceFile = join(sourceDir, "index.ts");
    const distFile = join(distDir, "index.js");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(sourceFile, "export const value = 1;\n");
    await writeFile(tsconfigFile, '{"compilerOptions":{"outDir":"dist"}}\n');
    await writeFile(distFile, "export const value = 1;\n");

    const sourceTime = new Date("2026-04-23T14:00:00.000Z");
    const distTime = new Date("2026-04-23T14:05:00.000Z");
    await utimes(sourceDir, sourceTime, sourceTime);
    await utimes(sourceFile, sourceTime, sourceTime);
    await utimes(tsconfigFile, sourceTime, sourceTime);
    await utimes(distDir, distTime, distTime);
    await utimes(distFile, distTime, distTime);

    // Direct import from build module matches re-export from lib.
    const resultDirect = await shouldBuildDistForPathsDirect({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });
    const resultViaLib = await shouldBuildDistForPaths({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });
    expect(resultDirect).toBe(false);
    expect(resultDirect).toBe(resultViaLib);

    // assertWorkspaceInstalled direct import behaves identically to the lib re-export.
    const checkoutRoot = join(tempDir, "checkout");
    assert.throws(
      () => assertWorkspaceInstalledDirect({ checkoutRoot, sharedManifestPath: null }),
      /Dependencies are not installed/,
    );
    assert.throws(
      () => assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath: null }),
      /Dependencies are not installed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // INSTALL_HOST_DEFINITIONS, INSTALL_HOST_ORDER, getInstallHostKeys,
  // getInstallProfile are importable directly from install-hosts and match the
  // underscore-aliased re-exports from wrapper-lib.
  expect(INSTALL_HOST_ORDER).toEqual(_INSTALL_HOST_ORDER);
  expect(INSTALL_HOST_DEFINITIONS).toEqual(_INSTALL_HOST_DEFINITIONS);
  expect(getInstallHostKeys("all")).toEqual(_getInstallHostKeys("all"));
  expect(getInstallProfile("opencode")).toEqual(_getInstallProfile("opencode"));
});

test.concurrent("OpenCode permission helpers are importable from the dedicated module", () => {
  // assertOpenCodeAuditPermissionConfig throws when required bash rules are missing.
  const badPermission = {
    read: "allow",
    glob: "allow",
    grep: "allow",
    external_directory: { "*": "allow" },
    edit: { ".audit-code/**": "allow", ".audit-tools/**": "allow" },
    bash: {
      // Missing required allow/deny rules entirely
      "*": "allow",
    },
  };
  assert.throws(
    () => assertOpenCodeAuditPermissionConfig(badPermission, "permission"),
    /bash must allow|bash must deny/,
  );

  // buildMergedOpenCodeProjectConfig with an empty existing config preserves
  // the generated values for read/glob/grep and sets external_directory allow.
  const builtFromEmpty = buildMergedOpenCodeProjectConfig({}, "/tmp/repo");
  expect(builtFromEmpty.permission?.read).toBe("allow");
  expect(builtFromEmpty.permission?.glob).toBe("allow");
  expect(builtFromEmpty.permission?.grep).toBe("allow");
  expect(builtFromEmpty.permission?.external_directory?.["*"]).toBe("allow");
  expect(builtFromEmpty.agent?.auditor?.permission?.read).toBe("allow");

  // buildMergedOpenCodeProjectConfig produces a config with the required
  // permission structure even when called with an empty existing config.
  const built = buildMergedOpenCodeProjectConfig({}, "/tmp/repo");
  expect(built.permission?.read).toBe("allow");
  expect(built.permission?.glob).toBe("allow");
  expect(built.permission?.grep).toBe("allow");
  expect(built.permission?.external_directory?.["*"]).toBe("allow");
  expect(built.agent?.auditor?.permission?.read).toBe("allow");
});

test.concurrent("OPENCODE_AUDIT_BASH_PERMISSION includes Select-String", () => {
  expect(OPENCODE_AUDIT_BASH_PERMISSION["Select-String *"], "OPENCODE_AUDIT_BASH_PERMISSION must include 'Select-String *': 'allow' as the source of truth").toBe("allow");
});

test.concurrent("renderOpenCodePermissionConfig bash block includes Select-String", () => {
  const config = renderOpenCodePermissionConfig();
  expect(config.bash["Select-String *"], "renderOpenCodePermissionConfig() must return a bash block containing 'Select-String *': 'allow'").toBe("allow");
});

test.concurrent("buildMergedOpenCodeProjectConfig preserves '*': 'allow' on external_directory even when existing config has a more restrictive value", () => {
  // User had '*': 'ask' on external_directory — managed rule must override to 'allow'
  const askExisting = { permission: { external_directory: { "*": "ask" } } };
  const mergedAsk = buildMergedOpenCodeProjectConfig(askExisting, "/tmp/repo");
  expect(mergedAsk.permission.external_directory["*"], "managed rule must override user '*': 'ask' to 'allow' on external_directory").toBe("allow");

  // User had '*': 'deny' on external_directory — managed rule must override to 'allow'
  const denyExisting = { permission: { external_directory: { "*": "deny" } } };
  const mergedDeny = buildMergedOpenCodeProjectConfig(denyExisting, "/tmp/repo");
  expect(mergedDeny.permission.external_directory["*"], "managed rule must override user '*': 'deny' to 'allow' on external_directory").toBe("allow");

  // Undefined existing external_directory — managed rule must still produce 'allow'
  const undefinedExisting = { permission: {} };
  const mergedUndefined = buildMergedOpenCodeProjectConfig(undefinedExisting, "/tmp/repo");
  expect(mergedUndefined.permission.external_directory["*"], "managed rule must produce 'allow' even when existing external_directory is undefined").toBe("allow");
});

test.concurrent("buildMergedOpenCodeProjectConfig does not let user external_directory override the managed allow rule (parity with edit/bash behavior)", () => {
  // A user-owned external_directory object with no '*' key still gets '*': 'allow'
  const noStarExisting = { permission: { external_directory: { "some/path/**": "ask" } } };
  const mergedNoStar = buildMergedOpenCodeProjectConfig(noStarExisting, "/tmp/repo");
  expect(mergedNoStar.permission.external_directory["*"], "managed rule must add '*': 'allow' even when existing object has no '*' key").toBe("allow");

  // Parity with edit: a user '*': 'deny' on edit is preserved for '*' key (managed rules use withoutOpenCodeWildcard for edit)
  const editDenyExisting = { permission: { edit: { "*": "deny" } } };
  const mergedEditDeny = buildMergedOpenCodeProjectConfig(editDenyExisting, "/tmp/repo");
  // The '*' key on edit comes from the generated permission (OPENCODE_AUDIT_EDIT_PERMISSION has '*': 'ask')
  // mergeOpenCodeAgentPermissionRule: existing '*' wins over generated '*', but managed rules (without wildcard) override specifics
  expect(mergedEditDeny.permission.edit["*"], "user '*': 'deny' on edit is preserved (agent-scope merge keeps existing wildcard)").toBe("deny");
  // Same behavior must hold for external_directory: managed OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION includes '*'
  const extDenyExisting = { permission: { external_directory: { "*": "deny" } } };
  const mergedExtDeny = buildMergedOpenCodeProjectConfig(extDenyExisting, "/tmp/repo");
  expect(mergedExtDeny.permission.external_directory["*"], "OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION must override user '*': 'deny' on external_directory").toBe("allow");
});
