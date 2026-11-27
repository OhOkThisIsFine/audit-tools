import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkFileIntegrity } = await import("../../src/audit/orchestrator/fileIntegrity.js");
const { normalizeGenericExternalResults } = await import("../../src/shared/analyzers/normalizeExternal.js");
const { runCommand } = await import("../../src/audit/orchestrator/runtimeCommand.js");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function manifest(files: { path: string; hash: string }[]) {
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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-code-obs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Silence (and capture) process.stderr.write for a single async body. */
async function withCapturedStderr<T>(fn: (lines: string[]) => Promise<T> | T): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = (chunk: Uint8Array | string) => {
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
    expect(result.io_errors).toEqual([rel]);
    expect(result.missing_files).toEqual([]);
    expect(result.is_clean).toBe(false);
  });
});

test("checkFileIntegrity reports an absent file as missing, not io_errors", async () => {
  await withTempDir(async (dir) => {
    const result = await checkFileIntegrity(
      dir,
      manifest([{ path: "does-not-exist.ts", hash: "deadbeef" }]),
    );
    expect(result.missing_files).toEqual(["does-not-exist.ts"]);
    expect(result.io_errors).toEqual([]);
    expect(result.is_clean).toBe(false);
  });
});

test("checkFileIntegrity is_clean is false whenever io_errors is non-empty", async () => {
  await withTempDir(async (dir) => {
    const rel = "dir-path";
    await mkdir(join(dir, rel), { recursive: true });
    const result = await withCapturedStderr(() =>
      checkFileIntegrity(dir, manifest([{ path: rel, hash: "deadbeef" }])),
    );
    expect(result.io_errors.length > 0).toBeTruthy();
    expect(result.is_clean).toBe(false);
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
    expect(result.changed_files).toEqual([rel]);
    expect(result.missing_files).toEqual([]);
    expect(result.io_errors).toEqual([]);
    expect(result.is_clean).toBe(false);
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
    expect(result.is_clean).toBe(true);
  });
});

// ── normalizeGenericExternalResults: dropped-item signal (OBS-003) ───────────

test("normalizeGenericExternalResults drops items missing path/summary and logs the count", async () => {
  const lines: string[] = [];
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
  expect(result.results.length).toBe(2);
  expect(result.results.map((r) => r.path)).toEqual(["a.ts", "c.ts"]);
  // Structured drop event emitted with the correct count.
  const dropLine = lines.find((l) => {
    try { const obj = JSON.parse(l.trim()); return obj.event === "normalizer_findings_dropped"; }
    catch { return false; }
  });
  expect(dropLine, "expected a normalizer_findings_dropped JSON event on stderr").toBeTruthy();
  const dropEvent = JSON.parse(dropLine!.trim());
  expect(dropEvent.tool).toBe("semgrep");
  expect(dropEvent.dropped).toBe(2);
  expect(dropEvent.total).toBe(4);
});

test("normalizeGenericExternalResults emits no drop log when nothing is dropped", async () => {
  const lines: string[] = [];
  await withCapturedStderr(async (captured) => {
    normalizeGenericExternalResults("eslint", [
      { path: "a.ts", summary: "A" },
      { path: "b.ts", summary: "B" },
    ]);
    lines.push(...captured);
  });
  expect(lines.some((l) => {
      try { const obj = JSON.parse(l.trim()); return obj.event === "normalizer_findings_dropped"; }
      catch { return false; }
    })).toBe(false);
});

// ── buildLineIndex / buildLineIndexForPaths: warn on unreadable file (OBS-2cc9cf82) ──

const { buildLineIndex, buildLineIndexForPaths, isUnmeasuredLineCount } = await import("../../src/audit/cli/lineIndex.js");

