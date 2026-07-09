import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJsonPath = join(repoRoot, "package.json");
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;
const requiredPackagedPaths = [
  "audit-code.mjs",
  "wrapper/audit-code-wrapper-lib.mjs",
  "package.json",
  "README.md",
  "dist/audit/index.js",
  "dist/audit/cli.js",
  "dispatch/lens-definitions.json",
  "schemas/audit_result.schema.json",
  "skills/audit-code/SKILL.md",
  "skills/audit-code/agents/openai.yaml",
  "skills/audit-code/audit-code.prompt.md",
];
const verbose = process.env.AUDIT_CODE_VERBOSE === "1";
const liveCommandOutput = true;

async function countLines(root, path) {
  const content = await readFile(join(root, path), "utf8");
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith("\n")
    ? content.split(/\r?\n/).length - 1
    : content.split(/\r?\n/).length;
}

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
    notes: ["Synthetic completion result for packaged smoke coverage."],
    requires_followup: false,
  })));
}

function platformCommand(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function installedAuditCodeCommand(installDir) {
  return process.platform === "win32"
    ? join(installDir, "node_modules", ".bin", "audit-code.cmd")
    : join(installDir, "node_modules", ".bin", "audit-code");
}

function installedDistCliPath(installDir) {
  return join(installDir, "node_modules", "audit-tools", "dist", "audit", "cli.js");
}

const STEP_CONTRACT_VERSION = "audit-code-step/v1alpha1";

// Pause step kinds that next-step can emit before review dispatch is ready
// (analyzer install decision, intent confirmation, design review passes,
// optional edge reasoning), each at most once; allow extra headroom.
const MAX_PRE_DISPATCH_PAUSES = 8;

// Drive `next-step` past the host pause steps that precede review dispatch by
// answering each pause headlessly (skip analyzer installs, confirm the default
// scope, submit empty design-review findings). Returns the first
// dispatch-ready step (dispatch_review or single_task_fallback).
async function advanceToDispatchReady(runNextStep, root) {
  const incomingDir = join(root, ".audit-tools", "audit", "incoming");
  for (let i = 0; i < MAX_PRE_DISPATCH_PAUSES; i++) {
    const step = JSON.parse((await runNextStep()).stdout);
    assert.equal(step.contract_version, STEP_CONTRACT_VERSION);
    detail(`next-step -> ${step.step_kind} (${step.status})`);
    if (step.step_kind === "analyzer_install") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.analyzer_decisions,
        JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "provider_confirmation") {
      // Accept the tool's suggested cost ordering verbatim (the interactive Gate-0
      // step; spec/cost-first-routing.md). Writing the input is the "operator has
      // acted" signal that lets the run proceed.
      await writeFile(
        step.artifact_paths.provider_confirmation_input,
        JSON.stringify({ schema_version: "provider-confirmation-input/v1" }, null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "confirm_intent") {
      await writeFile(
        step.artifact_paths.intent_checkpoint,
        JSON.stringify(
          {
            schema_version: "intent-checkpoint/v1",
            confirmed_at: new Date().toISOString(),
            confirmed_by: "host",
            scope_summary: "Full repository scope as discovered by intake.",
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
      await writeFile(join(incomingDir, "design-review-contract-findings.json"), "[]\n");
      await writeFile(join(incomingDir, "design-review-conceptual-findings.json"), "[]\n");
      continue;
    }
    if (step.step_kind === "design_review_contract") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(join(incomingDir, "design-review-contract-findings.json"), "[]\n");
      continue;
    }
    if (step.step_kind === "design_review_conceptual") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(join(incomingDir, "design-review-conceptual-findings.json"), "[]\n");
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
async function disableNarrative(root) {
  const configPath = join(root, ".audit-tools", "audit", "session-config.json");
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

async function nextStepUntilPresentReport(runNextStep) {
  for (let i = 0; i < MAX_FINALIZE_STEPS; i++) {
    const step = JSON.parse((await runNextStep()).stdout);
    assert.equal(step.contract_version, STEP_CONTRACT_VERSION);
    detail(`next-step -> ${step.step_kind} (${step.status})`);
    if (step.step_kind === "present_report") {
      // Mandatory friction triage: present_report pauses at status:"ready" until
      // the host covers every friction category. Attest each clean the way a host
      // would for a no-friction run, then loop so the next call completes.
      // promoteFinalAuditReport deletes the artifacts dir, so recreate the
      // friction subdir before writing.
      if (step.status === "ready" && step.artifact_paths?.friction_record) {
        let record = {};
        try {
          record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8"));
        } catch { /* new record */ }
        record.category_attestations = [
          { category: "ambiguous_direction", note: "none this run" },
          { category: "tool_should_decide", note: "none this run" },
          { category: "inefficient_feeding", note: "none this run" },
        ];
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

function findHostGuidance(installedHost, host) {
  const entry = installedHost.host_guidance.find((item) => item.host === host);
  assert.ok(entry, `expected host guidance for ${host}`);
  return entry;
}

const legacyLocalAuditCodeSurfaceSpecs = [
  {
    path: [".codex", "skills", "audit-code", "SKILL.md"],
    content: [
      "---",
      "name: audit-code",
      "description: Conversation-first autonomous code auditing workflow for the /audit-code command.",
      "---",
      "",
      "# audit-code skill",
      "",
    ].join("\n"),
  },
  {
    path: [".codex", "skills", "audit-code", "audit-code.prompt.md"],
    content: [
      "---",
      "description: Autonomous local loop code auditing",
      "---",
      "",
      "# `/audit-code` Loader",
      "",
      "You are the audit-code orchestrator for this conversation.",
      "",
    ].join("\n"),
  },
  {
    path: [".codex", "skills", "audit-code", "agents", "openai.yaml"],
    content: [
      "interface:",
      "  display_name: \"audit-code\"",
      "  short_description: \"Run the autonomous /audit-code repository audit workflow.\"",
      "  default_prompt: \"Start /audit-code for this repository.\"",
      "",
    ].join("\n"),
  },
  {
    path: [".codex", "skills", "audit-code", "agents", "local-model.yaml"],
    content: [
      "interface:",
      "  display_name: \"audit-code\"",
      "  short_description: \"Run the autonomous /audit-code repository audit workflow.\"",
      "  default_prompt: \"Start /audit-code for this repository.\"",
      "",
    ].join("\n"),
  },
  {
    path: [".opencode", "commands", "audit-code.md"],
    content: [
      "---",
      "description: Autonomous local loop code auditing",
      "---",
      "",
      "# `/audit-code` Loader",
      "",
      "You are the audit-code orchestrator for this conversation.",
      "",
    ].join("\n"),
  },
  {
    path: [".opencode", "skills", "audit-code", "SKILL.md"],
    content: [
      "---",
      "name: audit-code",
      "description: Conversation-first autonomous code auditing workflow for the /audit-code command.",
      "---",
      "",
    ].join("\n"),
  },
  {
    path: [".opencode", "skills", "audit-code", "audit-code.prompt.md"],
    content: [
      "---",
      "description: Autonomous local loop code auditing",
      "---",
      "",
      "# `/audit-code` Loader",
      "",
      "You are the audit-code orchestrator for this conversation.",
      "",
    ].join("\n"),
  },
  {
    path: [".claude", "commands", "audit-code.md"],
    content: [
      "---",
      "description: Autonomous local loop code auditing",
      "---",
      "",
      "# `/audit-code` Loader",
      "",
      "You are the audit-code orchestrator for this conversation.",
      "",
    ].join("\n"),
  },
];

async function writeLegacyLocalAuditCodeSurfaces(root) {
  for (const spec of legacyLocalAuditCodeSurfaceSpecs) {
    const target = join(root, ...spec.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, spec.content);
  }
}

async function assertLegacyLocalAuditCodeSurfacesRemoved(root) {
  for (const spec of legacyLocalAuditCodeSurfaceSpecs) {
    const target = join(root, ...spec.path);
    await assert.rejects(
      () => stat(target),
      `legacy local /audit-code surface should be removed: ${target}`,
    );
  }
}

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSpawn(command, args) {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

function step(label) {
  process.stderr.write(`[smoke:packaged] step: ${label}\n`);
}

function detail(message) {
  process.stderr.write(`[smoke:packaged] detail: ${message}\n`);
}

function success(message) {
  process.stderr.write(`[smoke:packaged] success: ${message}\n`);
}

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function buildCommandFailureMessage({
  label,
  command,
  args,
  cwd,
  code,
  stdout,
  stderr,
  failureHint,
}) {
  const detailSections = [];
  if (stderr.trim().length > 0) {
    detailSections.push(`stderr:\n${stderr.trim()}`);
  }
  if (stdout.trim().length > 0) {
    detailSections.push(`stdout:\n${stdout.trim()}`);
  }

  const lines = [
    `[smoke:packaged] ${label} failed with exit code ${code}.`,
    `command: ${formatCommand(command, args)}`,
    `cwd: ${cwd}`,
  ];
  if (failureHint) {
    lines.push(`hint: ${failureHint}`);
  }
  if (detailSections.length > 0) {
    lines.push(detailSections.join("\n---\n"));
  } else {
    lines.push("No stdout/stderr was captured from the failed command.");
  }
  return lines.join("\n");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveSpawn(command, args);
    const cwd = options.cwd ?? repoRoot;
    const label = options.label ?? formatCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Suppress the console window a windowless parent pops when spawning a
      // console child (npm, the packaged bins) on win32.
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (options.liveOutput) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (options.liveOutput) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(buildCommandFailureMessage({
        label,
        command,
        args,
        cwd,
        code,
        stdout,
        stderr,
        failureHint: options.failureHint,
      })));
    });
  });
}

// `npm publish --dry-run` can leak dry-run flags, registry overrides, and auth
// tokens into child npm invocations. The packaged smoke flow needs a real
// tarball and a clean install, so we intentionally strip npm_config_* overrides
// plus publish credentials before forcing dry-run back off.
function createIsolatedNpmEnv(env = process.env) {
  const nextEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("npm_config_") ||
      normalizedKey === "node_auth_token" ||
      normalizedKey === "npm_token"
    ) {
      continue;
    }
    nextEnv[key] = value;
  }
  // Explicitly force dry-run off in case npm reads it from another source.
  nextEnv.npm_config_dry_run = "false";
  nextEnv.NPM_CONFIG_DRY_RUN = "false";
  nextEnv.NPM_CONFIG_LOGLEVEL = env.NPM_CONFIG_LOGLEVEL ?? (verbose ? "notice" : "warn");
  return nextEnv;
}

function assertPackagedContract(packMetadata) {
  assert.equal(
    Array.isArray(packMetadata.files),
    true,
    "npm pack --json did not return a tarball file list.",
  );
  const packagedPaths = new Set(packMetadata.files.map((entry) => entry.path));
  const missingPaths = requiredPackagedPaths.filter(
    (requiredPath) => !packagedPaths.has(requiredPath),
  );

  if (missingPaths.length > 0) {
    throw new Error(
      `Packed tarball ${packMetadata.filename ?? "(unknown filename)"} is missing required shipped paths: ${missingPaths.join(", ")}. Rerun npm run build and npm pack --dry-run to inspect the packaged file list before retrying the smoke script.`,
    );
  }
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-packaged-smoke-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "smoke-test-repo", version: "0.0.0" }, null, 2) + "\n",
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

async function main() {
  const smokeStart = Date.now();
  let stepStart = Date.now();
  step("start");
  const installDir = await mkdtemp(
    join(tmpdir(), "audit-code-packed-install-"),
  );
  const packDir = await mkdtemp(
    join(tmpdir(), "audit-code-pack-"),
  );
  let tarballPath;
  let tarballFilename;

  try {
    await writeFile(
      join(installDir, "package.json"),
      JSON.stringify(
        {
          name: "audit-code-packed-install-smoke",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );

    stepStart = Date.now();
    step("npm pack");
    detail(
      "Isolating inherited npm_config_* overrides and publish credentials so nested npm publish --dry-run does not suppress tarball generation.",
    );
    const packed = JSON.parse(
      (
        await runCommand(platformCommand("npm"), ["pack", "--json", "--pack-destination", packDir], {
          cwd: repoRoot,
          env: createIsolatedNpmEnv(),
          liveOutput: liveCommandOutput,
          label: "npm pack --json",
          failureHint:
            "If this smoke run is nested under npm publish --dry-run, make sure inherited npm_config_* flags were cleared and rerun with AUDIT_CODE_VERBOSE=1 for live child output.",
        })
      ).stdout,
    );
    // npm pack --json returns either an array (older npm) or object (npm 12+)
    const packEntries = Array.isArray(packed) ? packed : Object.values(packed);
    assert.equal(packEntries.length, 1, "npm pack --json must produce exactly one tarball");
    const packMetadata = packEntries[0];
    assert.ok(packMetadata, "npm pack --json did not return tarball metadata");
    assert.equal(typeof packMetadata.filename, "string");
    assertPackagedContract(packMetadata);
    tarballFilename = packMetadata.filename;
    tarballPath = join(packDir, packMetadata.filename);
    process.stderr.write(`[smoke:packaged] elapsed: npm pack — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    step("npm install from tarball");
    await runCommand(
      platformCommand("npm"),
      ["install", "--no-package-lock", tarballPath],
      {
        cwd: installDir,
        env: createIsolatedNpmEnv(),
        liveOutput: liveCommandOutput,
        label: "npm install --no-package-lock <tarball>",
        failureHint:
          "Confirm the tarball exists on disk, the inherited npm publish env was stripped, and rerun with AUDIT_CODE_VERBOSE=1 if the install stalls or the registry config looks wrong.",
      },
    );
    const auditCodeCommand = installedAuditCodeCommand(installDir);
    const packagedPromptPath = join(
      installDir,
      "node_modules",
      "audit-tools",
      "skills",
      "audit-code",
      "audit-code.prompt.md",
    );
    process.stderr.write(`[smoke:packaged] elapsed: npm install from tarball — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    step("prompt-path check");
    const promptPathOutput = (
      await runCommand(auditCodeCommand, ["prompt-path"], { cwd: installDir })
    ).stdout.trim();
    assert.equal(promptPathOutput, packagedPromptPath);
    assert.equal((await stat(promptPathOutput)).isFile(), true);
    assert.match(
      await readFile(promptPathOutput, "utf8"),
      /\/audit-code/,
    );
    process.stderr.write(`[smoke:packaged] elapsed: prompt-path check — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    step("--version check");
    const versionOutput = (
      await runCommand(auditCodeCommand, ["--version"], { cwd: installDir })
    ).stdout.trim();
    assert.equal(versionOutput, packageVersion);
    process.stderr.write(`[smoke:packaged] elapsed: --version check — ${Date.now() - stepStart}ms\n`);

    await withTempRepo(async (root) => {
      stepStart = Date.now();
      step("ensure self-bootstrap");
      const ensured = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["ensure"],
            {
              cwd: root,
              label: "audit-code ensure",
              failureHint:
                "Review the host bootstrap files under .audit-code/install and rerun with AUDIT_CODE_VERBOSE=1 for more child-process output.",
            },
          )
        ).stdout,
      );
      assert.equal(ensured.status, "ok");
      assert.equal(ensured.action, "installed");
      assert.equal(ensured.host_count, 4);

      const ensuredAgain = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["ensure"],
            {
              cwd: root,
              label: "audit-code ensure (idempotent)",
              failureHint:
                "The second ensure call should detect current repo-local assets and skip rewrites.",
            },
          )
        ).stdout,
      );
      assert.equal(ensuredAgain.status, "ok");
      assert.equal(ensuredAgain.action, "skipped");
      process.stderr.write(`[smoke:packaged] elapsed: ensure self-bootstrap — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("ensure removes stale local command surfaces");
      await writeLegacyLocalAuditCodeSurfaces(root);
      const ensuredAfterLegacySurfaces = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["ensure"],
            {
              cwd: root,
              label: "audit-code ensure (legacy local surfaces)",
              failureHint:
                "The installer should remove stale repo-local /audit-code command, skill, prompt, and interface metadata surfaces for every supported host.",
            },
          )
        ).stdout,
      );
      assert.equal(ensuredAfterLegacySurfaces.status, "ok");
      assert.equal(ensuredAfterLegacySurfaces.action, "installed");
      assert.equal(
        ensuredAfterLegacySurfaces.reason,
        "legacy_local_audit_code_surface",
      );
      await assertLegacyLocalAuditCodeSurfacesRemoved(root);
      process.stderr.write(`[smoke:packaged] elapsed: ensure removes stale local command surfaces — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("install");
      const installedHost = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["install"],
            {
              cwd: root,
              label: "audit-code install",
              failureHint:
                "Review the host bootstrap files under .audit-code/install and rerun with AUDIT_CODE_VERBOSE=1 for more child-process output.",
            },
          )
        ).stdout,
      );
      const installedPromptPath = join(
        root,
        ".audit-code",
        "install",
        "audit-code.import.md",
      );
      const installGuidePath = join(
        root,
        ".audit-code",
        "install",
        "GETTING-STARTED.md",
      );
      const installManifestPath = join(
        root,
        ".audit-code",
        "install",
        "manifest.json",
      );
      const vscodePromptPath = join(
        root,
        ".github",
        "prompts",
        "audit-code.prompt.md",
      );
      const vscodeAgentPath = join(
        root,
        ".github",
        "agents",
        "auditor.agent.md",
      );
      const opencodeConfigPath = join(root, "opencode.json");
      const legacyCodexSkillPath = join(
        root,
        ".codex",
        "skills",
        "audit-code",
        "SKILL.md",
      );
      const legacyCodexPromptPath = join(
        root,
        ".codex",
        "skills",
        "audit-code",
        "audit-code.prompt.md",
      );
      const legacyCodexOpenAiAgentPath = join(
        root,
        ".codex",
        "skills",
        "audit-code",
        "agents",
        "openai.yaml",
      );
      const agentsPath = join(root, "AGENTS.md");
      const antigravityPlanningGuidePath = join(
        root,
        ".audit-code",
        "install",
        "antigravity",
        "PLANNING-MODE.md",
      );
      const geminiCommandPath = join(
        root,
        ".gemini",
        "commands",
        "audit-code.toml",
      );
      const antigravitySkillPath = join(
        root,
        ".agent",
        "skills",
        "audit-code",
        "SKILL.md",
      );
      const installManifest = JSON.parse(
        await readFile(installManifestPath, "utf8"),
      );
      assert.equal(installedHost.host, "all");
      assert.equal(installedHost.installed_prompt_path, installedPromptPath);
      assert.equal(installedHost.install_guide_path, installGuidePath);
      assert.equal(installedHost.install_manifest_path, installManifestPath);
      // The MCP surface was removed: install no longer emits an MCP server launcher.
      assert.equal(installedHost.mcp_server_launcher_path, undefined);
      assert.equal(installedHost.slash_command_surfaces.vscode_prompt, vscodePromptPath);
      assert.equal(
        installedHost.slash_command_surfaces.opencode_config,
        opencodeConfigPath,
      );
      assert.equal(installedHost.instruction_surfaces.agents, agentsPath);
      assert.equal(
        installedHost.instruction_surfaces.copilot_instructions,
        join(root, ".github", "copilot-instructions.md"),
      );
      assert.equal(installedHost.host_guidance.length, 4);
      assert.deepEqual(
        installedHost.host_guidance.map((entry) => entry.host),
        ["codex", "opencode", "vscode", "antigravity"],
      );
      assert.equal(
        findHostGuidance(installedHost, "codex").primary_path,
        agentsPath,
      );
      assert.equal(
        findHostGuidance(installedHost, "vscode").primary_path,
        vscodePromptPath,
      );
      assert.equal(
        findHostGuidance(installedHost, "opencode").primary_path,
        opencodeConfigPath,
      );
      assert.equal(
        findHostGuidance(installedHost, "antigravity").primary_path,
        antigravitySkillPath,
      );
      assert.ok(
        findHostGuidance(installedHost, "antigravity").supporting_paths.includes(geminiCommandPath),
      );
      assert.ok(
        findHostGuidance(installedHost, "antigravity").supporting_paths.includes(antigravityPlanningGuidePath),
      );
      assert.equal(await readFile(installedPromptPath, "utf8"), await readFile(packagedPromptPath, "utf8"));
      assert.match(
        await readFile(installGuidePath, "utf8"),
        /## Codex/,
      );
      assert.match(
        await readFile(installGuidePath, "utf8"),
        /## VS Code/,
      );
      assert.match(
        await readFile(installGuidePath, "utf8"),
        /## OpenCode/,
      );
      assert.match(
        await readFile(installGuidePath, "utf8"),
        /## Antigravity/,
      );
      assert.doesNotMatch(
        await readFile(installGuidePath, "utf8"),
        /## Claude Desktop/,
      );
      assert.match(
        await readFile(vscodePromptPath, "utf8"),
        /^---\nname: audit-code\ndescription: Autonomous local loop code auditing\nagent: auditor/m,
      );
      assert.match(await readFile(vscodeAgentPath, "utf8"), /# Audit Code Agent/);
      const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
      assert.equal(opencodeConfig.command?.["audit-code"], undefined, "project opencode.json must not define the global /audit-code command");
      assert.equal(opencodeConfig.mcp?.auditor, undefined, "project opencode.json must not define mcp.auditor (global config owns it)");
      await assert.rejects(() => stat(join(root, ".opencode", "commands", "audit-code.md")), "legacy command file must not be generated");
      await assert.rejects(() => stat(legacyCodexSkillPath));
      await assert.rejects(() => stat(legacyCodexPromptPath));
      await assert.rejects(() => stat(legacyCodexOpenAiAgentPath));
      assert.match(await readFile(agentsPath, "utf8"), /When the user enters `\/audit-code`/);
      // The MCP surface was removed: install must not write the MCP server launcher
      // or the Claude Desktop bundle.
      await assert.rejects(() =>
        stat(join(root, ".audit-code", "install", "run-mcp-server.mjs")),
      );
      await assert.rejects(() =>
        stat(join(root, ".audit-code", "install", "claude-desktop")),
      );
      assert.equal(installedHost.unsupported_hosts.length, 0);
      assert.equal(installManifest.contract_version, "audit-code-install/v1alpha1");
      assert.equal(installManifest.hosts.length, 4);
      process.stderr.write(`[smoke:packaged] elapsed: install — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("verify generated host assets");
      const verifiedInstall = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["verify-install"],
            {
              cwd: root,
              label: "audit-code verify-install",
              failureHint:
                "Inspect the generated install manifest and host guidance files under .audit-code/install for the failing host surface.",
            },
          )
        ).stdout,
      );
      assert.equal(verifiedInstall.status, "ok");
      assert.equal(verifiedInstall.issue_count, 0);
      assert.equal(verifiedInstall.hosts.length, 4);
      process.stderr.write(`[smoke:packaged] elapsed: verify generated host assets — ${Date.now() - stepStart}ms\n`);

      const runNextStep = () =>
        runCommand(auditCodeCommand, ["next-step"], {
          cwd: root,
          label: "audit-code next-step",
          failureHint:
            "Inspect .audit-tools/audit/steps/current-step.json and rerun with AUDIT_CODE_VERBOSE=1 if the packaged wrapper fails earlier than expected.",
        });

      stepStart = Date.now();
      step("next-step until dispatch_review (expect a ready review step)");
      const dispatchStep = await advanceToDispatchReady(runNextStep, root);
      assert.equal(dispatchStep.contract_version, "audit-code-step/v1alpha1");
      assert.equal(dispatchStep.status, "ready");
      assert.match(dispatchStep.step_kind, /^(dispatch_review|single_task_fallback)$/);
      assert.ok(dispatchStep.run_id);
      const tasks = JSON.parse(
        await readFile(join(root, ".audit-tools", "audit", "audit_tasks.json"), "utf8"),
      );
      assert.ok(tasks.length > 0);
      process.stderr.write(`[smoke:packaged] elapsed: next-step until dispatch_review — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("ingest synthetic results");
      const resultsPath = join(root, "audit_results.json");
      await writeFile(
        resultsPath,
        JSON.stringify(
          await buildSyntheticResults(tasks, root),
          null,
          2,
        ),
      );
      await disableNarrative(root);
      const ingested = JSON.parse(
        (
          await runCommand(
            process.execPath,
            [
              installedDistCliPath(installDir),
              "ingest-results",
              "--root",
              root,
              "--artifacts-dir",
              join(root, ".audit-tools", "audit"),
              "--results",
              resultsPath,
            ],
            {
              cwd: root,
              label: "ingest-results --results <synthetic-results>",
              failureHint:
                "Inspect the generated audit_results.json file and .audit-tools/audit contents if ingestion fails unexpectedly.",
            },
          )
        ).stdout,
      );
      assert.equal(ingested.selected_executor, "result_ingestion_executor");
      process.stderr.write(`[smoke:packaged] elapsed: ingest synthetic results — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("next-step until present_report (expect completion + promotion)");
      const presented = await nextStepUntilPresentReport(runNextStep);
      assert.equal(presented.status, "complete");
      assert.equal(
        await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8").then((content) => /# Audit Report/.test(content)),
        true,
      );
      await stat(join(root, ".audit-tools", "audit-findings.json"));
      // Completion cleans the audit working artifacts (only the present_report
      // step scaffolding remains so the host can follow prompt_path).
      await assert.rejects(() =>
        stat(join(root, ".audit-tools", "audit", "audit_tasks.json")),
      );
      process.stderr.write(`[smoke:packaged] elapsed: next-step until present_report — ${Date.now() - stepStart}ms\n`);

      stepStart = Date.now();
      step("rerun after completion (expect a fresh audit step)");
      const rerun = JSON.parse((await runNextStep()).stdout);
      assert.equal(rerun.contract_version, "audit-code-step/v1alpha1");
      assert.notEqual(
        rerun.step_kind,
        "present_report",
        "a rerun after completion must start a fresh audit, not re-present the old report",
      );
      assert.equal(rerun.status, "ready");
      process.stderr.write(`[smoke:packaged] elapsed: rerun after completion (expect a fresh audit step) — ${Date.now() - stepStart}ms\n`);
    });

    success(
      `Validated tarball ${tarballFilename}, packaged install bootstrap surfaces, and the next-step/ingest-results/present_report audit flow. Total elapsed: ${Math.round((Date.now() - smokeStart) / 1000)}s.`,
    );
  } finally {
    if (tarballPath) {
      await rm(tarballPath, { force: true });
    }
    await rm(installDir, { recursive: true, force: true });
    await rm(packDir, { recursive: true, force: true });
  }
}

await main();
