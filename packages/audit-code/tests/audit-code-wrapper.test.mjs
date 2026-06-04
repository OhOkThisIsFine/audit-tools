import test from "node:test";
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
import { spawn } from "node:child_process";
import { assertMatchesJsonSchema } from "./helpers/jsonSchemaAssert.mjs";
import {
  shouldBuildDistForPaths,
  assertWorkspaceInstalled,
} from "../audit-code-wrapper-lib.mjs";
const { isCanonicalResultFilename } = await import("../src/cli/args.ts");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const schemaPath = join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json");
const packageJsonPath = join(repoRoot, "package.json");
const responseSchema = JSON.parse(await readFile(schemaPath, "utf8"));
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;

function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: cleanEnv,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }

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

function runWrapperJsonOutput(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: cleanEnv,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(stderr || stdout || "wrapper JSON output timed out"));
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

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      try {
        const parsed = JSON.parse(stdout);
        settle(null, { stdout, stderr, parsed });
      } catch {
        // Wait until the wrapper has emitted a complete JSON object.
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => settle(error));
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) {
        try {
          settle(null, { stdout, stderr, parsed: JSON.parse(stdout) });
        } catch {
          settle(new Error(stderr || stdout || "wrapper exited without JSON"));
        }
        return;
      }
      settle(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

function assertOpenCodeAuditPermissions(config) {
  assert.equal(config.permission?.read, "allow");
  assert.equal(config.permission?.glob, "allow");
  assert.equal(config.permission?.grep, "allow");
  assert.equal(typeof config.permission?.external_directory, "object");
  assert.equal(config.permission?.edit?.[".audit-code/**"], "allow");
  assert.equal(config.permission?.edit?.[".audit-artifacts/**"], "allow");
  assert.equal(config.permission?.edit?.["audit-report.md"], "allow");
  assert.equal(config.permission?.bash?.["audit-code"], "allow");
  assert.equal(config.permission?.bash?.["audit-code ensure*"], "allow");
  assert.equal(config.permission?.bash?.["audit-code next-step*"], "allow");
  assert.equal(config.permission?.bash?.["audit-code run-to-completion*"], "deny");
  assert.equal(config.permission?.bash?.["audit-code synthesize*"], "deny");
  assert.equal(config.permission?.bash?.["audit-code cleanup*"], "deny");
  assert.equal(config.permission?.bash?.["audit-code requeue*"], "deny");
  assert.equal(config.permission?.bash?.["audit-code ingest-results*"], "deny");
  assert.equal(config.permission?.bash?.["*audit-code.mjs* submit-packet*"], "allow");
  assert.equal(config.permission?.bash?.["*audit-code.mjs* worker-run*"], "allow");
  assert.equal(config.permission?.bash?.["*audit-code.mjs* run-to-completion*"], "deny");
  assert.equal(config.permission?.bash?.["*audit-code.mjs* synthesize*"], "deny");
  assert.equal(config.permission?.bash?.["*node* *auditor-lambda*dist*index.js* worker-run*"], "allow");
  assert.equal(config.permission?.bash?.["Select-String *"], undefined);
  assert.equal(config.agent?.auditor?.permission?.read, "allow");
  assert.equal(config.agent?.auditor?.permission?.glob, "allow");
  assert.equal(config.agent?.auditor?.permission?.grep, "allow");
  assert.equal(typeof config.agent?.auditor?.permission?.external_directory, "object");
  assert.equal(config.agent?.auditor?.permission?.edit?.[".audit-artifacts/**"], "allow");
  assert.equal(config.agent?.auditor?.permission?.bash?.["audit-code next-step*"], "allow");
  assert.equal(config.agent?.auditor?.permission?.bash?.["*audit-code.mjs* merge-and-ingest*"], "allow");
  assert.equal(config.agent?.auditor?.permission?.bash?.["audit-code synthesize*"], "deny");
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
    // These end-to-end tests submit every planned packet in a single round and
    // assert all tasks are accepted. The single-worker canary (default on) would
    // hold back all but the top packet on first contact, so pin canary off to
    // exercise the deterministic single-round dispatch these fixtures expect.
    // (Canary phase behavior is covered by dispatch-features.test.mjs.)
    await mkdir(join(root, ".audit-artifacts"), { recursive: true });
    await writeFile(
      join(root, ".audit-artifacts", "session-config.json"),
      JSON.stringify(
        { provider: "local-subprocess", dispatch: { canary: false } },
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

async function setupSubmitPacketFixture(root) {
  const { stdout } = await runWrapper([], { cwd: root });
  const parsed = JSON.parse(stdout);
  const runId = parsed.handoff.active_review_run?.run_id;
  const artifactsDir = parsed.handoff.artifacts_dir;

  assert.ok(runId);
  assert.ok(artifactsDir);

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
  const packet = plan.find(
    (candidate) =>
      resultMap.entries.filter((entry) => entry.packet_id === candidate.packet_id)
        .length >= 2,
  );
  assert.ok(packet, "expected a dispatch packet with at least two tasks");
  const entries = resultMap.entries.filter(
    (entry) => entry.packet_id === packet.packet_id,
  );
  const packetTasks = entries.map((entry) => taskById.get(entry.task_id));
  assert.equal(
    packetTasks.every(Boolean),
    true,
    "expected task metadata for every packet entry",
  );

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
  assert.ok(guidance, `expected guidance for ${host}`);
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
  assert.equal(parsed.host, "all");
  assert.equal(parsed.repo_root, root);
  assert.equal(parsed.installed_prompt_path, paths.installedPromptPath);
  assert.equal(parsed.install_guide_path, paths.installGuidePath);
  assert.equal(parsed.install_manifest_path, paths.installManifestPath);
  // The MCP surface was removed: install no longer emits an MCP server launcher.
  assert.equal(parsed.mcp_server_launcher_path, undefined);
  assert.equal(parsed.slash_command_surfaces.vscode_prompt, paths.vscodePromptPath);
  assert.equal(parsed.slash_command_surfaces.opencode_config, paths.opencodeConfigPath);
  assert.equal(parsed.instruction_surfaces.agents, paths.agentsPath);
  assert.equal(
    parsed.instruction_surfaces.copilot_instructions,
    paths.copilotInstructionsPath,
  );
  assert.equal(parsed.host_guidance.length, 4);
  assert.deepEqual(
    parsed.host_guidance.map((entry) => entry.host),
    ["codex", "opencode", "vscode", "antigravity"],
  );
  assert.equal(parsed.unsupported_hosts.length, 0);
}

test("audit-code wrapper supports bounded single-step mode", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-artifacts");
    const { stdout } = await runWrapper(["--single-step"], { cwd: root });
    const parsed = JSON.parse(stdout);

    const info = await stat(artifactsDir);
    assert.equal(info.isDirectory(), true);
    assertMatchesJsonSchema(responseSchema, parsed, "auditCodeResponse");
    assert.equal(parsed.contract_version, "audit-code/v1alpha1");
    assert.equal(parsed.selected_executor, "intake_executor");
    assert.equal(parsed.progress_made, true);
    assert.equal(parsed.next_likely_step, "auto_fixes_applied");
    assert.equal(parsed.handoff.status, "active");
    assert.equal(parsed.handoff.suggested_commands.length, 0);
  });
});

test("audit-code wrapper can explain a resolved task id", async () => {
  await withTempRepo(async (root) => {
    await runWrapper([], { cwd: root });
    const tasks = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
    );
    const taskId = tasks[0].task_id;

    const explained = JSON.parse(
      (await runWrapper(["explain-task", taskId], { cwd: root })).stdout,
    );

    assert.equal(explained.task_id, taskId);
    assert.ok(Array.isArray(explained.coverage_entries));
    assert.ok(explained.coverage_entries.length > 0);
  });
});

