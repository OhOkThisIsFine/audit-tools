import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const { cleanupStaleArtifactsDir } = await import("../src/cli/cleanup.ts");
const { cmdCleanup } = await import("../src/cli/cleanupCommand.ts");

async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

test("cleanupStaleArtifactsDir preserves artifacts directory when status is active", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    assert.ok(await dirExists(artifactsDir), "directory should still exist for active status");
  });
});

test("cleanupStaleArtifactsDir preserves artifacts directory when status is blocked", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "blocked" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    assert.ok(await dirExists(artifactsDir), "directory should still exist for blocked status");
  });
});

test("cleanupStaleArtifactsDir re-throws on malformed audit_state.json", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "audit_state.json"), "not json");

    await assert.rejects(
      () => cleanupStaleArtifactsDir(artifactsDir),
      "should throw on malformed JSON",
    );

    assert.ok(await dirExists(artifactsDir), "directory should still exist after rejection");
  });
});

test("cleanupStaleArtifactsDir returns silently when audit_state.json is absent", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    await assert.doesNotReject(
      () => cleanupStaleArtifactsDir(artifactsDir),
      "should resolve without throwing when audit_state.json is missing",
    );

    assert.ok(await dirExists(artifactsDir), "directory should still exist (nothing deleted)");
  });
});

test("cleanupStaleArtifactsDir removes artifacts directory when status is complete", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed for complete status");
  });
});

test("cleanupStaleArtifactsDir removes artifacts directory when status is not_started", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "not_started" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed for not_started status");
  });
});

// ── Structured return value tests ─────────────────────────────────────────────

test("cleanupStaleArtifactsDir: deletes when status is complete (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    assert.equal(result.action, "deleted");
    assert.equal(result.status, "complete");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed");
  });
});

test("cleanupStaleArtifactsDir: deletes when status is not_started (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "not_started" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    assert.equal(result.action, "deleted");
    assert.equal(result.status, "not_started");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed");
  });
});

test("cleanupStaleArtifactsDir: skips deletion when status is active and force is false", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    assert.equal(result.action, "skipped");
    assert.equal(result.status, "active");
    assert.ok(typeof result.reason === "string", "reason should be a string");
    assert.ok(result.reason.includes("active"), "reason should mention 'active'");
    assert.ok(result.reason.includes("resumed") || result.reason.includes("resume"), "reason should mention resumption");
    assert.ok(await dirExists(artifactsDir), "directory should still exist");
  });
});

test("cleanupStaleArtifactsDir: deletes when status is active and force is true", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    assert.equal(result.action, "deleted");
    assert.equal(result.status, "active");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed despite active status");
  });
});

test("cleanupStaleArtifactsDir: dry-run skips rm but returns dry-run action", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir, { dryRun: true });

    assert.equal(result.action, "dry-run");
    assert.equal(result.status, "complete");
    assert.ok(await dirExists(artifactsDir), "directory should still exist in dry-run mode");
  });
});

test("cleanupStaleArtifactsDir: skips silently when audit_state.json is missing (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    assert.equal(result.action, "skipped");
    assert.equal(result.status, "unknown");
    assert.ok(await dirExists(artifactsDir), "directory should still exist");
  });
});

test("cleanupStaleArtifactsDir: force=true deletes even when state file is missing", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    assert.equal(result.action, "deleted");
    assert.equal(result.status, "unknown");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed when force=true and state file is missing");
  });
});

// ── cmdCleanup (CLI wiring) tests ─────────────────────────────────────────────
// FND-TST-49494736: cleanupCommand.ts CLI wiring — exitCode, stdout JSON shape,
// force/dryRun flag paths, unknown-status path.

async function runCleanup(artifactsDir, extraFlags = []) {
  const argv = [
    process.execPath,
    join(repoRoot, "src", "cli.ts"),
    "--artifacts-dir",
    artifactsDir,
    ...extraFlags,
  ];
  return captureConsole(() => cmdCleanup(argv));
}

test("cmdCleanup: active status — exitCode=1, JSON action=skipped with reason", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir);

    assert.equal(code, 1, "exitCode should be 1 when action is skipped");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.action, "skipped");
    assert.equal(parsed.artifacts_dir, artifactsDir);
    assert.ok(typeof parsed.reason === "string" && parsed.reason.length > 0, "reason should be a non-empty string");
    assert.ok(await dirExists(artifactsDir), "directory should still exist");
  });
});

test("cmdCleanup: complete status — exitCode=0, JSON action=deleted", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir);

    assert.equal(code, 0, "exitCode should be 0 when action is deleted");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.action, "deleted");
    assert.equal(parsed.status, "complete");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed");
  });
});

test("cmdCleanup: missing state file (no flags) — exitCode=1, JSON action=skipped, reason mentions --force", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json

    const { code, stdout } = await runCleanup(artifactsDir);

    assert.equal(code, 1, "exitCode should be 1 when action is skipped");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.action, "skipped");
    assert.ok(typeof parsed.reason === "string", "reason should be a string");
    assert.ok(
      parsed.reason.includes("--force") || parsed.reason.includes("force"),
      "reason should mention --force",
    );
    assert.ok(await dirExists(artifactsDir), "directory should still exist");
  });
});

test("cmdCleanup: --force flag deletes active-status artifacts, exitCode=0", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir, ["--force"]);

    assert.equal(code, 0, "exitCode should be 0 when force-deleted");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.action, "deleted");
    assert.equal(parsed.status, "active");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed with --force");
  });
});

test("cmdCleanup: --dry-run flag returns dry-run action without deleting, exitCode=0", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir, ["--dry-run"]);

    assert.equal(code, 0, "exitCode should be 0 for dry-run");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.action, "dry-run");
    assert.equal(parsed.dry_run, true);
    assert.ok(await dirExists(artifactsDir), "directory should still exist after dry-run");
  });
});

test("cmdCleanup: stdout is always valid JSON", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    const { stdout } = await runCleanup(artifactsDir);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      assert.fail(`cmdCleanup stdout is not valid JSON: ${stdout}`);
    }
    assert.ok(typeof parsed.action === "string", "action should be a string");
    assert.ok(typeof parsed.artifacts_dir === "string", "artifacts_dir should be a string");
  });
});
