// sites-pinned: tests/remediate/next-step-lifecycle-verbs.test.ts
// Operator lifecycle verbs (O31 / packet 14): first-class, persisted `plan-only`,
// `pause`, `resume`, and `cancel` transitions through the state store.
//
// The 2026-08-03 defect these exist to close: a plan-only stop left
// `.audit-tools/remediation/state.json` at `status: implementing`, the host work
// and its worktree had to be found and reconciled by hand, and the worktree
// survived only because the operator happened to know its path. There was no
// first-class place on disk that named the pause, the item, the binding, or the
// exact continuation — so a process restart had nothing to resume from.
//
// Each verb mutates exactly one run's state through the store (whose own
// `assertNotNodeWorktreeCwd` refuses a worker-context write) and writes a
// `lifecycle` record the next process discovers. None of them runs the state
// machine, so none can dispatch work, run a gate, or close the run — a lifecycle
// verb is a transition of the pause/cancel/resume surface, not an advance.
//
// `resume` deliberately consumes the record and clears it: it restores the saved
// phase and workload binding, then lets the ordinary `next-step` drain take over.
// The "resume must not re-run accepted work" property rests on the drain, which
// only ever dispatches still-`pending` frontier items — terminal (accepted)
// items are skipped by construction, so resume re-enters mid-run rather than
// re-starts it.

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemediationState, StateStore } from "../state/store.js";
import type { LifecycleRecord, LifecycleWorktree } from "../state/types.js";
import { LIFECYCLE_RECORD_SCHEMA_VERSION } from "../state/types.js";
import { invalidateStepContracts } from "audit-tools/shared";

/**
 * The single, tool-minted outcome of a lifecycle verb: a status token plus a
 * body to print, and (for a refusal) the reason the verb could not run. Mirrors
 * `RecoveryVerbResult` so the CLI action branches stay thin argv→call→print
 * shims and the real transitions are callable directly by a test without
 * spawning the CLI.
 */
export type LifecycleVerbResult =
  | { readonly status: "ok"; readonly body: Record<string, unknown> }
  | { readonly status: "unrunnable"; readonly message: string };

/** The run phases a lifecycle record may name for resume. */
const RESUMABLE_PHASES: ReadonlySet<string> = new Set([
  "planning",
  "waiting_for_clarification",
  "implementing",
  "triage",
  "waiting_for_triage",
  "closing",
]);

/**
 * The current item id, best-effort: the first non-terminal item (so pause
 * names the work the run was about to do), else null. Never used to re-run work
 * on resume — it is a pointer for an operator, not a re-dispatch signal.
 */
