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
      schema_version: "charter-register/v3",
      generated_at: "now",
      target: "charter",
      ceiling: { rung: "deep" },
      subsystems: [
        {
          node_id: "subsystem-1",
          members: ["src/a.ts"],
          charters: [
            {
              charter_id: "stated-1",
              kind: "stated",
              purpose: "Keep one resumable core",
              provenance: [],
              confidence: "high",
            },
          ],
          teleologies: {},
        },
      ],
      goal_graph: {
        nodes: [
          { node_id: "goal-1", premise_height: 0, statement: "One core" },
        ],
        edges: [],
      },
      deltas: [
        {
          delta_id: "delta-1",
          node_id: "subsystem-1",
          pair: ["stated", "revealed"],
          kind: "says_does_drift",
          routed_to: "remediator",
          summary: "Two mechanisms contradict the one-core goal",
        },
      ],
      findings: [],
      triangulated: [
        {
          node_id: "subsystem-1",
          telos: "Keep one resumable core",
          confidence: "high",
        },
      ],
      disagreement: [],
      validation_issues: [],
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
  expect(prompt).toContain("goal_graph");
  expect(prompt).toContain("delta-1");
  expect(prompt).toContain("triangulated");
  expect(prompt).toContain("candidate_dispositions");
  expect(prompt).toContain("contribution_percent");
  expect(prompt).toContain("/x/p1.json");
  expect(prompt).toContain("/x/judge.json");
  expect(prompt).toMatch(/callers and callees in both directions/i);
});
