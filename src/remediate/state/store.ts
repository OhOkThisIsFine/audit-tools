// sites-pinned: tests/remediate/clarification-round-contract.test.ts
import { z } from "zod";
import { executionPlanReferenceIssues } from "../../shared/types/executionPlan.js";
import { ITEM_STATUSES, isTerminalStatus } from "./itemStatus.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type LockedJsonStore,
  createLockedJsonStore,
  LOCKED_JSON_STORE_TIMEOUT_MS,
  SchemaVersionMismatchError,
  SKIP_WRITE,
  assertNotNodeWorktreeCwd,
  readOptionalJsonFile,
  writeJsonFile,
  withFileLock,
} from "audit-tools/shared";
import {
  type ConformanceReviewBinding,
  RemediationPlan,
  type FindingDisposition,
  type SourceVerification,
  SourceVerificationSchema,
  RemediationPlanSchema,
  RemediationItemState,
  ClosingPlan,
  isClarificationCategory,
  CoverageLedger,
  RemediationHostHandoffRecord,
  RemediationHostHandoffRecordSchema,
} from "./types.js";
import {
  REMEDIATION_RUN_STATUSES,
  isRemediationRunStatus,
  type RemediationRunStatus,
} from "./runStatus.js";

/**
 * Unit-native authored runtime. Older stamped states are refused without mutation:
 * their source/item identities cannot be losslessly interpreted as execution units.
 * Versionless new-shape states may be constructed in memory and are stamped only
 * on write; loading never fabricates a version or discards accepted evidence.
 */
export const REMEDIATION_STATE_CONTRACT_VERSION =
  "remediate-code-state/v2" as const;

/** The file this store owns, named once so the version error can name it too. */
const STATE_FILENAME = "state.json";

