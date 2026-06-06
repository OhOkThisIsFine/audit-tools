import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cleanupStaleArtifactsDir } = await import("../src/cli/cleanup.ts");

async function withTempDir(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-cleanup-test-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

test("cleanupStaleArtifactsDir preserves artifacts directory when status is active", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
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
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    assert.equal(result.action, "skipped");
    assert.equal(result.status, "unknown");
    assert.ok(await dirExists(artifactsDir), "directory should still exist");
  });
});

test("cleanupStaleArtifactsDir: force=true deletes even when state file is missing", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    assert.equal(result.action, "deleted");
    assert.equal(result.status, "unknown");
    assert.ok(!(await dirExists(artifactsDir)), "directory should be removed when force=true and state file is missing");
  });
});
