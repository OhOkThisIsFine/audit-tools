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
  const start = prompt.indexOf("### Prioritised reading list");
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

test("no longer contains the open-ended 'Read the project source' instruction", () => {
  const prompt = renderDesignReviewPrompt(bundleWithRisk(8));
  assert.ok(
    !prompt.includes(
      "Read the project source to understand what it does and how it works",
    ),
    "open-ended instruction must be removed",
  );
  assert.ok(
    prompt.includes(
      "highest-risk units listed below; you need not read the entire repository",
    ),
    "bounded directive must be present",
  );
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
