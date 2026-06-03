import { existsSync } from "node:fs";
import { join } from "node:path";
import { StateStore, RemediationState } from "./state/store.js";
import { runPlanPhase } from "./phases/plan.js";
import { runDocumentPhase } from "./phases/document.js";
import { runImplementPhase } from "./phases/implement.js";
import { runTriagePhase } from "./phases/triage.js";
import { runClosePhase } from "./phases/close.js";
import { OrchestratorOptions } from "./types/options.js";

export type { OrchestratorOptions };

function summarizeStateProgress(state: RemediationState): string {
  const itemStatuses = new Map<string, number>();
  for (const item of Object.values(state.items ?? {})) {
    itemStatuses.set(item.status, (itemStatuses.get(item.status) ?? 0) + 1);
  }
  const statusSummary = [...itemStatuses.entries()]
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
  const blockCount = state.plan?.blocks.length ?? 0;
  return [
    blockCount > 0 ? `blocks=${blockCount}` : "",
    statusSummary ? `itemStatuses=${statusSummary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Deprecated legacy loop retained for direct module consumers. The supported
// user-facing execution model is the `decideNextStep()` loop in steps/nextStep.
// State flow:
//   pending → planning → documenting → implementing → closing → complete
//   implementing may pause at waiting_for_triage; planning may pause at waiting_for_clarification
//   "triage" status = triage phase is active (entered from implementing or waiting_for_triage resume)
/**
 * @deprecated Use decideNextStep() and let the host drive the one-step loop.
 */
export async function runOrchestrator(
  options: OrchestratorOptions,
): Promise<void> {
  const store = new StateStore(options.artifactsDir);
  let state = await store.loadState();

  if (!state) {
    state = { status: "pending" };
    await store.saveState(state);
  }

  let iteration = 0;

  while (state.status !== "complete") {
    iteration++;
    const phaseStart = Date.now();
    const itemCount = state.items ? Object.keys(state.items).length : 0;
    const progressSummary = summarizeStateProgress(state);
    console.log(
      `[orchestrator] iteration ${iteration}: entering phase "${state.status}"` +
        (itemCount > 0 ? ` (${itemCount} items)` : "") +
        (progressSummary ? ` ${progressSummary}` : ""),
    );

    switch (state.status) {
      case "pending":
        state = await runPlanPhase(state, options);
        break;
      case "planning":
        state = await runDocumentPhase(state, options);
        break;
      case "documenting":
        state = await runImplementPhase(state, options);
        break;
      case "implementing":
      case "triage":
        state = await runTriagePhase(state, options);
        break;
      case "closing":
        state = await runClosePhase(state, options);
        break;
      case "waiting_for_clarification":
        if (
          existsSync(
            join(options.artifactsDir, "clarification_resolution.json"),
          )
        ) {
          state.status = "planning";
        }
        break;
      case "waiting_for_triage":
        if (existsSync(join(options.artifactsDir, "triage_resolution.json"))) {
          state.status = "triage";
        }
        break;
    }

    const elapsedMs = Date.now() - phaseStart;
    console.log(
      `[orchestrator] iteration ${iteration}: phase completed in ${elapsedMs}ms → "${state.status}"`,
    );

    if (
      state.status === "waiting_for_clarification" ||
      state.status === "waiting_for_triage"
    ) {
      await store.saveState(state);
      console.log(
        `Remediation paused: ${state.status}. Waiting for user input via MCP.`,
      );
      return;
    }
    await store.saveState(state);
  }

  console.log("Remediation complete.");
}
