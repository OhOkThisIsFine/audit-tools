import test from "node:test";
import assert from "node:assert/strict";

const { buildDesignAssessment } = await import(
  "../dist/extractors/designAssessment.js"
);

function makeParams(overrides = {}) {
  return {
    unitManifest: { units: [] },
    graphBundle: { graphs: { imports: [], calls: [] } },
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
    ...overrides,
  };
}

test("empty project produces no findings", () => {
  const result = buildDesignAssessment(makeParams());
  assert.equal(result.findings.length, 0);
  assert.ok(result.generated_at);
});

test("detects import cycle", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "a.ts", to: "b.ts" },
            { from: "b.ts", to: "c.ts" },
            { from: "c.ts", to: "a.ts" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter(
    (f) => f.category === "dependency_cycle",
  );
  assert.ok(cycleFindings.length > 0, "should detect at least one cycle");
  assert.equal(cycleFindings[0].lens, "architecture");
  assert.equal(cycleFindings[0].systemic, true);
  assert.equal(cycleFindings[0].severity, "medium");
});

test("large cycle gets high severity", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "a.ts", to: "b.ts" },
            { from: "b.ts", to: "c.ts" },
            { from: "c.ts", to: "d.ts" },
            { from: "d.ts", to: "e.ts" },
            { from: "e.ts", to: "a.ts" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter(
    (f) => f.category === "dependency_cycle",
  );
  assert.ok(cycleFindings.length > 0);
  assert.equal(cycleFindings[0].severity, "high");
});

test("detects hub modules with high fan-in and fan-out", () => {
  const edges = [];
  for (let i = 0; i < 10; i++) {
    edges.push({ from: `dep-${i}.ts`, to: "hub.ts" });
    edges.push({ from: "hub.ts", to: `target-${i}.ts` });
  }

  const result = buildDesignAssessment(
    makeParams({
      graphBundle: { graphs: { imports: edges } },
    }),
  );
  const hubFindings = result.findings.filter(
    (f) => f.category === "hub_module",
  );
  assert.ok(hubFindings.length > 0, "should detect hub module");
  assert.ok(hubFindings[0].title.includes("hub.ts"));
});

test("does not flag hub when fan-in/out below threshold", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "a.ts", to: "b.ts" },
            { from: "c.ts", to: "b.ts" },
            { from: "b.ts", to: "d.ts" },
          ],
        },
      },
    }),
  );
  const hubFindings = result.findings.filter(
    (f) => f.category === "hub_module",
  );
  assert.equal(hubFindings.length, 0);
});

test("detects orphan units", () => {
  const result = buildDesignAssessment(
    makeParams({
      unitManifest: {
        units: [
          { unit_id: "connected", name: "connected", files: ["a.ts"], required_lenses: [] },
          { unit_id: "orphan", name: "orphan", files: ["z.ts"], required_lenses: [] },
        ],
      },
      graphBundle: {
        graphs: {
          imports: [
            { from: "a.ts", to: "b.ts" },
            { from: "b.ts", to: "a.ts" },
          ],
        },
      },
    }),
  );
  const orphanFindings = result.findings.filter(
    (f) => f.category === "orphan_units",
  );
  assert.ok(orphanFindings.length > 0);
  assert.ok(orphanFindings[0].summary.includes("orphan"));
});

test("detects risk concentration", () => {
  const result = buildDesignAssessment(
    makeParams({
      unitManifest: {
        units: [
          { unit_id: "hot", name: "hot", files: ["hot.ts"], required_lenses: [] },
          { unit_id: "a", name: "a", files: ["a.ts"], required_lenses: [] },
          { unit_id: "b", name: "b", files: ["b.ts"], required_lenses: [] },
          { unit_id: "c", name: "c", files: ["c.ts"], required_lenses: [] },
          { unit_id: "d", name: "d", files: ["d.ts"], required_lenses: [] },
        ],
      },
      riskRegister: {
        items: [
          { unit_id: "hot", risk_score: 9, signals: ["critical_flow_member"] },
          { unit_id: "a", risk_score: 1, signals: [] },
          { unit_id: "b", risk_score: 1, signals: [] },
          { unit_id: "c", risk_score: 1, signals: [] },
          { unit_id: "d", risk_score: 1, signals: [] },
        ],
      },
    }),
  );
  const concFindings = result.findings.filter(
    (f) => f.category === "risk_concentration",
  );
  assert.ok(concFindings.length > 0);
  assert.equal(concFindings[0].lens, "architecture");
});

test("detects dominant monolith unit", () => {
  const bigFiles = Array.from({ length: 20 }, (_, i) => `big/f${i}.ts`);
  const result = buildDesignAssessment(
    makeParams({
      unitManifest: {
        units: [
          { unit_id: "monolith", name: "monolith", files: bigFiles, required_lenses: [] },
          { unit_id: "small-a", name: "small-a", files: ["a.ts"], required_lenses: [] },
          { unit_id: "small-b", name: "small-b", files: ["b.ts"], required_lenses: [] },
        ],
      },
    }),
  );
  const monoFindings = result.findings.filter(
    (f) => f.category === "monolith_unit",
  );
  assert.ok(monoFindings.length > 0);
  assert.ok(monoFindings[0].title.includes("monolith"));
});

test("detects critical flow gaps", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [{ from: "connected.ts", to: "other.ts" }],
        },
      },
      criticalFlows: {
        flows: [
          {
            id: "flow-1",
            name: "auth-flow",
            entrypoints: ["entry.ts"],
            paths: ["disconnected-a.ts", "disconnected-b.ts", "disconnected-c.ts"],
            concerns: [],
          },
        ],
      },
    }),
  );
  const gapFindings = result.findings.filter(
    (f) => f.category === "flow_gap",
  );
  assert.ok(gapFindings.length > 0);
  assert.ok(gapFindings[0].title.includes("auth-flow"));
});

test("finding ids are unique and sequentially assigned", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "a.ts", to: "b.ts" },
            { from: "b.ts", to: "a.ts" },
          ],
        },
      },
      unitManifest: {
        units: [
          { unit_id: "orphan", name: "orphan", files: ["z.ts"], required_lenses: [] },
          { unit_id: "connected", name: "connected", files: ["a.ts"], required_lenses: [] },
        ],
      },
    }),
  );
  const ids = result.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "all finding ids should be unique");
  assert.ok(ids.every((id) => id.startsWith("DA-")));
});

test("all findings use architecture lens and systemic flag", () => {
  const edges = [];
  for (let i = 0; i < 10; i++) {
    edges.push({ from: `dep-${i}.ts`, to: "hub.ts" });
    edges.push({ from: "hub.ts", to: `target-${i}.ts` });
  }
  edges.push({ from: "a.ts", to: "b.ts" }, { from: "b.ts", to: "a.ts" });

  const result = buildDesignAssessment(
    makeParams({
      graphBundle: { graphs: { imports: edges } },
      unitManifest: {
        units: [
          { unit_id: "u1", name: "u1", files: ["hub.ts"], required_lenses: [] },
        ],
      },
    }),
  );

  for (const finding of result.findings) {
    assert.equal(finding.lens, "architecture", `${finding.id} should use architecture lens`);
    assert.equal(finding.systemic, true, `${finding.id} should be systemic`);
  }
});
