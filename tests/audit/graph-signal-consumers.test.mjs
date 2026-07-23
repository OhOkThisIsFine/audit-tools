import { test, expect } from "vitest";

const { buildRiskRegister } = await import(
  "../../src/audit/extractors/risk.ts"
);
const { buildDesignAssessment } = await import(
  "../../src/audit/extractors/designAssessment.ts"
);
const { deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.ts"
);

// A graph bundle exercising all three new node-metric/seam signals.
//
// Edges form a simple chain a -> b -> c -> orphan.ts, so every edge is a bridge
// (cut-edge / seam). node_metrics carry high complexity on `a.ts` and
// duplication on `b.ts`. `orphan.ts` is a seam/metric endpoint owned by NO unit.
function makeBundle() {
  return {
    graphs: {
      imports: [
        { from: "a.ts", to: "b.ts" },
        { from: "b.ts", to: "c.ts" },
        { from: "c.ts", to: "orphan.ts" },
      ],
    },
    node_metrics: {
      "a.ts": {
        complexity: { value: 25, measure: "cyclomatic-approx", reach: "js-ts-effective" },
      },
      "b.ts": {
        duplication: { value: 40, measure: "duplicate-line-count", reach: "js-ts-effective" },
      },
      // A metric on a node owned by NO unit — must still surface node-keyed.
      "orphan.ts": {
        complexity: { value: 30, measure: "cyclomatic-approx", reach: "js-ts-effective" },
      },
    },
  };
}

// Units cover a.ts, b.ts, c.ts but NOT orphan.ts.
function makeUnitManifest() {
  return {
    units: [
      { unit_id: "u-a", files: ["a.ts"], required_lenses: [] },
      { unit_id: "u-b", files: ["b.ts"], required_lenses: [] },
      { unit_id: "u-c", files: ["c.ts"], required_lenses: [] },
    ],
  };
}

test("complexity / duplication / seams each reach buildRiskRegister output", () => {
  const bundle = makeBundle();
  const signals = deriveGraphSignals(bundle);
  const register = buildRiskRegister(
    makeUnitManifest(),
    undefined,
    undefined,
    signals,
  );

  const byUnit = new Map(register.items.map((i) => [i.unit_id, i]));

  // complexity → high_complexity on the unit owning a.ts
  expect(byUnit.get("u-a").signals.includes("high_complexity"), "unit owning high-complexity node should carry high_complexity").toBeTruthy();
  // duplication → duplicated_code on the unit owning b.ts
  expect(byUnit.get("u-b").signals.includes("duplicated_code"), "unit owning duplicated node should carry duplicated_code").toBeTruthy();
  // seam → seam_endpoint on a unit owning a seam endpoint
  const anySeamEndpoint = register.items.some((i) =>
    i.signals.includes("seam_endpoint"),
  );
  expect(anySeamEndpoint, "a seam endpoint should be flagged on some unit").toBeTruthy();
});

test("complexity / duplication / seams each reach a design-assessment finding", () => {
  const bundle = makeBundle();
  const register = buildRiskRegister(
    makeUnitManifest(),
    undefined,
    undefined,
    deriveGraphSignals(bundle),
  );
  const assessment = buildDesignAssessment({
    unitManifest: makeUnitManifest(),
    graphBundle: bundle,
    criticalFlows: { flows: [] },
    riskRegister: register,
  });

  const categories = assessment.findings.map((f) => f.category);
  expect(categories.includes("complexity_hotspot"), "should surface a complexity_hotspot finding").toBeTruthy();
  expect(categories.includes("code_duplication"), "should surface a code_duplication finding").toBeTruthy();
  expect(categories.includes("architectural_seam"), "should surface an architectural_seam finding").toBeTruthy();
});

test("a node owned by NO unit still surfaces as a node-keyed finding", () => {
  const bundle = makeBundle();
  const assessment = buildDesignAssessment({
    unitManifest: makeUnitManifest(),
    graphBundle: bundle,
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  });

  // orphan.ts is in NO unit, but has high complexity AND is a seam endpoint.
  const orphanComplexity = assessment.findings.find(
    (f) =>
      f.category === "complexity_hotspot" &&
      f.affected_files.some((af) => af.path === "orphan.ts"),
  );
  expect(orphanComplexity, "complexity finding for the unit-less orphan node must surface").toBeTruthy();

  const orphanSeam = assessment.findings.find(
    (f) =>
      f.category === "architectural_seam" &&
      f.affected_files.some((af) => af.path === "orphan.ts"),
  );
  expect(orphanSeam, "seam finding for the unit-less orphan endpoint must surface").toBeTruthy();
});

