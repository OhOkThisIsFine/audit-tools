import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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

    assert.equal((await stat(join(codexSkillDir, "SKILL.md"))).isFile(), true);
    assert.equal((await stat(join(codexSkillDir, "audit-code.prompt.md"))).isFile(), true);
    assert.equal((await stat(openAiMetadataPath)).isFile(), true);
    assert.match(await readFile(openAiMetadataPath, "utf8"), /display_name: "audit-code"/);
    const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, "utf8"));
    assert.equal(opencodeConfig.permission?.read, "allow");
    assert.equal(opencodeConfig.permission?.grep, "allow");
    // Global scope must not seed broad allows (CFG-4996560e).
    assert.equal(opencodeConfig.permission?.external_directory, undefined);
    assert.equal(opencodeConfig.permission?.bash?.["*"], undefined);
    assert.equal(opencodeConfig.permission?.bash?.["audit-code"], "allow");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code next-step*"], "allow");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code synthesize*"], "deny");
    // Single-package postinstall runs both the audit and remediate halves, so the
    // shared global opencode.json also carries the remediate scope's allows
    // (e.g. "Select-String *"). The audit half still seeds no broad allows of its own.
    assert.equal(opencodeConfig.agent?.auditor?.permission?.read, "allow");
    assert.equal(opencodeConfig.agent?.auditor?.permission?.bash?.["*audit-code.mjs* synthesize*"], "deny");
    assert.match(result.stdout, /Codex skill UI metadata/);
    assert.equal(result.stderr, "");

    // Claude Desktop command file
    const claudeCommandPath = join(homeDir, ".claude", "commands", "audit-code.md");
    assert.equal((await stat(claudeCommandPath)).isFile(), true);
    assert.match(await readFile(claudeCommandPath, "utf8"), /audit-code/);

    // Antigravity (Gemini IDE) plugin files
    const antigravityPluginDir = join(homeDir, ".gemini", "config", "plugins", "audit-code");
    const antigravityPluginJsonPath = join(antigravityPluginDir, "plugin.json");
    const antigravityPluginSkillPath = join(antigravityPluginDir, "skills", "SKILL.md");
    assert.equal((await stat(antigravityPluginJsonPath)).isFile(), true);
    assert.equal((await stat(antigravityPluginSkillPath)).isFile(), true);
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
    assert.equal(config.permission?.bash?.["*"], undefined);
    assert.equal(config.permission?.external_directory, undefined);

    // Denylist hygiene rules are still present at the top level.
    assert.equal(config.permission?.bash?.["audit-code synthesize*"], "deny");
    assert.equal(config.permission?.bash?.["audit-code cleanup*"], "deny");
    assert.equal(config.permission?.bash?.["*dist*index.js* synthesize*"], "deny");
    assert.equal(config.permission?.bash?.["rm *"], "deny");

    // Specific allows remain.
    assert.equal(config.permission?.bash?.["audit-code next-step*"], "allow");
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
    assert.equal(config.permission?.bash?.["*"], undefined);
    assert.equal(config.permission?.external_directory, undefined);

    // Unrelated user-authored keys survive the migration unchanged — including
    // a specific bash key whose value happens to equal the managed broad value
    // ("allow"): only the broad wildcard is migrated, never specific entries.
    assert.equal(config.theme, "user-theme");
    assert.equal(config.permission?.webfetch, "ask");
    assert.equal(config.permission?.bash?.["custom-user-tool *"], "deny");
    assert.equal(config.permission?.bash?.["git status"], "allow");

    // Convergence: re-running over the already-migrated config is idempotent —
    // the broad rules are not re-emitted and the result is byte-identical.
    const firstRaw = await readFile(configPath, "utf8");
    await runPostinstall(homeDir);
    assert.equal(await readFile(configPath, "utf8"), firstRaw);
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

    assert.equal(config.permission?.bash?.["*"], "ask");
    assert.deepEqual(config.permission?.external_directory, {
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
    assert.equal(first.agent?.auditor?.permission?.bash?.["*"], "allow");
    assert.deepEqual(first.agent?.auditor?.permission?.external_directory, { "*": "allow" });
    assert.equal(first.agent?.auditor?.permission?.bash?.["audit-code synthesize*"], "deny");
    assert.equal(first.agent?.auditor?.permission?.bash?.["rm *"], "deny");

    // Re-running is idempotent for both scopes (no duplicate or mutated rules).
    await runPostinstall(homeDir);
    const second = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(second.agent?.auditor, first.agent?.auditor);
    assert.deepEqual(second.permission, first.permission);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
