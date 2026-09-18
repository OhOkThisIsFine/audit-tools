// sites-pinned: tests/shared/ingest-report.test.ts, tests/audit/semantic-review-step.test.ts, tests/remediate/ingest-issues-recorded-before-exit.test.ts
// (each draw passes its own remedy map, so inverting an entry moves a work
// item to the wrong heading in the host prompt of that draw)
/**
 * THE renderer for an ingest report — the sections a host reads to learn what
 * the last ingest did with its results, and what it must do next.
 *
 * ONE renderer, both draws (owner review of prompt 20, 2026-09-18). The audit
 * draw renders it in the semantic-review step and on a step of another kind
 * that carries the same report; the remediate draw renders it in the
 * implement-dispatch step. Each draw supplies its own REMEDY map — the answer to
 * "what must the reader do about this code" — and nothing else. The sections,
 * their order, the bullet format and the paragraphs have one home, here: the
 * two hand copies this replaced had already drifted apart (the remediate copy
 * rendered a duplicate result as a repair beside every other refusal, the audit
 * copy as settled; the remediate copy had no settled section at all).
 *
 * The section a work item lands in is chosen by the draw's remedy for its CODE,
 * never by the message text. A message may be reworded at any time and the
 * section must not move with it.
 */
import type { IssueRemedy } from "./hostResultOutcomes.js";
import type { SubmissionIssue } from "./submissionClassifier.js";

/**
 * Where the workload that binds every `result_path` sits relative to the
 * report, which decides how the repair paragraph points at it.
 *
 *  - `follows`    — the same prompt publishes the workload BELOW the report.
 *  - `named_above` — the same prompt names the workload file ABOVE the report.
 *  - `next_call`  — the report rides a step of another kind; the next workload
 *                   comes on a later call.
 */
type IngestReportWorkload = "follows" | "named_above" | "next_call";

/** An advisory the ingest recorded on a result it ACCEPTED. */
interface IngestAdvisory {
  readonly work_item_id: string;
  readonly message: string;
}

const OPERATOR_SECTION_HEADING =
  "## Problems the worker cannot fix — stop and report them to the operator";

const REPAIR_PARAGRAPH: Readonly<Record<IngestReportWorkload, string>> = {
  follows:
    "Each item above is still pending and is republished in the workload below. Write its result at the `result_path` the workload binds — the workload is the authority for every path.",
  named_above:
    "Each item above is still pending and is republished in the workload file named above. Write its result at the `result_path` the workload binds — the workload is the authority for every path.",
  next_call:
    "Each item above is still pending. Write its result at the `result_path` the next published workload binds — the workload is the authority for every path.",
};

/** One issue as a bullet, with its locators. */
function describeIssue<TCode extends string>(issue: SubmissionIssue<TCode>): string {
  return (
    `- ${issue.work_item_id ? `\`${issue.work_item_id}\` (${issue.code}): ` : `${issue.code}: `}` +
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
 * `landedWithoutResult` names the items whose edits LANDED (the run holds a
 * corroborated commit for each) with no result file at the bound path. Each is
 * listed once, under its own section: the remedy is not "write the result when
 * the work is done" but "write the result for the commit that is already
 * there", so the same id is left out of the not-yet-written section.
 */
export function renderIngestReportLines<TCode extends string>(input: {
  readonly issues: readonly SubmissionIssue<TCode>[];
  readonly remedy: (issue: SubmissionIssue<TCode>) => IssueRemedy;
  readonly workload: IngestReportWorkload;
  readonly landedWithoutResult?: readonly string[];
  readonly advisories?: readonly IngestAdvisory[];
}): string[] {
  const landed = [...new Set(input.landedWithoutResult ?? [])];
  const landedSet = new Set(landed);
  const byRemedy = (remedy: IssueRemedy): SubmissionIssue<TCode>[] =>
    input.issues.filter((issue) => input.remedy(issue) === remedy);
  const waiting = byRemedy("wait").filter(
    (issue) => issue.work_item_id === undefined || !landedSet.has(issue.work_item_id),
  );
  const repairable = byRemedy("repair").map(describeIssue);
  return [
    ...section("## Results not yet written", waiting.map(describeIssue)),
    ...section("## Results to repair and write again", repairable),
    // The repair paragraph belongs to the repair section and renders with it.
    // A report holding only settled refusals must not tell the reader to write a
    // repaired result for an item no workload binds a path for.
    ...(repairable.length === 0 ? [] : [REPAIR_PARAGRAPH[input.workload], ""]),
    ...section(
      "## Commits that landed without a result file",
      landed.map(
        (id) =>
          `- \`${id}\`: write the result for the commit that is already on HEAD. Do not do the edit again.`,
      ),
    ),
    ...section(OPERATOR_SECTION_HEADING, byRemedy("operator").map(describeIssue)),
    ...section("## Settled — no action needed", byRemedy("none").map(describeIssue)),
    ...section(
      "## Advisory notes on accepted results",
      (input.advisories ?? []).map(
        (advisory) =>
          `- \`${advisory.work_item_id}\` was ACCEPTED; advisory: ${advisory.message}`,
      ),
    ),
  ];
}