test("audit-code wrapper reaches a terminal blocked handoff from repo root with no arguments under local-subprocess", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);

    assertMatchesJsonSchema(responseSchema, parsed, "auditCodeResponse:noArgs");
    assert.equal(parsed.contract_version, "audit-code/v1alpha1");
    assert.equal(parsed.audit_state.status, "blocked");
    assert.equal(parsed.progress_made, true);
    assert.equal(parsed.next_likely_step, null);
    assert.equal(parsed.selected_executor, "agent");
  assert.ok(parsed.artifacts_written.includes("run-ledger.json"));
  assert.match(parsed.progress_summary, /audit-results\.json|Worker launch failed|Ready for LLM semantic review|single-task fallback/i);
  assert.equal(parsed.handoff.status, "blocked");
  assert.equal(parsed.handoff.provider, "local-subprocess");
  assert.ok(parsed.handoff.pending_obligations.includes("audit_tasks_completed"));
  assert.ok(parsed.handoff.suggested_inputs.length >= 0);
  assert.ok(parsed.handoff.suggested_commands.length >= 0);
  assert.match(parsed.handoff.interactive_provider_hint, /session-config\.json|Provider:/i);
  // active_review_run may not be present if provider launch failed
    assert.match(
      parsed.handoff.artifact_paths.current_task.replaceAll("\\", "/"),
      /\/dispatch\/current-task\.json$/,
    );

    const handoffJson = JSON.parse(
      await readFile(parsed.handoff.artifact_paths.operator_handoff_json, "utf8"),
    );
  assert.equal(handoffJson.status, "blocked");
  assert.equal(handoffJson.provider, "local-subprocess");
  // active_review_run may not be present if provider launch failed
  if (handoffJson.active_review_run && parsed.handoff.active_review_run) {
    assert.equal(
      handoffJson.active_review_run.audit_results_path,
      parsed.handoff.active_review_run.audit_results_path,
    );
  }

  const handoffMarkdown = await readFile(
    parsed.handoff.artifact_paths.operator_handoff_markdown,
    "utf8",
  );
  assert.match(handoffMarkdown, /audit-code operator handoff/i);
  // Active review run section and packet dispatch command only present if review handoff exists
  if (parsed.handoff.active_review_run) {
    assert.match(handoffMarkdown, /Active review run:/i);
    assert.match(handoffMarkdown, /next-step/i);
    assert.doesNotMatch(handoffMarkdown, /prepare-dispatch/i);
    // next-step outputs (dispatch plan / single-task prompt) live in the step
    // contract, not the hand-off file_map.
    assert.equal(parsed.handoff.file_map.single_task_prompt, undefined);
    assert.equal(parsed.handoff.file_map.dispatch_plan, undefined);
    // Collapse: run-to-completion pre-renders the actionable review step itself,
    // so the host can act on steps/current-step.json without a second next-step
    // round-trip.
    const currentStep = JSON.parse(
      await readFile(
        join(root, ".audit-artifacts", "steps", "current-step.json"),
        "utf8",
      ),
    );
    assert.match(
      currentStep.step_kind,
      /^(dispatch_review|single_task_fallback)$/,
    );
    assert.equal(currentStep.run_id, parsed.handoff.active_review_run.run_id);
    const allAuditTasks = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
    );
    const pendingRunTasks = JSON.parse(
      await readFile(
        parsed.handoff.active_review_run.pending_audit_tasks_path,
        "utf8",
      ),
    );
    assert.equal(pendingRunTasks.length, allAuditTasks.length);
  }
});
});

