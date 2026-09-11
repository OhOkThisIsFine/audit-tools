// The DERIVATION half of NO-REJECTION-OUTCOME.
//
// A candidate's verification claim is the judge's; the FINAL finding's is the
// tool's — folded from the candidates that fed it, so it can always be
// cross-checked against the adjudication record and never rides in on host
// supply. The invariant is TOTALITY: after conceptual ingest every admitted
// finding carries a status, because an absent field is the silence this whole
// vocabulary exists to end.
//
// This file pins the FOLD. That the fold is WIRED is a separate proof, and it
// lives in `deep-review-production-flow.test.ts` — a derivation with no caller
// is write-only data that reads as authoritative.
import { describe, expect, it } from "vitest";

import {
  ConceptualJudgeSubmissionSchema,
  deriveConceptualVerificationStatus,
  suppliedToolVerdictIssue,
} from "../../src/audit/types/conceptualAdjudication.js";
import type { ConceptualReviewAdjudication } from "../../src/audit/types/conceptualAdjudication.js";
import type { Finding } from "../../src/audit/types.js";

function finding(id: string): Finding {
  return {
    id,
    title: id,
    category: "design_simplification",
    severity: "medium",
    confidence: "high",
    lens: "architecture",
    summary: `${id} summary`,
    affected_files: [{ path: "src/a.ts" }],
  };
}

function disposition(
  candidateId: string,
  verificationStatus: "judge_confirmed" | "asserted" | "refuted_at_head",
  targets: string[],
): ConceptualReviewAdjudication["candidate_dispositions"][number] {
  return {
    candidate_id: candidateId,
    contributor_id: "p1",
    source_finding_id: candidateId.split("::")[1] ?? candidateId,
    disposition: targets.length === 0 ? "rejected" : "merged",
    target_final_finding_ids: targets,
    modification_percent: 10,
    rationale: `${candidateId} rationale`,
    verification_status: verificationStatus,
    ...(verificationStatus === "asserted"
      ? {}
      : { verification_note: `${candidateId} was checked against HEAD` }),
  };
}

function adjudication(
  dispositions: ConceptualReviewAdjudication["candidate_dispositions"],
): ConceptualReviewAdjudication {
  return {
    schema_version: 1,
    generated_at: "now",
    round_id: "round-1",
    contributors: [],
    candidate_dispositions: dispositions,
    final_finding_shares: [],
    candidate_disposition_breakdown: {},
    candidate_verification_status_breakdown: {},
  };
}

describe("deriveConceptualVerificationStatus", () => {
  it("promotes a final finding to judge_confirmed when ANY contributing candidate is", () => {
    const derived = deriveConceptualVerificationStatus(
      [finding("FINAL-1")],
      adjudication([
        disposition("p1::DR-1", "asserted", ["FINAL-1"]),
        disposition("p1::DR-2", "judge_confirmed", ["FINAL-1"]),
      ]),
    );
    expect(derived[0]?.verification_status).toBe("judge_confirmed");
  });

  it("leaves a finding whose every contributing candidate is merely asserted", () => {
    const derived = deriveConceptualVerificationStatus(
      [finding("FINAL-1")],
      adjudication([
        disposition("p1::DR-1", "asserted", ["FINAL-1"]),
        disposition("p1::DR-2", "asserted", ["FINAL-1"]),
      ]),
    );
    expect(derived[0]?.verification_status).toBe("asserted");
  });

  it("stamps a judge-added finding — no candidate at all — as asserted", () => {
    const derived = deriveConceptualVerificationStatus(
      [finding("JUDGE-ADDED")],
      adjudication([disposition("p1::DR-1", "judge_confirmed", ["FINAL-1"])]),
    );
    expect(derived[0]?.verification_status).toBe("asserted");
  });

  it("stamps every finding when there is no adjudication at all (the shallow pass)", () => {
    const derived = deriveConceptualVerificationStatus(
      [finding("SHALLOW-1"), finding("SHALLOW-2")],
      undefined,
    );
    expect(derived.map((entry) => entry.verification_status)).toEqual([
      "asserted",
      "asserted",
    ]);
  });

  it("never emits refuted_at_head on an admitted finding", () => {
    // A refuted candidate is forced to `rejected` by the validator, and a
    // rejected candidate maps to no final finding — so the status cannot reach
    // `findings[]` even by a mis-cited target.
    const derived = deriveConceptualVerificationStatus(
      [finding("FINAL-1")],
      adjudication([
        disposition("p1::DR-1", "refuted_at_head", []),
        disposition("p1::DR-2", "asserted", ["FINAL-1"]),
      ]),
    );
    expect(derived.map((entry) => entry.verification_status)).not.toContain(
      "refuted_at_head",
    );
  });

  // The REACH half. `refuseSuppliedVerificationStatus` lived only inside
  // `buildConceptualReviewAdjudication`, which the production fold reaches with
  // an ALREADY-PARSED submission — and `ConceptualJudgeSubmissionSchema` omits
  // `verification_status`, so the parse had stripped the supplied value before
  // the check could look. The check named a field it could never see on the only
  // path that matters. It is now stated BEFORE the parse, and stated over the RAW
  // value: these two cases differ exactly there, and both must be caught, because
  // "the schema already rejects it" is false — the schema ACCEPTS and strips.
  it("names a supplied verification_status on the raw value, before the stripping parse", () => {
    const supplied = {
      round_id: "round-1",
      findings: [
        {
          id: "FINAL-1",
          title: "t",
          category: "design_simplification",
          severity: "medium",
          confidence: "high",
          lens: "architecture",
          summary: "s",
          affected_files: [{ path: "src/a.ts" }],
          verification_status: "judge_confirmed",
        },
      ],
      candidate_dispositions: [],
      final_finding_shares: [],
    };
    expect(suppliedToolVerdictIssue(supplied)).toContain(
      "findings[0].verification_status",
    );
    // And the schema's own parse is NOT what protects the invariant: it accepts
    // the submission and silently drops the field.
    const parsed = ConceptualJudgeSubmissionSchema.safeParse(supplied);
    expect(
      parsed.success,
      "the stripping parse is not a refusal — it is why the raw-value check must exist",
    ).toBe(true);
    expect(
      (parsed as { data?: { findings: { verification_status?: string }[] } }).data
        ?.findings[0]?.verification_status,
    ).toBeUndefined();
  });

  it("stays silent when no verification_status was supplied", () => {
    expect(
      suppliedToolVerdictIssue({
        round_id: "round-1",
        findings: [{ id: "FINAL-1" }],
      }),
    ).toBe(null);
  });

  it("does not mutate its input findings", () => {
    const input = [finding("FINAL-1")];
    deriveConceptualVerificationStatus(
      input,
      adjudication([disposition("p1::DR-1", "judge_confirmed", ["FINAL-1"])]),
    );
    expect(input[0]?.verification_status).toBeUndefined();
  });
});
