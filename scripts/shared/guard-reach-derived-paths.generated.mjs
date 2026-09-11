// GENERATED — do not edit. Run `node scripts/shared/generate-guard-reach-paths.mjs`.
//
// The pre-build twins of two declarations the guard-reach registry needs but
// cannot import: the registry is loaded by the commit gate under plain node,
// with no build, so a `.ts` import would not resolve.
//
//   SITES_PINNED_PATHS               ← PINNED_PATHS in scripts/check-sites-pinned.mjs
//   CONTRACT_SCHEMA_PRODUCER_SCHEMAS ← the schema files named by
//                                      CONTRACT_SCHEMA_PRODUCERS in
//                                      src/audit/contracts/workerSchemas.ts
//
// `npm run check:guard-reach-paths` fails the build when this drifts from
// either source, so the twin can never silently narrow the reach it declares.
//
// It asserts no behaviour of its own — it is a data projection, and the two
// sources it projects are pinned by tests/shared/contract-construction-sites.test.ts
// and tests/shared/sites-pinned-gate.test.ts.

// sites-pinned: none — GENERATED data twin. Its content is derived from
// PINNED_PATHS and CONTRACT_SCHEMA_PRODUCERS, each pinned by its own suite, and
// check:guard-reach-paths refuses any drift from those sources. Editing this file
// by hand is exactly what that gate exists to catch.

/** The staged paths the per-site pinning gate pins. */
export const SITES_PINNED_PATHS = [
  "src/**/*.ts",
  "scripts/**/*.mjs",
  "scripts/*.mjs",
  ".claude/hooks/*.mjs",
  "wrapper/*.mjs",
  "wrapper/**/*.mjs",
  "dispatch/*.mjs",
  "dispatch/**/*.mjs",
  "audit-code.mjs",
  "remediate-code.mjs",
];

/** The rendered schema files this repo's worker-schema producer writes. */
export const CONTRACT_SCHEMA_PRODUCER_SCHEMAS = [
  "schemas/audit_result.schema.json",
  "schemas/finding.schema.json",
];
