import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_LEDGER_STATUSES,
  type RunLedger,
  type RunLedgerEntry,
} from "../types/runLedger.js";
import { isFileMissingError, readJsonFile, writeJsonFile } from "../io/json.js";

const RUN_LEDGER_FILENAME = "run-ledger.json";
const RUN_LEDGER_LOCK_FILENAME = "run-ledger.lock";
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_RETRY_LIMIT = 100;
const VALID_RUN_LEDGER_STATUSES = new Set<RunLedgerEntry["status"]>(
  RUN_LEDGER_STATUSES,
);

function ledgerPath(artifactsDir: string): string {
  return join(artifactsDir, RUN_LEDGER_FILENAME);
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

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
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
        `Invalid run ledger in ${fieldPath}.${field}: expected a string or null.`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLedgerLock(artifactsDir: string) {
  const lockPath = ledgerLockPath(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      if (attempt === LOCK_RETRY_LIMIT - 1) {
        throw new Error(
          `Timed out waiting to update ${ledgerPath(artifactsDir)} because ${lockPath} is locked.`,
        );
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Failed to acquire lock for ${ledgerPath(artifactsDir)}.`);
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
  const lockHandle = await acquireLedgerLock(artifactsDir);
  const path = ledgerPath(artifactsDir);
  const tempPath = buildTempLedgerPath(artifactsDir);

  try {
    const ledger = await loadRunLedger(artifactsDir);
    ledger.runs.push(entry);
    await writeJsonFile(tempPath, ledger);
    await rename(tempPath, path);
  } finally {
    await lockHandle.close();
    await rm(ledgerLockPath(artifactsDir), { force: true });
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
