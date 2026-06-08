import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { IntentCheckpoint } from "@audit-tools/shared";
import { resolveAuditScope } from "./scope.js";
import { isAuditExcludedStatus } from "../extractors/disposition.js";

export async function runIntentCheckpointExecutor(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): Promise<ExecutorRunResult> {
  const scope = resolveAuditScope({ root, since, bundle });
  
  let filesInScope = 0;
  if (scope.mode === "delta") {
    filesInScope = scope.seed_files.length + scope.expanded_files.length;
  } else {
    // Count auditable files in disposition. Fall back to manifest or 0.
    const auditableCount = bundle.file_disposition?.files.filter(
      (file) => !isAuditExcludedStatus(file.status)
    ).length ?? (bundle.repo_manifest?.files.length ?? 0);
    filesInScope = auditableCount;
  }

  const intent: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: new Date().toISOString(),
    scope_summary: `Root: ${root}${scope.since ? ` (since ${scope.since})` : ""}, files in scope: ${filesInScope}`,
    intent_summary: scope.mode === "delta" ? `delta-audit since ${scope.since}` : "full-audit",
    confirmed_by: "host",
  };

  return {
    updated: {
      ...bundle,
      intent_checkpoint: intent,
    },
    artifacts_written: ["intent_checkpoint.json"],
    progress_summary: `Recorded scope/intent checkpoint: ${intent.scope_summary} (${intent.intent_summary}).`,
  };
}