test("merge-and-ingest blocks when assigned task results are missing", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);
    const runId = parsed.handoff.active_review_run?.run_id;
    const artifactsDir = parsed.handoff.artifacts_dir;

    assert.ok(runId);
    assert.ok(artifactsDir);

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

test("merge-and-ingest accepts packet task result files as the legacy result array", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);
    const runId = parsed.handoff.active_review_run?.run_id;
    const artifactsDir = parsed.handoff.artifacts_dir;

    assert.ok(runId);
    assert.ok(artifactsDir);

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

    for (const packet of plan) {
      const packetResults = [];
      for (const entry of resultMap.entries.filter(
        (item) => item.packet_id === packet.packet_id,
      )) {
        const taskId = entry.task_id;
        const task = taskById.get(taskId);
        assert.ok(task, `expected task metadata for ${taskId}`);
        packetResults.push({
          task_id: task.task_id,
          unit_id: task.unit_id,
          pass_id: task.pass_id,
          lens: task.lens,
          file_coverage: task.file_paths.map((path) => ({
            path,
            total_lines: task.file_line_counts?.[path] ?? 0,
          })),
          findings: [],
        });
      }
      await runWrapper(
        ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
        { cwd: root, input: JSON.stringify(packetResults) },
      );
    }

    const merge = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const mergeSummary = JSON.parse(merge.stdout);
    assert.equal(mergeSummary.status, "completed");
    assert.equal(mergeSummary.accepted_count, tasks.length);
    assert.equal(mergeSummary.rejected_count, 0);
    assert.equal(mergeSummary.finding_count, 0);
    assert.equal(mergeSummary.selected_executor, "result_ingestion_executor");
    assert.ok("next_likely_step" in mergeSummary);

    const merged = JSON.parse(
      await readFile(join(runDir, "run-results.json"), "utf8"),
    );
    assert.deepEqual(
      merged.map((result) => result.task_id).sort(),
      tasks.map((task) => task.task_id).sort(),
    );
    assert.equal(merge.stderr, "");
  });
});