test("appended detectors do not renumber existing DA-### ids", () => {
  // A bundle with a cycle (so existing detectors fire) AND new-signal data.
  const cyclicBundle = {
    graphs: {
      imports: [
        { from: "a.ts", to: "b.ts" },
        { from: "b.ts", to: "a.ts" },
      ],
    },
    node_metrics: {
      "a.ts": {
        complexity: { value: 50, measure: "cyclomatic-approx", reach: "js-ts-effective" },
      },
    },
  };
  const unitManifest = {
    units: [{ unit_id: "u-a", files: ["a.ts", "b.ts"], required_lenses: [] }],
  };

  // Baseline: same bundle WITHOUT node_metrics — capture existing detector ids.
  const baselineBundle = { graphs: cyclicBundle.graphs };
  const baseline = buildDesignAssessment({
    unitManifest,
    graphBundle: baselineBundle,
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  });
  const baselineCycle = baseline.findings.find(
    (f) => f.category === "dependency_cycle",
  );
  expect(baselineCycle, "baseline should have a cycle finding").toBeTruthy();

  // With node_metrics added, the cycle finding must keep its original id.
  const withMetrics = buildDesignAssessment({
    unitManifest,
    graphBundle: cyclicBundle,
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  });
  const withMetricsCycle = withMetrics.findings.find(
    (f) => f.category === "dependency_cycle",
  );
  expect(withMetricsCycle.id, "appended detectors must not renumber the existing cycle finding's id").toBe(baselineCycle.id);

  // The new findings must come AFTER the existing ones (higher id ordinals).
  const cycleOrdinal = Number(withMetricsCycle.id.slice(3));
  const complexityFinding = withMetrics.findings.find(
    (f) => f.category === "complexity_hotspot",
  );
  expect(complexityFinding, "complexity finding should exist").toBeTruthy();
  expect(Number(complexityFinding.id.slice(3)) > cycleOrdinal, "appended complexity finding id must be greater than the existing cycle id").toBeTruthy();
});

test("phantom-cycle members (cycle closed only by a references edge) lose member_of_cycle", () => {
  // a.ts -> b.ts is a real import; b.ts -> a.ts is only a prose/path reference.
  // Load-order-only cycle detection must not fabricate a cycle here, so neither
  // unit may carry member_of_cycle (or its risk_score contribution).
  const bundle = {
    graphs: {
      imports: [{ from: "a.ts", to: "b.ts" }],
      references: [{ from: "b.ts", to: "a.ts", kind: "path-reference" }],
    },
  };
  const register = buildRiskRegister(
    {
      units: [
        { unit_id: "u-a", files: ["a.ts"], required_lenses: [] },
        { unit_id: "u-b", files: ["b.ts"], required_lenses: [] },
      ],
    },
    undefined,
    undefined,
    deriveGraphSignals(bundle),
  );
  for (const item of register.items) {
    expect(
      item.signals.includes("member_of_cycle"),
      `${item.unit_id} must not carry member_of_cycle from a references-closed phantom cycle`,
    ).toBe(false);
  }
});

test("genuine imports/calls cycle members still carry member_of_cycle", () => {
  const bundle = {
    graphs: {
      imports: [{ from: "a.ts", to: "b.ts" }],
      calls: [{ from: "b.ts", to: "a.ts" }],
    },
  };
  const register = buildRiskRegister(
    {
      units: [
        { unit_id: "u-a", files: ["a.ts"], required_lenses: [] },
      ],
    },
    undefined,
    undefined,
    deriveGraphSignals(bundle),
  );
  const item = register.items.find((i) => i.unit_id === "u-a");
  expect(
    item.signals.includes("member_of_cycle"),
    "a genuine load-order cycle must still flag member_of_cycle",
  ).toBe(true);
});

test("correlated cycle+hub+seam family cannot alone drive risk_score to 10", () => {
  // Build a graph where one node is simultaneously in a cycle, a hub, AND a seam
  // endpoint — the maximally-correlated structural case — with NO other risk
  // contributors (no base risk_score, no flows, no external, no metrics).
  //
  // Hub threshold is max(8, ceil(connected*0.15)); give `hub.ts` >= 8 in and out
  // edges, put it in a cycle, and attach a pendant via a bridge so it is also a
  // seam endpoint.
  const imports = [];
  for (let i = 0; i < 9; i++) {
    imports.push({ from: `in${i}.ts`, to: "hub.ts" });
    imports.push({ from: "hub.ts", to: `out${i}.ts` });
  }
  // Cycle through hub.ts.
  imports.push({ from: "hub.ts", to: "cyc.ts" });
  imports.push({ from: "cyc.ts", to: "hub.ts" });
  // A pendant reached only through hub.ts → the hub.ts—pendant edge is a bridge.
  imports.push({ from: "hub.ts", to: "pendant.ts" });

  const bundle = { graphs: { imports } };
  const signals = deriveGraphSignals(bundle);

  // Sanity: hub.ts is in all three structural sets.
  expect(signals.hubs.has("hub.ts"), "hub.ts should be a hub").toBeTruthy();
  expect(signals.nodesInCycles.has("hub.ts"), "hub.ts should be in a cycle").toBeTruthy();
  expect(signals.seams.some((s) => s.from === "hub.ts" || s.to === "hub.ts"), "hub.ts should be a seam endpoint").toBeTruthy();

  const register = buildRiskRegister(
    {
      units: [
        // risk_score 0, no lenses, no stateful path tokens → only the structural
        // family contributes.
        { unit_id: "u-hub", files: ["hub.ts"], required_lenses: [] },
      ],
    },
    undefined,
    undefined,
    signals,
  );

  const hubItem = register.items.find((i) => i.unit_id === "u-hub");
  expect(hubItem.signals.includes("member_of_cycle")).toBeTruthy();
  expect(hubItem.signals.includes("is_hub")).toBeTruthy();
  expect(hubItem.signals.includes("seam_endpoint")).toBeTruthy();
  expect(hubItem.risk_score < 10, `correlated structural family alone must not saturate risk_score to 10 (got ${hubItem.risk_score})`).toBeTruthy();
});
