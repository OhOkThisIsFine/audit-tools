/**
 * CX-02 preservation constraint — every transition produces a FRESH bundle,
 * and no handler mutates a carried bundle's nested objects in place.
 *
 * The named hazard: `handleDesignReviewBranch` used to alias
 * `bundle.design_assessment` and mutate it, relying on a disk reload to mint a
 * new identity. Under the in-memory carry both derive memos key on bundle
 * IDENTITY, so an in-place mutation lets an earlier carry observe a later
 * change — the memo hands back a pre-mutation `AuditState`, the just-completed
 * review re-selects, and the slice-ordering premise breaks silently. The
 * reason is ALIASING, not memoization: a shallow copy alone would re-derive
 * correctly and still leak writes into the prior carry (the record corrects
 * exactly that misattribution).
 *
 * Mechanism: DEEP-FREEZE the input bundle. Any in-place write throws in strict
 * mode, so the handler passing at all proves the no-aliasing rule; the
 * identity assertions pin the fresh-carry half.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { handleDesignReviewBranch } from "../../src/audit/cli/nextStepHelpers.js";
import {
  GATE_LANES,
  laneSubmissionPath,
} from "../../src/audit/cli/laneSubmissions.js";
import { submissionsDir } from "../../src/shared/io/auditToolsPaths.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { computeStaleArtifacts } from "../../src/audit/orchestrator/staleness.js";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

test("a consumed design-review submission never mutates the carried bundle in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-aliasing-"));
  try {
    const artifactsDir = join(dir, "audit");
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract),
      JSON.stringify([{ id: "DR-001", title: "contract finding" }]),
      "utf8",
    );

    const assessment = {
      generated_at: "now",
      findings: [],
      contract_reviewed: false,
      conceptual_reviewed: false,
    };
    const bundle: ArtifactBundle = deepFreeze({ design_assessment: assessment });
    const state: AuditState = { status: "active", obligations: [] };

    // Frozen input: an in-place mutation anywhere in the handler throws.
    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      state,
      createFoldTransaction(),
    );

    expect(branch.action).toBe("continue");
    if (branch.action !== "continue") throw new Error("expected continue");
    // Fresh carry: new bundle identity, new nested assessment identity.
    expect(branch.bundle).not.toBe(bundle);
    expect(branch.bundle.design_assessment).not.toBe(assessment);
    expect(branch.bundle.design_assessment?.contract_reviewed).toBe(true);
    // The input is byte-for-byte what it was.
    expect(assessment.contract_reviewed).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([GATE_LANES.design_review_contract])(
  "%s ingestion updates content without refreshing structural or old adjudication baselines",
  async (lane) => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "dr-baseline-"));
    try {
      await mkdir(submissionsDir(artifactsDir), { recursive: true });
      await writeFile(laneSubmissionPath(artifactsDir, lane), JSON.stringify([{ id: "DR-new", title: "new review finding" }]));
      const bundle: ArtifactBundle = {
        unit_manifest: { units: [] },
        critical_flows: { flows: [] },
        design_assessment: { generated_at: "before", findings: [] },
        conceptual_review_adjudication: {
          schema_version: 1, generated_at: "before", round_id: "prior-round",
          contributors: [], candidate_dispositions: [], final_finding_shares: [],
          candidate_disposition_breakdown: {}, candidate_verification_status_breakdown: {},
        },
      };
      bundle.artifact_metadata = computeArtifactMetadata(bundle);
      // This handler is also directly callable: consuming a review does not
      // authorize it to certify a pending structural rebuild.
      bundle.artifact_metadata.artifacts["unit_manifest.json"]!.revision += 1;
      const prior = structuredClone(bundle.artifact_metadata);
      deepFreeze(bundle);
      const branch = await handleDesignReviewBranch(
        { artifactsDir }, bundle, { status: "active", obligations: [] }, createFoldTransaction(),
      );
      expect(branch.action).toBe("continue");
      if (branch.action !== "continue") throw new Error("expected consumed review");
      const next = branch.bundle;
      expect(next.artifact_metadata?.artifacts["design_assessment.json"]?.content_hash).toBe(hashArtifactValue("design_assessment.json", next.design_assessment));
      expect(next.artifact_metadata?.artifacts["design_assessment.json"]?.dependency_revisions).toEqual(prior.artifacts["design_assessment.json"]!.dependency_revisions);
      expect(next.artifact_metadata?.artifacts["conceptual_review_adjudication.json"]).toEqual(prior.artifacts["conceptual_review_adjudication.json"]);
      expect(next.conceptual_review_adjudication).toBe(bundle.conceptual_review_adjudication);
      const stale = computeStaleArtifacts(next, { emit: false });
      expect(stale.has("design_assessment.json")).toBe(true);
      expect(stale.has("conceptual_review_adjudication.json")).toBe(true);
      expect(bundle.artifact_metadata).toEqual(prior);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  },
);
