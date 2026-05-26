import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../orchestrator.js";
import { TriageBatch } from "../state/types.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readOptionalJsonFile, writeJsonFile } from "../io/json.js";
import { validateTriageResolution } from "../validation/remediationState.js";
import { formatValidationIssues } from "../validation/basic.js";

interface TriageResolution {
  items: {
    finding_id: string;
    action: "retry" | "ignore" | "halt";
    rationale?: string;
  }[];
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

      for (const res of resolution.items) {
        if (res.action === "halt") {
          console.log("Halt requested during triage. Marking run complete.");
          return { ...state, status: "complete" };
        }

        const item = state.items[res.finding_id];
        if (item && item.status === "blocked") {
          if (res.action === "retry") {
            // "documented" maps to runImplementPhase in the orchestrator switch
            item.status = "documented";
            requiresRetry = true;
          } else if (res.action === "ignore") {
            item.status = "ignored";
            item.failure_reason = res.rationale ?? "User ignored during triage";
          }
        }
      }

      if (requiresRetry) {
        return { ...state, status: "documenting" };
      }
    } else {
      // If the user approved findings in the preview, auto-retry those rather
      // than asking the model to triage them. Only items that were NOT skipped
      // (i.e., not deemed_inappropriate) at preview time are auto-retried.
      const previewAckPath = join(options.artifactsDir, "impl_preview_acknowledged.json");
      if (existsSync(previewAckPath)) {
        let autoRetried = false;
        for (const item of blockedItems) {
          item.status = "documented";
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
        `Please provide resolutions via MCP tool submit_triage, or write triage_resolution.json and run again.`,
      );
      return { ...state, status: "waiting_for_triage" };
    }
  } else {
    console.log("No blocked items found. Proceeding to close.");
  }

  // "closing" status triggers runClosePhase in the orchestrator switch
  return { ...state, status: "closing" };
}
