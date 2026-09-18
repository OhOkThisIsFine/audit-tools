// sites-pinned: tests/audit/semantic-review-step.test.ts, tests/audit/host-handoff.test.ts
/**
 * THE renderer for an ingest report — the sections a host reads to learn what
 * the last ingest did with its results, and what it must do next.
 *
 * ONE renderer, two callers. The semantic-review step
 * (`renderSemanticReviewStep`) states these sections in the prompt it emits;
 * the fold's emission-boundary drain (`renderCarriedAdvisoryLines` in
 * `nextStepHelpers.ts`) states the same fact on a step of a different KIND,
 * which carries no advisory channel of its own. Both are the same report
 * reaching the operator through two paths, so a second hand copy of the split
 * and the bullet format is exactly the drift this module exists to stop — the
 * copy had already gone stale, and a reworded bullet in one place did not
 * reach the other.
 *
 * The section a work item lands in is chosen by {@link auditIngestRemedy},
 * never by the message text and never by a `code !== "submission_missing"`
 * negation. The negation put every non-missing code under one heading that
 * told the reader to repair and write the result again — which is wrong for
 * `duplicate_submission_id` (the item was ALREADY ACCEPTED, so it is not
 * pending and the republished workload does not carry it) and wrong for
 * `workload_stale` (which names no work item at all). Owner review of prompt
 * 13, 2026-09-17: a settled refusal gets its own section.
 */
import {
  auditIngestRemedy,
  type AuditHostIngestIssue,
} from "../validation/ingestIssueCodes.js";

import type { AuditHostValidationWarning } from "./dispatch/hostHandoff.js";

/** One issue as a bullet, with its locators. */
function describeIssue(issue: AuditHostIngestIssue): string {
  return (
    `${issue.work_item_id ? `\`${issue.work_item_id}\` (${issue.code}): ` : `${issue.code}: `}` +
    `${issue.message}${issue.result_path ? ` (\`${issue.result_path}\`)` : ""}`
  );
}

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [heading, "", ...lines, ""];
}

/**
 * The ingest report as prompt lines. An empty section is omitted, so a clean
 * ingest renders nothing at all.
 *
 * `workloadFollows` is TRUE when the caller publishes a fresh workload
 * immediately below these sections (the semantic-review step). The repair
 * instruction then names that workload as the authority for every
 * `result_path`. It is FALSE when the report rides a step of another kind,
 * where the next workload comes on a later call.
 */
export function renderIngestReportLines(input: {
  readonly issues: readonly AuditHostIngestIssue[];
  readonly validationWarnings: readonly AuditHostValidationWarning[];
  readonly workloadFollows: boolean;
}): string[] {
  const byRemedy = (remedy: "wait" | "repair" | "none"): string[] =>
    input.issues
      .filter((issue) => auditIngestRemedy(issue) === remedy)
      .map((issue) => `- ${describeIssue(issue)}`);
  const repairable = byRemedy("repair");
  return [
    ...section("## Results not yet written", byRemedy("wait")),
    ...section("## Results to repair and write again", repairable),
    // The repair paragraph belongs to the repair section and renders with it.
    // It used to render whenever ANY issue existed, so a report holding only
    // settled refusals told the reader to write a repaired result for an item
    // no workload binds a path for.
    ...(repairable.length === 0
      ? []
      : [
          input.workloadFollows
            ? "Each item above is still pending and is republished in the workload below. Write its result at the `result_path` the workload binds — the workload is the authority for every path."
            : "Each item above is still pending. Write its result at the `result_path` the next published workload binds — the workload is the authority for every path.",
          "",
        ]),
    ...section("## Settled — no action needed", byRemedy("none")),
    ...section(
      "## Advisory notes on accepted results",
      input.validationWarnings.map(
        (warning) =>
          `- \`${warning.work_item_id}\` was ACCEPTED; advisory: ${warning.message}`,
      ),
    ),
  ];
}