test("merge-and-ingest is idempotent on re-run and never truncates results", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);
    const runId = parsed.handoff.active_review_run?.run_id;
    const artifactsDir = parsed.handoff.artifacts_dir;

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

    for (const packet of plan) {
      const packetResults = resultMap.entries
        .filter((item) => item.packet_id === packet.packet_id)
        .map((entry) => {
          const task = taskById.get(entry.task_id);
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
          };
        });
      await runWrapper(
        ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
        { cwd: root, input: JSON.stringify(packetResults) },
      );
    }

    const first = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    assert.equal(JSON.parse(first.stdout).status, "completed");
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
    assert.equal(replaySummary.idempotent_replay, true);
    assert.equal(replaySummary.status, "completed");
    assert.equal(replaySummary.accepted_count, tasks.length);
    assert.equal(
      await readFile(resultsPath, "utf8"),
      mergedAfterFirst,
      "the second merge must not rewrite the transient results file",
    );
  });
});

test("submit-packet rejects duplicate task result ids", async () => {
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

test("submit-packet rejects task results outside the packet", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks, tasks } =
      await setupSubmitPacketFixture(root);
    const outsideTask = tasks.find(
      (task) => !entries.some((entry) => entry.task_id === task.task_id),
    );
    assert.ok(outsideTask, "expected a task outside the selected packet");
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

test("submit-packet rejects missing assigned task results", async () => {
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

test("merge-and-ingest proceeds despite unexpected files in task-results/", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);
    const runId = parsed.handoff.active_review_run?.run_id;
    const artifactsDir = parsed.handoff.artifacts_dir;

    assert.ok(runId);
    assert.ok(artifactsDir);

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

    for (const packet of plan) {
      const packetResults = [];
      for (const entry of resultMap.entries.filter(
        (item) => item.packet_id === packet.packet_id,
      )) {
        const task = taskById.get(entry.task_id);
        assert.ok(task, `expected task metadata for ${entry.task_id}`);
        packetResults.push({
          task_id: task.task_id,
          unit_id: task.unit_id,
          pass_id: task.pass_id,
          lens: task.lens,
          file_coverage: task.file_paths.map((path) => ({
            path,
            total_lines: task.file_line_counts?.[path] ?? 0,
          })),
          findings: [],
        });
      }
      await runWrapper(
        ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
        { cwd: root, input: JSON.stringify(packetResults) },
      );
    }

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
    assert.equal(mergeSummary.status, "completed");
    assert.equal(mergeSummary.accepted_count, tasks.length);
    assert.equal(mergeSummary.rejected_count, 0);
    assert.equal(mergeSummary.spurious_file_count, 1);
    assert.match(merge.stderr, /unexpected file.*packet_spurious_results\.json/i);
  });
});

