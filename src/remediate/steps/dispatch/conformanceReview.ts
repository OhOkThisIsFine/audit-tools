// sites-pinned: tests/remediate/conformance-review.test.ts
//
// The opt-in per-result contract conformance review (O39 / packet 17): the
// owner decision's second half. The mechanical floor — the work item binds
// `obligation_ids`, the result cites `obligation_evidence` per bound obligation,
// and ingestion refuses uncovered/unknown/duplicated/uncited obligations — is
// already enforced in `parseResult`. What that floor cannot do is judge whether
// the cited evidence actually DEMONSTRATES conformance to the carried module
// contracts: coverage is mechanical, sufficiency is not. This module owns the
// sufficiency half as an opt-in per-run depth dial.
//
//   - DEFAULT-OFF AT DISPATCH: a new run may opt in before its first dispatch.
//     Primary v1alpha2 state persists the choice and the dispatch marker.
//   - BOUND, not remembered: the review is bound to the result's obligation
//     evidence, the obligation set, and the carried contract content. A changed
//     result or a changed contract makes the binding stale, and a stale verdict
//     never admits the result.
//   - PASS PERMITS, FAIL REPAIRS, ABSENT PAUSES: a passing verdict is the only
//     thing that lets a mechanically-corroborated result be accepted; an
//     "insufficient evidence" verdict is a repair the worker can make; an
//     "unavailable" verdict (no independent reviewer could be recruited) pauses
//     the run rather than admitting the result unreviewed.
//   - THE REVIEWER CANNOT BYPASS THE MECHANICAL FLOOR: the verdict is ingested
//     OUTSIDE the result parse, so a review never reopens obligation coverage —
//     `parseResult` still refuses the result before any review is considered.
//
// The binding/verdict engine below is pure. The legacy sidecar reader only
// detects old opt-in evidence when a primary policy is absent; new runs never
// write that sidecar.

import { join } from "node:path";

import {
  compareCodeUnits,
  contentSha256,
  hasExactKeys,
  isRecord,
  readSubmissionDocument,
  stableStringify,
} from "audit-tools/shared";
import { resolveBoundaryPaths } from "./internal.js";

const CONFORMANCE_REVIEW_SELECTION_VERSION =
  "remediate-code-conformance-review-selection/v1alpha1";

/** Detect a v1alpha1 sidecar that must not silently migrate to default-off. */
export async function readLegacyConformanceReviewSelection(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
}): Promise<
  | { readonly kind: "off"; readonly path: string }
  | { readonly kind: "on"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string }
> {
  const paths = resolveBoundaryPaths(params);
  const path = join(paths.runDir, "conformance-review", "selection.json");
  const read = await readSubmissionDocument(path);
  if (read.kind === "missing") return { kind: "off", path };
  if (read.kind === "malformed") {
    return { kind: "invalid", path, reason: read.detail };
  }
  const value = read.value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema_version", "run_id", "enabled"]) ||
    value.schema_version !== CONFORMANCE_REVIEW_SELECTION_VERSION ||
    value.run_id !== params.runId ||
    value.enabled !== true
  ) {
    return {
      kind: "invalid",
      path,
      reason: "invalid version, shape, or run binding",
    };
  }
  return { kind: "on", path };
}

export const CONFORMANCE_REVIEW_CONTRACT_VERSION =
  "remediate-code-conformance-review/v1alpha1" as const;

/** The closed verdict vocabulary a reviewer may return. */
export type ConformanceVerdictStatus = "conforms" | "insufficient_evidence" | "unavailable";

/**
 * The bounded facts a review is bound to: result and work-item identities,
 * result obligation evidence, the obligation set, and carried contract content.
 * A review is minted against these; changing any bound fact invalidates it.
 */
export interface ConformanceReviewBinding {
  readonly contract_version: typeof CONFORMANCE_REVIEW_CONTRACT_VERSION;
  /** The review id, derived from the binding so a re-review of the same inputs is the same review. */
  readonly review_id: string;
  readonly result_id: string;
  readonly work_item_id: string;
  /** The bound obligation ids, sorted — the same set `parseResult` coverage-checks. */
  readonly obligation_ids: readonly string[];
  /** The bound carried contracts (module → contract), sorted by module. */
  readonly module_contracts: readonly {
    readonly module: string;
    readonly contract: Readonly<Record<string, unknown>>;
  }[];
  /** The result's cited evidence, verbatim — what the reviewer judges. */
  readonly obligation_evidence: readonly {
    readonly obligation_id: string;
    readonly evidence: readonly string[];
  }[];
}

