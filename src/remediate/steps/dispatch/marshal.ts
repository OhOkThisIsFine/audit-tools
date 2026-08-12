import { join } from "node:path";

import { readOptionalJsonFile } from "audit-tools/shared";

/**
 * Read the planning pipeline's handoff artifact when it exists. Implementation
 * execution no longer has a second dispatch-plan marshalling layer: the only
 * production implementation boundary is hostHandoff.ts.
 */
export async function readExtractedPlanIfPresent(
  artifactsDir: string,
): Promise<unknown | undefined> {
  return readOptionalJsonFile(join(artifactsDir, "extracted-plan.json"));
}
