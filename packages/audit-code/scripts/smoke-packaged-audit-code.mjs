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
import { assertMatchesJsonSchema } from "../tests/helpers/jsonSchemaAssert.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json");
const packageJsonPath = join(repoRoot, "package.json");
const responseSchema = JSON.parse(await readFile(schemaPath, "utf8"));
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;
const requiredPackagedPaths = [
  "audit-code.mjs",
  "audit-code-wrapper-lib.mjs",
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/cli.js",
  "dist/mcp/server.js",
  "dispatch/lens-definitions.json",
  "schemas/audit-code-v1alpha1.schema.json",
  "skills/audit-code/SKILL.md",
  "skills/audit-code/agents/openai.yaml",
  "skills/audit-code/audit-code.prompt.md",
];
const verbose = process.env.AUDIT_CODE_VERBOSE === "1";
const liveCommandOutput = verbose || process.env.CI === "true";

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

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function createMcpClient(command, args, options = {}) {
  const resolved = resolveSpawn(command, args);
  const child = spawn(resolved.command, resolved.args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) {
        return;
      }
      const headerBlock = buffer.slice(0, separator).toString("utf8");
      const contentLengthHeader = headerBlock
        .split("\r\n")
        .find((header) => header.toLowerCase().startsWith("content-length:"));
      if (!contentLengthHeader) {
        return;
      }
      const contentLength = Number(contentLengthHeader.split(":")[1]?.trim());
      const frameLength = separator + 4 + contentLength;
      if (buffer.length < frameLength) {
        return;
      }

      const payload = JSON.parse(
        buffer.slice(separator + 4, frameLength).toString("utf8"),
      );
      buffer = buffer.slice(frameLength);

      if (pending.has(payload.id)) {
        pending.get(payload.id)(payload);
        pending.delete(payload.id);
      }
    }
  });

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      pending.set(id, (payload) => {
        if (payload.error) {
          reject(new Error(payload.error.message));
          return;
        }
        resolve(payload.result);
      });
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      );
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        method,
        params,
      }),
    );
  }

  async function close() {
    await request("shutdown", "shutdown");
    notify("exit");
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
  }

  return { request, notify, close };
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
  step("start");
  const installDir = await mkdtemp(
    join(tmpdir(), "audit-code-packed-install-"),
  );
  let tarballPath;
  let tarballFilename;
  let sharedTarballPath;

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

    step("npm pack @audit-tools/shared");
    if (liveCommandOutput) {
      detail(
        "Streaming child npm output because AUDIT_CODE_VERBOSE=1 or CI=true is set.",
      );
    }
    detail(
      "Isolating inherited npm_config_* overrides and publish credentials so nested npm publish --dry-run does not suppress tarball generation.",
    );
    const sharedRoot = join(repoRoot, "..", "shared");
    const sharedPacked = JSON.parse(
      (
        await runCommand(platformCommand("npm"), ["pack", "--json"], {
          cwd: sharedRoot,
          env: createIsolatedNpmEnv(),
          liveOutput: liveCommandOutput,
          label: "npm pack --json (@audit-tools/shared)",
          failureHint:
            "The @audit-tools/shared workspace package must be built before packing.",
        })
      ).stdout,
    );
    assert.equal(Array.isArray(sharedPacked), true);
    sharedTarballPath = join(sharedRoot, sharedPacked[0].filename);

    step("npm pack");
    const packed = JSON.parse(
      (
        await runCommand(platformCommand("npm"), ["pack", "--json"], {
          cwd: repoRoot,
          env: createIsolatedNpmEnv(),
          liveOutput: liveCommandOutput,
          label: "npm pack --json",
          failureHint:
            "If this smoke run is nested under npm publish --dry-run, make sure inherited npm_config_* flags were cleared and rerun with AUDIT_CODE_VERBOSE=1 for live child output.",
        })
      ).stdout,
    );
    assert.equal(Array.isArray(packed), true);
    assert.equal(packed.length, 1);
    assert.equal(typeof packed[0].filename, "string");
    assertPackagedContract(packed[0]);
    tarballFilename = packed[0].filename;
    tarballPath = join(repoRoot, packed[0].filename);

    step("npm install from tarball");
    await runCommand(
      platformCommand("npm"),
      ["install", "--no-package-lock", sharedTarballPath, tarballPath],
      {
        cwd: installDir,
        env: createIsolatedNpmEnv(),
        liveOutput: liveCommandOutput,
        label: "npm install --no-package-lock <shared-tarball> <tarball>",
        failureHint:
          "Confirm the tarball exists on disk, the inherited npm publish env was stripped, and rerun with AUDIT_CODE_VERBOSE=1 if the install stalls or the registry config looks wrong.",
      },
    );
    const auditCodeCommand = installedAuditCodeCommand(installDir);
    const packagedPromptPath = join(
      installDir,
      "node_modules",
      "auditor-lambda",
      "skills",
      "audit-code",
      "audit-code.prompt.md",
    );

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

    step("--version check");
    const versionOutput = (
      await runCommand(auditCodeCommand, ["--version"], { cwd: installDir })
    ).stdout.trim();
    assert.equal(versionOutput, packageVersion);

    await withTempRepo(async (root) => {
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
      assert.equal(ensured.host_count, 5);

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
      const mcpLauncherPath = join(
        root,
        ".audit-code",
        "install",
        "run-mcp-server.mjs",
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
      const vscodeMcpPath = join(root, ".vscode", "mcp.json");
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
      const claudeDesktopDxtPath = join(
        root,
        ".audit-code",
        "install",
        "claude-desktop",
        "auditor-lambda.dxt",
      );
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
      assert.equal(installedHost.mcp_server_launcher_path, mcpLauncherPath);
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
      assert.equal(installedHost.host_guidance.length, 5);
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
        findHostGuidance(installedHost, "claude-desktop").primary_path,
        claudeDesktopDxtPath,
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
        /## Claude Desktop/,
      );
      assert.match(
        await readFile(installGuidePath, "utf8"),
        /## Antigravity/,
      );
      assert.match(
        await readFile(vscodePromptPath, "utf8"),
        /^---\nname: audit-code\ndescription: Autonomous local loop code auditing\nagent: auditor/m,
      );
      assert.match(await readFile(vscodeAgentPath, "utf8"), /# Auditor Agent/);
      assert.match(
        await readFile(vscodeMcpPath, "utf8"),
        /run-mcp-server\.mjs/,
      );
      const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
      assert.equal(opencodeConfig.command?.["audit-code"], undefined, "project opencode.json must not define the global /audit-code command");
      assert.equal(opencodeConfig.mcp?.auditor, undefined, "project opencode.json must not define mcp.auditor (global config owns it)");
      await assert.rejects(() => stat(join(root, ".opencode", "commands", "audit-code.md")), "legacy command file must not be generated");
      await assert.rejects(() => stat(legacyCodexSkillPath));
      await assert.rejects(() => stat(legacyCodexPromptPath));
      await assert.rejects(() => stat(legacyCodexOpenAiAgentPath));
      assert.match(await readFile(agentsPath, "utf8"), /When the user enters `\/audit-code`/);
      assert.match(
        await readFile(mcpLauncherPath, "utf8"),
        /Unable to locate an audit-code executable/,
      );
      const dxtInfo = await stat(claudeDesktopDxtPath);
      assert.equal(dxtInfo.isFile(), true);
      assert.ok(dxtInfo.size > 0);
      assert.equal(installedHost.unsupported_hosts.length, 0);
      assert.equal(installManifest.contract_version, "audit-code-install/v1alpha1");
      assert.equal(installManifest.hosts.length, 5);

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
      assert.equal(verifiedInstall.hosts.length, 5);

      step("packaged mcp initialize");
      const mcpClient = createMcpClient(
        auditCodeCommand,
        ["mcp", "--root", root, "--artifacts-dir", join(root, ".audit-artifacts")],
        { cwd: root },
      );
      try {
        const initialize = await mcpClient.request("init", "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "packaged-smoke",
            version: "1.0.0",
          },
        });
        assert.equal(initialize.protocolVersion, "2025-06-18");
        assert.equal(initialize.serverInfo.name, "audit-code");
        mcpClient.notify("notifications/initialized");
        const tools = await mcpClient.request("tools", "tools/list");
        assert.ok(
          tools.tools.some((tool) => tool.name === "start_audit"),
          "expected start_audit tool in packaged MCP server",
        );
        const status = await mcpClient.request("status", "tools/call", {
          name: "get_status",
          arguments: {},
        });
        assert.equal(status.structuredContent.audit_state.status, "not_started");
      } finally {
        await mcpClient.close();
      }

      step("first run (expect blocked)");
      const blocked = JSON.parse(
        (
          await runCommand(auditCodeCommand, [], {
            cwd: root,
            label: "audit-code (initial run)",
            failureHint:
              "Inspect .audit-artifacts/operator-handoff.* and rerun with AUDIT_CODE_VERBOSE=1 if the packaged wrapper blocks earlier than expected.",
          })
        ).stdout,
      );
      assertMatchesJsonSchema(
        responseSchema,
        blocked,
        "auditCodeResponse:blocked",
      );
      assert.equal(blocked.contract_version, "audit-code/v1alpha1");
      assert.equal(blocked.audit_state.status, "blocked");
      assert.equal(blocked.progress_made, true);
      assert.equal(blocked.next_likely_step, null);
      assert.equal(blocked.selected_executor, "agent");
  assert.equal(blocked.handoff.status, "blocked");
  // Provider could be opencode if available, or local-subprocess as fallback
  assert.ok(/local-subprocess|opencode|claude-code/.test(blocked.handoff.provider ?? ""));

      const tasks = JSON.parse(
        await readFile(join(root, ".audit-artifacts", "audit_tasks.json"), "utf8"),
      );
      const resultsPath = join(root, "audit_results.json");
      await writeFile(
        resultsPath,
        JSON.stringify(
          await buildSyntheticResults(tasks, root),
          null,
          2,
        ),
      );

      step("ingest results (expect completed)");
      const completed = JSON.parse(
        (
          await runCommand(
            auditCodeCommand,
            ["--results", resultsPath],
            {
              cwd: root,
              label: "audit-code --results <synthetic-results>",
              failureHint:
                "Inspect the generated audit_results.json file and .audit-artifacts contents if ingestion or synthesis fails unexpectedly.",
            },
          )
        ).stdout,
      );
      assertMatchesJsonSchema(
        responseSchema,
        completed,
        "auditCodeResponse:completed",
      );
      assert.equal(completed.selected_executor, "synthesis_executor");
      assert.equal(completed.audit_state.status, "complete");
      assert.equal(completed.next_likely_step, null);
      assert.equal(completed.handoff.status, "complete");
      assert.equal(
        await readFile(join(root, "audit-report.md"), "utf8").then((content) => /# Audit Report/.test(content)),
        true,
      );

      step("rerun after completion (expect a fresh blocked audit)");
      const rerun = JSON.parse(
        (
          await runCommand(auditCodeCommand, [], {
            cwd: root,
            label: "audit-code (rerun after completion)",
            failureHint:
              "A rerun should start a fresh blocked audit. Inspect the retained audit-report.md and regenerated .audit-artifacts state if behavior diverges.",
          })
        ).stdout,
      );
      assertMatchesJsonSchema(
        responseSchema,
        rerun,
        "auditCodeResponse:rerun",
      );
      assert.equal(rerun.progress_made, true);
      assert.equal(rerun.audit_state.status, "blocked");
      assert.equal(rerun.selected_executor, "agent");
      assert.equal(rerun.next_likely_step, null);
      assert.equal(rerun.handoff.status, "blocked");
    });

    success(
      `Validated tarball ${tarballFilename}, packaged install bootstrap surfaces, packaged MCP startup, and the blocked/completed/rerun audit flow.`,
    );
  } finally {
    if (tarballPath) {
      await rm(tarballPath, { force: true });
    }
    if (sharedTarballPath) {
      await rm(sharedTarballPath, { force: true });
    }
    await rm(installDir, { recursive: true, force: true });
  }
}

await main();
