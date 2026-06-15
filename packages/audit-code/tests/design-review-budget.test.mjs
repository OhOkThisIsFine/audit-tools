import test from "node:test";
import assert from "node:assert/strict";

const { renderDesignReviewPrompt } = await import(
  "../src/orchestrator/designReviewPrompt.ts"
);

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
  assert.match(
    prompt,
    /Top 5 highest-risk unit\(s\) by risk score \(out of 15 total\):/,
  );
  // The five highest-scoring units appear in the reading list; the sixth does not.
  const list = readingList(prompt);
  for (let i = 0; i < 5; i++) {
    assert.ok(list.includes(`unit-${i}`), `expected unit-${i} in reading list`);
  }
  assert.ok(!list.includes("unit-5"), "unit-5 should not be in the reading list");

  // Ordered highest → lowest risk_score.
  const idx0 = list.indexOf("unit-0");
  const idx4 = list.indexOf("unit-4");
  assert.ok(idx0 < idx4, "units must be ordered by descending risk score");

  // Each listed line carries the unit id, its risk_score, and a file path.
  assert.ok(list.includes("(risk score: 100)"));
  assert.ok(list.includes("src/unit-0.ts"));
});

test("respects max_units from options (lower)", () => {
  const bundle = bundleWithRisk(10);
  const prompt = renderDesignReviewPrompt(bundle, { max_units: 3 });
  assert.match(prompt, /Top 3 highest-risk unit\(s\)/);
  const list = readingList(prompt);
  for (let i = 0; i < 3; i++) assert.ok(list.includes(`unit-${i}`));
  assert.ok(!list.includes("unit-3"), "unit-3 should not be in the reading list");
});

test("respects max_units from options (higher than available)", () => {
  const bundle = bundleWithRisk(10);
  const prompt = renderDesignReviewPrompt(bundle, { max_units: 25 });
  // Only 10 units exist; cannot exceed the available count.
  assert.match(prompt, /Top 10 highest-risk unit\(s\) by risk score \(out of 10 total\):/);
  for (let i = 0; i < 10; i++) assert.ok(prompt.includes(`unit-${i}`));
});

test("default budget scales and clamps with repo size", () => {
  // 50 units → ceil(50/5)=10, within [5,20] → 10
  const big = bundleWithRisk(50);
  assert.match(
    renderDesignReviewPrompt(big),
    /Top 10 highest-risk unit\(s\)/,
  );

  // 3 units → ceil(3/5)=1, clamped up to the minimum 5; only 3 risk items exist
  const small = bundleWithRisk(3);
  assert.match(
    renderDesignReviewPrompt(small),
    /Top 3 highest-risk unit\(s\) by risk score \(out of 3 total\):/,
  );

  // 200 units → ceil(200/5)=40, clamped down to the maximum 20
  const huge = bundleWithRisk(200);
  assert.match(renderDesignReviewPrompt(huge), /Top 20 highest-risk unit\(s\)/);
});

test("uses the orient-then-roam reading directive (not the old open-ended one)", () => {
  const prompt = renderDesignReviewPrompt(bundleWithRisk(8));
  assert.ok(
    !prompt.includes(
      "Read the project source to understand what it does and how it works",
    ),
    "old open-ended instruction must be removed",
  );
  assert.ok(
    prompt.includes("to orient yourself, then follow the code wherever it leads"),
    "orient-then-roam directive must be present",
  );
  assert.ok(
    prompt.includes("need not read every file"),
    "scoped reading directive must be present",
  );
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

  assert.match(section, /20 critical flows:/);
  assert.ok(section.includes("flow-0"), "first flow must be present");
  assert.ok(section.includes("flow-14"), "15th flow must be present");
  assert.ok(!section.includes("flow-15"), "16th flow must not be present");
  assert.match(section, /\.\.\. and 5 more/);
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

  assert.match(section, /25 surfaces:/);
  assert.ok(section.includes("surface-0"), "first surface must be present");
  assert.ok(section.includes("surface-19"), "20th surface must be present");
  assert.ok(!section.includes("surface-20"), "21st surface must not be present");
  assert.match(section, /\.\.\. and 5 more/);
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

  assert.match(section, /25 structural findings from deterministic analysis:/);
  assert.ok(section.includes("Finding 0"), "first finding must be present");
  assert.ok(section.includes("Finding 19"), "20th finding must be present");
  assert.ok(!section.includes("Finding 20"), "21st finding must not be present");
  assert.match(section, /\.\.\. and 5 more/);
});

test("summarizeFlows — within cap shows all items without suffix", () => {
  const flows = Array.from({ length: 10 }, (_, i) => ({
    name: `flow-${i}`, paths: [], concerns: [],
  }));
  const prompt = renderDesignReviewPrompt({ critical_flows: { flows } });
  assert.match(prompt, /10 critical flows:/);
  assert.ok(!prompt.includes("... and"), "no truncation suffix expected when within cap");
});

test("summarizeSurfaces — within cap shows all items without suffix", () => {
  const surfaces = Array.from({ length: 5 }, (_, i) => ({
    id: `s-${i}`, kind: "http", entrypoint: `/api/${i}`,
  }));
  const prompt = renderDesignReviewPrompt({ surface_manifest: { surfaces } });
  assert.match(prompt, /5 surfaces:/);
  assert.ok(!prompt.includes("... and"), "no truncation suffix expected when within cap");
});

// ── contract assessment ───────────────────────────────────────────────────────

test("includes observational contract assessment guidance separate from conceptual critique", () => {
  const prompt = renderDesignReviewPrompt(bundleWithRisk(8));

  assert.match(prompt, /### Contract assessment/);
  assert.match(prompt, /### Conceptual design critique/);
  assert.match(prompt, /inferred or existing project contracts/);
  assert.match(prompt, /invariants/);
  assert.match(prompt, /trust boundaries/);
  assert.match(prompt, /concrete counterexamples/);
  assert.match(prompt, /critical_invariant_coverage_gap/);
  assert.match(prompt, /do not invent a new contract DSL/);
  assert.match(prompt, /remediate code/);
  assert.match(prompt, /implementation pipeline/);
  assert.match(prompt, /inferred_contract_gap/);
  assert.match(prompt, /trust_boundary_gap/);
  assert.match(prompt, /invariant_counterexample/);
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
  assert.match(prompt1, /no risk scores available/);
  assert.ok(prompt1.includes("u-a"));
  assert.ok(prompt1.includes("u-b"));

  // Neither risk_register nor unit_manifest → orientation fallback string.
  const empty = {};
  const prompt2 = renderDesignReviewPrompt(empty);
  assert.ok(
    prompt2.includes(
      "No risk or unit data available; read the repository root files to orient yourself.",
    ),
  );
});
