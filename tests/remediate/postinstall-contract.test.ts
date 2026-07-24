import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { ensureGlobalAssets } from "../../src/remediate/index.js";
import { scratchDir } from "../helpers/scratch.js";

const TEMP_HOME = scratchDir(".test-home-postinstall-contract");
const PKG_ROOT = join(__dirname, "..", "..");
const POSTINSTALL_SCRIPT = join(PKG_ROOT, "scripts", "postinstall.mjs");
const AUDIT_CODE_POSTINSTALL_SCRIPT = join(
  PKG_ROOT,
  "scripts",
  "audit",
  "postinstall.mjs",
);
const CONFIG_PATH = join(TEMP_HOME, ".config", "opencode", "opencode.json");

function runPostinstall(script = POSTINSTALL_SCRIPT) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    encoding: "utf8",
  });
}

async function seedConfig(config: unknown) {
  await mkdir(join(TEMP_HOME, ".config", "opencode"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

// NOTE (OBL-013): these tests verify the *deployed config shape* only. Whether
// agent-scoped allowances (agent.remediator.permission / agent.auditor.permission)
// actually propagate to subtasks spawned inside a live OpenCode install cannot
// be exercised in unit tests; validating real OpenCode subtask permission
// inheritance is a manual, user-owned follow-up.
describe("postinstall OpenCode permission scopes (CFG-4996560e)", () => {
  beforeEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
    await mkdir(TEMP_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
  });

  it("global scope seeds no broad allows on a fresh config", async () => {
    const result = runPostinstall();
    expect(result.status).toBe(0);

    const config = await readConfig();
    // No broad allows at the global top-level scope.
    expect(config.permission.bash["*"]).toBeUndefined();
    expect(config.permission.external_directory).toBeUndefined();
    // Denylist hygiene rules are still present at the top level.
    expect(config.permission.bash["rm *"]).toBe("deny");
    // Specific allows remain.
    expect(config.permission.bash["remediate-code next-step*"]).toBe("allow");
  });

  it("migration removes exactly-matching historically managed broad rules", async () => {
    await seedConfig({
      theme: "user-theme",
      permission: {
        bash: { "*": "allow", "custom-user-tool *": "deny", "git status": "allow" },
        external_directory: { "*": "allow" },
        webfetch: "ask",
      },
    });

    const result = runPostinstall();
    expect(result.status).toBe(0);

    const config = await readConfig();
    // Exactly-matching historically managed broad rules are deleted.
    expect(config.permission.bash["*"]).toBeUndefined();
    expect(config.permission.external_directory).toBeUndefined();
    // Unrelated user-authored keys survive the migration unchanged — including
    // a specific bash key whose value happens to equal the managed broad value
    // ("allow"): only the broad wildcard is migrated, never specific entries.
    expect(config.theme).toBe("user-theme");
    expect(config.permission.webfetch).toBe("ask");
    expect(config.permission.bash["custom-user-tool *"]).toBe("deny");
    expect(config.permission.bash["git status"]).toBe("allow");

    // Convergence: re-running over the already-migrated config is idempotent —
    // the broad rules are not re-emitted and the result is byte-identical.
    const firstRaw = await readFile(CONFIG_PATH, "utf8");
    const second = runPostinstall();
    expect(second.status).toBe(0);
    expect(await readFile(CONFIG_PATH, "utf8")).toBe(firstRaw);
  });

  it("leaves non-matching top-level broad rules byte-for-byte untouched", async () => {
    await seedConfig({
      permission: {
        bash: { "*": "ask" },
        external_directory: { "*": "deny", "C:/somewhere/**": "allow" },
      },
    });

    const result = runPostinstall();
    expect(result.status).toBe(0);

    const config = await readConfig();
    expect(config.permission.bash["*"]).toBe("ask");
    expect(config.permission.external_directory).toEqual({
      "*": "deny",
      "C:/somewhere/**": "allow",
    });
  });

  it("agent scope keeps its rules and re-running is idempotent", async () => {
    const first = runPostinstall();
    expect(first.status).toBe(0);
    const firstConfig = await readConfig();

    // The remediator agent scope keeps its deny rules and managed allows.
    expect(firstConfig.agent.remediator.permission.bash["*"]).toBe("ask");
    expect(firstConfig.agent.remediator.permission.bash["rm *"]).toBe("deny");
    expect(firstConfig.agent.remediator.permission.bash["remediate-code next-step*"]).toBe(
      "allow",
    );

    const second = runPostinstall();
    expect(second.status).toBe(0);
    const secondConfig = await readConfig();
    // No duplicate or mutated rules in either scope.
    expect(secondConfig.agent.remediator).toEqual(firstConfig.agent.remediator);
    expect(secondConfig.permission).toEqual(firstConfig.permission);
  });

  it("ensureGlobalAssets (remediate-code ensure) applies the same scoped behavior", async () => {
    await seedConfig({
      permission: {
        bash: { "*": "allow" },
        external_directory: { "*": "allow" },
      },
    });

    ensureGlobalAssets(true, () => {}, TEMP_HOME);

    const config = await readConfig();
    expect(config.permission.bash["*"]).toBeUndefined();
    expect(config.permission.external_directory).toBeUndefined();
    expect(config.permission.bash["remediate-code ensure*"]).toBe("allow");
    expect(config.agent.remediator.permission.bash["*"]).toBe("ask");
  });

  it("exits non-zero when at least one file install fails (INV-remediate-infra-08)", async () => {
    // Block the Claude command target by creating a directory in its place so
    // writeFile throws EISDIR — a partial deploy must not report success (exit 0).
    const claudeCommandDir = join(TEMP_HOME, ".claude", "commands", "remediate-code.md");
    await mkdir(claudeCommandDir, { recursive: true });

    const result = runPostinstall();
    // At least one install fails → non-zero exit.
    expect(result.status).toBeGreaterThan(0);
  });

  it("audit-code and remediate-code deploy identical scoped permission behavior", async () => {
    // Both packages import the hoisted audit-tools/shared helpers; running
    // them back to back against the same global config must leave no broad
    // allows at the top level while each agent keeps its own scope.
    await seedConfig({
      permission: {
        bash: { "*": "allow" },
        external_directory: { "*": "allow" },
      },
    });

    const auditResult = runPostinstall(AUDIT_CODE_POSTINSTALL_SCRIPT);
    expect(auditResult.status).toBe(0);
    const remediateResult = runPostinstall();
    expect(remediateResult.status).toBe(0);

    const config = await readConfig();
    // Global scope: no broad allows survive either deploy.
    expect(config.permission.bash["*"]).toBeUndefined();
    expect(config.permission.external_directory).toBeUndefined();
    // Both deny hygiene sets are present at the top level.
    expect(config.permission.bash["audit-code synthesize*"]).toBe("deny");
    expect(config.permission.bash["rm *"]).toBe("deny");
    // Agent scopes keep their per-package deployments unchanged — both agents
    // are hardened: bash wildcard "ask", no external_directory allow-all (V3).
    expect(config.agent.auditor.permission.bash["*"]).toBe("ask");
    expect(config.agent.auditor.permission.external_directory).toBeUndefined();
    expect(config.agent.remediator.permission.bash["*"]).toBe("ask");
  });
});
