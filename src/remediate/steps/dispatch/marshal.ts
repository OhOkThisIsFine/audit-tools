// sites-pinned: tests/remediate/host-handoff.test.ts, tests/remediate/host-handoff-repair.test.ts
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

/**
 * Raised when workload preparation cannot proceed due to plan or block issues.
 * Exported here rather than from hostHandoff.ts to preserve the established
 * host-handoff public export surface pinned in DISPATCH_BARREL_EXPORTS.
 */
export class CannotPrepareWorkloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotPrepareWorkloadError";
  }
}
