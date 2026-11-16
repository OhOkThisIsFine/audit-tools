/**
 * The six LANE-GATE rows of `POLICY_CLASSIFIERS`, pinned branch by branch.
 *
 * Each row has one shape: probe its lane FIRST (a pending submission is
 * `await_submission`, whatever the bundle says); else a deterministic omit arm
 * when its predicate holds; else a host boundary. `critical_flow_fallback_current`
 * has no omit arm. The probe-first order is load-bearing: the full fold consumes
 * a stray submission even when the gate would omit, and the plan draw must
 * classify it the same way. This test holds each row's lane, its order and its
 * exact reason strings, so a change to the row's construction cannot move them.
 */
import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { IntentCheckpoint } from "../../src/shared/index.js";
import {
  classifyObligationBranch,
  type ObligationBranch,
} from "../../src/audit/orchestrator/obligationPolicy.js";
import { GATE_LANES, systemicChallengeLane } from "../../src/audit/cli/laneSubmissions.js";
import { normalizeCheckpointForms, computeGateVersion } from "../../src/audit/orchestrator/intentCheckpointGate.js";
import { METADATA_SCHEMA_VERSION } from "../../src/audit/types/artifactMetadata.js";
import { runCharterClarificationExecutor } from "../../src/audit/orchestrator/charterClarificationExecutor.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";

function checkpoint(over: Partial<IntentCheckpoint> = {}): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "Root: /repo, files in scope: 12",
    intent_summary: "full-audit",
    ...over,
  };
}

const deepCheckpoint = (): IntentCheckpoint =>
  checkpoint({ design_review: { answered_at: "2026-01-01T00:00:00Z", ceiling: { rung: "deep" }, attention: "all" } });

/** A prose-only checkpoint change against a stamped baseline: the host judge is owed. */
function proseDeltaBundle(): ArtifactBundle {
  const forms = normalizeCheckpointForms(checkpoint());
  return {
    intent_checkpoint: checkpoint({ scope_summary: "Scope root /repo (12 files)" }),
    artifact_metadata: {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {
        "intent_checkpoint.json": { revision: 3, content_hash: "irrelevant-here", dependency_revisions: {} },
      },
      intent_baseline: {
        normalized_structured: forms.structured,
        normalized_prose: forms.prose,
        revision: 3,
        gate_version: computeGateVersion(),
      },
    },
  } as ArtifactBundle;
}

/** A deep run whose clarification executor asked the operator two questions. */
function askedClarificationBundle(): ArtifactBundle {
  return runCharterClarificationExecutor({
    intent_checkpoint: deepCheckpoint(),
    charter_register: {
      ...EMPTY_REGISTER_BODY,
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-01-01T00:00:00Z",
      target: "charter",
      ceiling: { rung: "deep" },
      differences: ["d1", "d2"].map((difference_id) => ({
        difference_id, correspondence_id: "c1", dimension: "scope", relation: "incompatible",
        accounts: [
          { kind: "stated", claim: "Review all source", provenance: [] },
          { kind: "revealed", claim: "Review security only", provenance: [] },
        ],
        gap: "Scope differs", routed_to: "clarification", finding_candidate: true,
        fidelity: { verdict: "supported", rationale: "Both accounts are present", decided_by: "lane" },
      })),
    },
  } as ArtifactBundle).updated;
}

function openSystemicBundle(): ArtifactBundle {
  return {
    intent_checkpoint: deepCheckpoint(),
    systemic_challenge: {
      generated_at: "2026-01-01T00:00:00Z",
      target: "systemic_challenge",
      ceiling: { rung: "deep" },
      rounds: [],
      converged: false,
      findings: [],
      validation_issues: [],
    },
  } as ArtifactBundle;
}

interface LaneGateRow {
  id: string;
  lane: string;
  pendingReason: string;
  /** Absent for the one row with no omit arm. */
  omits: boolean;
  /** A bundle on which the omit predicate does NOT hold. */
  boundaryBundle: () => ArtifactBundle;
  boundaryReason: string;
}

const ROWS: readonly LaneGateRow[] = [
  {
    id: "critical_flow_fallback_current",
    lane: GATE_LANES.critical_flow_fallback,
    pendingReason: "a critical-flow fallback submission is pending",
    omits: false,
    boundaryBundle: () => ({}),
    boundaryReason: "deterministic flow inference fell below the confidence bar; the host authors the enrichment",
  },
  {
    id: "intent_equivalence_current",
    lane: GATE_LANES.intent_equivalence,
    pendingReason: "an intent-equivalence verdict submission is pending",
    omits: true,
    boundaryBundle: proseDeltaBundle,
    boundaryReason: "a prose-only intent delta awaits the host judge",
  },
  {
    id: "charter_comparison_current",
    lane: GATE_LANES.charter_comparison,
    pendingReason: "a charter-comparison submission is pending",
    omits: true,
    boundaryBundle: () => ({ charter_register: { comparison_pending: true } }) as unknown as ArtifactBundle,
    boundaryReason: "a comparison_pending register owes the comparison reader's turn",
  },
  {
    id: "charter_fidelity_current",
    lane: GATE_LANES.charter_fidelity,
    pendingReason: "a charter-fidelity submission is pending",
    omits: true,
    boundaryBundle: () => ({ charter_register: { fidelity_pending: true } }) as unknown as ArtifactBundle,
    boundaryReason: "a fidelity_pending register owes the fidelity lane's turn",
  },
  {
    id: "charter_clarification_current",
    lane: GATE_LANES.charter_clarification,
    pendingReason: "a clarification-answers submission is pending",
    omits: true,
    boundaryBundle: askedClarificationBundle,
    boundaryReason: "an interactive clarification queue awaits relay to the operator",
  },
  {
    id: "systemic_challenge_current",
    lane: systemicChallengeLane([]),
    pendingReason: "a systemic-challenge round submission is pending",
    omits: true,
    boundaryBundle: openSystemicBundle,
    boundaryReason: "an open challenge register awaits the next adversary round",
  },
];

async function classify(id: string, bundle: ArtifactBundle, pendingLane?: string) {
  const probed: string[] = [];
  const branch: ObligationBranch = await classifyObligationBranch(id, bundle, {
    submissionProbe: async (lane) => {
      probed.push(lane);
      return lane === pendingLane;
    },
  }, () => true);
  return { branch, probed };
}

describe("POLICY_CLASSIFIERS lane-gate rows", () => {
  for (const row of ROWS) {
    describe(row.id, () => {
      it("a pending submission on its lane wins, even on a bundle the gate would omit", async () => {
        const { branch, probed } = await classify(row.id, {}, row.lane);
        expect(branch).toEqual({ branch: "await_submission", lane: row.lane, reason: row.pendingReason });
        expect(probed).toEqual([row.lane]);
      });

      it("the same pending submission wins on a bundle that owes the host turn", async () => {
        const { branch } = await classify(row.id, row.boundaryBundle(), row.lane);
        expect(branch).toEqual({ branch: "await_submission", lane: row.lane, reason: row.pendingReason });
      });

      if (row.omits) {
        it("with no submission, its omit predicate takes the deterministic arm", async () => {
          const { branch, probed } = await classify(row.id, {});
          expect(branch).toEqual({ branch: "deterministic" });
          expect(probed).toEqual([row.lane]);
        });
      }

      it("with no submission and nothing to omit, it halts at the host boundary", async () => {
        const { branch, probed } = await classify(row.id, row.boundaryBundle());
        expect(branch).toEqual({ branch: "host_boundary", reason: row.boundaryReason });
        expect(probed).toEqual([row.lane]);
      });
    });
  }
});
