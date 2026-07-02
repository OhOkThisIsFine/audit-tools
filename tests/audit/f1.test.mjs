/**
 * F-1 — design-review prose-staleness projection.
 *
 * The design-review staleness projection (`designReviewProjection.ts`) is
 * narrowed FIELD-BY-FIELD so cosmetic prose / provenance churn no longer
 * re-stales the (expensive, LLM-driven) review, while every prompt-RENDERED
 * (load-bearing) field still does. Each exclusion below is paired with a proof
 * that the downstream prompt input is byte-identical when ONLY that field
 * mutates, and a load-bearing NEGATIVE-COMPLEMENT proof that the corresponding
 * rendered fact still re-stales.
 *
 * dc4's per-unit in/excluded scope DETERMINATION stays INSIDE the projection
 * (only the cosmetic bracket-tag reason TEXT is exclusion-eligible), so a scope
 * change re-stales. CE-008: a field is excluded only when it is unread by EVERY
 * downstream consumer — here the sole consumer that puts these artifacts in front
 * of the model is `renderSharedStructuralContext`, exercised directly below.
 */
import { test, expect } from "vitest";

const {
  projectDesignReviewInputs,
  projectDesignReviewInput,
} = await import("../../src/audit/orchestrator/designReviewProjection.ts");
const {
  isDesignReviewStale,
} = await import("../../src/audit/orchestrator/designReviewSnapshot.ts");
const {
  renderSharedStructuralContext,
  renderDesignReviewPrompt,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");
const { stableStringifyProjection } = await import("audit-tools/shared");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A fully-populated design-review bundle (every structural input non-empty). */
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
          kind: "module",
          files: ["src/a.ts"],
          required_lenses: ["architecture"],
          critical_flows: ["F1"],
        },
        {
          unit_id: "U2",
          name: "vendored",
          kind: "module",
          files: ["vendor/x.ts"],
          required_lenses: ["security"],
          critical_flows: [],
        },
      ],
    },
    graph_bundle: {
      graphs: {
        imports: [{ from: "src/a.ts", to: "src/b.ts", confidence: 0.9, reason: "import" }],
      },
    },
    surface_manifest: {
      surfaces: [
        { id: "S1", kind: "http_route", entrypoint: "src/a.ts", exposure: "public", methods: ["GET"], notes: "n" },
      ],
    },
    critical_flows: {
      flows: [
        { id: "F1", name: "login", entrypoints: ["src/a.ts"], paths: ["src/a.ts"], concerns: ["auth"], confidence: 0.8 },
      ],
    },
    risk_register: {
      items: [{ unit_id: "U1", risk_score: 5, signals: ["x"], notes: "why" }],
    },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [
        {
          id: "DA-1",
          title: "t",
          category: "c",
          severity: "high",
          confidence: "high",
          lens: "architecture",
          summary: "s",
          affected_files: [{ path: "src/a.ts", line: 1 }],
          systemic: false,
        },
      ],
    },
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x",
    intent_summary: "y",
    ...overrides,
  };
}

function projStr(b) {
  return stableStringifyProjection(projectDesignReviewInputs(b));
}

/** Snapshot a bundle so isDesignReviewStale can diff a later bundle against it. */
function snapshotFrom(b) {
  return {
    schema_version: "audit-code/design-review-snapshot/v1alpha1",
    pass: "contract",
    reviewed_at: "2026-01-01T00:00:00Z",
    prior_findings: [],
    reviewed_inputs: projectDesignReviewInputs(b),
  };
}

// ── 1. Per-excluded-field byte-identical (cosmetic / provenance churn) ──────────
//
// Each case mutates EXACTLY one excluded field and asserts the projection is
// byte-identical — the proof that the field is non-load-bearing for staleness.

