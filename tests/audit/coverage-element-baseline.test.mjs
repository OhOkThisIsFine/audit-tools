import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(sig["a.ts"], "deadbeef", "hash wins when present");
  assert.equal(sig["b.ts"], "size:200", "size fallback when no hash");
});

test("deriveCoverageElementKey: stable across ordering, moves on any input change", () => {
  const base = file("a.ts");
  const reordered = file("a.ts", {
    required_lenses: ["correctness", "security"],
    unit_ids: ["unit-1"],
  });
  const k1 = deriveCoverageElementKey(base, "sig1");
  assert.equal(deriveCoverageElementKey(reordered, "sig1"), k1, "lens order does not move the key");

  assert.notEqual(deriveCoverageElementKey(base, "sig2"), k1, "content signal change moves the key");
  assert.notEqual(
    deriveCoverageElementKey(file("a.ts", { required_lenses: ["security"] }), "sig1"),
    k1,
    "required-lens set change moves the key",
  );
  assert.notEqual(
    deriveCoverageElementKey(file("a.ts", { unit_ids: ["unit-2"] }), "sig1"),
    k1,
    "unit membership change moves the key",
  );
});

test("recordCoverageElementBaselines: one key per non-excluded file", () => {
  const coverage = {
    files: [file("a.ts"), file("b.ts", { audit_status: "excluded" })],
  };
  const sig = { "a.ts": "s1", "b.ts": "s2" };
  const store = recordCoverageElementBaselines(coverage, sig);
  assert.ok(store["a.ts"], "non-excluded file gets a baseline");
  assert.equal(store["b.ts"], undefined, "excluded file is omitted");
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
  assert.equal(n, 1, "one file preserved");
  assert.equal(fresh.files[0].audit_status, "complete", "carried prior status");
  assert.deepEqual(
    [...fresh.files[0].completed_lenses].sort(),
    ["correctness", "security"],
    "carried prior completed lenses",
  );
});

test("applyContentAddressedPreservation: re-audits when content signal moves", () => {
  const prior = {
    files: [file("a.ts", { audit_status: "complete", completed_lenses: ["security", "correctness"] })],
  };
  const baselines = recordCoverageElementBaselines(prior, { "a.ts": "s1" });
  const fresh = { files: [file("a.ts")] };
  // Content signal changed (file edited) → key moves → not preserved.
  const n = applyContentAddressedPreservation(fresh, prior, baselines, { "a.ts": "s2" });
  assert.equal(n, 0, "changed file is not preserved");
  assert.equal(fresh.files[0].audit_status, "pending", "stays pending for re-audit");
});

test("applyContentAddressedPreservation: no baseline (first run) preserves nothing", () => {
  const fresh = { files: [file("a.ts")] };
  const n = applyContentAddressedPreservation(fresh, { files: [file("a.ts")] }, undefined, { "a.ts": "s1" });
  assert.equal(n, 0, "no baseline → no preservation");
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
  assert.equal(n, 0, "excluded and already-complete files are skipped");
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
  assert.deepEqual(merged.result_baselines, { ik1: "ck1" }, "result baselines untouched");
  assert.deepEqual(merged.coverage_element_baselines, { "a.ts": "k1" });
  assert.equal(merged.metadata_schema_version, METADATA_SCHEMA_VERSION);

  const seeded = withCoverageElementBaselines(undefined, { "a.ts": "k1" });
  assert.equal(seeded.metadata_schema_version, METADATA_SCHEMA_VERSION, "fresh manifest is F1-stamped");
  assert.deepEqual(seeded.coverage_element_baselines, { "a.ts": "k1" });
});

test("readCoverageElementBaselines: reads the carried store, undefined when absent", () => {
  assert.deepEqual(
    readCoverageElementBaselines({ metadata_schema_version: 1, artifacts: {}, coverage_element_baselines: { "a.ts": "k" } }),
    { "a.ts": "k" },
  );
  assert.equal(readCoverageElementBaselines(undefined), undefined);
  assert.equal(readCoverageElementBaselines({ metadata_schema_version: 1, artifacts: {} }), undefined);
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
  assert.deepEqual(out.coverage_element_baselines, { "a.ts": "k1" }, "carried forward from bundle");
});

test("computeArtifactMetadata: drops an old-shape (pre-F1) coverage baseline store", () => {
  const bundle = {
    repo_manifest: { repository: { name: "x" }, generated_at: "t", files: [] },
    // No metadata_schema_version → old-shape → fail-safe drop.
    artifact_metadata: { artifacts: {}, coverage_element_baselines: { "a.ts": "k1" } },
  };
  const out = computeArtifactMetadata(bundle, undefined, []);
  assert.equal(out.coverage_element_baselines, undefined, "old-shape store is not carried");
});
