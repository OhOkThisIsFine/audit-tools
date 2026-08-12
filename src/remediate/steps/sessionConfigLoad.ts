import {
  loadSessionIntent,
  type SessionIntentLoadResult,
} from "audit-tools/shared";

/**
 * Remediation adapter for the one canonical repository session intent.
 */
export async function loadRemediateSessionConfig(
  params: { root: string },
): Promise<SessionIntentLoadResult> {
  return loadSessionIntent(params.root);
}
