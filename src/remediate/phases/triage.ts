import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, withFsRetry } from "audit-tools/shared";
import { validateTriageResolution } from "../validation/remediationState.js";
import { rationaleAsksForRetry } from "../steps/stepUtils.js";
import { verifyNodeInWorktree, implementResultPath } from "../steps/dispatch.js";

interface TriageResolution {
  /**
   * The plan this resolution answers (INV-RSM-RESOLUTION-CORRELATE). Optional
   * for host-leniency: an absent plan_id is accepted, but a PRESENT one that
   * does not match the live plan marks the file as a stale leftover from an
   * earlier run — it is archived and treated as absent, never applied.
   */
  plan_id?: string;
  items: {
    finding_id: string;
    action: "retry" | "ignore" | "halt";
    rationale?: string;
  }[];
}

/**
 * Host-facing batch written to `triage_batch.json` — a projection over the
 * blocked items asking the host to write a {@link TriageResolution}. Local to
 * this phase (its only producer); the wire contract is the `TriageBatch` type below.
 */
interface TriageBatch {
  /** The live plan the batch was written for — echoed back on the resolution
   * so INV-RSM-RESOLUTION-CORRELATE can reject a stale cross-run answer. */
  plan_id?: string;
  items: {
    finding_id: string;
    failure_reason: string;
    last_successful_step: string;
  }[];
}

function markRetry(item: { started_at?: string; completed_at?: string }): void {
  item.started_at ??= new Date().toISOString();
  delete item.completed_at;
}

function markTerminal(item: { started_at?: string; completed_at?: string }): void {
  const now = new Date().toISOString();
  item.started_at ??= now;
  item.completed_at = now;
}

// Caps on silent auto-retries (when the user approved at preview). Split by
// failure class so transient infra failures get more headroom than deterministic
// contract/test failures. After the cap, fall through to a real triage prompt.
const MAX_AUTO_RETRIES_CONTRACT = 2;
const MAX_AUTO_RETRIES_INFRA = 5;

/** Keywords that identify infra failures (quota, rate-limit, EPERM, provider crash). */
const INFRA_FAILURE_RE =
  /\b(quota|rate.?limit|EPERM|timeout|tool.?crash|provider.?error)\b/i;

function classifyFailure(failureReason: string | undefined): "infra" | "contract" {
  if (failureReason && INFRA_FAILURE_RE.test(failureReason)) return "infra";
  return "contract";
}

function buildFailureContext(
  failureReason: string | undefined,
  lastSuccessfulStep: string | undefined,
): string {
  const parts: string[] = [];
  if (failureReason) parts.push(`failure: ${failureReason}`);
  if (lastSuccessfulStep) parts.push(`last successful step: ${lastSuccessfulStep}`);
  return parts.join("; ") || "unknown";
}

function retryBlockedItem(
  item: {
    status: string;
    started_at?: string;
    completed_at?: string;
    rework_count?: number;
    infra_rework_count?: number;
    failure_context?: string;
    failure_reason?: string;
    last_successful_step?: string;
  },
  failureClass: "infra" | "contract",
): void {
  // Capture failure context before resetting state so the re-dispatched
  // prompt carries what failed and avoids an identical retry.
  item.failure_context = buildFailureContext(item.failure_reason, item.last_successful_step);
  // "pending" maps to the implement dispatch in the orchestrator.
  item.status = "pending";
  markRetry(item);
  if (failureClass === "infra") {
    item.infra_rework_count = (item.infra_rework_count ?? 0) + 1;
  } else {
    item.rework_count = (item.rework_count ?? 0) + 1;
  }
}

/**
 * Re-verify a blocked item against the CURRENT working tree before retrying it.
 *
 * Runs the item's block's post-merge `targeted_commands` at the repo root. If
 * they pass, the finding is already satisfied in the tree — e.g. a lean/hand lap
 * landed the fix outside this run, or the run is being resumed after the work
 * already shipped — so retrying would just re-hit an already-fixed state, burn
 * the retry budget, and dump the item to human triage (the obsolete-run-resume
 * bug). Reconcile it to `resolved_no_change` instead.
 *
 * This is deliberately NODE-GRANULAR, never a coarse whole-run abandon: an
 * unrelated fix elsewhere cannot make an unrelated node's OWN verification pass,
 * so only the specifically already-satisfied items close; everything genuinely
 * open keeps retrying as before. Returns:
 *   - `"satisfied"`     — commands present and ALL pass (already fixed in tree)
 *   - `"unsatisfied"`   — commands present and at least one fails (still open)
 *   - `"indeterminate"` — no `targeted_commands` to check, so we cannot tell
 *                         (caller falls back to the normal retry path)
 */
