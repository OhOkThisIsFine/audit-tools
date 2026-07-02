import { test, expect } from "vitest";

const {
  coverageContentSignature,
  deriveCoverageElementKey,
  recordCoverageElementBaselines,
  readCoverageElementBaselines,
  withCoverageElementBaselines,
  applyContentAddressedPreservation,
} = await import("../../src/audit/orchestrator/coverageElementBaseline.ts");
const { computeArtifactMetadata } = await import(
  "../../src/audit/orchestrator/artifactMetadata.ts"
);
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.ts"
);

function file(path, overrides = {}) {
  return {
    path,
    unit_ids: ["unit-1"],
    classification_status: "classified",
    audit_status: "pending",
    required_lenses: ["security", "correctness"],
    completed_lenses: [],
    ...overrides,
  };
}

test("coverageContentSignature: prefers hash, falls back to size_bytes", () => {
  const sig = coverageContentSignature({
    repository: { name: "x" },
    generated_at: "t",
    files: [
      { path: "a.ts", language: "ts", size_bytes: 100, hash: "deadbeef" },
      { path: "b.ts", language: "ts", size_bytes: 200 },
    ],
  });
  expect(sig["a.ts"], "hash wins when present").toBe("deadbeef");
  expect(sig["b.ts"], "size fallback when no hash").toBe("size:200");
});

test("deriveCoverageElementKey: stable across ordering, moves on any input change", () => {
  const base = file("a.ts");
  const reordered = file("a.ts", {
    required_lenses: ["correctness", "security"],
    unit_ids: ["unit-1"],
  });
  const k1 = deriveCoverageElementKey(base, "sig1");
  expect(deriveCoverageElementKey(reordered, "sig1"), "lens order does not move the key").toBe(k1);

  expect(deriveCoverageElementKey(base, "sig2"), "content signal change moves the key").not.toBe(k1);
  expect(deriveCoverageElementKey(file("a.ts", { required_lenses: ["security"] }), "sig1"), "required-lens set change moves the key").not.toBe(k1);
  expect(deriveCoverageElementKey(file("a.ts", { unit_ids: ["unit-2"] }), "sig1"), "unit membership change moves the key").not.toBe(k1);
});

test("recordCoverageElementBaselines: one key per non-excluded file", () => {
  const coverage = {
    files: [file("a.ts"), file("b.ts", { audit_status: "excluded" })],
  };
  const sig = { "a.ts": "s1", "b.ts": "s2" };
  const store = recordCoverageElementBaselines(coverage, sig);
  expect(store["a.ts"], "non-excluded file gets a baseline").toBeTruthy();
  expect(store["b.ts"], "excluded file is omitted").toBe(undefined);
});

test("applyContentAddressedPreservation: preserves unchanged file's prior completion", () => {
  const sig = { "a.ts": "s1" };
  const prior = {
    files: [file("a.ts", { audit_status: "complete", completed_lenses: ["security", "correctness"] })],
  };
  const baselines = recordCoverageElementBaselines(prior, sig);
  // Fresh re-plan: same inputs → pending, awaiting preservation.
  const fresh = { files: [file("a.ts")] };
  const n = applyContentAddressedPreservation(fresh, prior, baselines, sig);
  expect(n, "one file preserved").toBe(1);
  expect(fresh.files[0].audit_status, "carried prior status").toBe("complete");
  expect([...fresh.files[0].completed_lenses].sort(), "carried prior completed lenses").toEqual(["correctness", "security"]);
});

test("applyContentAddressedPreservation: re-audits when content signal moves", () => {
  const prior = {
    files: [file("a.ts", { audit_status: "complete", completed_lenses: ["security", "correctness"] })],
  };
  const baselines = recordCoverageElementBaselines(prior, { "a.ts": "s1" });
  const fresh = { files: [file("a.ts")] };
  // Content signal changed (file edited) → key moves → not preserved.
  const n = applyContentAddressedPreservation(fresh, prior, baselines, { "a.ts": "s2" });
  expect(n, "changed file is not preserved").toBe(0);
  expect(fresh.files[0].audit_status, "stays pending for re-audit").toBe("pending");
});

test("applyContentAddressedPreservation: no baseline (first run) preserves nothing", () => {
  const fresh = { files: [file("a.ts")] };
  const n = applyContentAddressedPreservation(fresh, { files: [file("a.ts")] }, undefined, { "a.ts": "s1" });
  expect(n, "no baseline → no preservation").toBe(0);
});

test("applyContentAddressedPreservation: skips excluded and already-complete files", () => {
  const sig = { "a.ts": "s1", "b.ts": "s1" };
  const prior = {
    files: [
      file("a.ts", { audit_status: "complete", completed_lenses: ["security"] }),
      file("b.ts", { audit_status: "complete", completed_lenses: ["security"] }),
    ],
  };
  const baselines = recordCoverageElementBaselines(prior, sig);
  const fresh = {
    files: [
      file("a.ts", { audit_status: "excluded" }),
      file("b.ts", { audit_status: "complete", completed_lenses: ["security"] }),
    ],
  };
  const n = applyContentAddressedPreservation(fresh, prior, baselines, sig);
  expect(n, "excluded and already-complete files are skipped").toBe(0);
});

test("withCoverageElementBaselines: merges without clobbering result_baselines + stamps version", () => {
  const merged = withCoverageElementBaselines(
    {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: { "x.json": { revision: 1, content_hash: "h", dependency_revisions: {} } },
      result_baselines: { ik1: "ck1" },
    },
    { "a.ts": "k1" },
  );
  expect(merged.result_baselines, "result baselines untouched").toEqual({ ik1: "ck1" });
  expect(merged.coverage_element_baselines).toEqual({ "a.ts": "k1" });
  expect(merged.metadata_schema_version).toBe(METADATA_SCHEMA_VERSION);

  const seeded = withCoverageElementBaselines(undefined, { "a.ts": "k1" });
  expect(seeded.metadata_schema_version, "fresh manifest is F1-stamped").toBe(METADATA_SCHEMA_VERSION);
  expect(seeded.coverage_element_baselines).toEqual({ "a.ts": "k1" });
});

test("readCoverageElementBaselines: reads the carried store, undefined when absent", () => {
  expect(readCoverageElementBaselines({ metadata_schema_version: 1, artifacts: {}, coverage_element_baselines: { "a.ts": "k" } })).toEqual({ "a.ts": "k" });
  expect(readCoverageElementBaselines(undefined)).toBe(undefined);
  expect(readCoverageElementBaselines({ metadata_schema_version: 1, artifacts: {} })).toBe(undefined);
});

test("computeArtifactMetadata: carries coverage_element_baselines forward from the bundle (F1-current)", () => {
  const bundle = {
    repo_manifest: { repository: { name: "x" }, generated_at: "t", files: [] },
    artifact_metadata: {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {},
      coverage_element_baselines: { "a.ts": "k1" },
    },
  };
  const out = computeArtifactMetadata(bundle, undefined, []);
  expect(out.coverage_element_baselines, "carried forward from bundle").toEqual({ "a.ts": "k1" });
});

test("computeArtifactMetadata: drops an old-shape (pre-F1) coverage baseline store", () => {
  const bundle = {
    repo_manifest: { repository: { name: "x" }, generated_at: "t", files: [] },
    // No metadata_schema_version → old-shape → fail-safe drop.
    artifact_metadata: { artifacts: {}, coverage_element_baselines: { "a.ts": "k1" } },
  };
  const out = computeArtifactMetadata(bundle, undefined, []);
  expect(out.coverage_element_baselines, "old-shape store is not carried").toBe(undefined);
});
