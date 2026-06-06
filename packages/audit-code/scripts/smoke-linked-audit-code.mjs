import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertMatchesJsonSchema } from "../tests/helpers/jsonSchemaAssert.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json");
const packageJsonPath = join(repoRoot, "package.json");
const responseSchema = JSON.parse(await readFile(schemaPath, "utf8"));
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;
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
    notes: ["Synthetic completion result for linked smoke coverage."],
    requires_followup: false,
  })));
}

function platformCommand(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
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
  process.stderr.write(`[smoke:linked] step: ${label}\n`);
}

function detail(message) {
  process.stderr.write(`[smoke:linked] detail: ${message}\n`);
}

function success(message) {
  process.stderr.write(`[smoke:linked] success: ${message}\n`);
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
    `[smoke:linked] ${label} failed with exit code ${code}.`,
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

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-smoke-"));
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
  step("npm link");
  await runCommand(platformCommand("npm"), ["link"], {
    cwd: repoRoot,
    liveOutput: liveCommandOutput,
    label: "npm link",
    failureHint:
      "Confirm the repository builds locally and that npm link has permission to create the global symlink for this user.",
  });
  process.stderr.write(`[smoke:linked] elapsed: npm link — ${Date.now() - stepStart}ms\n`);
  const auditCodeCommand = platformCommand("audit-code");

  stepStart = Date.now();
  step("--version check");
  const versionOutput = (
    await runCommand(auditCodeCommand, ["--version"], {
      label: "audit-code --version",
      failureHint:
        "Confirm npm link completed successfully and that the linked audit-code binary is on PATH before retrying.",
    })
  ).stdout.trim();
  assert.equal(versionOutput, packageVersion);
  process.stderr.write(`[smoke:linked] elapsed: --version check — ${Date.now() - stepStart}ms\n`);

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
              "Inspect the generated .audit-code/install files and rerun with AUDIT_CODE_VERBOSE=1 for more child-process output.",
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
    process.stderr.write(`[smoke:linked] elapsed: ensure self-bootstrap — ${Date.now() - stepStart}ms\n`);

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
    process.stderr.write(`[smoke:linked] elapsed: ensure removes stale local command surfaces — ${Date.now() - stepStart}ms\n`);

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
              "Inspect the generated .audit-code/install files and rerun with AUDIT_CODE_VERBOSE=1 for more child-process output.",
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
    assert.equal(
      await readFile(installedPromptPath, "utf8"),
      await readFile(join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"), "utf8"),
    );
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
    assert.match(await readFile(vscodeAgentPath, "utf8"), /# Auditor Agent/);
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
    process.stderr.write(`[smoke:linked] elapsed: install — ${Date.now() - stepStart}ms\n`);

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
    process.stderr.write(`[smoke:linked] elapsed: verify generated host assets — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    step("first run (expect blocked)");
    const blocked = JSON.parse(
      (
        await runCommand(auditCodeCommand, [], {
          cwd: root,
          label: "audit-code (initial run)",
          failureHint:
            "Inspect .audit-tools/audit/operator-handoff.* and rerun with AUDIT_CODE_VERBOSE=1 if the linked wrapper blocks earlier than expected.",
        })
      ).stdout,
    );
    assertMatchesJsonSchema(
      responseSchema,
      blocked,
      "auditCodeResponse:blocked",
    );
    assert.equal(blocked.audit_state.status, "blocked");
    assert.equal(blocked.progress_made, true);
    assert.equal(blocked.next_likely_step, null);
    assert.equal(blocked.selected_executor, "agent");
    assert.ok(blocked.artifacts_written.includes("run-ledger.json"));
  assert.equal(blocked.handoff.status, "blocked");
  // Provider could be opencode if available, or local-subprocess as fallback
  assert.ok(/local-subprocess|opencode|claude-code/.test(blocked.handoff.provider ?? ""));
    process.stderr.write(`[smoke:linked] elapsed: first run (expect blocked) — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    const tasks = JSON.parse(
      await readFile(join(root, ".audit-tools", "audit", "audit_tasks.json"), "utf8"),
    );
    const resultsPath = join(root, "audit_results.json");
    await writeFile(
      resultsPath,
      JSON.stringify(await buildSyntheticResults(tasks, root), null, 2),
    );

    stepStart = Date.now();
    step("ingest results (expect completed)");
    const completed = JSON.parse(
      (
        await runCommand(auditCodeCommand, ["--results", resultsPath], {
          cwd: root,
          label: "audit-code --results <synthetic-results>",
          failureHint:
            "Inspect the generated audit_results.json file and .audit-tools/audit contents if ingestion or synthesis fails unexpectedly.",
        })
      ).stdout,
    );
    assertMatchesJsonSchema(
      responseSchema,
      completed,
      "auditCodeResponse:completed",
    );
    assert.equal(completed.audit_state.status, "complete");
    assert.equal(completed.progress_made, true);
    assert.equal(completed.next_likely_step, null);
    assert.equal(completed.selected_executor, "synthesis_narrative_executor");
    assert.equal(completed.handoff.status, "complete");
    assert.equal(
      await readFile(join(root, ".audit-tools", "audit-report.md"), "utf8").then((content) => /# Audit Report/.test(content)),
      true,
    );
    process.stderr.write(`[smoke:linked] elapsed: ingest results (expect completed) — ${Date.now() - stepStart}ms\n`);

    stepStart = Date.now();
    step("rerun after completion (expect a fresh blocked audit)");
    const rerun = JSON.parse(
      (
        await runCommand(auditCodeCommand, [], {
          cwd: root,
          label: "audit-code (rerun after completion)",
          failureHint:
            "A rerun should start a fresh blocked audit. Inspect the retained .audit-tools/audit-report.md and regenerated .audit-tools/audit state if behavior diverges.",
        })
      ).stdout,
    );
    assertMatchesJsonSchema(
      responseSchema,
      rerun,
      "auditCodeResponse:rerun",
    );
    assert.equal(rerun.selected_executor, "agent");
    assert.equal(rerun.audit_state.status, "blocked");
    assert.equal(rerun.progress_made, true);
    assert.equal(rerun.next_likely_step, null);
    assert.equal(rerun.handoff.status, "blocked");
    process.stderr.write(`[smoke:linked] elapsed: rerun after completion (expect a fresh blocked audit) — ${Date.now() - stepStart}ms\n`);
  });

  success(
    `Validated npm link installation, linked host bootstrap surfaces, and the blocked/completed/rerun audit flow. Total elapsed: ${Math.round((Date.now() - smokeStart) / 1000)}s.`,
  );
}

// Remove the global `npm link` this smoke creates. Leaving it behind is a real
// footgun: when this checkout (often an ephemeral git worktree) is later
// removed, the global `auditor-lambda` package junction dangles and every
// global `audit-code` invocation dies with a raw MODULE_NOT_FOUND. Always clean
// up — even when the smoke fails partway — and never let cleanup failure mask
// the smoke's own result.
async function removeGlobalLink() {
  await runCommand(platformCommand("npm"), ["rm", "--global", "auditor-lambda"], {
    cwd: repoRoot,
    label: "npm unlink (cleanup)",
    failureHint:
      "Run `npm rm --global auditor-lambda` to remove the smoke test's global link.",
  }).catch((error) => {
    process.stderr.write(
      "[smoke:linked] warning: could not remove the global link; run " +
        "`npm rm --global auditor-lambda` manually: " +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}

try {
  await main();
} finally {
  await removeGlobalLink();
}
