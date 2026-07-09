import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type LockedJsonStore,
  createLockedJsonStore,
  LOCKED_JSON_STORE_TIMEOUT_MS,
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
  /**
   * Persisted host-capability handshake. Opaque to the state store: stored and
   * round-tripped verbatim, never interpreted here (validateState only gates
   * `status`). The dispatch-build site merges the explicitly-supplied host
   * options into this so a later call that omits a flag reuses the persisted
   * value rather than re-flooring it (C1). Fields: can-dispatch-subagents,
   * max-concurrent, context/output token windows, and the model roster / id.
   */
  host_capabilities?: HostCapabilities;
}

/**
 * Opaque persisted host-capability handshake (C1). Every field optional — only
 * the explicitly-supplied fields of a given call are persisted, so an omitted
 * field never clobbers a previously-stored value.
 */
export interface HostCapabilities {
  can_dispatch_subagents?: boolean;
  max_concurrent?: number;
  context_tokens?: number;
  output_tokens?: number;
  model_id?: string;
  models?: unknown;
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
// Acquire timeout for the shared file lock — the STALE_LOCK_MS-minus-margin
// derivation is single-sourced in the shared locked JSON store (a fresh-but-held
// lock times out deterministically before it could be reclaimed as stale).
// Re-exported here because callers and tests pin the store's timeout by name.
export const LOCK_TIMEOUT_MS = LOCKED_JSON_STORE_TIMEOUT_MS;

function statePath(artifactsDir: string): string {
  return join(artifactsDir, STATE_FILENAME);
}

function lockPath(artifactsDir: string): string {
  return join(artifactsDir, LOCK_FILENAME);
}

export class StateStore {
  /**
   * Thin adapter over the shared locked JSON store: `state.json` guarded by a
   * sibling `state.lock`. The lock-timeout derivation and the read-under-lock →
   * atomic-write cycle (shared `writeJsonFile`: temp + atomic rename,
   * INV-remediate-state-04) are single-sourced there; only the
   * RemediationState schema validation lives here.
   */
  private readonly store: LockedJsonStore<RemediationState | null>;

  constructor(
    private artifactsDir: string,
    // correlationId retained for API compatibility; no longer used in lock body
    private readonly _correlationId?: string,
  ) {
    this.store = createLockedJsonStore<RemediationState | null>({
      path: statePath(artifactsDir),
      lockPath: lockPath(artifactsDir),
      parse: (raw) => {
        if (raw === undefined) {
          return null;
        }
        const errors = validateState(raw);
        if (errors.length > 0) {
          throw new Error(
            `state.json failed schema validation: ${errors.join("; ")}`,
          );
        }
        return raw as RemediationState;
      },
    });
  }

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
    return this.store.read();
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
    let next!: RemediationState;
    await this.store.mutate(async (current) => {
      next = await fn(current);
      return next;
    });
    return next;
  }

  /**
   * Save state.json unconditionally (no TOCTOU protection, no read — so a
   * corrupt on-disk state never blocks recovery). Prefer `mutate` for
   * transitions; use this only when the caller holds an external guarantee
   * that no concurrent writer exists (e.g. single-agent close phase).
   */
  async saveState(state: RemediationState): Promise<void> {
    await this.store.replace(state);
  }
}