/** The host-facing review request a reviewer reads and answers. */
export interface ConformanceReviewRequest extends ConformanceReviewBinding {
  /** Human/LLM-facing: the question asked and the evidence to judge. */
  readonly instruction: string;
}

/** The verdict a reviewer returns (`conformance_review_result` artifact). */
export interface ConformanceReviewVerdict {
  readonly contract_version: typeof CONFORMANCE_REVIEW_CONTRACT_VERSION;
  readonly review_id: string;
  readonly status: ConformanceVerdictStatus;
  /** The reviewer's reason, in their words. Required for a non-passing verdict. */
  readonly rationale: string;
}

/** The outcome of applying a parsed verdict to a binding. */
export type ConformanceReviewOutcome =
  /**
   * The reviewer attested the cited evidence demonstrates conformance — the
   * result may be accepted (subject to the still-unchanged mechanical floor).
   */
  | { readonly kind: "pass" }
  /**
   * The reviewer judged the cited evidence insufficient to demonstrate
   * conformance — a repair the worker makes by strengthening the evidence (or
   * fixing the work). The result is NOT accepted.
   */
  | { readonly kind: "insufficient"; readonly rationale: string }
  /**
   * No independent reviewer could be recruited. The run pauses: the result is
   * neither accepted nor refused, and the review must be re-attempted.
   */
  | { readonly kind: "unavailable"; readonly rationale: string }
  /**
   * The verdict does not bind to this result/obligation/contract: the result or
   * the contract content changed after the review was requested, so the review
   * no longer describes them. The review must be re-minted against the new
   * content. This is the stale-binding case the packet names "changed result or
   * contract invalidates review".
   */
  | { readonly kind: "stale" }
  /**
   * The verdict file is not a parseable, well-formed review — refused, never
   * partly applied (the review-gate's "default is approve" hazard inverted:
   * here the absent/refused verdict is a HOLD, never a pass).
   */
  | { readonly kind: "refused"; readonly reason: string };

function sortedContracts(
  contracts: readonly { module: string; contract: Readonly<Record<string, unknown>> }[],
): readonly { module: string; contract: Readonly<Record<string, unknown>> }[] {
  return [...contracts].sort((a, b) => compareCodeUnits(a.module, b.module));
}

/**
 * The binding fingerprint: a single sha256 over the result and work-item
 * identities, result evidence, obligation set, and contract content. `review_id` derives from it, so a
 * reviewer cannot answer a different review by reusing an old verdict — the id
 * itself changes when any bound facts change.
 */
function bindingDigest(
  resultId: string,
  workItemId: string,
  evidence: ReadonlyArray<{ obligation_id: string; evidence: readonly string[] }>,
  obligationIds: readonly string[],
  contracts: ReadonlyArray<{ module: string; contract: Readonly<Record<string, unknown>> }>,
): string {
  return contentSha256({
    result_id: resultId,
    work_item_id: workItemId,
    evidence: [...evidence]
      .sort((a, b) => compareCodeUnits(a.obligation_id, b.obligation_id))
      .map((entry) => ({
        obligation_id: entry.obligation_id,
        evidence: [...entry.evidence].sort(),
      })),
    obligation_ids: [...obligationIds].sort(),
    module_contracts: sortedContracts(contracts),
  } as unknown);
}

/**
 * Mint a conformance review for one mechanically-corroborated landed result.
 * Pure: the caller supplies the bound facts it already holds (the work item's
 * obligation set and carried contracts, the result's cited evidence).
 */
