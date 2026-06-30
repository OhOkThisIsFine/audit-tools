import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cmdAdvanceAudit } = await import("../../src/audit/cli/advanceAuditCommand.ts");
const { listBatchResultFiles } = await import("../../src/audit/cli/args.ts");
const { cmdValidateResult } = await import("../../src/audit/cli/validateResultCommand.ts");
const {
  isCoverageTotalLinesMismatch,
  emitCoverageLineCountFriction,
} = await import("../../src/audit/validation/auditResults.ts");
const { frictionCaptureDir } = await import("../../src/shared/index.ts");

async function tmp() {
  return mkdtemp(join(tmpdir(), "cp-node-8-"));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// OBLIGATION 1: mutually-exclusive --results/--batch-results must be rejected
// BEFORE cleanupStaleArtifactsDir runs, so a bad invocation leaves prior
// artifacts intact instead of sweeping them then throwing.
await test("advance-audit rejects --results+--batch-results before destructive cleanup", async (t) => {
  const dir = await tmp();
  const artifactsDir = join(dir, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  // status:complete makes the dir eligible for cleanup deletion (the bug path).
  await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "complete" }));
  const sentinel = join(artifactsDir, "sentinel.txt");
  await writeFile(sentinel, "keep-me");

  const batchDir = join(dir, "batch");
  await mkdir(batchDir, { recursive: true });

  await t.test("throws on conflicting flags", async () => {
    await assert.rejects(
      () =>
        cmdAdvanceAudit([
          "--root",
          dir,
          "--artifacts-dir",
          artifactsDir,
          "--results",
          join(dir, "r.json"),
          "--batch-results",
          batchDir,
        ]),
      /either --results .* or --batch-results .* not both/,
    );
  });

  await t.test("artifacts survive the throw (not swept by cleanup)", async () => {
    assert.equal(await exists(sentinel), true, "sentinel must survive — cleanup must not run before the flag check");
    assert.equal(await exists(artifactsDir), true);
  });
});

// OBLIGATION 2: batch ingest admits ONLY canonical result filenames, never any
// stray *.json (config, schema pointer, scratch file).
await test("listBatchResultFiles admits only canonical result filenames", async (t) => {
  const dir = await tmp();
  const canonical = "unit_foo_0123456789ab.json";
  const packetInline = "lens_security_packet-1_a1b2c3d4e5f6.inline-result.json";
  await writeFile(join(dir, canonical), "[]");
  await writeFile(join(dir, packetInline), "[]");
  // Stray non-canonical JSON that must NOT be ingested as a result.
  await writeFile(join(dir, "session-config.json"), "{}");
  await writeFile(join(dir, "packet-23-results.json"), "[]");

  await t.test("returns only canonical files", async () => {
    const files = await listBatchResultFiles(dir);
    const names = files.map((f) => f.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, [packetInline, canonical].sort());
  });

  await t.test("throws when only stray JSON is present", async () => {
    const strayDir = await tmp();
    await writeFile(join(strayDir, "session-config.json"), "{}");
    await writeFile(join(strayDir, "notes.json"), "[]");
    await assert.rejects(() => listBatchResultFiles(strayDir), /No canonical audit result files/);
  });
});

// OBLIGATION 3: validate-result grounds spans/anchors against the configured
// root (task.json repo_root / --root), not process.cwd(). A finding whose cited
// span exists under the configured root but NOT under cwd must ground cleanly.
await test("validate-result grounds against configured root, not cwd", async (t) => {
  const repoRoot = await tmp();
  // The cited file + verbatim span live under repoRoot, which is NOT cwd.
  const targetRel = "src/target.ts";
  await mkdir(join(repoRoot, "src"), { recursive: true });
  const lineText = 'const grounded = "UNIQUE_GROUNDING_TOKEN_8";';
  await writeFile(join(repoRoot, targetRel), `// header\n${lineText}\n`);

  const artifactsDir = join(repoRoot, ".audit-tools", "audit");
  const runId = "run-1";
  const taskId = "task-1";
  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  await mkdir(taskResultsDir, { recursive: true });

  // task.json carries the authoritative repo_root.
  await writeFile(
    join(runDir, "task.json"),
    JSON.stringify({ repo_root: repoRoot, run_id: runId, obligation_id: "o", result_path: join(runDir, "wr.json") }),
  );
  await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify([]));

  const result = {
    task_id: taskId,
    unit_id: "u",
    pass_id: "p",
    lens: "security",
    findings: [
      {
        id: "F1",
        title: "t",
        severity: "low",
        confidence: "high",
        lens: "security",
        affected_files: [{ path: targetRel, quoted_text: lineText, line_start: 2, line_end: 2 }],
        evidence: [],
      },
    ],
    file_coverage: [{ path: targetRel, total_lines: 2 }],
  };
  // The default result path (no dispatch map): taskResultPath(taskResultsDir, taskId).
  const { taskResultPath } = await import("../../src/audit/cli/args.ts");
  await writeFile(taskResultPath(taskResultsDir, taskId), JSON.stringify(result));

  await t.test("no ungrounded warning when span resolves under configured root", async () => {
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    const origExit = process.exitCode;
    try {
      // cwd is the project worktree, NOT repoRoot — pre-fix this would ground
      // against cwd and the unique token would be missing → ungrounded warning.
      await cmdValidateResult(["--run-id", runId, "--task-id", taskId, "--artifacts-dir", artifactsDir, "--root", repoRoot]);
    } finally {
      console.error = origErr;
      process.exitCode = origExit;
    }
    const joined = errs.join("\n");
    assert.equal(/ungrounded finding/.test(joined), false, `expected no ungrounded warning, got:\n${joined}`);
  });
});

// OBLIGATION 4: the line-count failure policy is single-sourced — one predicate
// classifies the mismatch, one emitter routes it to friction.
await test("line-count mismatch policy is single-sourced", async (t) => {
  await t.test("predicate matches only file_coverage total_lines warnings", () => {
    assert.equal(
      isCoverageTotalLinesMismatch({ severity: "warning", field: "file_coverage[0].total_lines", message: "m" }),
      true,
    );
    assert.equal(
      isCoverageTotalLinesMismatch({ severity: "error", field: "file_coverage[0].total_lines", message: "m" }),
      false,
    );
    assert.equal(
      isCoverageTotalLinesMismatch({ severity: "warning", field: "findings[0].title", message: "m" }),
      false,
    );
  });

  await t.test("emitter writes friction for a mismatch and nothing for unrelated issues", async () => {
    const dir = await tmp();
    const artifactsDir = join(dir, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const captureDir = frictionCaptureDir(artifactsDir);

    // Unrelated warning → no friction artifact.
    await emitCoverageLineCountFriction(artifactsDir, "run-x", [
      { severity: "warning", field: "findings[0].title", message: "noise", result_index: 0, task_id: "t", path: "src/a.ts" },
    ]);
    const afterNoise = (await exists(captureDir)) ? (await readdir(captureDir)).filter((f) => !f.endsWith(".lock")) : [];
    assert.deepEqual(afterNoise, [], "no friction file for unrelated issue");

    // Mismatch warning → a friction artifact is written.
    await emitCoverageLineCountFriction(artifactsDir, "run-x", [
      { severity: "warning", field: "file_coverage[0].total_lines", message: "mismatch", result_index: 0, task_id: "t", path: "src/a.ts" },
    ]);
    const afterMismatch = (await readdir(captureDir)).filter((f) => !f.endsWith(".lock"));
    assert.ok(afterMismatch.length > 0, "a friction artifact must be written for the mismatch");
  });
});