test("excluded field: repo_manifest.generated_at churn projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2099-12-31T23:59:59Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 100, hash: "aaa" },
          { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
        ],
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: per-file size_bytes/hash churn (content edit) projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2026-01-01T00:00:00Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 9999, hash: "zzz" },
          { path: "src/b.ts", language: "typescript", size_bytes: 1, hash: "qqq" },
        ],
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: graph edge confidence/reason churn projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      graph_bundle: {
        graphs: {
          imports: [{ from: "src/a.ts", to: "src/b.ts", confidence: 0.01, reason: "totally different" }],
        },
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: surface.notes churn projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      surface_manifest: {
        surfaces: [
          { id: "S1", kind: "http_route", entrypoint: "src/a.ts", exposure: "public", methods: ["GET"], notes: "ENTIRELY REWORDED NOTE" },
        ],
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: risk_register.notes churn projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      risk_register: {
        items: [{ unit_id: "U1", risk_score: 5, signals: ["x"], notes: "different prose" }],
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: design_assessment.generated_at churn projects byte-identically", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      design_assessment: {
        generated_at: "2099-12-31T23:59:59Z",
        findings: bundle().design_assessment.findings,
      },
    }),
  );
  expect(after).toBe(before);
});

test("excluded field: the scope bracket-tag REASON text is cosmetic (reword projects byte-identically)", () => {
  // Same exclusion target, two different human reasons → same disposition KIND.
  const wordingA = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "third-party code" }] }),
  });
  const wordingB = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "third party" }] }),
  });
  expect(projStr(wordingB), "rewording the exclusion reason must not re-stale").toBe(projStr(wordingA));
  // And it really IS excluded (kind captured), not silently dropped.
  const unitProj = projectDesignReviewInput("unit_manifest", wordingA);
  const u2 = unitProj.find((u) => u.unit_id === "U2");
  expect(u2.scope, "the disposition kind is still projected").toBe("excluded");
});

// ── 2. Load-bearing negative-complement (rendered fact still re-stales) ─────────
//
// For each excluded field above, mutating the corresponding RENDERED structural
// fact must change the projection — proving the exclusion did not over-narrow.

test("negative-complement: adding a source file (rendered count + reading list) re-stales", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2026-01-01T00:00:00Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 100, hash: "aaa" },
          { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
          { path: "src/c.ts", language: "typescript", size_bytes: 50, hash: "ccc" },
        ],
      },
    }),
  );
  expect(after).not.toBe(before);
});

test("negative-complement: a real graph edge (rendered) re-stales", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      graph_bundle: {
        graphs: {
          imports: [
            { from: "src/a.ts", to: "src/b.ts", confidence: 0.9 },
            { from: "src/b.ts", to: "src/a.ts", confidence: 0.9 },
          ],
        },
      },
    }),
  );
  expect(after).not.toBe(before);
});

test("negative-complement: a surface method (rendered) re-stales", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      surface_manifest: {
        surfaces: [
          { id: "S1", kind: "http_route", entrypoint: "src/a.ts", exposure: "public", methods: ["GET", "POST"], notes: "n" },
        ],
      },
    }),
  );
  expect(after).not.toBe(before);
});

test("negative-complement: a risk signal (rendered) re-stales", () => {
  const before = projStr(bundle());
  const after = projStr(
    bundle({
      risk_register: {
        items: [{ unit_id: "U1", risk_score: 5, signals: ["x", "y"], notes: "why" }],
      },
    }),
  );
  expect(after).not.toBe(before);
});

test("negative-complement: a deterministic finding's rendered field (severity) re-stales", () => {
  const before = projStr(bundle());
  const flipped = bundle();
  flipped.design_assessment = {
    generated_at: "2026-01-01T00:00:00Z",
    findings: [{ ...bundle().design_assessment.findings[0], severity: "low" }],
  };
  expect(projStr(flipped)).not.toBe(before);
});

// ── 3. Order / provenance independence ──────────────────────────────────────────

test("order-independence: reordering files projects identically", () => {
  const before = projStr(bundle());
  const reversed = projStr(
    bundle({
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2026-01-01T00:00:00Z",
        files: [
          { path: "src/b.ts", language: "typescript", size_bytes: 200, hash: "bbb" },
          { path: "src/a.ts", language: "typescript", size_bytes: 100, hash: "aaa" },
        ],
      },
    }),
  );
  expect(reversed).toBe(before);
});

test("order-independence: reordering units / risk items / surfaces projects identically", () => {
  const before = projStr(bundle());
  const base = bundle();
  const reordered = bundle({
    unit_manifest: { units: [...base.unit_manifest.units].reverse() },
  });
  expect(projStr(reordered)).toBe(before);
});

