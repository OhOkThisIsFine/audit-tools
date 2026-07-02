import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureGlobalAssets, installRepoAssets, runValidateCommand } from "../../src/remediate/index.js";
import { rm, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");
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
    expect(existsSync(join(TEST_ROOT, ".audit-tools/remediation", ".gitkeep"))).toBe(false);
    expect(logs.some((line) => line.includes("repo-local install is deprecated"))).toBe(true);
  });

  it("quiet mode suppresses all log output", () => {
    const logs: string[] = [];
    ensureGlobalAssets(true, (m) => logs.push(m), TEST_HOME);
    expect(logs).toHaveLength(0);
  });

  it("ensureGlobalAssets reads edit permission rules from opencode.json (not hardcoded)", () => {
    ensureGlobalAssets(true, () => {}, TEST_HOME);

    const globalConfig = JSON.parse(
      readFileSync(join(TEST_HOME, ".config", "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    const sourceOpencode = JSON.parse(
      readFileSync(join(PKG_ROOT, "opencode.json"), "utf8"),
    ) as { agent?: { remediator?: { permission?: { edit?: Record<string, string> } } } };
    const sourceEdit = sourceOpencode.agent?.remediator?.permission?.edit ?? {};

    const agentPermission = (globalConfig.agent as any)?.remediator?.permission ?? {};
    const generatedEdit: Record<string, string> = agentPermission.edit ?? {};

    // Every key from opencode.json's agent.remediator.permission.edit must appear
    for (const [pattern, action] of Object.entries(sourceEdit)) {
      expect(generatedEdit[pattern]).toBe(action);
    }
    // The closing-result path from opencode.json must be present
    expect(generatedEdit["remediation-closing-result.json"]).toBe("allow");
  });

  it("ensureGlobalAssets reads bash permission rules from opencode.json (not hardcoded)", () => {
    ensureGlobalAssets(true, () => {}, TEST_HOME);

    const globalConfig = JSON.parse(
      readFileSync(join(TEST_HOME, ".config", "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    const sourceOpencode = JSON.parse(
      readFileSync(join(PKG_ROOT, "opencode.json"), "utf8"),
    ) as { agent?: { remediator?: { permission?: { bash?: Record<string, string> } } } };
    const sourceBash = sourceOpencode.agent?.remediator?.permission?.bash ?? {};

    const agentPermission = (globalConfig.agent as any)?.remediator?.permission ?? {};
    const generatedBash: Record<string, string> = agentPermission.bash ?? {};

    for (const [pattern, action] of Object.entries(sourceBash)) {
      expect(generatedBash[pattern]).toBe(action);
    }
    // deny rules that should propagate from opencode.json
    expect(generatedBash["rm *"]).toBe("deny");
  });
});

describe("committed host-asset no-drift guard", () => {
  it("committed .agent/skills/remediate-code/SKILL.md matches canonical skills/remediate-code/SKILL.md", () => {
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    const installed = lf(
      readFileSync(join(PKG_ROOT, ".agent", "skills", "remediate-code", "SKILL.md"), "utf8"),
    );
    const canonical = lf(
      readFileSync(join(PKG_ROOT, "skills", "remediate-code", "SKILL.md"), "utf8"),
    );
    expect(
      installed,
      "Committed .agent/skills/remediate-code/SKILL.md drifted from the canonical skills/remediate-code/SKILL.md. Re-run `remediate-code install` (or regenerate the asset).",
    ).toBe(canonical);
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
