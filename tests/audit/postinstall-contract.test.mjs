import { test, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const postinstallPath = join(repoRoot, "scripts", "postinstall.mjs");

function runPostinstall(homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [postinstallPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        // These tests assert on skill/permission seeding, not repo-visibility
        // detection. Pin an explicit visibility so the deliverable-gitignore
        // unknown-visibility warning never fires here (it would otherwise emit
        // to stderr on a runner without `gh`, e.g. Linux CI). The visibility
        // behavior itself is covered by tests/shared/gitignore-artifacts.test.mjs.
        AUDIT_TOOLS_REPO_VISIBILITY: "private",
      },
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
      reject(new Error(stderr || stdout || `postinstall exited with ${code}`));
    });
  });
}

test("postinstall seeds Codex skill metadata with the canonical hyphenated display name", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-code-postinstall-home-"));
  try {
    const result = await runPostinstall(homeDir);
    const codexSkillDir = join(homeDir, ".codex", "skills", "audit-code");
    const openAiMetadataPath = join(codexSkillDir, "agents", "openai.yaml");
    const opencodeConfigPath = join(homeDir, ".config", "opencode", "opencode.json");

    expect((await stat(join(codexSkillDir, "SKILL.md"))).isFile()).toBe(true);
    expect((await stat(join(codexSkillDir, "audit-code.prompt.md"))).isFile()).toBe(true);
    expect((await stat(openAiMetadataPath)).isFile()).toBe(true);
    expect(await readFile(openAiMetadataPath, "utf8")).toMatch(/display_name: "audit-code"/);
    const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
    expect(opencodeConfig.permission?.read).toBe("allow");
    expect(opencodeConfig.permission?.grep).toBe("allow");
    // Global scope must not seed broad allows (CFG-4996560e).
    expect(opencodeConfig.permission?.external_directory).toBe(undefined);
    expect(opencodeConfig.permission?.bash?.["*"]).toBe(undefined);
    expect(opencodeConfig.permission?.bash?.["audit-code"]).toBe("allow");
    expect(opencodeConfig.permission?.bash?.["audit-code next-step*"]).toBe("allow");
    expect(opencodeConfig.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
    // Single-package postinstall runs both the audit and remediate halves, so the
    // shared global opencode.json also carries the remediate scope's allows
    // (e.g. "Select-String *"). The audit half still seeds no broad allows of its own.
    expect(opencodeConfig.agent?.auditor?.permission?.read).toBe("allow");
    expect(opencodeConfig.agent?.auditor?.permission?.bash?.["*audit-code.mjs* synthesize*"]).toBe("deny");
    expect(result.stdout).toMatch(/Codex skill UI metadata/);
    expect(result.stderr).toBe("");

    // Claude Desktop command file
    const claudeCommandPath = join(homeDir, ".claude", "commands", "audit-code.md");
    expect((await stat(claudeCommandPath)).isFile()).toBe(true);
    expect(await readFile(claudeCommandPath, "utf8")).toMatch(/audit-code/);

    // Antigravity (Gemini IDE) plugin files
    const antigravityPluginDir = join(homeDir, ".gemini", "config", "plugins", "audit-code");
    const antigravityPluginJsonPath = join(antigravityPluginDir, "plugin.json");
    const antigravityPluginSkillPath = join(antigravityPluginDir, "skills", "SKILL.md");
    expect((await stat(antigravityPluginJsonPath)).isFile()).toBe(true);
    expect((await stat(antigravityPluginSkillPath)).isFile()).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

// NOTE (OBL-013): these tests verify the *deployed config shape* only. Whether
// agent-scoped allowances (agent.auditor.permission) actually propagate to
// subtasks spawned inside a live OpenCode install cannot be exercised in unit
// tests; validating real OpenCode subtask permission inheritance is a manual,
// user-owned follow-up.
async function seedOpenCodeConfig(homeDir, config) {
  const configDir = join(homeDir, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "opencode.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

test("postinstall global scope seeds no broad allows on a fresh config (CFG-4996560e)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-code-postinstall-home-"));
  try {
    await runPostinstall(homeDir);
    const configPath = join(homeDir, ".config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));

    // No broad allows at the global top-level scope.
    expect(config.permission?.bash?.["*"]).toBe(undefined);
    expect(config.permission?.external_directory).toBe(undefined);

    // Denylist hygiene rules are still present at the top level.
    expect(config.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
    expect(config.permission?.bash?.["audit-code cleanup*"]).toBe("deny");
    expect(config.permission?.bash?.["*dist*index.js* synthesize*"]).toBe("deny");
    expect(config.permission?.bash?.["rm *"]).toBe("deny");

    // Specific allows remain.
    expect(config.permission?.bash?.["audit-code next-step*"]).toBe("allow");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall migrates exactly-matching historically managed broad rules out of the global scope", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-code-postinstall-home-"));
  try {
    await seedOpenCodeConfig(homeDir, {
      theme: "user-theme",
      permission: {
        bash: { "*": "allow", "custom-user-tool *": "deny", "git status": "allow" },
        external_directory: { "*": "allow" },
        webfetch: "ask",
      },
    });
    await runPostinstall(homeDir);
    const configPath = join(homeDir, ".config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));

    // Exactly-matching historically managed broad rules are removed.
    expect(config.permission?.bash?.["*"]).toBe(undefined);
    expect(config.permission?.external_directory).toBe(undefined);

    // Unrelated user-authored keys survive the migration unchanged — including
    // a specific bash key whose value happens to equal the managed broad value
    // ("allow"): only the broad wildcard is migrated, never specific entries.
    expect(config.theme).toBe("user-theme");
    expect(config.permission?.webfetch).toBe("ask");
    expect(config.permission?.bash?.["custom-user-tool *"]).toBe("deny");
    expect(config.permission?.bash?.["git status"]).toBe("allow");

    // Convergence: re-running over the already-migrated config is idempotent —
    // the broad rules are not re-emitted and the result is byte-identical.
    const firstRaw = await readFile(configPath, "utf8");
    await runPostinstall(homeDir);
    expect(await readFile(configPath, "utf8")).toBe(firstRaw);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall leaves non-matching top-level broad rules untouched", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-code-postinstall-home-"));
  try {
    await seedOpenCodeConfig(homeDir, {
      permission: {
        bash: { "*": "ask" },
        external_directory: { "*": "deny", "C:/somewhere/**": "allow" },
      },
    });
    await runPostinstall(homeDir);
    const config = JSON.parse(
      await readFile(join(homeDir, ".config", "opencode", "opencode.json"), "utf8"),
    );

    expect(config.permission?.bash?.["*"]).toBe("ask");
    expect(config.permission?.external_directory).toEqual({
      "*": "deny",
      "C:/somewhere/**": "allow",
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall keeps auditor agent broad-allow-with-denylist and is idempotent", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-code-postinstall-home-"));
  try {
    await runPostinstall(homeDir);
    const configPath = join(homeDir, ".config", "opencode", "opencode.json");
    const first = JSON.parse(await readFile(configPath, "utf8"));

    // Agent scope keeps the broad allow plus the denylist.
    expect(first.agent?.auditor?.permission?.bash?.["*"]).toBe("allow");
    expect(first.agent?.auditor?.permission?.external_directory).toEqual({ "*": "allow" });
    expect(first.agent?.auditor?.permission?.bash?.["audit-code synthesize*"]).toBe("deny");
    expect(first.agent?.auditor?.permission?.bash?.["rm *"]).toBe("deny");

    // Re-running is idempotent for both scopes (no duplicate or mutated rules).
    await runPostinstall(homeDir);
    const second = JSON.parse(await readFile(configPath, "utf8"));
    expect(second.agent?.auditor).toEqual(first.agent?.auditor);
    expect(second.permission).toEqual(first.permission);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
