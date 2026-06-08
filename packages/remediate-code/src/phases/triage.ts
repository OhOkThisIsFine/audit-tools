import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { TriageBatch } from "../state/types.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { readOptionalJsonFile, writeJsonFile, formatValidationIssues, withFsRetry } from "@audit-tools/shared";
import { validateTriageResolution } from "../validation/remediationState.js";
import { rationaleAsksForRetry } from "../steps/stepUtils.js";

interface TriageResolution {
  items: {
    finding_id: string;
    action: "retry" | "ignore" | "halt";
    rationale?: string;
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

// Cap on silent auto-retries (when the user approved at preview). Without it, an
// item that fails deterministically — including one stranded by an unsatisfiable
// block dependency, which handleDocumenting marks `blocked` — would be retried
// forever (documenting→implement→triage→documenting). After the cap, fall through
// to a real triage prompt so the user decides (ignore/halt).
const MAX_AUTO_RETRIES = 2;

function retryBlockedItem(
  item: { status: string; started_at?: string; completed_at?: string; rework_count?: number },
): void {
  // "documented" maps to runImplementPhase in the orchestrator switch.
  item.status = "documented";
  markRetry(item);
  item.rework_count = (item.rework_count ?? 0) + 1;
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
    const resolution =
      await readOptionalJsonFile<TriageResolution>(resolutionPath);

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

      for (const res of resolution.items) {
        if (res.action === "halt") {
          await archiveIfPresent(resolutionPath, "consumed");
          console.log("Halt requested during triage. Marking run complete.");
          return { ...state, status: "complete" };
        }

        const item = state.items[res.finding_id];
        if (item && item.status === "blocked") {
          if (res.action === "retry" || rationaleAsksForRetry(res.rationale)) {
            retryBlockedItem(item);
            retryFindingIds.add(res.finding_id);
            requiresRetry = true;
          } else if (res.action === "ignore") {
            item.status = "ignored";
            markTerminal(item);
            item.failure_reason = res.rationale ?? "User ignored during triage";
          }
        }
      }

      await archiveIfPresent(resolutionPath, "consumed");
      if (requiresRetry) {
        await archiveImplementResultsForRetries(state, options, retryFindingIds);
        return { ...state, status: "documenting" };
      }
    } else {
      // If the user approved findings in the preview, auto-retry those rather
      // than asking the model to triage them. Preview-ignored items are terminal,
      // so only still-blocked implementation attempts are considered here.
      const previewAckPath = join(options.artifactsDir, "impl_preview_acknowledged.json");
      if (existsSync(previewAckPath)) {
        let autoRetried = false;
        for (const item of blockedItems) {
          // Stop auto-retrying an item that has already been retried the cap
          // number of times — it leaves it `blocked` so the fall-through below
          // routes the run to a human triage prompt instead of looping.
          if ((item.rework_count ?? 0) >= MAX_AUTO_RETRIES) continue;
          retryBlockedItem(item);
          autoRetried = true;
        }
        if (autoRetried) {
          console.log("User approved these items at preview — auto-retrying blocked findings.");
          return { ...state, status: "documenting" };
        }
      }

      const triageBatch: TriageBatch = {
        items: blockedItems.map((item) => ({
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
        `\nFound ${blockedItems.length} blocked items. Wrote triage_batch.json.`,
      );
      console.error(
        `Please write triage_resolution.json and run again to continue.`,
      );
      return { ...state, status: "waiting_for_triage" };
    }
  } else {
    console.log("No blocked items found. Proceeding to close.");
  }

  // "closing" status triggers runClosePhase in the orchestrator switch
  return { ...state, status: "closing" };
}
