import { test, expect } from "vitest";

const { renderDesignReviewPrompt } = await import("../../src/audit/orchestrator/designReviewPrompt.ts");

/**
 * Slice out just the "Prioritised reading list" section so assertions about
 * which units are listed don't pick up the full "Unit structure" summary
 * (which lists every unit) elsewhere in the prompt.
 */
function readingList(prompt) {
  const start = prompt.indexOf("### Starting points (orient, then roam)");
  if (start === -1) return "";
  const rest = prompt.slice(start);
  const end = rest.indexOf("\n## "); // next top-level heading
  return end === -1 ? rest : rest.slice(0, end);
}

/** Build a bundle with `n` risk items (descending scores) and matching units. */
function bundleWithRisk(n, { unitCount = n } = {}) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      unit_id: `unit-${i}`,
      risk_score: 100 - i, // strictly descending
      signals: [`sig-${i}`],
    });
  }
  const units = [];
  for (let i = 0; i < unitCount; i++) {
    units.push({
      unit_id: `unit-${i}`,
      name: `Unit ${i}`,
      files: [`src/unit-${i}.ts`],
      required_lenses: [],
    });
  }
  return {
    risk_register: { items },
    unit_manifest: { units },
  };
}

test("renders top-N units by risk score (default budget)", () => {
  const bundle = bundleWithRisk(15);
  const prompt = renderDesignReviewPrompt(bundle);
  // default = max(5, min(20, ceil(15/5))) = 5
  expect(prompt).toMatch(/Top 5 highest-risk unit\(s\) by risk score \(out of 15 total\):/);
  // The five highest-scoring units appear in the reading list; the sixth does not.
  const list = readingList(prompt);
  for (let i = 0; i < 5; i++) {
    expect(list.includes(`unit-${i}`), `expected unit-${i} in reading list`).toBeTruthy();
  }
  expect(!list.includes("unit-5"), "unit-5 should not be in the reading list").toBeTruthy();

  // Ordered highest → lowest risk_score.
  const idx0 = list.indexOf("unit-0");
  const idx4 = list.indexOf("unit-4");
  expect(idx0 < idx4, "units must be ordered by descending risk score").toBeTruthy();

  // Each listed line carries the unit id, its risk_score, and a file path.
  expect(list.includes("(risk score: 100)")).toBeTruthy();
  expect(list.includes("src/unit-0.ts")).toBeTruthy();
});

test("respects max_units from options (lower)", () => {
  const bundle = bundleWithRisk(10);
  const prompt = renderDesignReviewPrompt(bundle, { max_units: 3 });
  expect(prompt).toMatch(/Top 3 highest-risk unit\(s\)/);
  const list = readingList(prompt);
  for (let i = 0; i < 3; i++) expect(list.includes(`unit-${i}`)).toBeTruthy();
  expect(!list.includes("unit-3"), "unit-3 should not be in the reading list").toBeTruthy();
});

test("respects max_units from options (higher than available)", () => {
  const bundle = bundleWithRisk(10);
  const prompt = renderDesignReviewPrompt(bundle, { max_units: 25 });
  // Only 10 units exist; cannot exceed the available count.
  expect(prompt).toMatch(/Top 10 highest-risk unit\(s\) by risk score \(out of 10 total\):/);
  for (let i = 0; i < 10; i++) expect(prompt.includes(`unit-${i}`)).toBeTruthy();
});

test("default budget scales and clamps with repo size", () => {
  // 50 units → ceil(50/5)=10, within [5,20] → 10
  const big = bundleWithRisk(50);
  expect(renderDesignReviewPrompt(big)).toMatch(/Top 10 highest-risk unit\(s\)/);

  // 3 units → ceil(3/5)=1, clamped up to the minimum 5; only 3 risk items exist
  const small = bundleWithRisk(3);
  expect(renderDesignReviewPrompt(small)).toMatch(/Top 3 highest-risk unit\(s\) by risk score \(out of 3 total\):/);

  // 200 units → ceil(200/5)=40, clamped down to the maximum 20
  const huge = bundleWithRisk(200);
  expect(renderDesignReviewPrompt(huge)).toMatch(/Top 20 highest-risk unit\(s\)/);
});

test("uses the orient-then-roam reading directive (not the old open-ended one)", () => {
  const prompt = renderDesignReviewPrompt(bundleWithRisk(8));
  expect(!prompt.includes(
      "Read the project source to understand what it does and how it works",
    ), "old open-ended instruction must be removed").toBeTruthy();
  expect(prompt.includes("to orient yourself, then follow the code wherever it leads"), "orient-then-roam directive must be present").toBeTruthy();
  expect(prompt.includes("need not read every file"), "scoped reading directive must be present").toBeTruthy();
});

// ── section-cap helpers ───────────────────────────────────────────────────────

function extractSection(prompt, heading, nextHeadingPrefix) {
  const start = prompt.indexOf(heading);
  if (start === -1) return "";
  const rest = prompt.slice(start);
  const end = rest.indexOf(nextHeadingPrefix, heading.length);
  return end === -1 ? rest : rest.slice(0, end);
}

