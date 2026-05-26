import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureGlobalAssets, installRepoAssets, runValidateCommand } from "../src/index.js";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(__dirname, ".test-install-root");
const TEST_HOME = join(__dirname, ".test-install-home");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("global-first install helpers", () => {
  it("ensureGlobalAssets installs Claude, Codex, metadata, and OpenCode files", () => {
    const logs: string[] = [];
    ensureGlobalAssets(false, (m) => logs.push(m), TEST_HOME);

    expect(existsSync(join(TEST_HOME, ".claude", "commands", "remediate-code.md"))).toBe(true);
    expect(existsSync(join(TEST_HOME, ".codex", "skills", "remediate-code", "SKILL.md"))).toBe(true);
    expect(existsSync(join(TEST_HOME, ".codex", "skills", "remediate-code", "remediate-code.prompt.md"))).toBe(true);
    expect(existsSync(join(TEST_HOME, ".codex", "skills", "remediate-code", "agents", "openai.yaml"))).toBe(true);
    expect(existsSync(join(TEST_HOME, ".config", "opencode", "opencode.json"))).toBe(true);
    expect(logs.some((line) => line.includes("global OpenCode command"))).toBe(true);
  });

  it("installRepoAssets does not create repo-local host files", () => {
    const logs: string[] = [];
    installRepoAssets(TEST_ROOT, false, (m) => logs.push(m), TEST_HOME);

    expect(existsSync(join(TEST_ROOT, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(TEST_ROOT, ".remediation-artifacts", ".gitkeep"))).toBe(false);
    expect(logs.some((line) => line.includes("repo-local install is deprecated"))).toBe(true);
  });

  it("quiet mode suppresses all log output", () => {
    const logs: string[] = [];
    ensureGlobalAssets(true, (m) => logs.push(m), TEST_HOME);
    expect(logs).toHaveLength(0);
  });
});

describe("runValidateCommand", () => {
  it("returns 0 when type checking succeeds", () => {
    const logs: string[] = [];
    const code = runValidateCommand({
      run: () => ({ status: 0 }) as any,
      log: (message) => logs.push(message),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(logs[0]).toMatch(/types OK/);
  });

  it("returns the child status when type checking fails", () => {
    const errors: string[] = [];
    const code = runValidateCommand({
      run: () => ({ status: 17 }) as any,
      log: () => {},
      error: (message) => errors.push(message),
    });

    expect(code).toBe(17);
    expect(errors[0]).toMatch(/Type check failed/);
  });
});
