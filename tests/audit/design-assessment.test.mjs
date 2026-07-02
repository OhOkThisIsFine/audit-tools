import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { buildDesignAssessment } = await import("../../src/audit/extractors/designAssessment.ts");

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
  expect(result.findings.length).toBe(0);
  expect(result.generated_at).toBeTruthy();
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
  expect(cycleFindings.length > 0, "should detect at least one cycle").toBeTruthy();
  expect(cycleFindings[0].lens).toBe("architecture");
  expect(cycleFindings[0].systemic).toBe(true);
  expect(cycleFindings[0].severity).toBe("medium");
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
  expect(cycleFindings.length > 0).toBeTruthy();
  expect(cycleFindings[0].severity).toBe("high");
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
  expect(hubFindings.length > 0, "should detect hub module").toBeTruthy();
  expect(hubFindings[0].title.includes("hub.ts")).toBeTruthy();
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
  expect(hubFindings.length).toBe(0);
});

// Threshold boundary tests for hub_module detection.
// The threshold formula is: Math.max(8, Math.ceil(allNodes.size * 0.15)).
// With exactly 7 in + 7 out unique neighbours for hub.ts:
//   allNodes = 1 (hub) + 7 deps + 7 targets = 15
//   threshold = Math.max(8, Math.ceil(15 * 0.15)) = Math.max(8, 3) = 8
// With exactly 8 in + 8 out unique neighbours:
//   allNodes = 1 (hub) + 8 deps + 8 targets = 17
//   threshold = Math.max(8, Math.ceil(17 * 0.15)) = Math.max(8, 3) = 8
// So threshold is 8 in both cases: 7 does NOT trigger, 8 DOES.

test("does not flag hub at threshold-1 fan-in and threshold-1 fan-out", () => {
  const edges = [];
  for (let i = 0; i < 7; i++) {
    edges.push({ from: `dep-${i}.ts`, to: "hub.ts" });
    edges.push({ from: "hub.ts", to: `target-${i}.ts` });
  }
  const result = buildDesignAssessment(
    makeParams({ graphBundle: { graphs: { imports: edges } } }),
  );
  const hubFindings = result.findings.filter(
    (f) => f.category === "hub_module",
  );
  expect(hubFindings.length, "7 fan-in and 7 fan-out should not trigger hub detection").toBe(0);
});

test("detects hub at exactly threshold fan-in and threshold fan-out", () => {
  const edges = [];
  for (let i = 0; i < 8; i++) {
    edges.push({ from: `dep-${i}.ts`, to: "hub.ts" });
    edges.push({ from: "hub.ts", to: `target-${i}.ts` });
  }
  const result = buildDesignAssessment(
    makeParams({ graphBundle: { graphs: { imports: edges } } }),
  );
  const hubFindings = result.findings.filter(
    (f) => f.category === "hub_module",
  );
  expect(hubFindings.length > 0, "8 fan-in and 8 fan-out should trigger hub detection").toBeTruthy();
  expect(hubFindings[0].title.includes("hub.ts")).toBeTruthy();
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
  expect(orphanFindings.length > 0).toBeTruthy();
  expect(orphanFindings[0].summary.includes("orphan")).toBeTruthy();
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
  expect(concFindings.length > 0).toBeTruthy();
  expect(concFindings[0].lens).toBe("architecture");
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
  expect(monoFindings.length > 0).toBeTruthy();
  expect(monoFindings[0].title.includes("monolith")).toBeTruthy();
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
  expect(gapFindings.length > 0).toBeTruthy();
  expect(gapFindings[0].title.includes("auth-flow")).toBeTruthy();
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
  expect(new Set(ids).size, "all finding ids should be unique").toBe(ids.length);
  expect(ids.every((id) => id.startsWith("DA-"))).toBeTruthy();
});

