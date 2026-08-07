import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real subprocess round-trips (install/ensure/verify-install
// wrapper invocations), and the cases are `concurrent`, so under a full-suite
// run they contend with siblings. Single-sourced ceiling — see
// tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  assertOpenCodeAuditPermissions,
  assertSharedHostInstallResponse,
  hostGuidance,
  repoRoot,
  runWrapper,
  runWrapperJsonOutput,
  setupRepoLocalHostInstallFixture,
  withTempRepo,
  type HostInstallPaths,
  type HostStatusReport,
  type InstallResponse,
} from "./helpers/wrapper-harness.js";

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

interface RepoLocalHostCase {
  name: string;
  host: string;
  assertHost: (
    root: string,
    parsed: InstallResponse,
    paths: HostInstallPaths,
  ) => Promise<void>;
}

const repoLocalHostCases: RepoLocalHostCase[] = [
  {
    name: "Codex",
    host: "codex",
    async assertHost(_root, parsed, paths) {
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
      // including --auditor '{"self":{...}}' rather than bespoke abbreviated prose.
      const vscodeAgent = await readFile(paths.vscodeAgentPath, "utf8");
      expect(vscodeAgent).toMatch(/# Audit Code Agent/);
      expect(vscodeAgent).toMatch(/--auditor/);
      expect(vscodeAgent).toMatch(/node audit-code\.mjs/);
      // The MCP surface was removed: install no longer writes .vscode/mcp.json.
      await assert.rejects(() => stat(join(root, ".vscode", "mcp.json")));
      expect(await readFile(paths.installGuidePath, "utf8")).toMatch(/## VS Code/);
    },
  },
  {
    name: "OpenCode",
    host: "opencode",
    async assertHost(_root, parsed, paths) {
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
    async assertHost(_root, parsed, paths) {
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
    const installManifest: HostStatusReport = JSON.parse(
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
    const { parsed: verifiedInstall }: { parsed: HostStatusReport } =
      await runWrapperJsonOutput(["verify-install"], { cwd: root });

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

    const parsed: InstallResponse = JSON.parse(
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
