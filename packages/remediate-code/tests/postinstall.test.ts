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

describe("scripts/postinstall.mjs", () => {
  beforeEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
    await mkdir(TEMP_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
  });

  it("exits 0", () => {
    const result = spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });

  it("installs ~/.claude/commands/remediate-code.md", () => {
    spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    });

    const installedPath = join(
      TEMP_HOME,
      ".claude",
      "commands",
      "remediate-code.md",
    );
    expect(existsSync(installedPath)).toBe(true);
  });

  it("installed command matches source prompt", async () => {
    spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    });

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
    spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    });

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
    spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    });

    const configPath = join(TEMP_HOME, ".config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.command["remediate-code"].template).toContain(
      "remediate-code next-step",
    );
    expect(config.permission.bash["remediate-code next-step*"]).toBe("allow");
    expect(config.permission.bash["remediate-code run*"]).toBe("deny");
  });

  it("is idempotent — second run exits 0 and leaves files current", () => {
    const env = { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME };
    const r1 = spawnSync(process.execPath, [POSTINSTALL_SCRIPT], { env });
    const r2 = spawnSync(process.execPath, [POSTINSTALL_SCRIPT], { env });
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
  });

  it("repairs a customized command file by updating it to the packaged loader", async () => {
    const env = { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME };
    spawnSync(process.execPath, [POSTINSTALL_SCRIPT], { env });

    const installedPath = join(
      TEMP_HOME,
      ".claude",
      "commands",
      "remediate-code.md",
    );
    await writeFile(installedPath, "custom local command\n", "utf8");

    const result = spawnSync(process.execPath, [POSTINSTALL_SCRIPT], {
      env,
      encoding: "utf8",
    });
    const installed = await readFile(installedPath, "utf8");

    expect(result.status).toBe(0);
    expect(installed).toBe(await readFile(PROMPT_SOURCE, "utf8"));
    expect(result.stdout).toContain("updated global Claude command");
  });
});