function reverifyBlockedItemAgainstTree(
  item: { finding_id: string; block_id?: string },
  state: RemediationState,
  options: OrchestratorOptions,
): "satisfied" | "unsatisfied" | "indeterminate" {
  const block =
    (item.block_id
      ? state.plan?.blocks.find((b) => b.block_id === item.block_id)
      : undefined) ??
    state.plan?.blocks.find((b) => b.items.includes(item.finding_id));
  // No-worker guard (2026-07-06): a passing tree verify only proves this node's
  // work was DONE if an implement worker actually RAN and left a result. When the
  // provider produced nothing (e.g. `worker-command` no-op) the merge marks the
  // node blocked with no result file; a GENERIC `build && check` targeted_command
  // then passes on ANY green tree and would FALSE-resolve an un-implemented node.
  // This is distinct from the deliverable-existence guard below — an edit-node's
  // touched paths PRE-EXIST, so that guard can't catch a never-implemented edit;
  // only the missing worker result can. No result on disk ⇒ "no worker ran" ⇒
  // unsatisfied (route to retry / re-dispatch), never `resolved_no_change`.
  const runId = state.plan?.plan_id;
  if (
    runId &&
    block?.block_id &&
    !existsSync(implementResultPath(options.artifactsDir, runId, block.block_id))
  ) {
    return "unsatisfied";
  }
  // Deliverable-existence guard (2026-07-03): a node cannot be "already satisfied" if
  // its declared deliverables aren't in the tree. A passing `targeted_command` may be
  // satisfied by a SIBLING's work while THIS node's file was never created — proven
  // 2026-07-03, a node was false-reconciled to `resolved_no_change` though its code was
  // never on the branch. Require every declared touched path to exist before trusting
  // the command result. (An edit-node's paths pre-exist, so this only fires on a
  // never-created new-file deliverable — exactly the false-resolve case.)
  for (const rel of block?.touched_files ?? []) {
    if (!existsSync(join(options.root, rel))) return "unsatisfied";
  }
  const commands = block?.targeted_commands;
  if (!commands || commands.length === 0) return "indeterminate";
  return verifyNodeInWorktree(options.root, commands).passed
    ? "satisfied"
    : "unsatisfied";
}

async function archiveIfPresent(path: string, suffix: "consumed" | "stale"): Promise<void> {
  if (!existsSync(path)) return;
  await withFsRetry(() => rename(path, `${path}.${suffix}-${Date.now()}`));
}

async function archiveImplementResultsForRetries(
  state: RemediationState,
  options: OrchestratorOptions,
  findingIds: Set<string>,
): Promise<void> {
  const runId = state.plan?.plan_id;
  if (!runId || findingIds.size === 0) return;

  const blockIds = new Set<string>();
  for (const findingId of findingIds) {
    const item = state.items?.[findingId];
    const blockId =
      item?.block_id ??
      state.plan?.blocks.find((block) => block.items.includes(findingId))?.block_id;
    if (blockId) blockIds.add(blockId);
  }

  for (const blockId of blockIds) {
    await archiveIfPresent(
      join(
        options.artifactsDir,
        "runs",
        runId,
        "implement",
        `implement-${blockId}.result.json`,
      ),
      "stale",
    );
  }
}

