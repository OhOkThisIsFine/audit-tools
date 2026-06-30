import { join } from "node:path";
import {
  RUN_LEDGER_STATUSES,
  type RunLedger,
  type RunLedgerEntry,
} from "audit-tools/shared";
import { isFileMissingError, readJsonFile } from "audit-tools/shared";

const RUN_LEDGER_FILENAME = "run-ledger.json";
const VALID_RUN_LEDGER_STATUSES = new Set<RunLedgerEntry["status"]>(
  RUN_LEDGER_STATUSES,
);

function ledgerPath(artifactsDir: string): string {
  return join(artifactsDir, RUN_LEDGER_FILENAME);
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
