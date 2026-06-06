import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_LEDGER_STATUSES,
  type RunLedger,
  type RunLedgerEntry,
} from "@audit-tools/shared";
import { isFileMissingError, readJsonFile, writeJsonFile, withFileLock } from "@audit-tools/shared";

const RUN_LEDGER_FILENAME = "run-ledger.json";
const RUN_LEDGER_LOCK_FILENAME = "run-ledger.lock";
const VALID_RUN_LEDGER_STATUSES = new Set<RunLedgerEntry["status"]>(
  RUN_LEDGER_STATUSES,
);

function ledgerPath(artifactsDir: string): string {
  return join(artifactsDir, RUN_LEDGER_FILENAME);
}

/**
 * Wrap withFileLock for the run ledger, emitting a stderr message on the first
 * contention event so operators can observe prolonged lock waits before the
 * full timeout expires.
 */
async function withLedgerLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  // Probe for an immediate lock acquisition; if the lock file already exists,
  // log contention before delegating to withFileLock for the full retry loop.
  try {
    const fd = await open(lockPath, "wx");
    await fd.close();
    // Lock acquired on the first attempt — no contention; release and let
    // withFileLock manage the full acquire + release lifecycle.
    await rm(lockPath, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      process.stderr.write(
        `[audit-code] runLedger: lock contention detected on ${lockPath}, waiting...\n`,
      );
    }
  }
  return withFileLock(lockPath, fn);
}

function ledgerLockPath(artifactsDir: string): string {
  return join(artifactsDir, RUN_LEDGER_LOCK_FILENAME);
}

function buildTempLedgerPath(artifactsDir: string): string {
  return join(
    artifactsDir,
    `${RUN_LEDGER_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRunLedgerEntry(
  value: unknown,
  fieldPath: string,
): RunLedgerEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid run ledger in ${fieldPath}: expected an object.`);
  }

  const requireString = (field: string): string => {
    const entry = value[field];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `Invalid run ledger in ${fieldPath}.${field}: expected a non-empty string.`,
      );
    }
    return entry;
  };

  const requireNullableString = (field: string): string | null => {
    const entry = value[field];
    if (entry === null) {
      return null;
    }
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `Invalid run ledger in ${fieldPath}.${field}: expected a non-empty string or null.`,
      );
    }
    return entry;
  };

  const status = value.status;
  if (
    typeof status !== "string" ||
    !VALID_RUN_LEDGER_STATUSES.has(status as RunLedgerEntry["status"])
  ) {
    throw new Error(
      `Invalid run ledger in ${fieldPath}.status: expected one of ${Array.from(VALID_RUN_LEDGER_STATUSES).join(", ")}.`,
    );
  }

  return {
    run_id: requireString("run_id"),
    provider: requireString("provider"),
    obligation_id: requireNullableString("obligation_id"),
    selected_executor: requireNullableString("selected_executor"),
    status: status as RunLedgerEntry["status"],
    started_at: requireString("started_at"),
    ended_at: requireString("ended_at"),
    result_path: requireString("result_path"),
  };
}

function parseRunLedger(value: unknown, path: string): RunLedger {
  if (!isRecord(value)) {
    throw new Error(`Invalid run ledger in ${path}: expected an object.`);
  }
  if (!Array.isArray(value.runs)) {
    throw new Error(
      `Invalid run ledger in ${path}: expected runs to be an array.`,
    );
  }

  return {
    runs: value.runs.map((entry, index) =>
      assertRunLedgerEntry(entry, `${path}.runs[${index}]`),
    ),
  };
}

export async function loadRunLedger(artifactsDir: string): Promise<RunLedger> {
  const path = ledgerPath(artifactsDir);
  try {
    return parseRunLedger(await readJsonFile<unknown>(path), path);
  } catch (error) {
    if (isFileMissingError(error)) {
      // A missing run ledger just means no worker runs have been recorded yet.
      return { runs: [] };
    }
    throw error;
  }
}

export async function appendRunLedgerEntry(
  artifactsDir: string,
  entry: RunLedgerEntry,
): Promise<void> {
  const path = ledgerPath(artifactsDir);
  const lockPath = ledgerLockPath(artifactsDir);
  const tempPath = buildTempLedgerPath(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  await withLedgerLock(lockPath, async () => {
    const ledger = await loadRunLedger(artifactsDir);
    ledger.runs.push(entry);
    await writeJsonFile(tempPath, ledger);
    await rename(tempPath, path);
    await rm(tempPath, { force: true }).catch(() => undefined);
  });
}