// CP-NODE-6: a read failure surfaces as the UNMEASURED sentinel, not a silent 0
// (a missing file and a genuine zero-line file were previously indistinguishable).
// These tests used to pin the old silent-0 behavior; they now assert the
// sentinel via the module's own exported isUnmeasuredLineCount() predicate,
// never a bare NaN equality.
test("buildLineIndex warns on unreadable file and marks that entry unmeasured", async () => {
  await withTempDir(async (dir) => {
    const validFile = "valid.ts";
    await writeFile(join(dir, validFile), "line1\nline2\nline3\n", "utf8");

    const manifest = {
      repository: { name: "t" },
      generated_at: new Date().toISOString(),
      files: [
        { path: validFile, language: "ts", size_bytes: 18, hash: "abc" },
        { path: "does-not-exist.ts", language: "ts", size_bytes: 0, hash: "000" },
      ],
    };

    let result: Record<string, number> | undefined;
    const stderrLines: string[] = [];
    await withCapturedStderr(async (lines) => {
      result = await buildLineIndex(dir, manifest);
      stderrLines.push(...lines);
    });

    // Non-existent file is marked UNMEASURED, not a genuine 0 line count.
    expect(isUnmeasuredLineCount(result!["does-not-exist.ts"]), "unreadable file must be UNMEASURED, not a silent 0").toBe(true);
    // Valid file still has the correct count.
    expect(result![validFile] > 0, "valid file should have a positive line count").toBeTruthy();
    expect(isUnmeasuredLineCount(result![validFile]), "a successfully-measured file must not read as unmeasured").toBe(false);
    // A stderr diagnostic was emitted containing the failing path and an error message.
    const warnLine = stderrLines.find((l) => l.includes("does-not-exist.ts"));
    expect(warnLine, "expected a stderr diagnostic for the unreadable file").toBeTruthy();
    expect(warnLine).toMatch(/\[lineIndex\]/);
  });
});

test("buildLineIndexForPaths warns on unreadable file and marks that entry unmeasured", async () => {
  await withTempDir(async (dir) => {
    const validFile = "module.ts";
    await writeFile(join(dir, validFile), "a\nb\n", "utf8");

    let result: Record<string, number> | undefined;
    const stderrLines: string[] = [];
    await withCapturedStderr(async (lines) => {
      result = await buildLineIndexForPaths(dir, [validFile, "ghost.ts"]);
      stderrLines.push(...lines);
    });

    // Non-existent path is marked UNMEASURED, not a genuine 0.
    expect(isUnmeasuredLineCount(result!["ghost.ts"]), "unreadable path must be UNMEASURED, not a silent 0").toBe(true);
    // Valid path has a correct count.
    expect(result![validFile] > 0, "valid file should have a positive line count").toBeTruthy();
    expect(isUnmeasuredLineCount(result![validFile]), "a successfully-measured path must not read as unmeasured").toBe(false);
    // A stderr diagnostic was emitted containing the failing path.
    const warnLine = stderrLines.find((l) => l.includes("ghost.ts"));
    expect(warnLine, "expected a stderr diagnostic for the unreadable path").toBeTruthy();
    expect(warnLine).toMatch(/\[lineIndex\]/);
  });
});

// ── runCommand error event: accumulated output in evidence (OBS-99c970ca) ─────

test("runCommand error event with no prior output returns empty evidence", async () => {
  // Spawn a command that cannot exist on any platform; the OS fires an error
  // event immediately (ENOENT), with no stdout/stderr having arrived yet.
  const result = await runCommand(
    ["__audit_code_nonexistent_command_xyz__"],
    process.cwd(),
  );
  expect(result.status, "status is inconclusive on spawn error").toBe("inconclusive");
  expect(result.summary, "summary says 'Failed to execute'").toMatch(/Failed to execute/);
  expect(result.summary, "summary includes the failing command").toMatch(/__audit_code_nonexistent_command_xyz__/);
  expect(result.evidence, "evidence is empty when no output was captured").toEqual([]);
});

test("runCommand error event summary includes the OS error message", async () => {
  const result = await runCommand(["__audit_code_nonexistent_42__"], process.cwd());
  expect(result.status).toBe("inconclusive");
  expect(result.summary.length > 0, "summary is non-empty").toBeTruthy();
  expect(result.summary.includes("__audit_code_nonexistent_42__"), "summary embeds the command name").toBeTruthy();
});
