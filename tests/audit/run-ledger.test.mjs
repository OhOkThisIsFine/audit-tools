import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { appendRunLedgerEntry, loadRunLedger } = await import("../../src/audit/supervisor/runLedger.ts");

function sampleEntry(overrides = {}) {
  return {
    run_id: "test-run-1",
    provider: "claude-code",
    obligation_id: "test-obligation",
    selected_executor: "inline",
    status: "completed",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    result_path: "/tmp/result.json",
    ...overrides,
  };
}

test("appendRunLedgerEntry uses shared withFileLock: no local acquireLedgerLock exported", async () => {
  // Verify the refactored module does not export or define the old local lock loop.
  const mod = await import("../../src/audit/supervisor/runLedger.ts");
  assert.ok(!("acquireLedgerLock" in mod), "acquireLedgerLock should not be exported");
  assert.ok(!("LOCK_RETRY_DELAY_MS" in mod), "LOCK_RETRY_DELAY_MS should not be exported");
  assert.ok(!("LOCK_RETRY_LIMIT" in mod), "LOCK_RETRY_LIMIT should not be exported");
});

test("appendRunLedgerEntry successfully appends an entry when no lock file is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-ledger-"));
  try {
    const entry = sampleEntry();
    await appendRunLedgerEntry(dir, entry);
    const ledger = await loadRunLedger(dir);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.runs[0].run_id, entry.run_id);
    assert.equal(ledger.runs[0].status, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEntry accumulates multiple entries in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-ledger-multi-"));
  try {
    const entry1 = sampleEntry({ run_id: "run-001" });
    const entry2 = sampleEntry({ run_id: "run-002" });
    await appendRunLedgerEntry(dir, entry1);
    await appendRunLedgerEntry(dir, entry2);
    const ledger = await loadRunLedger(dir);
    assert.equal(ledger.runs.length, 2);
    assert.equal(ledger.runs[0].run_id, "run-001");
    assert.equal(ledger.runs[1].run_id, "run-002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEntry throws FileLockTimeoutError when lock file is permanently held", async (t) => {
  const { FileLockTimeoutError } = await import("audit-tools/shared");
  const dir = await mkdtemp(join(tmpdir(), "run-ledger-lock-"));
  try {
    // Acquire the lock manually via shared acquireLock so it is never released.
    const { acquireLock } = await import("audit-tools/shared");
    const lockPath = join(dir, "run-ledger.lock");
    void await acquireLock(lockPath); // token unused; lock is abandoned when dir is deleted

    // appendRunLedgerEntry should time out waiting for the lock.
    await assert.rejects(
      () => appendRunLedgerEntry(dir, sampleEntry()),
      (err) => err instanceof FileLockTimeoutError,
      "should throw FileLockTimeoutError when lock is permanently held",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── OBS-fe5a1e72: contention logging ─────────────────────────────────────────

test("acquireLedgerLock logs to stderr on first contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-ledger-contention-"));
  try {
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, "run-ledger.lock");

    // Hold the lock file manually so withLedgerLock detects contention.
    const fd = await open(lockPath, "wx");

    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

    // Release the lock after a brief delay so appendRunLedgerEntry can proceed.
    const releaseTimer = setTimeout(async () => {
      await fd.close();
      await rm(lockPath, { force: true });
    }, 100);

    try {
      await appendRunLedgerEntry(dir, sampleEntry({ run_id: "contention-run" }));
    } finally {
      clearTimeout(releaseTimer);
      process.stderr.write = origWrite;
    }

    const contentionLine = stderrLines.find((l) =>
      l.includes("runLedger: lock contention detected") && l.includes(lockPath),
    );
    assert.ok(contentionLine, "expected a lock-contention stderr line containing the lock path");

    // Verify the entry was still appended after contention resolved.
    const ledger = await loadRunLedger(dir);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.runs[0].run_id, "contention-run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("No stderr is emitted when the lock is acquired on the first attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-ledger-nocontention-"));
  try {
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
    try {
      await appendRunLedgerEntry(dir, sampleEntry({ run_id: "no-contention-run" }));
    } finally {
      process.stderr.write = origWrite;
    }

    const contentionLines = stderrLines.filter((l) =>
      l.includes("runLedger: lock contention detected"),
    );
    assert.equal(contentionLines.length, 0, "no contention stderr when lock is acquired immediately");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