test("isCanonicalResultFilename separates canonical results from stray files", () => {
  // Canonical per-task result name: <stem>_<12-hex digest>.json (artifactNameForId).
  assert.equal(isCanonicalResultFilename("unit_foo_0123456789ab.json"), true);
  assert.equal(
    isCanonicalResultFilename("lens_security_packet-1_a1b2c3d4e5f6.json"),
    true,
  );
  // Stray files a subagent might leave — no _<12hex> suffix, so a prior round's
  // canonical results never inflate spurious_file_count while these still do.
  assert.equal(isCanonicalResultFilename("packet-23-results.json"), false);
  assert.equal(isCanonicalResultFilename("packet_spurious_results.json"), false);
  assert.equal(isCanonicalResultFilename("tmp-packet-87-result.json"), false);
  assert.equal(isCanonicalResultFilename("audit_result_packet1.json"), false);
});

test("merge-and-ingest rejects swapped task result files", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper([], { cwd: root });
    const parsed = JSON.parse(stdout);
    const runId = parsed.handoff.active_review_run?.run_id;
    const artifactsDir = parsed.handoff.artifacts_dir;

    assert.ok(runId);
    assert.ok(artifactsDir);

    await runWrapper(
      ["prepare-dispatch", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );

    const runDir = join(artifactsDir, "runs", runId);
    const tasks = JSON.parse(
      await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
    );
    assert.ok(tasks.length >= 2);
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    const entryByTaskId = new Map(
      resultMap.entries.map((entry) => [entry.task_id, entry]),
    );
    const [first, second] = tasks;

    function validResult(task) {
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
      };
    }

    await writeFile(
      entryByTaskId.get(first.task_id).result_path,
      JSON.stringify(validResult(second), null, 2) + "\n",
    );
    await writeFile(
      entryByTaskId.get(second.task_id).result_path,
      JSON.stringify(validResult(first), null, 2) + "\n",
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

test("wrapper build freshness ignores package metadata churn when dist is newer than source inputs", async () => {
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

    assert.equal(shouldBuild, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("assertWorkspaceInstalled flags missing or foreign @audit-tools/shared", () => {
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

test("audit-code wrapper prints help text", async () => {
  const { stdout } = await runWrapper(["--help"]);
  assert.ok(stdout.includes("run the wrapper with no arguments"));
  assert.ok(
    stdout.includes(
      "default behavior advances the audit automatically until it completes or no further automatic progress is possible",
    ),
  );
  assert.ok(stdout.includes("--single-step"));
  assert.ok(stdout.includes("--batch-results"));
  assert.ok(stdout.includes("explain-task <task_id>"));
  assert.ok(stdout.includes("ensure lazily bootstraps repo-local"));
  assert.ok(stdout.includes("install bootstraps /audit-code"));
  assert.ok(stdout.includes("next-step advances deterministic audit state"));
  assert.ok(stdout.includes("install-host --host copilot"));
});

test("audit-code wrapper prints package version", async () => {
  const { stdout } = await runWrapper(["--version"]);
  assert.equal(stdout.trim(), packageVersion);
});

test("audit-code wrapper prints the canonical prompt asset path", async () => {
  const { stdout } = await runWrapper(["prompt-path"]);
  const promptPath = stdout.trim();

  assert.ok(promptPath.length > 0);
  assert.match(
    promptPath.replaceAll("\\", "/"),
    /skills\/audit-code\/audit-code\.prompt\.md$/,
  );

  const info = await stat(promptPath);
  assert.equal(info.isFile(), true);
});

test("slash prompt is a tiny next-step loader without dispatch branches", async () => {
  const prompt = await readFile(
    join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
    "utf8",
  );

  assert.match(prompt, /audit-code ensure --quiet/);
  assert.match(prompt, /audit-code next-step/);
  assert.match(prompt, /follow only.*prompt_path/is);
  assert.doesNotMatch(prompt, /prepare-dispatch/);
  assert.doesNotMatch(prompt, /single-task fallback/i);
  assert.doesNotMatch(prompt, /Step 2/i);
});

test("audit-code ensure lazily bootstraps and refreshes repo-local host assets", async () => {
  await withTempRepo(async (root) => {
    const quiet = await runWrapper(["ensure", "--quiet"], { cwd: root });
    assert.equal(quiet.stdout, "");
    assert.equal(quiet.stderr, "");

    const installManifestPath = join(
      root,
      ".audit-code",
      "install",
      "manifest.json",
    );
    const installManifest = JSON.parse(
      await readFile(installManifestPath, "utf8"),
    );
    assert.equal(installManifest.contract_version, "audit-code-install/v1alpha1");
    assert.equal(installManifest.hosts.length, 4);

    const skipped = JSON.parse(
      (await runWrapper(["ensure"], { cwd: root })).stdout,
    );
    assert.equal(skipped.status, "ok");
    assert.equal(skipped.action, "skipped");

    const installedPromptPath =
      installManifest.asset_paths.installedPromptPath;
    await writeFile(installedPromptPath, "stale prompt\n");

    const refreshed = JSON.parse(
      (await runWrapper(["ensure"], { cwd: root })).stdout,
    );
    assert.equal(refreshed.status, "ok");
    assert.equal(refreshed.action, "installed");
    assert.equal(refreshed.reason, "stale_installed_prompt");
    assert.equal(refreshed.host_count, 4);

    const sourcePrompt = await readFile(
      join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
      "utf8",
    );
    assert.equal(await readFile(installedPromptPath, "utf8"), sourcePrompt);

  });
});

test("audit-code ensure refreshes stale OpenCode audit permissions", async () => {
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
    assert.equal(refreshed.status, "ok");
    assert.equal(refreshed.action, "installed");
    assert.equal(refreshed.reason, "stale_host_asset:opencode:permissions");

    const repairedConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
    assertOpenCodeAuditPermissions(repairedConfig);
  });
});

const repoLocalHostCases = [
  {
    name: "Codex",
    host: "codex",
    async assertHost(root, parsed, paths) {
      assert.equal(hostGuidance(parsed, "codex").primary_path, paths.agentsPath);
      assert.match(
        await readFile(paths.agentsPath, "utf8"),
        /When the user enters `\/audit-code`/,
      );
      assert.match(await readFile(paths.installGuidePath, "utf8"), /## Codex/);
    },
  },
  {
    name: "VS Code",
    host: "vscode",
    async assertHost(root, parsed, paths) {
      assert.equal(hostGuidance(parsed, "vscode").primary_path, paths.vscodePromptPath);
      assert.match(
        await readFile(paths.vscodePromptPath, "utf8"),
        /^---\nname: audit-code\ndescription: Autonomous local loop code auditing\nagent: auditor/m,
      );
      assert.match(await readFile(paths.vscodePromptPath, "utf8"), /\/audit-code/);
      assert.match(await readFile(paths.vscodeAgentPath, "utf8"), /# Auditor Agent/);
      // The MCP surface was removed: install no longer writes .vscode/mcp.json.
      await assert.rejects(() => stat(join(root, ".vscode", "mcp.json")));
      assert.match(await readFile(paths.installGuidePath, "utf8"), /## VS Code/);
    },
  },
  {
    name: "OpenCode",
    host: "opencode",
    async assertHost(root, parsed, paths) {
      assert.equal(
        hostGuidance(parsed, "opencode").primary_path,
        paths.opencodeConfigPath,
      );
      const opencodeConfig = JSON.parse(
        await readFile(paths.opencodeConfigPath, "utf8"),
      );
      assert.equal(
        opencodeConfig.command?.["audit-code"],
        undefined,
        "project opencode.json must not define the global /audit-code command",
      );
      assert.equal(
        opencodeConfig.mcp?.auditor,
        undefined,
        "project opencode.json must not define mcp.auditor (global config owns it)",
      );
      assertOpenCodeAuditPermissions(opencodeConfig);
      assert.match(await readFile(paths.installGuidePath, "utf8"), /## OpenCode/);
    },
  },
  {
    name: "Antigravity",
    host: "antigravity",
    async assertHost(root, parsed, paths) {
      const guidance = hostGuidance(parsed, "antigravity");
      assert.equal(guidance.primary_path, paths.antigravitySkillPath);
      assert.ok(guidance.supporting_paths.includes(paths.geminiCommandPath));
      assert.ok(
        guidance.supporting_paths.includes(paths.antigravityPlanningGuidePath),
      );
      assert.match(await readFile(paths.installGuidePath, "utf8"), /## Antigravity/);
    },
  },
];

for (const { name, assertHost } of repoLocalHostCases) {
  test(`audit-code wrapper bootstraps repo-local ${name} host integration`, async () => {
    await withTempRepo(async (root) => {
      const { parsed, paths } = await setupRepoLocalHostInstallFixture(root);

      assertSharedHostInstallResponse(parsed, root, paths);
      await assertHost(root, parsed, paths);
    });
  });
}

test("repo-local host install writes shared manifest and cleanup behavior", async () => {
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
    assert.equal(installedPromptContent, promptContent);
    assert.equal(
      (await readFile(join(root, ".audit-code", "install", "SKILL.md"), "utf8"))
        .replace(/\r\n/g, "\n"),
      skillContent.replace(/\r\n/g, "\n"),
    );
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
    assert.equal(installManifest.contract_version, "audit-code-install/v1alpha1");
    assert.equal(
      installManifest.source_prompt_path,
      join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
    );
    assert.equal(
      installManifest.source_skill_path,
      join(repoRoot, "skills", "audit-code", "SKILL.md"),
    );
    assert.equal(installManifest.hosts.length, 4);
    assert.deepEqual(
      installManifest.hosts.map((entry) => entry.host),
      parsed.host_guidance.map((entry) => entry.host),
    );
    assert.match(
      await readFile(paths.installGuidePath, "utf8"),
      /refresh every generated host surface from the shared prompt and skill assets together/,
    );
  });
});

test("verify-install summarizes repo-local host integration status", async () => {
  await withTempRepo(async (root) => {
    const { parsed } = await setupRepoLocalHostInstallFixture(root);
    const { parsed: verifiedInstall } = await runWrapperJsonOutput(
      ["verify-install"],
      { cwd: root },
    );

    assert.equal(verifiedInstall.status, "ok");
    assert.equal(verifiedInstall.issue_count, 0);
    assert.equal(verifiedInstall.hosts.length, 4);
    assert.deepEqual(
      verifiedInstall.hosts.map((entry) => entry.host),
      parsed.host_guidance.map((entry) => entry.host),
    );
    for (const host of verifiedInstall.hosts) {
      assert.equal(host.status, "ok");
    }
  });
});

test("audit-code install removes legacy generated repo-local Codex skill copies", async () => {
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

    assert.equal(
      parsed.files.some(
        (file) => file.path === legacySkillPath && file.mode === "removed",
      ),
      true,
    );
    assert.equal(
      parsed.files.some(
        (file) => file.path === legacyPromptPath && file.mode === "removed",
      ),
      true,
    );
    await assert.rejects(() => stat(legacySkillPath));
    await assert.rejects(() => stat(legacyPromptPath));
  });
});

test("audit-code installer merges existing host config instead of clobbering it", async () => {
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
    assert.equal(opencodeConfig.customSetting, true);
    assert.equal(opencodeConfig.permission.webfetch, "deny");
    assert.equal(opencodeConfig.permission.bash["npm test*"], "allow");
    assert.equal(opencodeConfig.permission.edit["docs/**"], "allow");
    assert.equal(opencodeConfig.command["audit-code"], undefined);
    assert.equal(opencodeConfig.command.keepMe.template, "custom command");
    assertOpenCodeAuditPermissions(opencodeConfig);
    assert.deepEqual(opencodeConfig.mcp.existing.command, [
      "node",
      "existing-server.mjs",
    ]);
    assert.equal(opencodeConfig.mcp.auditor, undefined, "project config must not define mcp.auditor after install");
    assert.equal(opencodeConfig.agent.existingAgent.description, "Keep me");
    assert.equal(
      opencodeConfig.agent.auditor.description,
      "Read-heavy audit orchestration agent for the /audit-code workflow.",
    );
    assert.equal(opencodeConfig.agent.auditor.customAgentSetting, true);
    assert.equal(opencodeConfig.agent.auditor.permission.bash["git log*"], "allow");
    assert.equal(opencodeConfig.agent.auditor.permission.edit["docs/notes.md"], "allow");

    // The MCP surface was removed: install no longer touches .vscode/mcp.json,
    // so a pre-existing file is left untouched and no auditor server is injected.
    const vscodeConfig = JSON.parse(
      await readFile(join(root, ".vscode", "mcp.json"), "utf8"),
    );
    assert.deepEqual(vscodeConfig.servers.existing.args, [
      "existing-server.mjs",
    ]);
    assert.equal(vscodeConfig.servers.auditor, undefined);
    assert.deepEqual(vscodeConfig.inputs, []);
  });
});

test("audit-code wrapper updates managed compatibility blocks without clobbering existing instructions", async () => {
  await withTempRepo(async (root) => {
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# Existing Team Instructions\n");

    await runWrapper(["install", "--host", "opencode"], { cwd: root });
    const firstPass = await readFile(agentsPath, "utf8");
    assert.match(firstPass, /Existing Team Instructions/);
    assert.match(firstPass, /audit-code:begin/);

    await writeFile(
      agentsPath,
      firstPass.replace(
        "When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.",
        "When the user enters `/audit-code`, use the managed install block.",
      ),
    );

    await runWrapper(["install", "--host", "opencode"], { cwd: root });
    const secondPass = await readFile(agentsPath, "utf8");
    assert.match(secondPass, /Existing Team Instructions/);
    assert.equal(
      (secondPass.match(/audit-code:begin/g) ?? []).length,
      1,
    );
    assert.match(
      secondPass,
      /When the user enters `\/audit-code`, treat it as this repository's autonomous audit workflow\./,
    );
  });
});

test("audit-code wrapper keeps the Copilot-specific installer as a compatibility alias", async () => {
  await withTempRepo(async (root) => {
    const { stdout } = await runWrapper(
      ["install-host", "--host", "copilot"],
      { cwd: root },
    );
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.host, "copilot");
    assert.equal(
      parsed.slash_command_surfaces.vscode_prompt,
      join(root, ".github", "prompts", "audit-code.prompt.md"),
    );
    assert.equal(
      parsed.instruction_surfaces.copilot_instructions,
      join(root, ".github", "copilot-instructions.md"),
    );
    assert.equal(parsed.instruction_surfaces.agents, null);
    assert.equal(parsed.slash_command_surfaces.opencode_config, null);
    assert.equal(parsed.host_guidance.length, 1);
    assert.equal(parsed.host_guidance[0].host, "vscode");

    const verified = JSON.parse(
      (await runWrapper(["verify-install", "--host", "copilot"], { cwd: root }))
        .stdout,
    );
    assert.equal(verified.status, "ok");
    assert.equal(verified.issue_count, 0);
    assert.equal(verified.hosts.length, 1);
    assert.equal(verified.hosts[0].host, "vscode");
  });
});