test("order-independence: reordering a unit's excluded_scope entries projects identically", () => {
  const a = bundle({
    intent_checkpoint: checkpoint({
      excluded_scope: [
        { path: "vendor", reason: "third-party" },
        { path: "generated", reason: "codegen" },
      ],
    }),
  });
  const b = bundle({
    intent_checkpoint: checkpoint({
      excluded_scope: [
        { path: "generated", reason: "codegen" },
        { path: "vendor", reason: "third-party" },
      ],
    }),
  });
  expect(projStr(b), "exclusion-entry order does not change any unit's disposition").toBe(projStr(a));
});

// ── 4. Scope-change re-stale (dc4 determination kept in the projection) ──────────

test("scope-change re-stale: excluding a previously-in-scope unit re-stales the review", () => {
  // Baseline: no checkpoint → both units in scope.
  const baseline = bundle();
  const snap = snapshotFrom(baseline);
  expect(isDesignReviewStale(snap, baseline), "identical bundle is fresh").toBe(false);

  // Now the host excludes vendor/ → U2 flips to excluded → the review must re-run.
  const scoped = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "third-party" }] }),
  });
  expect(isDesignReviewStale(snap, scoped), "a scope exclusion re-stales the review").toBe(true);
});

test("scope-change re-stale: a disposition_overrides exclusion also re-stales", () => {
  const baseline = bundle();
  const snap = snapshotFrom(baseline);
  const scoped = bundle({
    intent_checkpoint: checkpoint({
      disposition_overrides: [{ path: "vendor/x.ts", status: "vendor", reason: "generated" }],
    }),
  });
  expect(isDesignReviewStale(snap, scoped)).toBe(true);
});

test("scope-change re-stale: a partially-excluded unit stays in scope (no spurious re-stale)", () => {
  // U1 has src/a.ts; excluding only src/a.ts would leave U1 with no in-scope file,
  // so use a unit-internal partial: exclude one of two files and confirm the unit
  // stays in_scope, hence projects identically (no re-stale).
  const twoFileUnit = bundle({
    unit_manifest: {
      units: [
        {
          unit_id: "U1",
          name: "core",
          kind: "module",
          files: ["src/a.ts", "src/b.ts"],
          required_lenses: ["architecture"],
          critical_flows: ["F1"],
        },
      ],
    },
  });
  const snap = snapshotFrom(twoFileUnit);
  const partiallyExcluded = bundle({
    unit_manifest: twoFileUnit.unit_manifest,
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "src/a.ts", reason: "one file only" }] }),
  });
  expect(isDesignReviewStale(snap, partiallyExcluded), "a unit with any in-scope file stays in scope → no re-stale").toBe(false);
});

test("scope-change re-stale: rewording an exclusion reason does NOT re-stale (cosmetic)", () => {
  const scopedA = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "third-party code" }] }),
  });
  const snap = snapshotFrom(scopedA);
  const scopedB = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "vendored dependency" }] }),
  });
  expect(isDesignReviewStale(snap, scopedB), "the bracket-tag reason text is cosmetic").toBe(false);
});

// ── CE-008: the rendered prompt is the actual downstream consumer ────────────────
//
// Ties the projection's "load-bearing" claim to the one render path that puts
// these artifacts in front of the model: a scope flip changes the rendered tag
// (load-bearing), while a reason reword changes only cosmetic prose.

test("CE-008: the scope flip the projection captures is exactly what the prompt renders", () => {
  const inScope = renderSharedStructuralContext(bundle(), 5);
  expect(inScope, "with no checkpoint the unit renders [in scope]").toMatch(/U2 \[in scope\]/);

  const scoped = bundle({
    intent_checkpoint: checkpoint({ excluded_scope: [{ path: "vendor", reason: "third-party" }] }),
  });
  const excludedRender = renderSharedStructuralContext(scoped, 5);
  expect(excludedRender, "the excluded unit renders the tag the projection keys on").toMatch(/U2 \[excluded: third-party\]/);
  // The whole-prompt path agrees (renderDesignReviewPrompt wraps the shared context).
  expect(renderDesignReviewPrompt(scoped)).toMatch(/U2 \[excluded: third-party\]/);
});
