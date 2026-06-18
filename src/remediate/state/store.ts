import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isFileMissingError,
  writeJsonFile,
  withFileLock,
  STALE_LOCK_MS,
} from "audit-tools/shared";
import type { PartialCompletionTerminal } from "audit-tools/shared";
import {
  RemediationPlan,
  RemediationItemState,
  ClarificationRequest,
  ClosingPlan,
  CoverageLedger,
} from "./types.js";

export interface RemediationState {
  status:
    | "pending"
    | "planning"
    | "waiting_for_clarification"
    | "implementing"
    | "triage"
    | "waiting_for_triage"
    | "closing"
    | "complete";
  plan?: RemediationPlan;
  items?: Record<string, RemediationItemState>;
  clarifications?: ClarificationRequest[];
  closing_plan?: ClosingPlan;
  started_at?: string;
  step_count?: number;
  plan_coverage?: CoverageLedger;
  /**
   * Set when the dispatch engine fires a partial-completion terminal (empty pool
   * or livelock guard). When present, `decideNextStep` treats stranded
   * documented/pending items as `blocked` and routes the run to close rather
   * than looping forever on undispatchable work (INV-X06 / OBL-S09).
   */
  partial_completion_terminal?: PartialCompletionTerminal;
  /**
   * Reason the run was routed to close without all items reaching a terminal
   * status. Set by the triage phase on `halt` so the close phase can stamp
   * a `user_halted` marker in the partial report.
   */
  closing_context?: "user_halted";
}

/** Known status values for RemediationState — used for schema validation on load. */
const KNOWN_STATUSES = new Set<string>([
  "pending",
  "planning",
  "waiting_for_clarification",
  "implementing",
  "triage",
  "waiting_for_triage",
  "closing",
  "complete",
]);

/** Validate that a parsed JSON value is a usable RemediationState. */
function validateState(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("state.json must be a JSON object");
    return errors;
  }
  const obj = value as Record<string, unknown>;
  if (!("status" in obj)) {
    errors.push("Missing required field: status");
  } else if (!KNOWN_STATUSES.has(obj["status"] as string)) {
    errors.push(
      `Unknown status "${String(obj["status"])}"; expected one of: ${[...KNOWN_STATUSES].join(", ")}`,
    );
  }
  return errors;
}

const STATE_FILENAME = "state.json";
const LOCK_FILENAME = "state.lock";
// Acquire timeout for the shared file lock, DERIVED to stay safely below shared
// fileLock's STALE_LOCK_MS rather than hardcoded — tying them programmatically so
// the invariant can't silently drift. A fresh-but-held lock then times out
// deterministically before it could be reclaimed as stale; an equal/greater
// timeout makes that a load-sensitive boundary race (the lock is written just
// before the acquire starts, so its stale point precedes the deadline). The margin
// absorbs the write→acquire gap, loop overhead, and load drift.
const LOCK_TIMEOUT_MARGIN_MS = 10_000;
export const LOCK_TIMEOUT_MS = STALE_LOCK_MS - LOCK_TIMEOUT_MARGIN_MS;

function statePath(artifactsDir: string): string {
  return join(artifactsDir, STATE_FILENAME);
}

function lockPath(artifactsDir: string): string {
  return join(artifactsDir, LOCK_FILENAME);
}

export class StateStore {
  constructor(
    private artifactsDir: string,
    // correlationId retained for API compatibility; no longer used in lock body
    private readonly _correlationId?: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
  }

  /**
   * Read state.json and schema-validate it. Returns null when the file is
   * absent. Throws when the file is present but fails schema validation
   * (corrupt or version-drifted — callers must not silently swallow such a
   * state and hand it to the state machine). INV-remediate-state-01.
   *
   * Does NOT hold the lock — use `mutate` for any read-modify-write transition
   * that requires TOCTOU safety (INV-remediate-state-02).
   */
  async loadState(): Promise<RemediationState | null> {
    try {
      const data = await readFile(statePath(this.artifactsDir), "utf8");
      const parsed: unknown = JSON.parse(data);
      const errors = validateState(parsed);
      if (errors.length > 0) {
        throw new Error(
          `state.json failed schema validation: ${errors.join("; ")}`,
        );
      }
      return parsed as RemediationState;
    } catch (error) {
      if (isFileMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * TOCTOU-safe read-modify-write: acquires the file lock ONCE, loads the
   * current state (or null), passes it to `fn`, and writes the returned state
   * before releasing the lock. No other holder can interleave between the load
   * and the save. INV-remediate-state-02 + INV-remediate-state-03.
   */
  async mutate(
    fn: (current: RemediationState | null) => Promise<RemediationState>,
  ): Promise<RemediationState> {
    await mkdir(this.artifactsDir, { recursive: true });
    const lock = lockPath(this.artifactsDir);
    let next!: RemediationState;
    await withFileLock(
      lock,
      async () => {
        // Load inside the lock — no TOCTOU gap between load and save.
        let current: RemediationState | null = null;
        try {
          const data = await readFile(statePath(this.artifactsDir), "utf8");
          const parsed: unknown = JSON.parse(data);
          const errors = validateState(parsed);
          if (errors.length > 0) {
            throw new Error(
              `state.json failed schema validation: ${errors.join("; ")}`,
            );
          }
          current = parsed as RemediationState;
        } catch (err) {
          if (!isFileMissingError(err)) throw err;
        }
        next = await fn(current);
        await this._writeStateLocked(next);
      },
      LOCK_TIMEOUT_MS,
    );
    return next;
  }

  /**
   * Save state.json unconditionally (no TOCTOU protection). Prefer `mutate`
   * for transitions; use this only when the caller holds an external guarantee
   * that no concurrent writer exists (e.g. single-agent close phase).
   * INV-remediate-state-04: the durable write goes through the shared atomic
   * writer (temp + atomic rename), the single source for atomic JSON writes.
   */
  async saveState(state: RemediationState): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
    const lock = lockPath(this.artifactsDir);
    await withFileLock(
      lock,
      async () => {
        await this._writeStateLocked(state);
      },
      LOCK_TIMEOUT_MS,
    );
  }

  /**
   * Persist state.json while the caller already holds the lock. Delegates to the
   * shared `writeJsonFile` (temp + atomic rename) — the lock-agnostic single
   * source for atomic JSON writes — so this store carries no inline writer of
   * its own.
   */
  private async _writeStateLocked(state: RemediationState): Promise<void> {
    await writeJsonFile(statePath(this.artifactsDir), state);
  }
}
