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
const bridgePath = join(here, "helpers", "provider-assisted-bridge.mjs");

function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: cleanEnv,
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
      reject(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

async function runWrapperOrSkip(t, args, options = {}) {
  try {
    return await runWrapper(args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/spawn EPERM/i.test(message)) {
      t.skip("spawn EPERM in this sandbox prevents wrapper/provider subprocess coverage");
      return null;
    }
    throw error;
  }
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-provider-assisted-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "test-repo", version: "0.0.0" }, null, 2) + "\n",
    );
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
        "export function createSession(id: string): Session {",
        "  return { id };",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(root, "infra", "deploy.yml"),
      [
        "name: deploy",
        "on: [push]",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "",
      ].join("\n"),
    );

    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code can continue through provider-assisted review in a single invocation", async (t) => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          provider: "subprocess-template",
          subprocess_template: {
            command_template: [process.execPath, bridgePath, "{taskPath}"],
          },
        },
        null,
        2,
      ),
    );

    const result = await runWrapperOrSkip(t, [], { cwd: root });
    if (!result) {
      return;
    }
    const parsed = JSON.parse(result.stdout);
    // The repo may complete in one pass (small fixture) or need more cycles (large fixture);
    // both are valid outcomes for a functioning subprocess-template provider.
    assert.ok(
      ["blocked", "complete"].includes(parsed.audit_state.status),
      `expected blocked or complete, got ${parsed.audit_state.status}`,
    );
    assert.equal(parsed.progress_made, true);
    assert.ok(/subprocess-template|opencode/.test(parsed.handoff.provider ?? ""));
  });
});

test("provider-assisted review persists per-run worker results even when parallel workers are configured", async (t) => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          provider: "subprocess-template",
          parallel_workers: 2,
          agent_task_batch_size: 1,
          subprocess_template: {
            command_template: [process.execPath, bridgePath, "{taskPath}"],
          },
        },
        null,
        2,
      ),
    );

    const run = await runWrapperOrSkip(
      t,
      ["--provider", "subprocess-template", "--parallel", "2", "--agent-batch-size", "1", "--max-runs", "1"],
      { cwd: root },
    );
    if (!run) {
      return;
    }

    const ledger = JSON.parse(
      await readFile(join(artifactsDir, "run-ledger.json"), "utf8"),
    );
    assert.ok(ledger.runs.length >= 1);
    for (const entry of ledger.runs) {
      const workerResult = JSON.parse(await readFile(entry.result_path, "utf8"));
      assert.equal(workerResult.run_id, entry.run_id);
      assert.match(workerResult.status, /completed|no_progress/);
    }
  });
});
