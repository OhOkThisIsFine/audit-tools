/**
 * The ONE per-item host-submission scan both ingests draw from.
 *
 * Every submitted work item crosses the same four-step gate before any draw's
 * domain work begins: resolve the bound path inside the boundary, read the
 * bytes, classify a missing / unparseable / contract-invalid document, and
 * refuse a `result_id` the caller has already seen. Both twins hand-rolled that
 * sequence — audit in `readSubmittedResult` plus an inline duplicate check,
 * remediate inline in its ingest loop — and the two copies had already drifted
 * on CONTAINMENT: remediate re-checked the resolved path under the artifacts
 * dir, audit checked the root only. This module resolves that in the stricter
 * direction for BOTH draws.
 *
 * What it deliberately does NOT own — because these are the places the draws
 * genuinely differ, not places they drifted:
 *
 * - the MESSAGE TEXT of each refusal (a per-draw renderer supplies it; the two
 *   vocabularies are test-pinned and address different readers);
 * - the DOMAIN PARSER (a callback; each draw's parser stays standalone, so the
 *   hand-recovery lane can wrap `parseResult` directly and stay parity-pinned);
 * - identity enforcement, which lives INSIDE those parsers — hoisting it would
 *   change refusal precedence for a doubly-bad document;
 * - loop iteration, aggregation order, seen-set seeding, and the TIMING of the
 *   duplicate consume. Audit seeds from its persisted accepted ledger and
 *   consumes only after conversion, validation and grounding; remediate uses a
 *   fresh per-call set and consumes at parse. This scan only CHECKS.
 */
// Sibling modules imported DIRECTLY, never through ../index.js: the barrel
// re-exports this module, so importing the barrel here would close a cycle
// (index → submissionScan → index) that check:depgraph refuses.
import {
  readSubmissionDocument,
  type SubmissionIssue,
} from "./submissionClassifier.js";
import { resolveContainedPath } from "./submissionIdentity.js";
import type { IngestionCheckId } from "./ingestionChecks.js";

/**
 * The domain parser's answer, normalized. `detail` is handed straight to the
 * draw's `contractInvalid` renderer — the scan never composes refusal prose of
 * its own.
 */
export type SubmissionParse<TParsed> =
  | { readonly ok: true; readonly parsed: TParsed }
  | { readonly ok: false; readonly check: IngestionCheckId; readonly detail: string };

/**
 * The per-draw refusal vocabulary. Text is a DRAW concern: the audit ingest
 * addresses a host repairing a bound result file, remediate addresses one
 * repairing a pending work item, and several strings are pinned by tests.
 */
export interface SubmissionScanMessages {
  /** Nothing exists at the bound path. */
  readonly missing: () => string;
  /** Bytes exist but are not JSON; `detail` is the parse/IO reason. */
  readonly malformed: (detail: string) => string;
  /** JSON that the domain parser refused; `detail` is its stated reason. */
  readonly contractInvalid: (detail: string) => string;
  /** The parsed result re-uses an identity the caller has already seen. */
  readonly duplicate: (resultId: string) => string;
}

/** Either the parsed submission, or the ONE issue that names why not. */
export type SubmissionScanOutcome<TParsed> =
  | { readonly ok: true; readonly parsed: TParsed }
  | { readonly ok: false; readonly issue: SubmissionIssue };

/**
 * Scan one bound submission. Throws only where the twins already threw: a bound
 * path that escapes the repository root or the artifacts dir is a boundary
 * violation, not a classified submission failure.
 */
export async function scanBoundSubmission<TParsed>(params: {
  /** Absolute repository root the bound path is expressed relative to. */
  readonly root: string;
  /** Absolute artifacts dir the submission must also stay beneath. */
  readonly artifactsDir: string;
  /** Names the item in the containment refusal and in both issue locators. */
  readonly workItemId: string;
  /** Repository-relative bound path, as the persisted contract declares it. */
  readonly resultPath: string;
  /** The draw's standalone contract gate. */
  readonly parse: (value: unknown) => SubmissionParse<TParsed>;
  /** The submitted identity the duplicate check is asked about. */
  readonly resultId: (parsed: TParsed) => string;
  /** Caller-owned predicate; seeding and consume timing stay per-draw. */
  readonly seen: (resultId: string) => boolean;
  readonly messages: SubmissionScanMessages;
}): Promise<SubmissionScanOutcome<TParsed>> {
  const locators = {
    work_item_id: params.workItemId,
    result_path: params.resultPath,
  } as const;
  const label = `result path for ${params.workItemId}`;
  const absolutePath = resolveContainedPath(
    params.root,
    params.resultPath,
    label,
  );
  // Both boundaries, both draws: a submission lives under the artifacts dir,
  // and root containment alone would admit any other tracked file in the repo.
  resolveContainedPath(params.artifactsDir, absolutePath, label);

  const read = await readSubmissionDocument(absolutePath);
  if (read.kind === "missing") {
    return {
      ok: false,
      issue: {
        code: "submission_missing",
        check: "result_path",
        message: params.messages.missing(),
        ...locators,
      },
    };
  }
  if (read.kind === "malformed") {
    return {
      ok: false,
      issue: {
        code: "submission_malformed",
        check: "result_json",
        message: params.messages.malformed(read.detail),
        ...locators,
      },
    };
  }
  const parsed = params.parse(read.value);
  if (!parsed.ok) {
    return {
      ok: false,
      issue: {
        code: "submission_contract_invalid",
        check: parsed.check,
        message: params.messages.contractInvalid(parsed.detail),
        ...locators,
      },
    };
  }
  const resultId = params.resultId(parsed.parsed);
  if (params.seen(resultId)) {
    return {
      ok: false,
      issue: {
        code: "duplicate_submission_id",
        check: "duplicate_result",
        message: params.messages.duplicate(resultId),
        ...locators,
      },
    };
  }
  return { ok: true, parsed: parsed.parsed };
}
