import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const postinstallPath = join(repoRoot, "scripts", "postinstall.mjs");

function runPostinstall(homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [postinstallPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
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
    assert.equal(typeof opencodeConfig.permission?.external_directory, "object");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code"], "allow");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code next-step*"], "allow");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code run-to-completion*"], "deny");
    assert.equal(opencodeConfig.permission?.bash?.["audit-code synthesize*"], "deny");
    assert.equal(opencodeConfig.permission?.bash?.["Select-String *"], undefined);
    assert.equal(opencodeConfig.agent?.auditor?.permission?.read, "allow");
    assert.equal(opencodeConfig.agent?.auditor?.permission?.bash?.["*audit-code.mjs* synthesize*"], "deny");
    assert.match(result.stdout, /Codex skill UI metadata/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
