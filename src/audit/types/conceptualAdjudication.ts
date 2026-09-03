import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  countBy,
  FindingSchema,
  FindingVerificationStatusSchema,
  isFileMissingError,
  isRecord,
  laneAssetsDir,
  readJsonFile,
  readOptionalJsonFile,
  writeJsonFile,
} from "audit-tools/shared";
import type { Finding } from "../types.js";

const PercentageSchema = z.number().finite().min(0).max(100);

export const ConceptualRoundContributorSchema = z
  .object({
    contributor_id: z.string().min(1),
    perspective: z.string().min(1),
    lane_id: z.string().min(1),
    prompt_path: z.string().min(1),
    result_path: z.string().min(1),
  })
  .strict();

export const ConceptualReviewRoundManifestSchema = z
  .object({
    schema_version: z.literal(1),
    mode: z.literal("deep"),
    round_id: z.string().min(1),
    perspectives: z.array(ConceptualRoundContributorSchema).min(1),
    judge: z
      .object({
        contributor_id: z.string().min(1),
        lane_id: z.string().min(1),
        prompt_path: z.string().min(1),
        result_path: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ConceptualReviewRoundManifest = z.infer<
  typeof ConceptualReviewRoundManifestSchema
>;

export const CONCEPTUAL_REVIEW_ROUND_FILENAME =
  "conceptual-review-round.json";

export function conceptualReviewRoundManifestPath(
  artifactsDir: string,
): string {
  return join(laneAssetsDir(artifactsDir), CONCEPTUAL_REVIEW_ROUND_FILENAME);
}

export async function writeConceptualReviewRoundManifest(
  artifactsDir: string,
  manifest: ConceptualReviewRoundManifest,
): Promise<void> {
  await writeJsonFile(
    conceptualReviewRoundManifestPath(artifactsDir),
    ConceptualReviewRoundManifestSchema.parse(manifest),
  );
}

export async function readConceptualReviewRoundManifest(
  artifactsDir: string,
): Promise<ConceptualReviewRoundManifest | undefined> {
  const value = await readOptionalJsonFile<unknown>(
    conceptualReviewRoundManifestPath(artifactsDir),
  );
  return value === undefined
    ? undefined
    : ConceptualReviewRoundManifestSchema.parse(value);
}

export async function clearConceptualReviewRoundManifest(
  artifactsDir: string,
): Promise<void> {
  try {
    await unlink(conceptualReviewRoundManifestPath(artifactsDir));
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
}

export const ConceptualCandidateDispositionSchema = z
  .object({
    candidate_id: z.string().min(1),
    contributor_id: z.string().min(1),
    source_finding_id: z.string().min(1),
    disposition: z.enum(["retained", "merged", "rejected"]),
    target_final_finding_ids: z.array(z.string().min(1)),
    modification_percent: PercentageSchema,
    rationale: z.string().trim().min(1),
    /**
     * The judge's claim about whether this candidate's named defect is present
     * at HEAD. REQUIRED, never optional: an optional field defaults to silence,
     * and silence is the defect (134 candidates across two live runs, zero
     * rejections, one of them a candidate the judge itself reported as already
     * fixed and merged at 70% modification).
     */
    verification_status: FindingVerificationStatusSchema,
    /**
     * What the judge checked, and what it found. Required exactly when the
     * status is not `asserted` and REFUSED when it is: that makes a
     * `judge_confirmed` or `refuted_at_head` claim cost something and leaves
     * `asserted` the cheap path, so the note cannot decay into boilerplate
     * stamped on every candidate.
     */
    verification_note: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((disposition, ctx) => {
    const asserted = disposition.verification_status === "asserted";
    if (asserted && disposition.verification_note !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification_note"],
        message: `candidate ${disposition.candidate_id}: verification_note is not permitted on an asserted candidate`,
      });
    }
    if (!asserted && disposition.verification_note === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification_note"],
        message: `candidate ${disposition.candidate_id}: verification_status "${disposition.verification_status}" requires a verification_note stating what was checked`,
      });
    }
  });

/**
 * The findings a judge or perspective may SUBMIT. `verification_status` is
 * omitted for the same reason `WorkerFindingSchema` omits `grounding`: it is
 * derived by the tool at ingest from the per-candidate claims, so a supplied
 * value would bypass the derivation and be un-cross-checkable. The omit keeps it
 * out of the parsed value; `refuseSuppliedVerificationStatus` NAMES it, because
 * a silently stripped field teaches the host nothing.
 */
export const ConceptualSubmittedFindingSchema = FindingSchema.omit({
  verification_status: true,
});

export const ConceptualFinalFindingShareSchema = z
  .object({
    final_finding_id: z.string().min(1),
    contributors: z
      .array(
        z
          .object({
            contributor_id: z.string().min(1),
            source_candidate_ids: z.array(z.string().min(1)),
            contribution_percent: PercentageSchema,
            rationale: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ConceptualJudgeSubmissionSchema = z
  .object({
    round_id: z.string().min(1),
    findings: z.array(ConceptualSubmittedFindingSchema),
    candidate_dispositions: z.array(ConceptualCandidateDispositionSchema),
    final_finding_shares: z.array(ConceptualFinalFindingShareSchema),
  })
  .strict();

export type ConceptualJudgeSubmission = z.infer<
  typeof ConceptualJudgeSubmissionSchema
>;

export interface ConceptualReviewContributor {
  contributor_id: string;
  role: "perspective" | "judge";
  perspective?: string;
  lane_id: string;
  prompt_path: string;
  result_path: string;
}

export interface ConceptualReviewAdjudication {
  schema_version: 1;
  generated_at: string;
  round_id: string;
  contributors: ConceptualReviewContributor[];
  candidate_dispositions: ConceptualJudgeSubmission["candidate_dispositions"];
  final_finding_shares: ConceptualJudgeSubmission["final_finding_shares"];
  /**
   * CANDIDATE-scoped counts, DERIVED by `buildConceptualReviewAdjudication` and
   * never read from the submission — an aggregate a judge supplied would let the
   * artifact self-certify its own outcome. Both are required, so an adjudication
   * that publishes no rejection rate cannot exist.
   *
   * These do NOT reconcile with the finding-scoped
   * `AuditFindingsSummary.verification_status_breakdown`, and are not meant to:
   * a merged candidate's final finding can still be quarantined ungrounded
   * downstream. Each is labelled by its population rather than reconciled into
   * one number that would have to hide the quarantine.
   */
  candidate_disposition_breakdown: Record<string, number>;
  candidate_verification_status_breakdown: Record<string, number>;
}

export function conceptualCandidateId(
  contributorId: string,
  findingId: string,
): string {
  return `${contributorId}::${findingId}`;
}

function submissionFindings(value: unknown, path: string): Finding[] {
  const envelope = z
    .union([
      z.array(ConceptualSubmittedFindingSchema),
      z.object({ findings: z.array(ConceptualSubmittedFindingSchema) }).passthrough(),
    ])
    .safeParse(value);
  if (!envelope.success) {
    throw new Error(
      `conceptual perspective result ${path} is not a valid findings array/envelope: ${envelope.error.message}`,
    );
  }
  return Array.isArray(envelope.data)
    ? envelope.data
    : envelope.data.findings;
}

/**
 * Read exactly the perspective result paths named by the current-round
 * manifest. No directory scan is permitted: old round files may remain for
 * provenance, but they are never candidates in a later adjudication.
 */
export async function loadConceptualPerspectiveFindings(
  manifestInput: ConceptualReviewRoundManifest,
): Promise<Map<string, Finding[]>> {
  const manifest = ConceptualReviewRoundManifestSchema.parse(manifestInput);
  const out = new Map<string, Finding[]>();
  for (const contributor of manifest.perspectives) {
    if (out.has(contributor.contributor_id)) {
      throw new Error(`duplicate contributor ${contributor.contributor_id}`);
    }
    const value = await readJsonFile<unknown>(contributor.result_path);
    out.set(
      contributor.contributor_id,
      submissionFindings(value, contributor.result_path),
    );
  }
  return out;
}

function fail(message: string): never {
  throw new Error(`invalid conceptual adjudication: ${message}`);
}

/**
 * The judge's own door into the finding contract. `ConceptualJudgeSubmissionSchema`
 * parses `findings` with `verification_status` OMITTED, which strips a supplied
 * value SILENTLY — so this pre-schema check names the field, exactly as the
 * per-file host handoff does for `grounding`. Stated before the schema parse for
 * the same reason: the strict envelope would report only a stripped/unknown key.
 */
function refuseSuppliedVerificationStatus(submission: unknown): void {
  if (!isRecord(submission) || !Array.isArray(submission.findings)) return;
  for (const [index, finding] of submission.findings.entries()) {
    if (isRecord(finding) && "verification_status" in finding) {
      fail(
        `findings[${index}].verification_status: verification_status is derived at ingest and must not be supplied`,
      );
    }
  }
}


/**
 * Apply semantic invariants a schema alone cannot express. Percentages remain
 * judge-authored estimates; tooling verifies references, completeness, and
 * arithmetic rather than pretending to derive semantic credit mechanically.
 */
export function buildConceptualReviewAdjudication(params: {
  manifest: ConceptualReviewRoundManifest;
  perspectiveFindings: ReadonlyMap<string, readonly Finding[]>;
  submission: unknown;
  generatedAt: string;
}): ConceptualReviewAdjudication {
  const manifest = ConceptualReviewRoundManifestSchema.parse(params.manifest);
  refuseSuppliedVerificationStatus(params.submission);
  const submission = ConceptualJudgeSubmissionSchema.parse(params.submission);
  if (submission.round_id !== manifest.round_id) {
    fail(
      `stale round ${submission.round_id}; expected current round ${manifest.round_id}`,
    );
  }

  const perspectiveIds = new Set<string>();
  for (const contributor of manifest.perspectives) {
    if (perspectiveIds.has(contributor.contributor_id)) {
      fail(`duplicate contributor ${contributor.contributor_id}`);
    }
    perspectiveIds.add(contributor.contributor_id);
  }
  if (perspectiveIds.has(manifest.judge.contributor_id)) {
    fail(`judge contributor duplicates perspective ${manifest.judge.contributor_id}`);
  }

  const expectedCandidates = new Map<
    string,
    { contributorId: string; findingId: string }
  >();
  for (const contributor of manifest.perspectives) {
    const findings = params.perspectiveFindings.get(contributor.contributor_id);
    if (!findings) {
      fail(`missing perspective findings for ${contributor.contributor_id}`);
    }
    const seenFindingIds = new Set<string>();
    for (const finding of findings) {
      if (seenFindingIds.has(finding.id)) {
        fail(
          `duplicate source finding ${finding.id} from contributor ${contributor.contributor_id}`,
        );
      }
      seenFindingIds.add(finding.id);
      const id = conceptualCandidateId(contributor.contributor_id, finding.id);
      expectedCandidates.set(id, {
        contributorId: contributor.contributor_id,
        findingId: finding.id,
      });
    }
  }

  const finalIds = new Set(submission.findings.map((finding) => finding.id));
  if (finalIds.size !== submission.findings.length) {
    fail("duplicate final finding id");
  }

  const dispositions = new Map<
    string,
    ConceptualJudgeSubmission["candidate_dispositions"][number]
  >();
  for (const disposition of submission.candidate_dispositions) {
    if (dispositions.has(disposition.candidate_id)) {
      fail(`duplicate candidate disposition ${disposition.candidate_id}`);
    }
    dispositions.set(disposition.candidate_id, disposition);
    const expected = expectedCandidates.get(disposition.candidate_id);
    if (!expected) {
      fail(`unknown candidate ${disposition.candidate_id}`);
    }
    if (
      disposition.contributor_id !== expected.contributorId ||
      disposition.source_finding_id !== expected.findingId ||
      disposition.candidate_id !==
        conceptualCandidateId(
          disposition.contributor_id,
          disposition.source_finding_id,
        )
    ) {
      fail(`candidate identity mismatch ${disposition.candidate_id}`);
    }
    for (const finalId of disposition.target_final_finding_ids) {
      if (!finalIds.has(finalId)) {
        fail(`unknown final finding ${finalId}`);
      }
    }
    if (
      disposition.disposition === "rejected" &&
      disposition.target_final_finding_ids.length > 0
    ) {
      fail(`rejected candidate ${disposition.candidate_id} maps to a final finding`);
    }
    // The single rule that closes NO-REJECTION-OUTCOME. A judge that has already
    // checked the named defect against HEAD and found it absent cannot then
    // launder the candidate into the final set at a high `modification_percent`
    // — the observed case. Rejection is the only disposition a refutation admits,
    // and `rejected` maps to no final finding, so `refuted_at_head` can never
    // reach `findings[]`.
    if (
      disposition.verification_status === "refuted_at_head" &&
      disposition.disposition !== "rejected"
    ) {
      fail(
        `refuted_at_head candidate ${disposition.candidate_id} must be rejected, not ${disposition.disposition}`,
      );
    }
    if (
      disposition.disposition !== "rejected" &&
      disposition.target_final_finding_ids.length === 0
    ) {
      fail(`${disposition.disposition} candidate ${disposition.candidate_id} has no final finding`);
    }
  }
  for (const expectedId of expectedCandidates.keys()) {
    if (!dispositions.has(expectedId)) {
      fail(`missing candidate disposition ${expectedId}`);
    }
  }

  const shareByFinal = new Map<
    string,
    ConceptualJudgeSubmission["final_finding_shares"][number]
  >();
  const citedShareEdges = new Set<string>();
  for (const finalShare of submission.final_finding_shares) {
    if (!finalIds.has(finalShare.final_finding_id)) {
      fail(`unknown final finding ${finalShare.final_finding_id}`);
    }
    if (shareByFinal.has(finalShare.final_finding_id)) {
      fail(`duplicate final finding share ${finalShare.final_finding_id}`);
    }
    shareByFinal.set(finalShare.final_finding_id, finalShare);

    const seenContributors = new Set<string>();
    let judgeShares = 0;
    let total = 0;
    for (const share of finalShare.contributors) {
      if (seenContributors.has(share.contributor_id)) {
        fail(
          `duplicate contributor ${share.contributor_id} for final finding ${finalShare.final_finding_id}`,
        );
      }
      seenContributors.add(share.contributor_id);
      total += share.contribution_percent;
      if (share.contributor_id === manifest.judge.contributor_id) {
        judgeShares += 1;
        if (share.source_candidate_ids.length > 0) {
          fail(`judge share for ${finalShare.final_finding_id} references source candidates`);
        }
        continue;
      }
      if (!perspectiveIds.has(share.contributor_id)) {
        fail(`unknown contributor ${share.contributor_id}`);
      }
      if (share.source_candidate_ids.length === 0) {
        fail(
          `perspective share ${share.contributor_id} for ${finalShare.final_finding_id} has no source candidate`,
        );
      }
    for (const candidateId of share.source_candidate_ids) {
      const edgeId = `${candidateId}\u0000${finalShare.final_finding_id}`;
      if (citedShareEdges.has(edgeId)) {
        fail(
          `candidate ${candidateId} is cited more than once for final finding ${finalShare.final_finding_id}`,
        );
      }
      citedShareEdges.add(edgeId);
      const candidate = dispositions.get(candidateId);
        if (!candidate) fail(`unknown candidate ${candidateId}`);
        if (candidate.contributor_id !== share.contributor_id) {
          fail(`candidate ${candidateId} belongs to another contributor`);
        }
        if (!candidate.target_final_finding_ids.includes(finalShare.final_finding_id)) {
          fail(
            `candidate ${candidateId} does not target final finding ${finalShare.final_finding_id}`,
          );
        }
      }
    }
    if (judgeShares !== 1) {
      fail(`final finding ${finalShare.final_finding_id} requires exactly one judge share`);
    }
    if (Math.abs(total - 100) > Number.EPSILON) {
      fail(`contribution shares for ${finalShare.final_finding_id} must total 100 (got ${total})`);
    }
  }
  for (const finalId of finalIds) {
    if (!shareByFinal.has(finalId)) {
      fail(`missing final finding share ${finalId}`);
    }
  }
  for (const disposition of dispositions.values()) {
    if (disposition.disposition === "rejected") continue;
    for (const finalId of disposition.target_final_finding_ids) {
      if (!citedShareEdges.has(`${disposition.candidate_id}\u0000${finalId}`)) {
        fail(
          `${disposition.disposition} candidate ${disposition.candidate_id} is not cited by final finding ${finalId}`,
        );
      }
    }
  }

  return {
    schema_version: 1,
    generated_at: params.generatedAt,
    round_id: manifest.round_id,
    contributors: [
      ...manifest.perspectives.map((contributor) => ({
        contributor_id: contributor.contributor_id,
        role: "perspective" as const,
        perspective: contributor.perspective,
        lane_id: contributor.lane_id,
        prompt_path: contributor.prompt_path,
        result_path: contributor.result_path,
      })),
      {
        contributor_id: manifest.judge.contributor_id,
        role: "judge",
        lane_id: manifest.judge.lane_id,
        prompt_path: manifest.judge.prompt_path,
        result_path: manifest.judge.result_path,
      },
    ],
    candidate_dispositions: submission.candidate_dispositions,
    final_finding_shares: submission.final_finding_shares,
    candidate_disposition_breakdown: countBy(
      submission.candidate_dispositions,
      (disposition) => disposition.disposition,
    ),
    candidate_verification_status_breakdown: countBy(
      submission.candidate_dispositions,
      (disposition) => disposition.verification_status,
    ),
  };
}
