// Shared harness for the audit-code-wrapper-*.test.ts suite (split from the
// former single audit-code-wrapper.test.ts so no one file dominates a CI shard
// — the wall-clock brief's T4). Everything here is a faithful move: spawn
// plumbing, temp-repo fixture, and the dispatch/merge/install fixtures the
// split files share.
import { expect } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  stat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../../helpers/spawn.mjs";
import { AuditCodeResponseSchema } from "../../../src/audit/contracts/wrapperResponse.js";

// Post-G2 the backend provider identity rides the per-invocation --auditor
// descriptor rather than the persisted session-config.json (which now rejects it).
export const AUDITOR_ARGS = [
  "--auditor",
  JSON.stringify({
    self: {
      provider: "worker-command",
      context_tokens: 200_000,
      output_tokens: 8_000,
    },
  }),
];

// Loose shapes for the JSON the wrapper prints / writes. Only the fields the
// assertions read through a callback are named — everything else stays open via
// the index signature, so these describe the contract without pinning a shape
// the artifacts do not actually guarantee.
export interface TaskRecord {
  task_id: string;
  [key: string]: any;
}

export interface HostEntry {
  host: string;
  [key: string]: any;
}

interface InstallFileEntry {
  path: string;
  mode: string;
  [key: string]: any;
}

export interface InstallResponse {
  host_guidance: HostEntry[];
  files: InstallFileEntry[];
  [key: string]: any;
}

export interface HostStatusReport {
  hosts: HostEntry[];
  [key: string]: any;
}

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");
const packageJsonPath = join(repoRoot, "package.json");

export function assertMatchesResponseSchema(value: unknown, label: string): void {
  const result = AuditCodeResponseSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditCodeResponseSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
}

export const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;

interface WrapperOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  onStdoutChunk?: (accumulated: string) => void;
  onError?: (error: Error) => void;
}

interface WrapperOutput {
  stdout: string;
  stderr: string;
}

interface WrapperJsonOutput extends WrapperOutput {
  parsed: any;
}

export function spawnWrapper(args: string[], options: WrapperOptions = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  const stdoutRef = { value: "" };
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [wrapperPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: { ...cleanEnv, ...(options.env ?? {}) },
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.input !== undefined) {
    child.stdin!.end(options.input);
  }
  child.stdout!.on("data", (chunk) => {
    stdoutRef.value += String(chunk);
    options.onStdoutChunk?.(stdoutRef.value);
  });
  child.stderr!.on("data", (chunk) => {
    stdoutRef; // keep ref in scope; only stderr is updated here
    stderrRef.value += String(chunk);
  });
  child.on("error", (error) => options.onError?.(error));
  return { child, stdoutRef, stderrRef };
}

