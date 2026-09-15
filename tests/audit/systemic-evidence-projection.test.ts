import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { expect, test } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { Finding } from "../../src/audit/types.js";

const { renderSecondOrderAdversaryPrompt } = await import(
  "../../src/audit/systemic/secondOrderAdversaryPrompt.js"
);

function finding(id: string, title: string): Finding {
  return {
    id,
    title,
    category: "design_simplification",
    severity: "medium",
    confidence: "high",
    lens: "architecture",
    summary: `${title} summary`,
    affected_files: [{ path: "src/a.ts" }],
  };
}

test("systemic challenge receives charter projection, actual findings, and conceptual attribution evidence", () => {
  const bundle: ArtifactBundle = {
    design_assessment: {
      generated_at: "now",
      findings: [],
      conceptual_findings: [finding("DR-1", "Collapse duplicate state")],
    },
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "now",
      target: "charter",
      ceiling: { rung: "deep" },
      lanes: [
        {
          kind: "stated",
          nodes: [
            {
              node_id: "stated-1",
              purpose: "Keep one resumable core",
              premise_height: 0,
              files: ["src/a.ts"],
              provenance: [],
              confidence: "high",
            },
          ],
          edges: [],
        },
        {
          kind: "revealed",
          nodes: [
            {
              node_id: "revealed-1",
              purpose: "Run two independent cores",
              premise_height: 0,
              files: ["src/a.ts"],
              provenance: [],
              confidence: "high",
            },
          ],
          edges: [],
        },
      ],
      candidates: [],
      correspondences: [
        {
          correspondence_id: "corr-1",
          members: [
            { kind: "stated", node_ids: ["stated-1"] },
            { kind: "revealed", node_ids: ["revealed-1"] },
          ],
          basis: "tool",
          evidence: [],
        },
      ],
      differences: [
        {
          difference_id: "difference-1",
          correspondence_id: "corr-1",
          dimension: "purpose",
          relation: "incompatible",
          split: { kind: "two_against_one", odd: "revealed" },
          accounts: [
            { kind: "stated", claim: "Keep one resumable core", provenance: [] },
            { kind: "revealed", claim: "Run two independent cores", provenance: [] },
          ],
          gap: "Two mechanisms contradict the one-core goal",
          routed_to: "remediator",
          finding_candidate: true,
          fidelity: { verdict: "supported", rationale: "both sources say so", decided_by: "lane" },
        },
      ],
      findings: [],
      validation_issues: [],
      ...REGISTER_V4_AFFIRMATION,
    },
    conceptual_review_adjudication: {
      schema_version: 1,
      generated_at: "now",
      round_id: "round-1",
      contributors: [
        {
          contributor_id: "p1",
          role: "perspective",
          perspective: "Minimalist",
          lane_id: "p1",
          prompt_path: "/x/p1-prompt.md",
          result_path: "/x/p1.json",
        },
        {
          contributor_id: "design_review_conceptual",
          role: "judge",
          lane_id: "design_review_conceptual",
          prompt_path: "/x/judge-prompt.md",
          result_path: "/x/judge.json",
        },
      ],
      candidate_dispositions: [
        {
          candidate_id: "p1::DR-1",
          contributor_id: "p1",
          source_finding_id: "DR-1",
          disposition: "retained",
          target_final_finding_ids: ["DR-1"],
          modification_percent: 20,
          rationale: "Retained after source verification",
          verification_status: "judge_confirmed",
          verification_note: "Re-read the cited module at HEAD; the split is still there.",
        },
      ],
      final_finding_shares: [
        {
          final_finding_id: "DR-1",
          contributors: [
            {
              contributor_id: "p1",
              source_candidate_ids: ["p1::DR-1"],
              contribution_percent: 80,
              rationale: "Primary candidate",
            },
            {
              contributor_id: "design_review_conceptual",
              source_candidate_ids: [],
              contribution_percent: 20,
              rationale: "Judge synthesis",
            },
          ],
        },
      ],
      candidate_disposition_breakdown: { retained: 1 },
      candidate_verification_status_breakdown: { judge_confirmed: 1 },
    },
  };

  const prompt = renderSecondOrderAdversaryPrompt({
    round: 1,
    metrics: {
      rollups: [],
      max_fan_out: 0,
      total_edges: 0,
      metric_covered_nodes: 0,
    },
    submissionPath: "/x/systemic.json",
    bundle,
    evidencePaths: [
      "/x/charter_register.json",
      "/x/conceptual_review_adjudication.json",
      "/x/p1.json",
      "/x/judge.json",
    ],
  });

  expect(prompt).toContain("Collapse duplicate state");
  expect(prompt).toContain("Keep one resumable core");
  expect(prompt).toContain("Run two independent cores");
  expect(prompt).toContain("difference-1");
  expect(prompt).toContain("correspondences");
  expect(prompt).toContain("candidate_dispositions");
  expect(prompt).toContain("contribution_percent");
  // The adversary challenges the round's OUTCOME, so it must see the round's own
  // rates — a zero rejection rate over every candidate is invisible from the
  // per-candidate records alone.
  expect(prompt).toContain("candidate_disposition_breakdown");
  expect(prompt).toContain("candidate_verification_status_breakdown");
  expect(prompt).toContain("judge_confirmed");
  expect(prompt).toContain("/x/p1.json");
  expect(prompt).toContain("/x/judge.json");
  expect(prompt).toMatch(/callers and callees in both directions/i);
});