function currentItemId(state: RemediationState): string | null {
  for (const item of Object.values(state.items ?? {})) {
    const status = item.status;
    if (
      status === "pending" ||
      status === "tested" ||
      status === "tested_successfully" ||
      status === "refactored" ||
      status === "verified" ||
      status === "needs_clarification"
    ) {
      return item.finding_id;
    }
  }
  return null;
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * `plan-only`: park a run that has crossed the ordinary planning gates into
 * `implementing`, before the next workload is dispatched. The CLI can request
 * this stop before intake; next-step carries that request through planning and
 * calls this verb at the boundary. A direct call cannot bypass planning gates.
 */
export async function planOnlyVerb(options: {
  root: string;
  artifactsDir: string;
  worktree?: LifecycleWorktree;
}): Promise<LifecycleVerbResult> {
  return pauseLike(options, {
    action: "plan_only",
  });
}

/**
 * `pause`: snapshot the current phase, item, workload binding, and exact
 * continuation, then set the run `paused`. The workload binding is MOVED into
 * the lifecycle record (clearing `host_handoff`, which the store validator
 * scopes to `implementing`) so resume can restore it verbatim.
 */
export async function pauseVerb(options: {
  root: string;
  artifactsDir: string;
  worktree?: LifecycleWorktree;
}): Promise<LifecycleVerbResult> {
  return pauseLike(options, {
    action: "pause",
  });
}

async function pauseLike(
  options: {
    root: string;
    artifactsDir: string;
    worktree?: LifecycleWorktree;
  },
  rec: {
    action: "plan_only" | "pause";
  },
): Promise<LifecycleVerbResult> {
  const store = new StateStore(options.artifactsDir);
  const state = await store.loadState();
  if (!state) {
    return {
      status: "unrunnable",
      message:
        `no remediation state at ${options.artifactsDir} to ${rec.action}`,
    };
  }
  if (state.status === "cancelled") {
    return {
      status: "unrunnable",
      message: "the run is cancelled; it cannot be paused or plan-only stopped",
    };
  }
  if (state.status === "complete") {
    return {
      status: "unrunnable",
      message: "the run is complete; there is nothing to pause",
    };
  }
  if (state.status === "paused") {
    const saved = state.lifecycle;
    if (!saved || !RESUMABLE_PHASES.has(saved.phase)) {
      return {
        status: "unrunnable",
        message: "the run is paused without a resumable lifecycle continuation",
      };
    }
    if (rec.action === "plan_only" && saved.action !== "plan_only") {
      return {
        status: "unrunnable",
        message: "the run is already paused by another lifecycle action; resume it before plan-only",
      };
    }
    // Repeating a pause is a no-op. Replacing the record would lose its phase,
    // workload binding, original timestamp, and exact continuation.
    return {
      status: "ok",
      body: {
        status: "paused",
        action: saved.action,
        lifecycle: saved,
        run_id: state.plan?.plan_id ?? null,
      },
    };
  }
  if (!RESUMABLE_PHASES.has(state.status)) {
    return {
      status: "unrunnable",
      message: `the run is in non-resumable phase "${state.status}"; advance it before pausing`,
    };
  }
  if (rec.action === "plan_only") {
    if (state.status !== "implementing") {
      return {
        status: "unrunnable",
        message: "planning is not complete; run `remediate-code next-step` through its planning gates before plan-only",
      };
    }
    if (
      !state.plan ||
      !state.items ||
      state.host_handoff ||
      state.conformance_review_policy?.first_dispatch_recorded === true ||
      (!state.plan_only_request &&
        Object.values(state.items).some((item) => item.status !== "pending"))
    ) {
      return {
        status: "unrunnable",
        message: "plan-only requires the completed planning boundary before the first implementation dispatch",
      };
    }
    if (
      state.plan_only_request?.plan_id !== undefined &&
      state.plan_only_request.plan_id !== state.plan.plan_id
    ) {
      return {
        status: "unrunnable",
        message: "the plan-only request belongs to another remediation plan",
      };
    }
  }
  const { host_handoff: binding, plan_only_request: pendingPlanOnly, ...withoutRequest } = state;
  const rest = rec.action === "plan_only"
    ? withoutRequest
    : { ...withoutRequest, ...(pendingPlanOnly ? { plan_only_request: pendingPlanOnly } : {}) };
  const lifecycle: LifecycleRecord = {
    contract_version: LIFECYCLE_RECORD_SCHEMA_VERSION,
    action: rec.action,
    phase: state.status,
    current_item_id: currentItemId(state),
    ...(binding ? { binding } : {}),
    continuation:
      rec.action === "plan_only"
        ? "planning is complete; run `remediate-code resume`, then `next-step` to begin implementation"
        : `run paused in ${state.status}; run \`remediate-code resume\` to continue`,
    ...((options.worktree ?? (rec.action === "plan_only" ? pendingPlanOnly?.worktree : undefined))
      ? { worktree: options.worktree ?? pendingPlanOnly?.worktree }
      : {}),
    at: timestamp(),
  };
  // Move the binding into the lifecycle record and drop it from the live state:
  // `host_handoff` is only valid under `implementing`, and a paused run must not
  // still claim a live workload. `resume` restores it.
  await store.saveState({
    ...rest,
    status: "paused",
    lifecycle,
  });
  await invalidateStepContracts(options.artifactsDir).catch(() => undefined);
  await rm(join(options.artifactsDir, "confirm_resume_ack.json"), { force: true }).catch(
    () => undefined,
  );
  return {
    status: "ok",
    body: {
      status: "paused",
      action: rec.action,
      lifecycle,
      run_id: state.plan?.plan_id ?? null,
    },
  };
}

/**
 * `resume`: consume the saved continuation — restore the phase and the workload
 * binding — and clear the record. Accepted (terminal) items stay terminal, so
 * the ordinary drain skips them. Runs no step; `next-step` follows to advance
 * from the restored phase.
 */
export async function resumeVerb(options: {
  root: string;
  artifactsDir: string;
}): Promise<LifecycleVerbResult> {
  const store = new StateStore(options.artifactsDir);
  const state = await store.loadState();
  if (!state) {
    return { status: "unrunnable", message: "no remediation state to resume" };
  }
  if (state.status !== "paused") {
    return {
      status: "unrunnable",
      message: `the run is not paused (status "${state.status}"); nothing to resume`,
    };
  }
  const lifecycle = state.lifecycle;
  if (!lifecycle) {
    return {
      status: "unrunnable",
      message: "the run is paused but carries no lifecycle record; nothing to resume from",
    };
  }
  if (lifecycle.action === "cancel") {
    return {
      status: "unrunnable",
      message: "the run was cancelled; it cannot be resumed",
    };
  }
  const phase = lifecycle.phase;
  if (!RESUMABLE_PHASES.has(phase)) {
    return {
      status: "unrunnable",
      message: `lifecycle.phase "${phase}" is not a resumable phase`,
    };
  }
  const { lifecycle: _consumed, ...rest } = state;
  const next: RemediationState = {
    ...rest,
    status: phase as RemediationState["status"],
    // Restore the binding that pause moved into the record. Its `work_item_ids`
    // are re-derived on the next prepare if the scope changed; restoring it
    // verbatim here only preserves the identity pause captured.
    ...(lifecycle.binding ? { host_handoff: lifecycle.binding } : {}),
  };
  await store.saveState(next);
  // The step contract named the paused run; it no longer describes the restored
  // phase, so invalidate it (best-effort — a missing steps tree is not a fault).
  await invalidateStepContracts(options.artifactsDir).catch(() => undefined);
  // Acknowledge the resume so a subsequent next-step advances directly without
  // halting on confirm_resume_or_restart (the operator already explicitly ran resume).
  await writeFile(
    join(options.artifactsDir, "confirm_resume_ack.json"),
    JSON.stringify({ choice: "resume" }, null, 2),
    "utf8",
  ).catch(() => undefined);
  return {
    status: "ok",
    body: {
      status: "resumed",
      phase,
      run_id: state.plan?.plan_id ?? null,
    },
  };
}

/**
 * `cancel`: stamp a terminal cancellation and preserve artifacts. The run is set
 * `cancelled` — NOT routed through the close phase, whose green path archives
 * the friction record and deletes the artifacts dir. Everything on disk stays
 * put; `next-step` on a `cancelled` state reports terminal cancellation and
 * never advances.
 */
export async function cancelVerb(options: {
  root: string;
  artifactsDir: string;
  worktree?: LifecycleWorktree;
}): Promise<LifecycleVerbResult> {
  const store = new StateStore(options.artifactsDir);
  const state = await store.loadState();
  if (!state) {
    return { status: "unrunnable", message: "no remediation state to cancel" };
  }
  if (state.status === "complete") {
    return { status: "unrunnable", message: "the run is already complete" };
  }
  if (state.status === "cancelled") {
    return { status: "unrunnable", message: "the run is already cancelled" };
  }
  const { host_handoff: _binding, ...rest } = state;
  const lifecycle: LifecycleRecord = {
    contract_version: LIFECYCLE_RECORD_SCHEMA_VERSION,
    action: "cancel",
    phase: state.status,
    current_item_id: currentItemId(state),
    continuation: "the run was cancelled by the operator; artifacts are preserved",
    ...(options.worktree ? { worktree: options.worktree } : {}),
    at: timestamp(),
  };
  await store.saveState({
    ...rest,
    status: "cancelled",
    lifecycle,
  });
  await invalidateStepContracts(options.artifactsDir).catch(() => undefined);
  await rm(join(options.artifactsDir, "confirm_resume_ack.json"), { force: true }).catch(
    () => undefined,
  );
  return {
    status: "ok",
    body: {
      status: "cancelled",
      lifecycle,
      run_id: state.plan?.plan_id ?? null,
    },
  };
}
