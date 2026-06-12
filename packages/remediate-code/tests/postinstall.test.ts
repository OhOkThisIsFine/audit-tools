import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TEMP_HOME = join(__dirname, ".test-home-postinstall");
const PKG_ROOT = join(__dirname, "..");
const POSTINSTALL_SCRIPT = join(PKG_ROOT, "scripts", "postinstall.mjs");
const PROMPT_SOURCE = join(
  PKG_ROOT,
  "skills",
  "remediate-code",
  "remediate-code.prompt.md",
);

function runPostinstall(home = TEMP_HOME) {
  return spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
}

describe("scripts/postinstall.mjs", () => {
  beforeEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
    await mkdir(TEMP_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
  });

  it("exits 0", () => {
    const result = runPostinstall();
    expect(result.status).toBe(0);
  });

  it("installs ~/.claude/commands/remediate-code.md", () => {
    const result = runPostinstall();
    // Surface a postinstall crash as a clear failing assertion rather than a
    // confusing missing-file error downstream.
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const installedPath = join(
      TEMP_HOME,
      ".claude",
      "commands",
      "remediate-code.md",
    );
    expect(existsSync(installedPath)).toBe(true);
  });

  it("installed command matches source prompt", async () => {
    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const installedPath = join(
      TEMP_HOME,
      ".claude",
      "commands",
      "remediate-code.md",
    );
    const installed = await readFile(installedPath, "utf8");
    const source = await readFile(PROMPT_SOURCE, "utf8");

    expect(installed).toBe(source);
  });

  it("installs Codex skill files", () => {
    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const skillMd = join(
      TEMP_HOME,
      ".codex",
      "skills",
      "remediate-code",
      "SKILL.md",
    );
    const promptMd = join(
      TEMP_HOME,
      ".codex",
      "skills",
      "remediate-code",
      "remediate-code.prompt.md",
    );
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(promptMd)).toBe(true);
    expect(
      existsSync(
        join(
          TEMP_HOME,
          ".codex",
          "skills",
          "remediate-code",
          "agents",
          "openai.yaml",
        ),
      ),
    ).toBe(true);
  });

  it("installs OpenCode global command and restricted permissions", async () => {
    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const configPath = join(TEMP_HOME, ".config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.command["remediate-code"].template).toContain(
      "remediate-code next-step",
    );
    expect(config.permission.bash["remediate-code next-step*"]).toBe("allow");
    expect(config.permission.bash["rm *"]).toBe("deny");
  });

  it("preserves a non-managed existing \"*\" wildcard in the global bash permission (COR-fc1f12a6)", async () => {
    // Pre-seed an opencode.json with a user-authored wildcard that does NOT
    // match the historically managed broad value ("allow"); it must survive.
    const configDir = join(TEMP_HOME, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({ permission: { bash: { "*": "deny" } } }),
      "utf8",
    );

    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const config = JSON.parse(await readFile(configPath, "utf8"));
    // The user's non-matching wildcard must survive untouched.
    expect(config.permission.bash["*"]).toBe("deny");
    // Specific managed glob patterns must still be present.
    expect(config.permission.bash["remediate-code next-step*"]).toBe("allow");
    expect(config.permission.bash["rm *"]).toBe("deny");
  });

  it("preserves an existing agent-scope \"*\" wildcard over the managed default (COR-fc1f12a6)", async () => {
    // The remediator agent scope still lets an existing user wildcard win over
    // the generated "ask" default.
    const configDir = join(TEMP_HOME, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agent: { remediator: { permission: { bash: { "*": "allow" } } } },
      }),
      "utf8",
    );

    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.agent.remediator.permission.bash["*"]).toBe("allow");
    expect(config.agent.remediator.permission.bash["rm *"]).toBe("deny");
  });

  it("does not seed a global bash wildcard on a fresh config; agent scope falls back to \"ask\" (COR-fc1f12a6)", async () => {
    // No pre-existing opencode.json — the global top-level scope never seeds a
    // wildcard; the remediator agent scope uses the generated "ask" default.
    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const configPath = join(TEMP_HOME, ".config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.permission.bash["*"]).toBeUndefined();
    expect(config.agent.remediator.permission.bash["*"]).toBe("ask");
  });

  it("is idempotent — second run exits 0 and leaves files current", () => {
    const r1 = runPostinstall();
    const r2 = runPostinstall();
    expect(r1.status).toBe(0);
    expect(r1.error).toBeUndefined();
    expect(r2.status).toBe(0);
    expect(r2.error).toBeUndefined();
  });

  it("repairs a customized command file by updating it to the packaged loader", async () => {
    const setup = runPostinstall();
    expect(setup.status).toBe(0);
    expect(setup.error).toBeUndefined();

    const installedPath = join(
      TEMP_HOME,
      ".claude",
      "commands",
      "remediate-code.md",
    );
    await writeFile(installedPath, "custom local command\n", "utf8");

    const result = runPostinstall();
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();

    const installed = await readFile(installedPath, "utf8");
    expect(installed).toBe(await readFile(PROMPT_SOURCE, "utf8"));
    expect(result.stdout).toContain("updated global Claude command");
  });
});