export const OPERATOR_LIFECYCLE_FILENAME = "operator-lifecycle.json";
export const OPERATOR_LIFECYCLE_VERSION = "remediation-operator-lifecycle/v1" as const;
const OperatorLifecycleSchema = z.object({
  contract_version: z.literal(OPERATOR_LIFECYCLE_VERSION),
  mode: z.enum(["active", "paused", "cancelled"]),
  plan_only: z.boolean(),
  updated_at: z.string().datetime(),
  reason: z.enum(["operator", "plan-only"]).optional(),
  // Diagnostic only. Live state/items/host_handoff remain continuation truth;
  // resume must never restore this snapshot over accepted work.
  diagnostic_continuation: z.object({
    phase: z.enum(REMEDIATION_RUN_STATUSES).nullable(),
    plan_id: z.string().nullable(),
    active_item_ids: z.array(z.string()),
    workload_sha256: z.string().optional(),
  }).strict().optional(),
  host_report: z.object({
    worktree: z.string().min(1).optional(),
    outcome: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();
export type OperatorLifecycle = z.infer<typeof OperatorLifecycleSchema>;
export type OperatorLifecycleAction = "pause" | "resume" | "cancel" | "plan-only";

export interface RemediationState {
  /**
   * Schema version of this persisted state. Optional on the TYPE because a
   * state written before the field existed is a legal input; see
   * {@link REMEDIATION_STATE_CONTRACT_VERSION} for how it reads.
   */
  contract_version?: typeof REMEDIATION_STATE_CONTRACT_VERSION;
  status: RemediationRunStatus;
  /** Tool-minted current-run snapshot; survives handoff/frontier replacement. */
  conformance_review?: ConformanceReviewBinding;
  plan?: RemediationPlan;
  items?: Record<string, RemediationItemState>;
  finding_dispositions?: Record<string, FindingDisposition>;
  source_verifications?: Record<string, SourceVerification>;
  closing_plan?: ClosingPlan;
  started_at?: string;
  step_count?: number;
  plan_coverage?: CoverageLedger;
  /**
   * Reason the run was routed to close without all items reaching a terminal
   * status. Set by the triage phase on `halt` so the close phase can stamp
   * a `user_halted` marker in the partial report.
   */
  closing_context?: "user_halted";
  /**
   * Union of repo-relative paths every ACCEPTED node has actually cherry-picked
   * into the main tree this run (ground truth, path-sorted, de-duplicated).
   * Populated from accepted host results. Each entry is validated against the
   * prompt-bound write scope before it can advance item state.
   *
   * This is the close phase's staging manifest (`collectStagingFiles` in
   * `src/remediate/phases/close.ts`): the invariant "remediation close must
   * never commit files the run didn't touch" is enforced by staging exactly
   * `applied_edit_surface ∩ currently-dirty`, never a repo-wide sweep.
   *
   * The close phase additionally unions in each resolved finding's declared
   * `affected_files` as a conservative fallback for current states created
   * before host-result ingestion recorded this surface.
   */
  applied_edit_surface?: string[];
  /**
   * Repo-relative paths that were ALREADY dirty (changed vs HEAD, or untracked)
   * when this run's plan was created — captured once via `stagedAndUntracked`
   * at the extracted-plan join site (src/remediate/steps/nextStep.ts), path-sorted,
   * and never re-captured on a replan (re-capturing after edits landed would
   * wrongly classify the run's own hand-applied work as pre-existing dirt).
   *
   * Consumed by the close phase's `resolveEditSurfaceManifest`: a file that was
   * dirty BEFORE the run started cannot be one of the run's edits, so it is
   * excluded from the DECLARED (fallback) manifest sources (finding
   * `affected_files` — plan-time declarations/write-grants, not verified
   * diffs). Ground-truth entries
   * (`applied_edit_surface`) are also excluded from closing-stage staging: a
   * landed commit proves attribution of the commit, not ownership of any
   * still-dirty pre-run content at that path.
   *
   * Absent on states created before this field existed: treated as empty — no
   * exclusions, preserving prior behavior for in-flight runs.
   */
  run_start_dirty?: string[];
  /**
   * Independent digest binding for the currently emitted host workload.
   * Cleared once that workload has no pending items. Production result
   * ingestion requires this record before it trusts any host-written file.
   */
  host_handoff?: RemediationHostHandoffRecord;
}

/**
 * Statuses whose derived step decisions READ the plan/items — a state in one of
 * these with those fields missing is unusable (the state machine would crash or,
 * worse, silently mis-derive), so the load gate rejects it up front
 * (INV-RSM-STATE-COMPLETE, DAT-017d52ff). `complete` is exempt: its only
 * decision path presents the report, and a green close deletes state.json.
 */
const PLAN_REQUIRED_STATUSES = new Set<string>([
  "implementing",
  "triage",
  "waiting_for_triage",
  "closing",
]);

/** Validate that a parsed JSON value is a usable RemediationState. */
function validateState(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("state.json must be a JSON object");
    return errors;
  }
  const obj = value as Record<string, unknown>;
  // The contract version, checked BEFORE anything is read off the state: a file
  // that positively claims another release's semantics must not have its fields
  // interpreted under this one's. ABSENT is admitted (see
  // REMEDIATION_STATE_CONTRACT_VERSION) — this is the stamped-and-different case
  // only, which throws rather than degrading because the state is authored,
  // unrebuildable work.
  if (
    obj["contract_version"] !== undefined &&
    obj["contract_version"] !== REMEDIATION_STATE_CONTRACT_VERSION
  ) {
    throw new SchemaVersionMismatchError(
      STATE_FILENAME,
      REMEDIATION_STATE_CONTRACT_VERSION,
      String(obj["contract_version"]),
    );
  }
  if (!("status" in obj)) {
    errors.push("Missing required field: status");
    return errors;
  }
  // The ONE membership test, derived from the same array the `status` type is —
  // so the gate and the type cannot drift apart with no red build. This used to
  // be a module-private `Set` hand-mirroring the inline union (DAT-017d52ff):
  // adding a status to the union without updating the set compiled cleanly and
  // then made the load gate reject every persisted state carrying it.
  if (!isRemediationRunStatus(obj["status"])) {
    errors.push(
      `Unknown status "${String(obj["status"])}"; expected one of: ${REMEDIATION_RUN_STATUSES.join(", ")}`,
    );
    return errors;
  }
  const status = obj["status"];

  // Status-conditional completeness (INV-RSM-STATE-COMPLETE): every field the
  // status's decision path reads must be present, or the load fails loudly
  // instead of handing the state machine a partially-persisted state.
  if (PLAN_REQUIRED_STATUSES.has(status)) {
    const plan = obj["plan"];
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      errors.push(`status "${status}" requires a persisted plan`);
    } else {
      const parsed = RemediationPlanSchema.safeParse(plan);
      if (!parsed.success) errors.push(...parsed.error.issues.map(issue => `plan.${issue.path.join(".")}: ${issue.message}`));

    }
    const items = obj["items"];
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      errors.push(`status "${status}" requires persisted items`);
    } else {
      for (const [key, item] of Object.entries(items as Record<string, unknown>)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          errors.push(`items["${key}"] must be an object`);
          continue;
        }
        const it = item as Record<string, unknown>;
        if (it["unit_id"] !== key || key.length === 0) errors.push(`items["${key}"] has an invalid unit_id identity`);
        if (it["finding_id"] !== undefined || it["block_id"] !== undefined) errors.push(`items["${key}"] uses retired finding/block identity`);
        if (!(ITEM_STATUSES as readonly unknown[]).includes(it["status"])) errors.push(`items["${key}"] has an invalid status`);

      }
    }
  }
  if (obj["plan"] !== undefined) {
    const parsed = RemediationPlanSchema.safeParse(obj["plan"]);
    if (!parsed.success) errors.push(...parsed.error.issues.map(issue => `plan.${issue.path.join(".")}: ${issue.message}`));
    else {
      errors.push(...executionPlanReferenceIssues(parsed.data, parsed.data.findings.map(finding => finding.id)));
      const unitIds = new Set(parsed.data.units.map(unit => unit.id));
      const items = obj["items"] as Record<string, unknown> | undefined;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        for (const id of Object.keys(items)) if (!unitIds.has(id)) errors.push(`items["${id}"] is not a plan unit`);
        for (const id of unitIds) if (!items[id]) errors.push(`plan unit "${id}" has no runtime item`);
      }
      if (obj["source_verifications"] !== undefined) {
        const sourceRecords = z.record(z.string(), SourceVerificationSchema).safeParse(obj["source_verifications"]);
        if (!sourceRecords.success) errors.push("source_verifications has invalid source evidence");
        else for (const id of Object.keys(sourceRecords.data)) if (!parsed.data.findings.some(f => f.id === id)) errors.push(`source_verifications references unknown source "${id}"`);
      }
      const dispositions = obj["finding_dispositions"];
      if (dispositions !== undefined) {
        const shape = z.record(z.string(), z.object({ status: z.enum(["ignored", "declined"]), reason: z.string().trim().min(1) }).strict()).safeParse(dispositions);
        if (!shape.success) errors.push("finding_dispositions must carry explicit source decisions with reasons");
        else for (const id of Object.keys(shape.data)) if (!parsed.data.findings.some(f => f.id === id)) errors.push(`finding_dispositions references unknown source "${id}"`);
      }
    }
  }
  errors.push(...clarificationQuestionErrors(obj));
  if (status === "closing") {
    const closingPlan = obj["closing_plan"];
    if (!closingPlan || typeof closingPlan !== "object" || Array.isArray(closingPlan)) {
      errors.push(`status "closing" requires a persisted closing_plan`);
    }
  }
  if (obj["host_handoff"] !== undefined) {
    const parsed = RemediationHostHandoffRecordSchema.safeParse(
      obj["host_handoff"],
    );
    if (!parsed.success) {
      errors.push(
        `host_handoff failed schema validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "host_handoff"}: ${issue.message}`)
          .join("; ")}`,
      );
    } else if (status !== "implementing") {
      errors.push('host_handoff is only valid while status is "implementing"');
    }
  }
  return errors;
}

/**
 * The clarification invariants. A worker question lives on its item, so:
 *
 * - the retired run-level `clarifications` list is refused (it was a second
 *   copy of the questions, and clearing it after a partial answer left the
 *   unanswered items with nothing to show — the round then listed no question
 *   and the run could not progress);
 * - an item paused as `needs_clarification` must carry its question, because
 *   the clarification round is built from those items alone.
 *
 * The retired representation is refused on both read and write; no question
 * authority is inferred from failure prose.
 */
function clarificationQuestionErrors(obj: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (obj["clarifications"] !== undefined) {
    errors.push(
      "clarifications is retired: a worker question lives on its item as clarification_question",
    );
  }
  const items = obj["items"];
  if (!items || typeof items !== "object" || Array.isArray(items)) return errors;
  for (const [key, item] of Object.entries(items as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    if (it["status"] !== "needs_clarification") continue;
    const question = it["clarification_question"];
    if (
      !question ||
      typeof question !== "object" ||
      Array.isArray(question) ||
      !isClarificationCategory((question as Record<string, unknown>)["category"]) ||
      typeof (question as Record<string, unknown>)["description"] !== "string" ||
      ((question as Record<string, unknown>)["description"] as string).trim().length === 0
    ) {
      errors.push(
        `items["${key}"] is needs_clarification but carries no valid clarification_question ` +
          "(a category and a non-empty description)",
      );
    }
  }
  return errors;
}

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
        // `validateState` throws SchemaVersionMismatchError for a state stamped
        // with another release's contract version; that propagates out of the
        // read exactly as the policy requires (see the constant's doc).
        const adopted = raw;
        const errors = validateState(adopted);
        if (errors.length > 0) {
          throw new Error(
            `state.json failed schema validation: ${errors.join("; ")}`,
          );
        }
        // Returned as READ. The version is stamped on the way IN (the write
        // hook below), so a state that has been through this store carries it
        // on disk and this read is byte-faithful: what `loadState` returns is
        // what the file says, with no field conjured at read time. A state
        // written before the field existed has none until its next write, and
        // `validateState` admits that (see the constant's doc) — which is the
        // whole reason the field is optional on the type rather than required.
        return adopted as RemediationState;
      },
      // The WRITE hook. Without it the store's own `persist` wrote whatever a
      // caller handed it — the load gate was the only validation on the path,
      // so a state that was never round-tripped (constructed in memory and
      // saved, which is every transition) could reach disk carrying fields no
      // reader would accept. The gate and the writer now share ONE validator.
      validate: (next) => {
        if (next === null) return;
        const errors = validateState(next);
        if (errors.length > 0) {
          throw new Error(
            `refusing to write state.json: ${errors.join("; ")}`,
          );
        }
      },
    });
  }

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
  }

  async loadOperatorLifecycle(): Promise<OperatorLifecycle | null> {
    const raw = await readOptionalJsonFile<unknown>(join(this.artifactsDir, OPERATOR_LIFECYCLE_FILENAME));
    return raw === undefined ? null : OperatorLifecycleSchema.parse(raw);
  }

  async assertOperatorActive(): Promise<void> {
    const control = await this.loadOperatorLifecycle();
    if (control && control.mode !== "active") {
      throw new Error(`Remediation is ${control.mode}; ${control.mode === "cancelled" ? "a cancelled run cannot advance" : "resume it before accepting work"}.`);
    }
  }

  /** Recovery writers share the advance mutex, then take the state lock. */
  async withActiveOperator<T>(body: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.artifactsDir, "phase.lock"), async () => {
      await this.assertOperatorActive();
      return body();
    });
  }

  /** Caller MUST hold phase.lock, including automatic plan-only boundaries. */
  async setOperatorLifecycleUnderPhaseLock(
    action: OperatorLifecycleAction,
    hostReport?: OperatorLifecycle["host_report"],
    reason: "operator" | "plan-only" = "operator",
  ): Promise<OperatorLifecycle> {
    assertNotNodeWorktreeCwd("a remediation operator lifecycle transition");
    const current = await this.loadOperatorLifecycle();
    if (current?.mode === "cancelled") {
      if (action === "resume" || action === "plan-only") throw new Error("A cancelled remediation run cannot be resumed.");
      return current;
    }
    const next: OperatorLifecycle = current ? { ...current } : {
      contract_version: OPERATOR_LIFECYCLE_VERSION,
      mode: "active", plan_only: false, updated_at: new Date().toISOString(),
    };
    if (hostReport) next.host_report = { ...next.host_report, ...hostReport };
    if (action === "plan-only") next.plan_only = true;
    else if (action === "resume") { next.mode = "active"; next.plan_only = false; }
    else if (next.mode !== (action === "pause" ? "paused" : "cancelled")) {
      next.mode = action === "pause" ? "paused" : "cancelled";
      next.reason = reason;
      if (action === "cancel") next.plan_only = false;
      const state = await this.loadState();
      next.diagnostic_continuation = {
        phase: state?.status ?? null,
        plan_id: state?.plan?.plan_id ?? null,
        active_item_ids: Object.values(state?.items ?? {})
          .filter((item) => !isTerminalStatus(item.status)).map((item) => item.unit_id).sort(),
        ...(state?.host_handoff ? { workload_sha256: state.host_handoff.workload_sha256 } : {}),
      };
    }
    if (current && JSON.stringify(next) === JSON.stringify(current)) return current;
    next.updated_at = new Date().toISOString();
    await writeJsonFile(join(this.artifactsDir, OPERATOR_LIFECYCLE_FILENAME), OperatorLifecycleSchema.parse(next));
    return next;
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
   *
   * Returning the shared `SKIP_WRITE` sentinel from `fn` is the no-op: the write
   * is skipped and this resolves with the state that was READ. The skip decision
   * is taken inside the SAME held lock as the write it avoids, so it cannot race
   * a concurrent writer. Whole-run verbs that routinely change nothing — the
   * `recover-ingest` retry loop is the live one — otherwise replace `state.json`
   * with byte-identical content on every pass, which makes "did anything
   * change?" unanswerable from the file and rewrites an artifact other readers
   * treat as the run's ground truth.
   */
  async mutate(
    fn: (
      current: RemediationState | null,
    ) => Promise<RemediationState | typeof SKIP_WRITE>,
  ): Promise<RemediationState> {
    // Node-worktree guard (defense-in-depth behind the CLI-entry guard): a
    // dispatched worker's process must never transition shared run state,
    // whatever invocation shape reached this writer.
    assertNotNodeWorktreeCwd("a remediation state.json transition");
    let next: RemediationState | typeof SKIP_WRITE = SKIP_WRITE;
    const readValue = await this.store.mutate(async (current) => {
      const produced = await fn(current);
      // Same stamp as `saveState`, at the other write door: the version is a
      // property of the store's writes, so no transition can produce an
      // unstamped file. The value RESOLVED to the caller is the newly stamped
      // state (matching what `saveState` put on disk); the SKIP_WRITE arm below
      // still resolves with what was READ.
      next = produced === SKIP_WRITE ? SKIP_WRITE : stampedState(produced);
      return next;
    });
    if (next !== SKIP_WRITE) return next;
    // The store resolves a skipped write with the value it read. A skipped write
    // over an ABSENT file has no state to resolve with — the caller asked to
    // leave nothing there and nothing was there, so there is nothing to return.
    if (readValue === null) {
      throw new Error(
        "StateStore.mutate returned SKIP_WRITE but no state.json exists to resolve with",
      );
    }
    return readValue;
  }

  /**
   * Save state.json unconditionally (no TOCTOU protection, no read — so a
   * corrupt on-disk state never blocks recovery). Prefer `mutate` for
   * transitions; use this only when the caller holds an external guarantee
   * that no concurrent writer exists (e.g. single-agent close phase).
   */
  async saveState(state: RemediationState): Promise<void> {
    // Same node-worktree guard as `mutate` — the unconditional-write recovery
    // path must not be the one door a worker-context write can still use.
    assertNotNodeWorktreeCwd("a remediation state.json write");
    await this.store.replace(stampedState(state));
  }
}

/**
 * The state as it goes to disk: its own `contract_version` when it has one,
 * else the current constant.
 *
 * Stamping here — at the two write doors, not in the read path — is what keeps
 * `loadState` byte-faithful. A version conjured at READ time would make
 * `loadState()` return a key the file does not contain, so the round trip
 * `saveState(x)` → `loadState()` would not equal `x`, and a caller comparing
 * states (the ingress's `state_changed`, the tests) would see a change that
 * never happened. A state that already carries a DIFFERENT version is left
 * alone: the write hook's validator refuses it loudly rather than this helper
 * silently overwriting the caller's claim.
 */
function stampedState(state: RemediationState): RemediationState {
  return state.contract_version === undefined
    ? { ...state, contract_version: REMEDIATION_STATE_CONTRACT_VERSION }
    : state;
}
