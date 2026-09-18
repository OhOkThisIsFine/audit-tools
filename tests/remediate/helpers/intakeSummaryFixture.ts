// One valid intake summary for tests, at the CURRENT schema version.
//
// The intake summary is the one file the host writes at synthesis; the tool
// renders `remediation-brief.md` from it. Tests that seed an intake build the
// summary here, so a schema change edits one default instead of every fixture.
// A test never writes the brief: the tool owns that render.

import {
  INTAKE_SUMMARY_SCHEMA_VERSION,
  type IntakeSummary,
} from "../../../src/remediate/intake.js";

export function intakeSummaryFixture(
  overrides: Partial<IntakeSummary> = {},
): IntakeSummary {
  return {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
    ready: true,
    source_type: "documents",
    source_summary: "Fix the reported defects.",
    goals: ["Fix all bugs"],
    non_goals: [],
    constraints: [],
    affected_files: [{ path: "src/main.ts" }],
    acceptance_criteria: [],
    scope_summary: "The files named in the sources.",
    intent_summary: "Remediate the reported defects.",
    filters: {},
    open_questions: [],
    ...overrides,
  };
}