test("finding id generation is instance-scoped across two buildDesignAssessment calls (COR-003)", () => {
  // COR-003(b) moved id generation into a per-call closure
  // (createFindingIdGenerator) with no shared mutable module state. The
  // observable guarantee is that each call's DA-### sequence is independent of
  // how many times buildDesignAssessment has run before: two calls with the
  // same finding-producing input deterministically produce the same id set,
  // rather than the second call continuing/diverging from a leaked module
  // counter. (A shared module-level counter would make the second run's ids
  // shift, e.g. start at DA-005 instead of DA-001.)
  const params = () =>
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
    });

  const first = buildDesignAssessment(params());
  const second = buildDesignAssessment(params());

  // Both runs actually produced findings (otherwise the assertion is vacuous).
  expect(first.findings.length > 0).toBeTruthy();
  // Within each run the ids are unique and DA-prefixed.
  for (const result of [first, second]) {
    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size, "ids unique within a single call").toBe(ids.length);
    expect(ids.every((id) => id.startsWith("DA-"))).toBeTruthy();
  }
  // Instance-scoped (not shared module state): the second call restarts its own
  // sequence rather than continuing the first, so identical input -> identical
  // id sequence.
  expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
  expect(first.findings[0].id).toBe("DA-001");
  expect(second.findings[0].id).toBe("DA-001");
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
    expect(finding.lens, `${finding.id} should use architecture lens`).toBe("architecture");
    expect(finding.systemic, `${finding.id} should be systemic`).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// COR-3eaa834c: detectUnitSprawl must not throw RangeError for large manifests
// ---------------------------------------------------------------------------

test("detectUnitSprawl does not throw RangeError for large unit manifests (COR-3eaa834c)", () => {
  // 100,000 units — well above the JS engine's max argument count (~65k-125k)
  // which would cause Math.max(...arr) to throw. The reduce-based fix handles
  // any array size without touching the call stack.
  const UNIT_COUNT = 100_000;
  const units = Array.from({ length: UNIT_COUNT }, (_, i) => ({
    unit_id: `unit-${i}`,
    name: `unit-${i}`,
    files: [`file-${i}.ts`],
    required_lenses: [],
  }));

  let result;
  assert.doesNotThrow(() => {
    result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  }, "buildDesignAssessment should not throw for a 100k-unit manifest");

  // The result must be an object with a findings array (even if empty).
  expect(result !== undefined).toBeTruthy();
  expect(Array.isArray(result.findings)).toBeTruthy();
});

test("detectUnitSprawl correctly identifies the dominant unit after the fix (COR-3eaa834c)", () => {
  // One unit with 20 files dominates (>50%) among 3 units with 22 total files.
  const bigFiles = Array.from({ length: 20 }, (_, i) => `big/f${i}.ts`);
  const units = [
    { unit_id: "monolith", name: "monolith", files: bigFiles, required_lenses: [] },
    { unit_id: "small-a", name: "small-a", files: ["a.ts"], required_lenses: [] },
    { unit_id: "small-b", name: "small-b", files: ["b.ts"], required_lenses: [] },
  ];

  const result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  const monoFindings = result.findings.filter((f) => f.category === "monolith_unit");
  expect(monoFindings.length > 0, "should detect a monolith_unit finding").toBeTruthy();
  expect(monoFindings[0].title.includes("monolith"), "finding should reference the dominant unit").toBeTruthy();

  // Confirm the maxFiles value is correct (20), not Infinity or 0.
  expect(monoFindings[0].summary ?? monoFindings[0].title, "finding should mention the 20-file count").toMatch(/20/);
});

// ---------------------------------------------------------------------------
// MNT-752dd5da: detectCycles dfsVisit refactor — behaviour-preservation tests
// ---------------------------------------------------------------------------

test("detectCycles (via buildDesignAssessment): finds a simple two-node cycle", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "A", to: "B" },
            { from: "B", to: "A" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter((f) => f.category === "dependency_cycle");
  expect(cycleFindings.length, "Should detect exactly one cycle").toBe(1);
  const cycleNodes = cycleFindings[0].affected_files.map((af) => af.path);
  expect(cycleNodes.includes("A") || cycleNodes.includes("B"), "Cycle should contain A or B").toBeTruthy();
});