export async function runTriagePhase(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<RemediationState> {
  console.log("Running Triage Phase...");

  if (!state.items) {
    throw new Error("Cannot run triage phase: items missing from state.");
  }

  const blockedItems = Object.values(state.items).filter(
    (item) => item.status === "blocked",
  );

  if (blockedItems.length > 0) {
    const resolutionPath = join(options.artifactsDir, "triage_resolution.json");
    let resolution: TriageResolution | null | undefined =
      await readOptionalJsonFile<TriageResolution>(resolutionPath);

    // INV-RSM-RESOLUTION-CORRELATE (COR-227a02ae class): a resolution written
    // for a DIFFERENT plan (a leftover from an earlier run in the same
    // artifacts dir) must never be applied to this run's items. Archive it as
    // stale and proceed as if no resolution exists. Absent plan_id = lenient.
    if (
      resolution &&
      typeof resolution.plan_id === "string" &&
      state.plan?.plan_id !== undefined &&
      resolution.plan_id !== state.plan.plan_id
    ) {
      console.error(
        `[triage] triage_resolution.json plan_id "${resolution.plan_id}" does not match the live plan "${state.plan.plan_id}" — archiving the stale resolution.`,
      );
      await archiveIfPresent(resolutionPath, "stale");
      resolution = undefined;
    }

    if (resolution) {
      const triageIssues = validateTriageResolution(resolution);
      if (triageIssues.filter((i) => i.severity === "error").length > 0) {
        throw new Error(
          `Invalid triage_resolution.json:\n${formatValidationIssues(triageIssues)}`,
        );
      }
      console.log("Found triage_resolution.json. Processing resolutions...");
      let requiresRetry = false;
      const retryFindingIds = new Set<string>();

      // Triage outcome artifact — records per-finding resolution actions.
      const triageOutcome: { finding_id: string; action: string }[] = [];

      for (const res of resolution.items) {
        if (res.action === "halt") {
          await archiveIfPresent(resolutionPath, "consumed");
          console.log("Halt requested during triage. Routing through close (partial report).");
          triageOutcome.push({ finding_id: res.finding_id, action: "halted" });
          await writeJsonFile(
            join(options.artifactsDir, "triage-outcome.json"),
            { resolved_at: new Date().toISOString(), items: triageOutcome },
          );
          return {
            ...state,
            status: "closing",
            closing_context: "user_halted",
            // INV-RSM-STATE-COMPLETE: a closing state must persist a closing_plan.
            closing_plan: state.closing_plan ?? { action: "none" },
          };
        }

        const item = state.items[res.finding_id];
        if (item && item.status === "blocked") {
          // Fix: explicit `action` is authoritative; rationaleAsksForRetry is a
          // tie-breaker used only when action is absent (e.g. action === undefined).
          const shouldRetry =
            res.action === "retry" ||
            (res.action === undefined && rationaleAsksForRetry(res.rationale));
          if (shouldRetry) {
            const failureClass = classifyFailure(item.failure_reason);
            retryBlockedItem(item, failureClass);
            retryFindingIds.add(res.finding_id);
            requiresRetry = true;
            triageOutcome.push({ finding_id: res.finding_id, action: "retried" });
          } else if (res.action === "ignore") {
            item.status = "ignored";
            markTerminal(item);
            item.failure_reason = res.rationale ?? "User ignored during triage";
            triageOutcome.push({ finding_id: res.finding_id, action: "ignored" });
          }
        }
      }

      await archiveIfPresent(resolutionPath, "consumed");
      await writeJsonFile(
        join(options.artifactsDir, "triage-outcome.json"),
        { resolved_at: new Date().toISOString(), items: triageOutcome },
      );
      if (requiresRetry) {
        await archiveImplementResultsForRetries(state, options, retryFindingIds);
        return { ...state, status: "implementing" };
      }

      // Post-resolution still-blocked guard (COR-87f78167): a resolution that
      // covered only SOME of the blocked items must NOT fall through to closing
      // — closing would force-close the undecided remainder as blocked without
      // any human decision. Re-batch the still-blocked items and wait.
      const stillBlockedAfterResolution = Object.values(state.items).filter(
        (item) => item.status === "blocked",
      );
      if (stillBlockedAfterResolution.length > 0) {
        const rebatch: TriageBatch = {
          ...(state.plan?.plan_id ? { plan_id: state.plan.plan_id } : {}),
          items: stillBlockedAfterResolution.map((item) => ({
            finding_id: item.finding_id,
            failure_reason: item.failure_reason ?? "Unknown error",
            last_successful_step: item.last_successful_step ?? "Unknown step",
          })),
        };
        await writeJsonFile(join(options.artifactsDir, "triage_batch.json"), rebatch);
        console.error(
          `\nTriage resolution left ${stillBlockedAfterResolution.length} blocked item(s) undecided. Re-wrote triage_batch.json.`,
        );
        console.error(
          `Please write triage_resolution.json covering them and run again to continue.`,
        );
        return { ...state, status: "waiting_for_triage" };
      }
    } else {
      // No triage resolution yet: auto-retry each blocked item within its
      // per-failure-class retry budget before escalating to human triage. The run
      // was approved at the review gate, so transient/contract failures retry
      // autonomously; only budget-exhausted items fall through to a human prompt.
      let autoRetried = false;
      let reconciledSatisfied = false;
      for (const item of blockedItems) {
        // Re-verify against the CURRENT tree BEFORE retrying (takes precedence
        // over the retry budget): if the node's own verification now passes, the
        // finding is already satisfied — a lean/hand lap landed it, or this is an
        // obsolete run being resumed after the work shipped — so reconcile to
        // resolved_no_change rather than re-hitting an already-fixed state.
        if (reverifyBlockedItemAgainstTree(item, state, options) === "satisfied") {
          item.status = "resolved_no_change";
          markTerminal(item);
          // NB: do not write `last_successful_step` here — dispatch.ts is its
          // single writer (CE-P3-001 / OBL-INV-RPS-05). The reconciliation is
          // conveyed by the terminal `resolved_no_change` status + this log.
          item.failure_reason = undefined;
          console.log(
            `[triage] ${item.finding_id}: already satisfied in the working tree — reconciled to resolved_no_change (no retry).`,
          );
          reconciledSatisfied = true;
          continue;
        }
        // Stop auto-retrying an item that has already been retried the cap
        // number of times for its failure class — leaves it `blocked` so the
        // fall-through below routes the run to a human triage prompt.
        const failureClass = classifyFailure(item.failure_reason);
        const cap =
          failureClass === "infra" ? MAX_AUTO_RETRIES_INFRA : MAX_AUTO_RETRIES_CONTRACT;
        const usedCount =
          failureClass === "infra"
            ? (item.infra_rework_count ?? 0)
            : (item.rework_count ?? 0);
        if (usedCount >= cap) {
          // OBS-df30208a: surface cap exhaustion. Without this the operator
          // cannot distinguish an item that auto-retried from one that fell
          // through to human triage because its retry budget is spent.
          console.error(
            `[triage] ${item.finding_id}: ${failureClass} retry budget exhausted (${usedCount}/${cap}) — routing to human triage.`,
          );
          continue;
        }
        console.log(
          `[triage] ${item.finding_id}: auto-retrying (${failureClass} failure, attempt ${usedCount + 1}/${cap}).`,
        );
        retryBlockedItem(item, failureClass);
        autoRetried = true;
      }
      if (autoRetried) {
        console.log("Auto-retrying blocked findings within their retry budget.");
        return { ...state, status: "implementing" };
      }

      // Re-verification may have reconciled some/all blocked items to
      // resolved_no_change above; only the genuinely-still-open ones remain.
      const stillBlocked = blockedItems.filter((item) => item.status === "blocked");
      if (stillBlocked.length === 0) {
        // Every blocked item was already satisfied in the tree — the run is an
        // obsolete/already-landed one; close it cleanly instead of looping its
        // stale nodes through human triage.
        console.log(
          "All blocked items already satisfied in the working tree — closing the reconciled run.",
        );
        return {
          ...state,
          status: "closing",
          closing_plan: state.closing_plan ?? { action: "none" },
        };
      }

      const triageBatch: TriageBatch = {
        ...(state.plan?.plan_id ? { plan_id: state.plan.plan_id } : {}),
        items: stillBlocked.map((item) => ({
          finding_id: item.finding_id,
          failure_reason: item.failure_reason ?? "Unknown error",
          last_successful_step: item.last_successful_step ?? "Unknown step",
        })),
      };

      await writeJsonFile(
        join(options.artifactsDir, "triage_batch.json"),
        triageBatch,
      );

      console.error(
        `\nFound ${stillBlocked.length} blocked items. Wrote triage_batch.json.`,
      );
      console.error(
        `Please write triage_resolution.json and run again to continue.`,
      );
      return { ...state, status: "waiting_for_triage" };
    }
  } else {
    console.log("No blocked items found. Proceeding to close.");
  }

  // "closing" status triggers runClosePhase in the orchestrator switch.
  // INV-RSM-STATE-COMPLETE: every closing transition persists a closing_plan.
  return {
    ...state,
    status: "closing",
    closing_plan: state.closing_plan ?? { action: "none" },
  };
}
