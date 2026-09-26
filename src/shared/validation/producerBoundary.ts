// sites-pinned: tests/shared/producer-boundary.test.ts
// Canonical-serialized-output-boundary enforcement (packet 20).
//
// THE DEFECT. A contract type gained a field; the change swept the TESTS and
// the producers under `src/`, but the producers EMIT their output without ever
// running it through the schema that owns it. Nothing at the write boundary
// checks the value, so a producer that drops a required field (or a
// hand-built literal that misses one) persists a malformed `audit-findings.json`
// / `remediation-outcomes.json` and only fails months later where a downstream
// consumer first re-reads it.
//
// WHAT THIS IS — and what it is NOT. Each function below runs a producer's
// finished output through its OWNING schema and throws with the full issue list
// BEFORE the value can be persisted or accepted downstream. It is a
// schema-boundary gate on ONE known value at ONE known serialized-output
// boundary, not a generic object-construction detector: it takes no source text,
// guesses at no dataflow, and can no more find an unmarked construction site than
// a typecheck can (and does not pretend to). Construction-site markers in
// `contractConstructionSites.ts` remain a truthful CENSUS aid — "where does this
// type get built" — not enforcement; the enforcement is the owning schema, run
// at the boundary this module names.
//
// The two functions are deliberately NOT one generic `assertValid(schema, value)`
// export: the owning schema is what the caller must NOT be left to remember, and
// a generic parameter passed from a producer is exactly the site where a
// producer hands the WRONG schema and the gate green-plates on the one it chose.
// Two named functions, one per canonical deliverable, so the owning schema is
// single-sourced in the body that enforces it.

import type { AuditFindingsReport } from "../types/finding.js";
import { AuditFindingsReportSchema } from "../types/finding.js";
import type { RemediationOutcomesReport } from "../types/remediationOutcome.js";
import { RemediationOutcomesReportSchema } from "../types/remediationOutcome.js";
import { formatSchemaFailure } from "./schemaFailure.js";

/**
 * Refuse an `audit-findings.json` value the canonical
 * `AuditFindingsReportSchema` rejects. Called by every producer of the
 * canonical machine contract (the synthesis executor and the shared
 * re-consumable deliverable emitter) at its serialized-output boundary, so a
 * producer that drops or malforms a required field throws here — before the
 * value is persisted or handed downstream — rather than leaving the miss for a
 * consumer to discover.
 */
export function assertValidAuditFindingsReport(value: AuditFindingsReport): void {
  const result = AuditFindingsReportSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `audit-findings.json: produced report fails the owning contract — ` +
        formatSchemaFailure(result.error),
    );
  }
}

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