test("summarizeFlows — caps at 15 items and emits '... and N more' suffix", () => {
  const flows = Array.from({ length: 20 }, (_, i) => ({
    name: `flow-${i}`,
    paths: [`path-${i}.ts`],
    concerns: [`concern-${i}`],
  }));
  const bundle = { critical_flows: { flows } };
  const prompt = renderDesignReviewPrompt(bundle);
  const section = extractSection(prompt, "### Critical flows", "\n###");

  expect(section).toMatch(/20 critical flows:/);
  expect(section.includes("flow-0"), "first flow must be present").toBeTruthy();
  expect(section.includes("flow-14"), "15th flow must be present").toBeTruthy();
  expect(!section.includes("flow-15"), "16th flow must not be present").toBeTruthy();
  expect(section).toMatch(/\.\.\. and 5 more/);
});

test("summarizeSurfaces — caps at 20 items and emits '... and N more' suffix", () => {
  const surfaces = Array.from({ length: 25 }, (_, i) => ({
    id: `surface-${i}`,
    kind: "http",
    entrypoint: `/api/${i}`,
  }));
  const bundle = { surface_manifest: { surfaces } };
  const prompt = renderDesignReviewPrompt(bundle);
  const section = extractSection(prompt, "### Externally reachable surfaces", "\n###");

  expect(section).toMatch(/25 surfaces:/);
  expect(section.includes("surface-0"), "first surface must be present").toBeTruthy();
  expect(section.includes("surface-19"), "20th surface must be present").toBeTruthy();
  expect(!section.includes("surface-20"), "21st surface must not be present").toBeTruthy();
  expect(section).toMatch(/\.\.\. and 5 more/);
});

test("formatDeterministicFindings — caps at 20 items and emits '... and N more' suffix", () => {
  const findings = Array.from({ length: 25 }, (_, i) => ({
    id: `F-${i}`,
    title: `Finding ${i}`,
    summary: `Summary ${i}`,
    severity: "high",
    confidence: "high",
    lens: "architecture",
    category: "bug",
    affected_files: [],
    evidence: [],
  }));
  const bundle = { design_assessment: { findings } };
  const prompt = renderDesignReviewPrompt(bundle);
  const section = extractSection(prompt, "### Deterministic structural findings", "\n##");

  expect(section).toMatch(/25 structural findings from deterministic analysis:/);
  expect(section.includes("Finding 0"), "first finding must be present").toBeTruthy();
  expect(section.includes("Finding 19"), "20th finding must be present").toBeTruthy();
  expect(!section.includes("Finding 20"), "21st finding must not be present").toBeTruthy();
  expect(section).toMatch(/\.\.\. and 5 more/);
});

test("summarizeFlows — within cap shows all items without suffix", () => {
  const flows = Array.from({ length: 10 }, (_, i) => ({
    name: `flow-${i}`, paths: [], concerns: [],
  }));
  const prompt = renderDesignReviewPrompt({ critical_flows: { flows } });
  expect(prompt).toMatch(/10 critical flows:/);
  expect(!prompt.includes("... and"), "no truncation suffix expected when within cap").toBeTruthy();
});

test("summarizeSurfaces — within cap shows all items without suffix", () => {
  const surfaces = Array.from({ length: 5 }, (_, i) => ({
    id: `s-${i}`, kind: "http", entrypoint: `/api/${i}`,
  }));
  const prompt = renderDesignReviewPrompt({ surface_manifest: { surfaces } });
  expect(prompt).toMatch(/5 surfaces:/);
  expect(!prompt.includes("... and"), "no truncation suffix expected when within cap").toBeTruthy();
});

// ── contract assessment ───────────────────────────────────────────────────────

test("includes observational contract assessment guidance separate from conceptual critique", () => {
  const prompt = renderDesignReviewPrompt(bundleWithRisk(8));

  expect(prompt).toMatch(/### Contract assessment/);
  expect(prompt).toMatch(/### Conceptual design critique/);
  expect(prompt).toMatch(/inferred or existing project contracts/);
  expect(prompt).toMatch(/invariants/);
  expect(prompt).toMatch(/trust boundaries/);
  expect(prompt).toMatch(/concrete counterexamples/);
  expect(prompt).toMatch(/critical_invariant_coverage_gap/);
  expect(prompt).toMatch(/do not invent a new contract DSL/);
  expect(prompt).toMatch(/remediate code/);
  expect(prompt).toMatch(/implementation pipeline/);
  expect(prompt).toMatch(/inferred_contract_gap/);
  expect(prompt).toMatch(/trust_boundary_gap/);
  expect(prompt).toMatch(/invariant_counterexample/);
});

test("falls back gracefully when risk data is absent", () => {
  // Units present, no risk scores → lists units under the fallback heading.
  const unitsOnly = {
    risk_register: { items: [] },
    unit_manifest: {
      units: [
        { unit_id: "u-a", name: "A", files: ["a.ts"], required_lenses: [] },
        { unit_id: "u-b", name: "B", files: ["b.ts"], required_lenses: [] },
      ],
    },
  };
  const prompt1 = renderDesignReviewPrompt(unitsOnly);
  expect(prompt1).toMatch(/no risk scores available/);
  expect(prompt1.includes("u-a")).toBeTruthy();
  expect(prompt1.includes("u-b")).toBeTruthy();

  // Neither risk_register nor unit_manifest → orientation fallback string.
  const empty = {};
  const prompt2 = renderDesignReviewPrompt(empty);
  expect(prompt2.includes(
      "No risk or unit data available; read the repository root files to orient yourself.",
    )).toBeTruthy();
});
