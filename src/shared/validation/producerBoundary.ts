// sites-pinned: tests/shared/producer-boundary.test.ts
// The write-boundary gate for `remediation-outcomes.json`: the close phase
// builds the machine contract but, without this check, persists whatever it
// built — a producer that drops a required field writes a malformed contract
// that only a much later consumer discovers. `assertValidRemediationOutcomesReport`
// runs the finished value through the OWNING schema (`RemediationOutcomesReportSchema`,
// deliberately not strict because the on-disk file is a superset) and throws with
// the full issue list BEFORE the value is written, so a refusal writes none of
// the close-phase artifacts.

import type { RemediationOutcomesReport } from "../types/remediationOutcome.js";
import { RemediationOutcomesReportSchema } from "../types/remediationOutcome.js";
import { formatSchemaFailure } from "./schemaFailure.js";

/**
 * Refuse a `remediation-outcomes.json` value the canonical
 * `RemediationOutcomesReportSchema` rejects. The schema is deliberately NOT
 * strict (the on-disk outcomes file is a superset, carrying run-level fields the
 * shared subset does not declare), so unknown keys are tolerated and only a
 * missing/malformed REQUIRED field of the owning contract is refused.
 */
export function assertValidRemediationOutcomesReport(
  value: RemediationOutcomesReport,
): void {
  const result = RemediationOutcomesReportSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `remediation-outcomes.json: produced report fails the owning contract — ` +
        formatSchemaFailure(result.error),
    );
  }
}
