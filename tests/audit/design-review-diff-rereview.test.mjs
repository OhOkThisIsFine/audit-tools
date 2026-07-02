/**
 * B2/B3 parity port — diff-based re-review for audit-code's design-review passes.
 *
 * Covers:
 *   - designReviewProjection: cosmetic/provenance edits project identically; a
 *     real structural change projects differently.
 *   - designReviewSnapshot: isDesignReviewStale / computeDesignReReviewDelta /
 *     renderDesignReReviewSection; capture→load roundtrip + buildDesignReReviewSection.
 *   - state.ts: design_review_*_completed is satisfied when the snapshot is fresh,
 *     stale when a structural input's projection changed, missing without a flag,
 *     and satisfied for the legacy (flag-but-no-snapshot) path.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const {
  projectDesignReviewInputs,
  DESIGN_REVIEW_INPUTS,
} = await import("../../src/audit/orchestrator/designReviewProjection.ts");
const {
  captureDesignReviewSnapshot,
  loadDesignReviewSnapshots,
  isDesignReviewStale,
  computeDesignReReviewDelta,
  renderDesignReReviewSection,
  buildDesignReReviewSection,
} = await import("../../src/audit/orchestrator/designReviewSnapshot.ts");
const { stableStringifyProjection } = await import("audit-tools/shared");

// ── Bundle factory ──────────────────────────────────────────────────────────────

function bundle(overrides = {}) {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100, hash: "aaa" },
        { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
      ],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "U1",
          name: "core",
          files: ["src/a.ts"],
          required_lenses: ["architecture"],
        },
      ],
    },
    graph_bundle: { graphs: { imports: [{ from: "src/a.ts", to: "src/b.ts", confidence: 0.9 }] } },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [{ unit_id: "U1", risk_score: 5, signals: ["x"] }] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
    },
    ...overrides,
  };
}

function snapshotFrom(b, pass = "contract", priorFindings = []) {
  return {
    schema_version: "audit-code/design-review-snapshot/v1alpha1",
    pass,
    reviewed_at: "2026-01-01T00:00:00Z",
    prior_findings: priorFindings,
    reviewed_inputs: projectDesignReviewInputs(b),
  };
}

// ── Projection: provenance/cosmetic invariance ────────────────────────────────

test("projection: provenance + per-file metrics are stripped (cosmetic edit projects identically)", () => {
  const a = bundle();
  const b = bundle({
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2099-12-31T23:59:59Z", // changed stamp
      files: [
        // size_bytes + hash changed (content edit), path/language same
        { path: "src/a.ts", language: "typescript", size_bytes: 9999, hash: "zzz" },
        { path: "src/b.ts", language: "typescript", size_bytes: 1, hash: "qqq" },
      ],
    },
    design_assessment: { generated_at: "2099-12-31T23:59:59Z", findings: [] },
    // graph edge confidence churned (analyzer provenance)
    graph_bundle: { graphs: { imports: [{ from: "src/a.ts", to: "src/b.ts", confidence: 0.1 }] } },
  });
  expect(stableStringifyProjection(projectDesignReviewInputs(a)), "cosmetic/provenance-only edits must project identically").toBe(stableStringifyProjection(projectDesignReviewInputs(b)));
});

test("projection: array ordering is non-load-bearing (reordered files project identically)", () => {
  const a = bundle();
  const reversed = bundle({
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [
        { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
        { path: "src/a.ts", language: "typescript", size_bytes: 100, hash: "aaa" },
      ],
    },
  });
  expect(stableStringifyProjection(projectDesignReviewInputs(a))).toBe(stableStringifyProjection(projectDesignReviewInputs(reversed)));
});

test("projection: a real structural change projects differently", () => {
  const a = bundle();
  const withNewUnit = bundle({
    unit_manifest: {
      units: [
        { unit_id: "U1", name: "core", files: ["src/a.ts"], required_lenses: ["architecture"] },
        { unit_id: "U2", name: "new", files: ["src/b.ts"], required_lenses: ["security"] },
      ],
    },
  });
  expect(stableStringifyProjection(projectDesignReviewInputs(a))).not.toBe(stableStringifyProjection(projectDesignReviewInputs(withNewUnit)));
});

// ── Staleness + delta ─────────────────────────────────────────────────────────

test("isDesignReviewStale: false on cosmetic edit, true on structural change", () => {
  const base = bundle();
  const snap = snapshotFrom(base);

  const cosmetic = bundle({
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2099-01-01T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 12345, hash: "new" },
        { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
      ],
    },
  });
  expect(isDesignReviewStale(snap, cosmetic)).toBe(false);

  const structural = bundle({
    surface_manifest: {
      surfaces: [{ id: "S1", kind: "interface", entrypoint: "src/a.ts" }],
    },
  });
  expect(isDesignReviewStale(snap, structural)).toBe(true);
});

test("computeDesignReReviewDelta: reports only the changed input; allUnchanged otherwise", () => {
  const base = bundle();
  const snap = snapshotFrom(base);

  const sameDelta = computeDesignReReviewDelta(snap, base);
  expect(sameDelta.allUnchanged).toBe(true);
  expect(sameDelta.changedInputs.length).toBe(0);

  const changed = bundle({
    risk_register: { items: [{ unit_id: "U1", risk_score: 99, signals: ["x", "y"] }] },
  });
  const delta = computeDesignReReviewDelta(snap, changed);
  expect(delta.allUnchanged).toBe(false);
  expect(delta.changedInputs.map((c) => c.label), "only risk_register changed").toEqual(["risk_register"]);
  expect(delta.changedInputs[0].lines.length > 0).toBeTruthy();
});

// ── Render ──────────────────────────────────────────────────────────────────────

test("renderDesignReReviewSection: carries prior verdict + diff, instructs diff-scoped re-review", () => {
  const base = bundle();
  const priorFindings = [{ id: "DR-001", title: "old finding", severity: "high" }];
  const snap = snapshotFrom(base, "contract", priorFindings);
  const changed = bundle({
    risk_register: { items: [{ unit_id: "U1", risk_score: 99, signals: ["x"] }] },
  });
  const section = renderDesignReReviewSection(
    snap,
    computeDesignReReviewDelta(snap, changed),
  );
  expect(section).toMatch(/Diff-Based Re-Review/);
  expect(section).toMatch(/prior verdict/i);
  expect(section).toMatch(/DR-001/);
  expect(section).toMatch(/risk_register/);
});

test("renderDesignReReviewSection: allUnchanged → re-affirm-verbatim wording", () => {
  const base = bundle();
  const snap = snapshotFrom(base, "contract", []);
  const section = renderDesignReReviewSection(
    snap,
    computeDesignReReviewDelta(snap, base),
  );
  expect(section).toMatch(/No upstream semantic change/i);
});

// ── state.ts integration ────────────────────────────────────────────────────────

function fullBundle(extra = {}) {
  return {
    provider_confirmation: { confirmed: true },
    file_disposition: { files: [] },
    auto_fixes_applied: { executed_tools: [] },
    syntax_resolution_status: { completed_at: "2026-01-01T00:00:00Z" },
    analyzer_capability: {},
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "full",
      intent_summary: "full-audit",
    },
    ...bundle(),
    ...extra,
  };
}

test("state.ts: completed pass with a fresh snapshot is satisfied", () => {
  const b = fullBundle({
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true },
  });
  b.design_review_snapshots = { contract: snapshotFrom(b, "contract") };
  const obl = deriveAuditState(b).obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  expect(obl.state).toBe("satisfied");
});

test("state.ts: completed pass goes stale when a structural input's projection changes", () => {
  const original = fullBundle({
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true },
  });
  const snap = snapshotFrom(original, "contract");
  // The live bundle gained a new surface since the snapshot was taken.
  const b = fullBundle({
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true },
    surface_manifest: { surfaces: [{ id: "S1", kind: "interface", entrypoint: "src/a.ts" }] },
  });
  b.design_review_snapshots = { contract: snap };
  const obl = deriveAuditState(b).obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  expect(obl.state).toBe("stale");
});

test("state.ts: a cosmetic-only change keeps a completed pass satisfied (no re-stale)", () => {
  const original = fullBundle({
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true },
  });
  const snap = snapshotFrom(original, "contract");
  const b = fullBundle({
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2099-09-09T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 1, hash: "new" },
        { path: "src/b.ts", language: "typescript", size_bytes: 2, hash: "new2" },
      ],
    },
    design_assessment: { generated_at: "2099-09-09T00:00:00Z", findings: [], contract_reviewed: true },
  });
  b.design_review_snapshots = { contract: snap };
  const obl = deriveAuditState(b).obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  expect(obl.state).toBe("satisfied");
});

test("state.ts: legacy flag-but-no-snapshot path stays satisfied (never spuriously re-fires)", () => {
  const b = fullBundle({
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
  });
  // No design_review_snapshots on the bundle.
  const state = deriveAuditState(b);
  for (const id of ["design_review_contract_completed", "design_review_conceptual_completed"]) {
    expect(state.obligations.find((o) => o.id === id).state).toBe("satisfied");
  }
});

// ── Disk roundtrip: capture → load → buildDesignReReviewSection ─────────────────

test("capture → load roundtrip + buildDesignReReviewSection emits the re-review on a real change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-dr-snap-"));
  try {
    const base = bundle();
    await captureDesignReviewSnapshot(
      dir,
      "contract",
      [{ id: "DR-001", title: "prior", severity: "high" }],
      base,
      "2026-01-01T00:00:00Z",
    );

    const loaded = await loadDesignReviewSnapshots(dir);
    expect(loaded.contract, "snapshot should load").toBeTruthy();
    expect(loaded.contract.pass).toBe("contract");
    expect(loaded.contract.prior_findings[0].id).toBe("DR-001");

    // No change → buildDesignReReviewSection still returns a section (re-affirm).
    const sameSection = await buildDesignReReviewSection(dir, base, "contract");
    expect(sameSection).toMatch(/No upstream semantic change/i);

    // Structural change → diff-scoped section naming the changed input.
    const changed = bundle({
      critical_flows: { flows: [{ id: "F1", name: "login", entrypoints: [], paths: ["src/a.ts"], concerns: ["auth"] }] },
    });
    const section = await buildDesignReReviewSection(dir, changed, "contract");
    expect(section).toMatch(/Diff-Based Re-Review/);
    expect(section).toMatch(/critical_flows/);
    expect(section).toMatch(/DR-001/);

    // No snapshot for conceptual → no section (first authoring).
    const none = await buildDesignReReviewSection(dir, base, "conceptual");
    expect(none).toBe(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DESIGN_REVIEW_INPUTS covers exactly the structural artifacts the review reads", () => {
  expect([...DESIGN_REVIEW_INPUTS].sort()).toEqual([
      "critical_flows",
      "design_assessment",
      "graph_bundle",
      "repo_manifest",
      "risk_register",
      "surface_manifest",
      "unit_manifest",
    ]);
});
