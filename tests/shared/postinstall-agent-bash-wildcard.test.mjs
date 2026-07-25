/**
 * Agent-scope bash wildcard migration in the two postinstall deployers.
 *
 * The install wrappers (`wrapper/{audit,remediate}-code-wrapper-opencode.mjs`)
 * migrate a pre-hardening agent-scope `bash["*"] = "allow"` — the historically
 * tool-managed broad value — away so the generated `"ask"` seed wins. The
 * postinstall deployers write the SAME agent blocks on every `npm install`, so
 * an upgrade that never runs `install --host opencode` must not be the one path
 * that keeps a broad wildcard alive in agent scope.
 *
 * Only the exact managed value migrates: any other user-authored wildcard
 * (`"deny"`, `"ask"`, …) survives untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.ts";

const TEMP_HOME = scratchDir(".test-home-postinstall-agent-wildcard");
const PKG_ROOT = resolve(__dirname, "..", "..");

// Each deployer owns exactly one agent block in the shared global config.
const DEPLOYERS = [
  { agent: "auditor", script: join(PKG_ROOT, "scripts", "audit", "postinstall.mjs") },
  { agent: "remediator", script: join(PKG_ROOT, "scripts", "remediate", "postinstall.mjs") },
];

const CONFIG_PATH = join(TEMP_HOME, ".config", "opencode", "opencode.json");

async function seedOpenCodeConfig(config) {
  await mkdir(join(TEMP_HOME, ".config", "opencode"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config), "utf8");
}

function runDeployer(script) {
  const result = spawnSyncHidden(process.execPath, [script], {
    env: { ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME },
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  // A postinstall crash is far easier to read as an explicit assertion than as
  // a missing-key failure further down.
  expect(result.status, `${script} stderr:\n${result.stderr ?? ""}`).toBe(0);
  // The OpenCode block is skipped entirely when audit-tools/shared is not built;
  // a silent skip would make every assertion below vacuous.
  expect(
    result.stderr ?? "",
    "audit-tools/shared must be built for this test to exercise the OpenCode merge",
  ).not.toContain("skipping OpenCode config deployment");
}

describe("postinstall agent-scope bash wildcard", () => {
  beforeEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
    await mkdir(TEMP_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
  });

  for (const { agent, script } of DEPLOYERS) {
    it(`migrates a pre-hardening agent.${agent} bash "*": "allow" to the generated "ask"`, async () => {
      await seedOpenCodeConfig({
        agent: { [agent]: { permission: { bash: { "*": "allow" } } } },
      });

      runDeployer(script);

      const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      const bash = config.agent[agent].permission.bash;
      expect(bash["*"]).toBe("ask");
      // The managed denies must still be deployed alongside the migration.
      expect(bash["rm *"]).toBe("deny");
    });

    it(`preserves a user-authored agent.${agent} bash "*": "deny"`, async () => {
      await seedOpenCodeConfig({
        agent: { [agent]: { permission: { bash: { "*": "deny" } } } },
      });

      runDeployer(script);

      const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      expect(config.agent[agent].permission.bash["*"]).toBe("deny");
    });
  }
});