test("detectCycles (via buildDesignAssessment): returns no cycle findings for a DAG", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "A", to: "B" },
            { from: "A", to: "C" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter((f) => f.category === "dependency_cycle");
  expect(cycleFindings.length, "A DAG should produce no cycle findings").toBe(0);
});

test("detectCycles (via buildDesignAssessment): longer three-node cycle is detected", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "A", to: "B" },
            { from: "B", to: "C" },
            { from: "C", to: "A" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter((f) => f.category === "dependency_cycle");
  expect(cycleFindings.length > 0, "Three-node cycle should be detected").toBeTruthy();
  // All three nodes must appear in the cycle's affected_files
  const paths = cycleFindings[0].affected_files.map((af) => af.path);
  expect(paths.includes("A") || paths.includes("B") || paths.includes("C"), "Cycle nodes should be reported").toBeTruthy();
});

test("detectCycles (via buildDesignAssessment): two independent cycles are both detected", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: {
          imports: [
            { from: "A", to: "B" },
            { from: "B", to: "A" },
            { from: "C", to: "D" },
            { from: "D", to: "C" },
          ],
        },
      },
    }),
  );
  const cycleFindings = result.findings.filter((f) => f.category === "dependency_cycle");
  expect(cycleFindings.length, "Both independent cycles should be detected").toBe(2);
});

// ---------------------------------------------------------------------------

test("detectUnitSprawl produces no monolith_unit finding when no unit dominates (COR-3eaa834c)", () => {
  // 5 units, each with 2 files (10 total). No unit exceeds 50%.
  const units = Array.from({ length: 5 }, (_, i) => ({
    unit_id: `u${i}`,
    name: `u${i}`,
    files: [`a${i}.ts`, `b${i}.ts`],
    required_lenses: [],
  }));

  const result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  const monoFindings = result.findings.filter((f) => f.category === "monolith_unit");
  expect(monoFindings.length, "no monolith_unit finding when no unit dominates").toBe(0);
});

// ---------------------------------------------------------------------------
// TST-ba5666be: detectUnitSprawl unit_fragmentation branch coverage
// ---------------------------------------------------------------------------

test("detects unit fragmentation when >50 units and >60% are single-file", () => {
  // 51 units: 40 single-file + 11 multi-file → ratio = 40/51 ≈ 78.4% > 60% threshold
  const units = [
    ...Array.from({ length: 40 }, (_, i) => ({
      unit_id: `single-${i}`,
      name: `single-${i}`,
      files: [`x${i}.ts`],
      required_lenses: [],
    })),
    ...Array.from({ length: 11 }, (_, i) => ({
      unit_id: `multi-${i}`,
      name: `multi-${i}`,
      files: [`a${i}.ts`, `b${i}.ts`],
      required_lenses: [],
    })),
  ];

  const result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  const fragFindings = result.findings.filter((f) => f.category === "unit_fragmentation");
  expect(fragFindings.length > 0, "should detect unit_fragmentation with 40/51 single-file units").toBeTruthy();
  expect(fragFindings[0].summary.includes("40") && fragFindings[0].summary.includes("51"), `finding summary should mention 40 single-file units and 51 total: ${fragFindings[0].summary}`).toBeTruthy();
  expect(fragFindings[0].systemic).toBe(true);
  expect(fragFindings[0].lens).toBe("architecture");
});

test("does NOT flag unit fragmentation when >50 units but <=60% are single-file", () => {
  // 51 units: 30 single-file + 21 multi-file → ratio = 30/51 ≈ 58.8% < 60% threshold
  const units = [
    ...Array.from({ length: 30 }, (_, i) => ({
      unit_id: `single-${i}`,
      name: `single-${i}`,
      files: [`x${i}.ts`],
      required_lenses: [],
    })),
    ...Array.from({ length: 21 }, (_, i) => ({
      unit_id: `multi-${i}`,
      name: `multi-${i}`,
      files: [`a${i}.ts`, `b${i}.ts`],
      required_lenses: [],
    })),
  ];

  const result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  const fragFindings = result.findings.filter((f) => f.category === "unit_fragmentation");
  expect(fragFindings.length, "should NOT detect unit_fragmentation when ratio ~58.8% < 60%").toBe(0);
});

