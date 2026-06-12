import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

function runNode(entryPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
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
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-config-errors-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "src", "lib", "session.ts"),
      [
        "export interface Session {",
        "  id: string;",
        "}",
        "",
      ].join("\n"),
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code advance-audit fails loudly on malformed session-config.json", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "session-config.json"), "{not-json\n");

    const result = await runNode(wrapperPath, ["advance-audit"], { cwd: root });
    const combined = `${result.stderr}\n${result.stdout}`;

    assert.notEqual(result.code, 0);
    assert.match(combined, /session-config\.json/i);
    assert.match(combined, /json|parse|invalid/i);
    const handoff = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    assert.equal(handoff.status, "blocked");
    assert.match(handoff.summary, /session-config\.json/i);
  });
});

test("audit-code advance-audit fails loudly on invalid session-config fields", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({ provider: "definitely-not-a-provider" }, null, 2),
    );

    const result = await runNode(wrapperPath, ["advance-audit"], { cwd: root });
    const combined = `${result.stderr}\n${result.stdout}`;

    assert.notEqual(result.code, 0);
    assert.match(combined, /session-config\.json/i);
    assert.match(combined, /provider/i);
    assert.match(combined, /unsupported provider/i);
    const handoff = JSON.parse(
      await readFile(join(artifactsDir, "operator-handoff.json"), "utf8"),
    );
    assert.equal(handoff.status, "blocked");
    assert.match(handoff.summary, /provider/i);
  });
});

test("validate fails loudly on corrupted artifact json", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "repo_manifest.json"), "{not-json\n");

    const result = await runNode(
      wrapperPath,
      ["validate", "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const combined = `${result.stderr}\n${result.stdout}`;

    assert.notEqual(result.code, 0);
    assert.match(combined, /repo_manifest\.json/i);
    assert.match(combined, /json|parse|invalid/i);
  });
});
