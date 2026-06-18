// S8 — fix the conceptual design review (repo-agnostic): general first-principles
// questions + orient-then-roam + a judging judge + grounded output. Asserts the
// prompt asks the right (general) questions, the judge evaluates rather than only
// merges, and design findings are grounded against real repo components at ingest.
import test from "node:test";
import assert from "node:assert/strict";

const { renderConceptualReviewPrompt, renderConceptualJudgePrompt, renderDesignReviewPrompt } =
  await import("../../src/audit/orchestrator/designReviewPrompt.ts");
const { groundDesignFindings, groundDesignFinding } = await import("../../src/audit/validation/designFindingGrounding.ts");

function minimalBundle() {
  return {
    repo_manifest: { repository: { name: "r" }, files: [{ path: "src/a.ts", language: "typescript" }] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "now", findings: [] },
  };
}

// ── fix 1 + 2: general first-principles questions + orient-then-roam ──
test("conceptual prompt asks general first-principles questions and says orient-then-roam", () => {
  const p = renderConceptualReviewPrompt(minimalBundle());
  assert.match(p, /first principles/i);
  assert.match(p, /fundamental approach/i);
  assert.match(p, /clean-sheet/i);
  assert.match(p, /core assumption/i);
  assert.match(p, /deepest structural risk/i);
  assert.match(p, /roam/i);
  assert.match(p, /documentation/i);
  // The old narrow improvement-checklist framing is gone.
  assert.doesNotMatch(p, /Tool and library opportunities/);
  // Output categories preserved (existing contract) and contract-only ones absent.
  assert.match(p, /tool_opportunity/);
  assert.match(p, /architecture_pattern/);
  assert.match(p, /missing_capability/);
  assert.doesNotMatch(p, /inferred_contract_gap/);
});

test("combined fallback prompt also uses first-principles framing", () => {
  const p = renderDesignReviewPrompt(minimalBundle());
  assert.match(p, /fundamental approach/i);
  assert.doesNotMatch(p, /Tool and library opportunities/);
});

// ── fix 3: a judging judge that flags what was missed ──
test("conceptual judge is evaluative and flags what perspectives collectively missed", () => {
  const p = renderConceptualJudgePrompt([{ name: "Pragmatist", path: "/tmp/p.json" }]);
  assert.match(p, /MISSED/);
  assert.match(p, /judge-added/);
  assert.match(p, /final reviewer/i);
  // It is no longer a merge-only pass.
  assert.doesNotMatch(p, /you are merging, not reviewing/);
});

// ── fix 4a: ground design findings against real repo components ──
test("groundDesignFinding: grounded iff a cited affected_files path exists in the repo", () => {
  const known = new Set(["src/a.ts", "src/b.ts"]);
  assert.equal(groundDesignFinding({ affected_files: [{ path: "src/a.ts" }] }, known).status, "grounded");
  // separator / ./ / case normalization
  assert.equal(groundDesignFinding({ affected_files: [{ path: ".\\SRC\\A.ts" }] }, known).status, "grounded");
  assert.equal(groundDesignFinding({ affected_files: [{ path: "src/ghost.ts" }] }, known).status, "ungrounded");
  assert.equal(groundDesignFinding({ affected_files: [] }, known).status, "ungrounded");
  assert.equal(groundDesignFinding({}, known).status, "ungrounded");
});

test("groundDesignFindings annotates each finding; passes through unchanged with no manifest", () => {
  const findings = [
    { id: "DR-1", affected_files: [{ path: "src/a.ts" }] },
    { id: "DR-2", affected_files: [{ path: "nope.ts" }] },
  ];
  const grounded = groundDesignFindings(findings, { files: [{ path: "src/a.ts" }] });
  assert.equal(grounded[0].grounding.status, "grounded");
  assert.equal(grounded[1].grounding.status, "ungrounded");
  assert.match(grounded[1].grounding.reason, /not found in the repository/);
  // No manifest → cannot ground → unchanged (no false-quarantine).
  const passthrough = groundDesignFindings(findings, undefined);
  assert.equal(passthrough[0].grounding, undefined);
});