export function runWrapper(args: string[], options: WrapperOptions = {}): Promise<WrapperOutput> {
  return new Promise<WrapperOutput>((resolve, reject) => {
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

export function runWrapperJsonOutput(
  args: string[],
  options: WrapperOptions = {},
): Promise<WrapperJsonOutput> {
  return new Promise<WrapperJsonOutput>((resolve, reject) => {
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

    function settle(error: Error | null, value?: WrapperJsonOutput) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        if (error) {
          reject(error);
        } else {
          resolve(value!);
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

export function assertOpenCodeAuditPermissions(config: any): void {
  expect(config.permission?.read).toBe("allow");
  expect(config.permission?.glob).toBe("allow");
  expect(config.permission?.grep).toBe("allow");
  // Hardened shape (V3): bash wildcard "ask", no external_directory allow-all.
  expect(config.permission?.bash?.["*"]).toBe("ask");
  expect(config.permission?.external_directory?.["*"]).not.toBe("allow");
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
  // Hardened shape (V3): bash wildcard "ask", no external_directory allow-all.
  expect(config.agent?.auditor?.permission?.bash?.["*"]).toBe("ask");
  expect(config.agent?.auditor?.permission?.external_directory?.["*"]).not.toBe("allow");
  expect(config.agent?.auditor?.permission?.edit?.[".audit-tools/**"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["audit-code next-step*"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["*audit-code.mjs* merge-and-ingest*"]).toBe("allow");
  expect(config.agent?.auditor?.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
}

export async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
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

export function validAuditResultForTask(task: any, overrides: Record<string, unknown> = {}) {
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path: string) => ({
      path,
      total_lines: task.file_line_counts?.[path] ?? 0,
    })),
    findings: [],
    reviewed_clean: true,
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
// dispatch-ready step (dispatch_review).
export async function startDispatchRun(root: string): Promise<any> {
  const incomingDir = join(root, ".audit-tools/audit", "incoming");
  for (let i = 0; i < MAX_PRE_DISPATCH_PAUSES; i++) {
    const step = JSON.parse(
      (await runWrapper(["next-step", ...AUDITOR_ARGS], { cwd: root })).stdout,
    );
    if (step.step_kind === "analyzer_consent") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.analyzer_consent_decisions,
        JSON.stringify({ semgrep: "declined", eslint: "declined", knip: "declined", jscpd: "declined", "osv-scanner": "declined" }, null, 2) + "\n",
      );
      continue;
    }
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
    if (step.step_kind === "edge_reasoning_dispatch") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(step.artifact_paths.edge_reasoning_results, "[]\n");
      continue;
    }
    if (step.step_kind === "dispatch_review") {
      return step;
    }
    throw new Error(
      `startDispatchRun: unexpected step kind '${step.step_kind}' (iteration ${i})`,
    );
  }
  throw new Error("next-step did not reach a dispatch-ready step");
}

async function setupDispatchFixture(root: string) {
  const step = await startDispatchRun(root);
  const runId = step.run_id;
  const artifactsDir = step.artifacts_dir;

  expect(runId).toBeTruthy();
  expect(artifactsDir).toBeTruthy();

  await runWrapper(
    [
      "prepare-dispatch",
      "--run-id",
      runId,
      "--artifacts-dir",
      artifactsDir,
      ...AUDITOR_ARGS,
    ],
    { cwd: root },
  );

  const runDir = join(artifactsDir, "runs", runId);
  const tasks: TaskRecord[] = JSON.parse(
    await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
  );
  const taskById = new Map<string, TaskRecord>(
    tasks.map((task) => [task.task_id, task]),
  );
  const plan = JSON.parse(
    await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
  );
  const resultMap = JSON.parse(
    await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
  );

  return { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap };
}

export async function setupMergeFixture(root: string) {
  return setupDispatchFixture(root);
}

export async function submitAllPackets(
  root: string,
  runId: string,
  artifactsDir: string,
  plan: any,
  resultMap: any,
  taskById: Map<string, TaskRecord>,
): Promise<void> {
  for (const packet of plan) {
    const packetResults = resultMap.entries
      .filter((item: any) => item.packet_id === packet.packet_id)
      .map((entry: any) => validAuditResultForTask(taskById.get(entry.task_id)));
    await runWrapper(
      ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
      { cwd: root, input: JSON.stringify(packetResults) },
    );
  }
}

export async function setupSubmitPacketFixture(root: string) {
  const { runId, artifactsDir, tasks, taskById, plan, resultMap } =
    await setupDispatchFixture(root);

  const packet = plan.find(
    (candidate: any) =>
      resultMap.entries.filter((entry: any) => entry.packet_id === candidate.packet_id)
        .length >= 2,
  );
  expect(packet, "expected a dispatch packet with at least two tasks").toBeTruthy();
  const entries = resultMap.entries.filter(
    (entry: any) => entry.packet_id === packet.packet_id,
  );
  const packetTasks = entries.map((entry: any) => taskById.get(entry.task_id));
  expect(packetTasks.every(Boolean), "expected task metadata for every packet entry").toBe(true);

  return { runId, artifactsDir, packet, entries, packetTasks, tasks };
}

export async function assertPacketResultFilesMissing(entries: any[]): Promise<void> {
  for (const entry of entries) {
    await assert.rejects(() => stat(entry.result_path));
  }
}

function repoLocalHostInstallPaths(root: string) {
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

export type HostInstallPaths = ReturnType<typeof repoLocalHostInstallPaths>;

export function hostGuidance(parsed: InstallResponse, host: string): any {
  const guidance = parsed.host_guidance.find((entry) => entry.host === host);
  expect(guidance, `expected guidance for ${host}`).toBeTruthy();
  return guidance;
}

export async function setupRepoLocalHostInstallFixture(root: string) {
  const paths = repoLocalHostInstallPaths(root);
  await mkdir(dirname(paths.legacyInstalledPromptPath), { recursive: true });
  await writeFile(paths.legacyInstalledPromptPath, "legacy prompt\n");

  const parsed: InstallResponse = JSON.parse(
    (await runWrapper(["install"], { cwd: root })).stdout,
  );

  return { parsed, paths };
}

export function assertSharedHostInstallResponse(
  parsed: InstallResponse,
  root: string,
  paths: HostInstallPaths,
): void {
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