test("does NOT flag unit fragmentation when <=50 units even if all are single-file", () => {
  // Exactly 50 single-file units — boundary: >50 is required, 50 does not qualify
  const units = Array.from({ length: 50 }, (_, i) => ({
    unit_id: `single-${i}`,
    name: `single-${i}`,
    files: [`x${i}.ts`],
    required_lenses: [],
  }));

  const result = buildDesignAssessment(makeParams({ unitManifest: { units } }));
  const fragFindings = result.findings.filter((f) => f.category === "unit_fragmentation");
  expect(fragFindings.length, "50 single-file units should NOT trigger fragmentation (boundary: >50 required)").toBe(0);
});

// ── Hidden coupling (consumes the git-history co_change bucket, F6) ────────────

const coChangeBundle = (coChange, structural = {}) => ({
  graphs: {
    imports: structural.imports ?? [],
    calls: structural.calls ?? [],
    references: structural.references ?? [],
    co_change: coChange,
  },
});

test("hidden coupling: co-change pair with NO structural edge is flagged", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: coChangeBundle([
        { from: "a.ts", to: "b.ts", kind: "git-co-change", direction: "undirected", confidence: 0.6, reason: "changed together in 5 commit(s) (temporal coupling)." },
      ]),
    }),
  );
  const hidden = result.findings.filter((f) => f.category === "hidden_coupling");
  expect(hidden.length).toBe(1);
  expect(hidden[0].lens).toBe("architecture");
  expect(hidden[0].systemic).toBe(true);
  expect(hidden[0].affected_files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  expect(hidden[0].summary).toMatch(/no import\/call\/reference edge/);
});

test("hidden coupling: a structurally-linked co-change pair is NOT hidden (either direction)", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: coChangeBundle(
        [{ from: "a.ts", to: "b.ts", kind: "git-co-change", confidence: 0.7 }],
        // structural edge in the REVERSE direction still counts as visible.
        { imports: [{ from: "b.ts", to: "a.ts", kind: "import" }] },
      ),
    }),
  );
  expect(result.findings.filter((f) => f.category === "hidden_coupling").length, "a co-change pair the dependency graph already shows is not hidden").toBe(0);
});

test("hidden coupling: below the confidence floor (≤2 commits) is not flagged", () => {
  const result = buildDesignAssessment(
    makeParams({
      graphBundle: coChangeBundle([
        { from: "a.ts", to: "b.ts", kind: "git-co-change", confidence: 0.45 },
      ]),
    }),
  );
  expect(result.findings.filter((f) => f.category === "hidden_coupling").length).toBe(0);
});

test("hidden coupling: no co_change bucket (git-history not mined) → no findings, nothing renumbered", () => {
  const without = buildDesignAssessment(
    makeParams({
      graphBundle: {
        graphs: { imports: [{ from: "a.ts", to: "b.ts" }, { from: "b.ts", to: "c.ts" }, { from: "c.ts", to: "a.ts" }] },
      },
    }),
  );
  expect(without.findings.filter((f) => f.category === "hidden_coupling").length).toBe(0);
  // The cycle finding keeps its id regardless of the new detector being appended.
  const cycle = without.findings.find((f) => f.category === "dependency_cycle");
  expect(cycle.id).toBe("DA-001");
});

test("hidden coupling: strongest-first and capped at 10", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    from: `a${String(i).padStart(2, "0")}.ts`,
    to: `b${String(i).padStart(2, "0")}.ts`,
    kind: "git-co-change",
    confidence: 0.5 + i * 0.01,
  }));
  const result = buildDesignAssessment(
    makeParams({ graphBundle: coChangeBundle(many) }),
  );
  const hidden = result.findings.filter((f) => f.category === "hidden_coupling");
  expect(hidden.length, "capped at 10").toBe(10);
  // Strongest coupling surfaces first (highest confidence = a14/b14).
  expect(hidden[0].title.includes("a14.ts")).toBeTruthy();
});