export function mintConformanceReview(params: {
  readonly resultId: string;
  readonly workItemId: string;
  readonly obligationIds: readonly string[];
  readonly moduleContracts: readonly {
    readonly module: string;
    readonly contract: Readonly<Record<string, unknown>>;
  }[];
  readonly obligationEvidence: readonly {
    readonly obligation_id: string;
    readonly evidence: readonly string[];
  }[];
}): ConformanceReviewRequest {
  const {
    resultId,
    workItemId,
    obligationIds,
    moduleContracts,
    obligationEvidence,
  } = params;
  const sortedObligationIds = [...obligationIds].sort();
  const orderedContracts = sortedContracts(moduleContracts);
  const reviewId = bindingDigest(
    resultId,
    workItemId,
    obligationEvidence,
    sortedObligationIds,
    orderedContracts,
  );
  const binding: ConformanceReviewBinding = {
    contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
    review_id: reviewId,
    result_id: resultId,
    work_item_id: workItemId,
    obligation_ids: sortedObligationIds,
    module_contracts: orderedContracts,
    obligation_evidence: obligationEvidence,
  };
  return {
    ...binding,
    instruction: renderConformanceInstruction(binding),
  };
}

/** The bounded question a reviewer answers, self-contained from the binding. */
export function renderConformanceInstruction(
  binding: ConformanceReviewBinding,
): string {
  const contracts =
    binding.module_contracts.length === 0
      ? "(no module contracts carried — conformance is judged against the obligations alone)"
      : binding.module_contracts
          .map(
            (entry) =>
              `## module ${entry.module}\n\`\`\`json\n${stableStringify(entry.contract)}\n\`\`\``,
          )
          .join("\n\n");
  const evidence = binding.obligation_evidence
    .map(
      (entry) =>
        `- ${entry.obligation_id}: ${entry.evidence.map((e) => JSON.stringify(e)).join(", ")}`,
    )
    .join("\n");
  return [
    "Judge whether the cited obligation evidence demonstrates conformance to the carried module contracts.",
    "",
    `Bound obligations: ${binding.obligation_ids.join(", ") || "(none)"}`,
    "",
    contracts,
    "",
    "Cited evidence:",
    evidence || "(none)",
    "",
    "Return one verdict: `conforms`, `insufficient_evidence` (name what is missing), or `unavailable` (no independent reviewer).",
  ].join("\n");
}

/**
 * Parse a reviewer's verdict against its request. Strict — the whole file is
 * refused or its binding checked before any status is trusted:
 *
 *   - not an object / not JSON / wrong `contract_version` / unknown `status` →
 *     refused;
 *   - `review_id` does not equal the request's → stale (the result or contract
 *     content changed after the review was requested).
 *
 * A verdict with a `review_id` that matches but was reworded later still binds:
 * the id is content-derived, so byte-comparing it is the exact check the
 * "changed content invalidates the review" property demands.
 */
export function parseConformanceVerdict(
  text: string,
  request: ConformanceReviewRequest,
): ConformanceReviewOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      kind: "refused",
      reason: `the verdict file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "refused", reason: "the verdict must be one JSON object" };
  }
  const record = value as Record<string, unknown>;
  if (record.contract_version !== CONFORMANCE_REVIEW_CONTRACT_VERSION) {
    return {
      kind: "refused",
      reason: `contract_version must be ${CONFORMANCE_REVIEW_CONTRACT_VERSION}`,
    };
  }
  if (typeof record.review_id !== "string" || record.review_id.trim().length === 0) {
    return {
      kind: "refused",
      reason: "review_id must be a non-empty string",
    };
  }
  if (record.review_id !== request.review_id) {
    return { kind: "stale" };
  }
  if (record.status === "conforms") {
    return { kind: "pass" };
  }
  const rationale =
    typeof record.rationale === "string" && record.rationale.trim().length > 0
      ? record.rationale
      : "";
  if (record.status === "insufficient_evidence") {
    return {
      kind: "insufficient",
      rationale: rationale || "the cited evidence was judged insufficient",
    };
  }
  if (record.status === "unavailable") {
    return {
      kind: "unavailable",
      rationale: rationale || "no independent reviewer was available",
    };
  }
  return {
    kind: "refused",
    reason:
      "status must be one of `conforms`, `insufficient_evidence`, or `unavailable`",
  };
}

/**
 * The verdict a review request is still being awaited for produces — the same
 * shape a reviewer would return `unavailable` in, but written by the tool when
 * the run is asked to pause rather than default to an answer. Not used by the
 * engine; exported for the host-handoff boundary to persist the pause marker.
 */
export function renderUnavailableVerdict(
  request: ConformanceReviewRequest,
): string {
  return stableStringify({
    contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
    review_id: request.review_id,
    status: "unavailable",
    rationale: "no independent reviewer was available to judge this result",
  } satisfies ConformanceReviewVerdict);
}
