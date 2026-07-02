import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { cleanupStaleArtifactsDir } = await import("../../src/audit/cli/cleanup.ts");
const { cmdCleanup } = await import("../../src/audit/cli/cleanupCommand.ts");

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

    expect(await dirExists(artifactsDir), "directory should still exist for active status").toBeTruthy();
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

    expect(await dirExists(artifactsDir), "directory should still exist for blocked status").toBeTruthy();
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

    expect(await dirExists(artifactsDir), "directory should still exist after rejection").toBeTruthy();
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

    expect(await dirExists(artifactsDir), "directory should still exist (nothing deleted)").toBeTruthy();
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

    expect(!(await dirExists(artifactsDir)), "directory should be removed for complete status").toBeTruthy();
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

    expect(!(await dirExists(artifactsDir)), "directory should be removed for not_started status").toBeTruthy();
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

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("complete");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
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

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("not_started");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
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

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("active");
    expect(typeof result.reason === "string", "reason should be a string").toBeTruthy();
    expect(result.reason.includes("active"), "reason should mention 'active'").toBeTruthy();
    expect(result.reason.includes("resumed") || result.reason.includes("resume"), "reason should mention resumption").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
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

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("active");
    expect(!(await dirExists(artifactsDir)), "directory should be removed despite active status").toBeTruthy();
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

    expect(result.action).toBe("dry-run");
    expect(result.status).toBe("complete");
    expect(await dirExists(artifactsDir), "directory should still exist in dry-run mode").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: skips silently when audit_state.json is missing (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("unknown");
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: force=true deletes even when state file is missing", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("unknown");
    expect(!(await dirExists(artifactsDir)), "directory should be removed when force=true and state file is missing").toBeTruthy();
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

    expect(code, "exitCode should be 1 when action is skipped").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("skipped");
    expect(parsed.artifacts_dir).toBe(artifactsDir);
    expect(typeof parsed.reason === "string" && parsed.reason.length > 0, "reason should be a non-empty string").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
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

    expect(code, "exitCode should be 0 when action is deleted").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("deleted");
    expect(parsed.status).toBe("complete");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
  });
});

test("cmdCleanup: missing state file (no flags) — exitCode=1, JSON action=skipped, reason mentions --force", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json

    const { code, stdout } = await runCleanup(artifactsDir);

    expect(code, "exitCode should be 1 when action is skipped").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("skipped");
    expect(typeof parsed.reason === "string", "reason should be a string").toBeTruthy();
    expect(parsed.reason.includes("--force") || parsed.reason.includes("force"), "reason should mention --force").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
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

    expect(code, "exitCode should be 0 when force-deleted").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("deleted");
    expect(parsed.status).toBe("active");
    expect(!(await dirExists(artifactsDir)), "directory should be removed with --force").toBeTruthy();
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

    expect(code, "exitCode should be 0 for dry-run").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("dry-run");
    expect(parsed.dry_run).toBe(true);
    expect(await dirExists(artifactsDir), "directory should still exist after dry-run").toBeTruthy();
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
    expect(typeof parsed.action === "string", "action should be a string").toBeTruthy();
    expect(typeof parsed.artifacts_dir === "string", "artifacts_dir should be a string").toBeTruthy();
  });
});
