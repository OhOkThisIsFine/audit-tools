// S8 — fix the conceptual design review (repo-agnostic): general first-principles
// questions + orient-then-roam + a judging judge + grounded output. Asserts the
// prompt asks the right (general) questions, the judge evaluates rather than only
// merges, and design findings are grounded against real repo components at ingest.
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { Finding, FindingGrounding } from "../../src/shared/types/finding.js";

const { renderConceptualReviewPrompt, renderConceptualJudgePrompt } =
  await import("../../src/audit/orchestrator/designReviewPrompt.js");
const {
  groundDesignFindings,
  groundDesignFinding: groundDesignFindingImpl,
} = await import("../../src/shared/validation/designFindingGrounding.js");

function minimalBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "r" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "now", findings: [] },
  };
}

function groundDesignFinding(
  finding: Partial<Finding>,
  knownPaths: ReadonlySet<string>,
): FindingGrounding {
  return groundDesignFindingImpl({
    id: "DR-fixture",
    title: "Fixture finding",
    category: "architecture",
    severity: "medium",
    confidence: "high",
    lens: "architecture",
    summary: "Fixture summary",
    affected_files: [],
    ...finding,
  }, knownPaths);
}

// ── fix 1 + 2: general first-principles questions + orient-then-roam ──
test("conceptual prompt asks general first-principles questions and says orient-then-roam", () => {
  const p = renderConceptualReviewPrompt(minimalBundle());
  expect(p).toMatch(/first principles/i);
  expect(p).toMatch(/fundamental approach/i);
  expect(p).toMatch(/clean-sheet/i);
  expect(p).toMatch(/core assumption/i);
  expect(p).toMatch(/deepest structural risk/i);
  expect(p).toMatch(/roam/i);
  expect(p).toMatch(/documentation/i);
  // The old narrow improvement-checklist framing is gone.
  expect(p).not.toMatch(/Tool and library opportunities/);
  // Output categories preserved (existing contract) and contract-only ones absent.
  expect(p).toMatch(/tool_opportunity/);
  expect(p).toMatch(/architecture_pattern/);
  expect(p).toMatch(/missing_capability/);
  expect(p).not.toMatch(/inferred_contract_gap/);
});

// ── fix 3: a judging judge that flags what was missed ──
test("conceptual judge is evaluative, complete, and attributable", () => {
  const p = renderConceptualJudgePrompt({} as ArtifactBundle, [
    {
      name: "Pragmatist",
      path: "/tmp/p.json",
      contributor_id: "design_review_conceptual_p1_round",
    },
  ], "round");
  expect(p).toMatch(/MISSED/);
  expect(p).toMatch(/judge-added/);
  expect(p).toMatch(/final reviewer/i);
  expect(p).toMatch(/candidate_dispositions/);
  expect(p).toMatch(/final_finding_shares/);
  expect(p).toMatch(/modification_percent/);
  expect(p).toMatch(/round_id/);
  expect(p).toMatch(/exactly one explicit .*judge share/i);
  // It is no longer a merge-only pass.
  expect(p).not.toMatch(/you are merging, not reviewing/);
});

// ── the rejection ground that was missing (NO-REJECTION-OUTCOME) ──
//
// LIMIT, stated so it is not read as more than it is: this proves the
// instruction SHIPS, not that a judge obeys it. The behavioural half is the
// validator's refusal of a refuted_at_head candidate that is not rejected
// (`conceptual-adjudication.test.ts`), which holds against any judge.
test("conceptual judge is told to reject what HEAD has already fixed", () => {
  const p = renderConceptualJudgePrompt({} as ArtifactBundle, [
    {
      name: "Pragmatist",
      path: "/tmp/p.json",
      contributor_id: "design_review_conceptual_p1_round",
    },
  ], "round");
  // The four pre-existing grounds were all about the FORM of an assertion
  // (vague / unactionable / unsupported / out-of-scope). None covered a
  // well-argued, actionable, in-scope claim whose defect is simply not there.
  expect(p).toMatch(/already (fixed|remediated)/i);
  expect(p).toMatch(/refuted_at_head/);
  expect(p).toMatch(/verification_status/);
  expect(p).toMatch(/verification_note/);
  expect(p).toMatch(/judge_confirmed/);
  // And it must say what a refutation costs: rejection, not a high-modification
  // merge, which is exactly what the live run did instead.
  expect(p).toMatch(/reject/i);
});

// ── fix 4a: ground design findings against real repo components ──
test("groundDesignFinding: grounded iff a cited affected_files path exists in the repo", () => {
  const known = new Set(["src/a.ts", "src/b.ts"]);
  expect(groundDesignFinding({ affected_files: [{ path: "src/a.ts" }] }, known).status).toBe("grounded");
  // separator / ./ / case normalization
  expect(groundDesignFinding({ affected_files: [{ path: ".\\SRC\\A.ts" }] }, known).status).toBe("grounded");
  expect(groundDesignFinding({ affected_files: [{ path: "src/ghost.ts" }] }, known).status).toBe("ungrounded");
  expect(groundDesignFinding({ affected_files: [] }, known).status).toBe("ungrounded");
  expect(groundDesignFinding({}, known).status).toBe("ungrounded");
});

test("groundDesignFindings annotates each finding; passes through unchanged with no manifest", () => {
  const findings: Finding[] = [
    {
      id: "DR-1",
      title: "First design finding",
      category: "architecture",
      severity: "medium",
      confidence: "high",
      lens: "architecture",
      summary: "First design summary",
      affected_files: [{ path: "src/a.ts" }],
    },
    {
      id: "DR-2",
      title: "Second design finding",
      category: "architecture",
      severity: "medium",
      confidence: "high",
      lens: "architecture",
      summary: "Second design summary",
      affected_files: [{ path: "nope.ts" }],
    },
  ];
  const grounded = groundDesignFindings(findings, { files: [{ path: "src/a.ts" }] });
  if (!grounded[0].grounding || !grounded[1].grounding) {
    throw new Error("groundDesignFindings did not annotate every finding");
  }
  expect(grounded[0].grounding.status).toBe("grounded");
  expect(grounded[1].grounding.status).toBe("ungrounded");
  expect(grounded[1].grounding.reason).toMatch(/not found in the repository/);
  // No manifest → cannot ground → unchanged (no false-quarantine).
  const passthrough = groundDesignFindings(findings, undefined);
  expect(passthrough[0].grounding).toBe(undefined);
});
