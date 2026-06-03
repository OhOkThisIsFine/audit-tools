import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkFileIntegrity } = await import("../src/orchestrator/fileIntegrity.ts");
const { normalizeGenericExternalResults } = await import(
  "../src/adapters/normalizeExternal.ts"
);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function manifest(files) {
  return {
    repository: { name: "t" },
    generated_at: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      language: "ts",
      size_bytes: 1,
      hash: f.hash,
    })),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-code-obs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Silence (and capture) process.stderr.write for a single async body. */
async function withCapturedStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return await fn(lines);
  } finally {
    process.stderr.write = original;
  }
}

// ── checkFileIntegrity: I/O-error vs missing classification (OBS-005) ────────

test("checkFileIntegrity reports an unreadable-but-present file via io_errors, not missing", async () => {
  await withTempDir(async (dir) => {
    // A directory at the manifest path exists on disk (existsSync is true) but
    // readFile throws a non-ENOENT error (EISDIR/EPERM); it must land in
    // io_errors, NOT missing_files.
    const rel = "as-a-dir";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    assert.deepEqual(result.io_errors, [rel]);
    assert.deepEqual(result.missing_files, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity reports an absent file as missing, not io_errors", async () => {
  await withTempDir(async (dir) => {
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: "does-not-exist.ts", hash: "deadbeef" }]),
    );
    assert.deepEqual(result.missing_files, ["does-not-exist.ts"]);
    assert.deepEqual(result.io_errors, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity is_clean is false whenever io_errors is non-empty", async () => {
  await withTempDir(async (dir) => {
    const rel = "dir-path";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    assert.ok(result.io_errors.length > 0);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity reports a content change in changed_files, not missing/io_errors", async () => {
  await withTempDir(async (dir) => {
    const rel = "changed.ts";
    await writeFile(join(dir, rel), "modified", "utf8");
    // hash recorded at manifest time differs from current content
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: rel, hash: sha256("original") }]),
    );
    assert.deepEqual(result.changed_files, [rel]);
    assert.deepEqual(result.missing_files, []);
    assert.deepEqual(result.io_errors, []);
    assert.equal(result.is_clean, false);
  });
});

test("checkFileIntegrity is_clean when current content matches the manifest hash", async () => {
  await withTempDir(async (dir) => {
    const rel = "stable.ts";
    await writeFile(join(dir, rel), "v1", "utf8");
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: rel, hash: sha256("v1") }]),
    );
    assert.equal(result.is_clean, true);
  });
});

// ── normalizeGenericExternalResults: dropped-item signal (OBS-003) ───────────

test("normalizeGenericExternalResults drops items missing path/summary and logs the count", async () => {
  const lines = [];
  const result = await withCapturedStderr(async (captured) => {
    const out = normalizeGenericExternalResults("semgrep", [
      { path: "a.ts", summary: "finding A" },
      { path: "b.ts" }, // missing summary -> dropped
      { summary: "no path" }, // missing path -> dropped
      { path: "c.ts", summary: "finding C" },
    ]);
    lines.push(...captured);
    return out;
  });
  // Existing behavior preserved: only the two valid items survive.
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    result.results.map((r) => r.path),
    ["a.ts", "c.ts"],
  );
  // Structured drop log emitted with the correct count.
  const dropLine = lines.find((l) => l.includes("normalizeExternal: dropped"));
  assert.ok(dropLine, "expected a dropped-item stderr line");
  assert.match(dropLine, /dropped 2\/4 semgrep finding\(s\) missing path or summary/);
});

test("normalizeGenericExternalResults emits no drop log when nothing is dropped", async () => {
  const lines = [];
  await withCapturedStderr(async (captured) => {
    normalizeGenericExternalResults("eslint", [
      { path: "a.ts", summary: "A" },
      { path: "b.ts", summary: "B" },
    ]);
    lines.push(...captured);
  });
  assert.equal(
    lines.some((l) => l.includes("normalizeExternal: dropped")),
    false,
  );
});
