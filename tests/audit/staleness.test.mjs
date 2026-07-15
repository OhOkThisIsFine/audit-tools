import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { computeArtifactMetadata, computeArtifactStateSignature } =
  await import("../../src/audit/orchestrator/artifactMetadata.ts");
const { computeStaleArtifacts } =
  await import("../../src/audit/orchestrator/staleness.ts");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { ARTIFACT_DEPENDENTS_MAP, ARTIFACT_DEPENDS_ON_MAP, invertDependencyMap } = await import("../../src/audit/orchestrator/dependencyMap.ts");
const {
  hashArtifactValue,
  stableStringify,
} = await import("../../src/audit/orchestrator/artifactFreshness.ts");

function makeBaseBundle(overrides = {}) {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-03-23T00:00:00Z",
      files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/api/auth.ts", status: "included" }],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          kind: "interface",
          files: ["src/api/auth.ts"],
          required_lenses: ["correctness", "security"],
          risk_score: 5,
          critical_flows: ["auth-session"],
        },
      ],
    },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: {
      flows: [
        {
          id: "auth-session",
          name: "Authentication Session Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security", "correctness"],
          confidence: "high",
        },
      ],
      fallback_required: false,
    },
    risk_register: { items: [] },
    coverage_matrix: {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness", "security"],
          completed_lenses: [],
        },
      ],
    },
    flow_coverage: {
      flows: [
        {
          flow_id: "auth-session",
          status: "pending",
          required_lenses: ["security", "correctness"],
          completed_lenses: [],
        },
      ],
    },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      {
        task_id: "src-api-auth:security",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "Audit auth under security lens.",
        priority: "high",
      },
    ],
    requeue_tasks: [
      {
        task_id: "requeue:correctness:src/api/auth.ts",
        unit_id: "requeue:src/api/auth.ts",
        pass_id: "requeue:correctness",
        lens: "correctness",
        file_paths: ["src/api/auth.ts"],
        rationale: "Mandatory audit coverage is still missing.",
        priority: "medium",
      },
    ],
    audit_report: "# Audit Report\n",
    ...overrides,
  };
}

test("computeArtifactStateSignature ignores revision churn but tracks content", () => {
  const sigOf = (artifacts) =>
    computeArtifactStateSignature({ artifact_metadata: { artifacts } });
  const base = {
    "repo_manifest.json": { revision: 1, content_hash: "aaa", dependency_revisions: {} },
    "audit-report.md": { revision: 3, content_hash: "bbb", dependency_revisions: {} },
  };
  // Same content hashes -> same signature even when revisions differ. This is
  // what lets the finalization cycle guard catch a ping-pong whose only churn is
  // monotonically incrementing revisions.
  const bumpedRevisions = {
    "repo_manifest.json": { revision: 9, content_hash: "aaa", dependency_revisions: {} },
    "audit-report.md": { revision: 42, content_hash: "bbb", dependency_revisions: {} },
  };
  expect(sigOf(base)).toBe(sigOf(bumpedRevisions));
  // A genuine content change -> different signature (real progress).
  const changedContent = {
    ...base,
    "audit-report.md": { revision: 3, content_hash: "ccc", dependency_revisions: {} },
  };
  expect(sigOf(base)).not.toBe(sigOf(changedContent));
  // Order-independent, and no metadata -> a stable sentinel.
  expect(sigOf(base)).toBe(sigOf({
      "audit-report.md": base["audit-report.md"],
      "repo_manifest.json": base["repo_manifest.json"],
    }));
  expect(computeArtifactStateSignature({})).toBe("no-metadata");
});

test("artifact freshness helpers normalize deterministic metadata hashes", () => {
  expect(stableStringify({ b: [2, { d: 4, c: 3 }], a: 1 })).toBe(stableStringify({ a: 1, b: [2, { c: 3, d: 4 }] }));
  expect(hashArtifactValue("repo_manifest.json", {
      generated_at: "a",
      files: [],
    })).toBe(hashArtifactValue("repo_manifest.json", {
      generated_at: "b",
      files: [],
    }));
  expect(hashArtifactValue("coverage_matrix.json", {
      generated_at: "a",
      files: [],
    })).not.toBe(hashArtifactValue("coverage_matrix.json", {
      generated_at: "b",
      files: [],
    }));
  expect(ARTIFACT_DEPENDS_ON_MAP["coverage_matrix.json"].includes(
      "external_analyzer_results.json",
    )).toBeTruthy();
  // access_memory.json carries run_id as provenance only — it must be stripped
  // from the semantic content hash so it can never churn the artifact revision.
  expect(hashArtifactValue("access_memory.json", {
      version: 1,
      run_id: "run-a",
      total_ordinals: 1,
      paths: [],
    })).toBe(hashArtifactValue("access_memory.json", {
      version: 1,
      run_id: "run-b",
      total_ordinals: 1,
      paths: [],
    }));
});

test("dependency revision changes mark downstream artifacts stale under the new audit-report model", () => {
  const initialBundle = makeBaseBundle();

  const metadata = computeArtifactMetadata(initialBundle);
  const revisedBundle = {
    ...initialBundle,
    repo_manifest: {
      ...initialBundle.repo_manifest,
      files: [
        ...initialBundle.repo_manifest.files,
        { path: "src/lib/session.ts", language: "ts", size_bytes: 80 },
      ],
    },
    artifact_metadata: metadata,
  };

  const stale = computeStaleArtifacts(revisedBundle);
  expect(stale.has("file_disposition.json")).toBeTruthy();
  expect(stale.has("unit_manifest.json")).toBeTruthy();
  expect(stale.has("coverage_matrix.json")).toBeTruthy();
  expect(stale.has("audit-report.md")).toBeTruthy();

  const state = deriveAuditState(revisedBundle);
  expect(state.obligations.find((item) => item.id === "file_disposition")?.state).toBe("stale");
  expect(state.obligations.find((item) => item.id === "structure_artifacts")?.state).toBe("stale");
  expect(state.obligations.find((item) => item.id === "planning_artifacts")?.state).toBe("stale");
  expect(state.obligations.find((item) => item.id === "synthesis_current")?.state).toBe("stale");
});

test("new dependency inputs invalidate previously derived artifacts", () => {
  const initialBundle = makeBaseBundle();

  const metadata = computeArtifactMetadata(initialBundle);
  const revisedBundle = {
    ...initialBundle,
    artifact_metadata: metadata,
    tooling_manifest: {
      generated_at: "2026-04-23T00:00:00Z",
      package_root: "/tool",
      package_version: "0.2.12",
      implementation_hash: "abc123",
      inputs: ["dist", "schemas"],
    },
  };

  const stale = computeStaleArtifacts(revisedBundle);
  expect(stale.has("repo_manifest.json")).toBeTruthy();
  expect(stale.has("file_disposition.json")).toBeTruthy();

  const state = deriveAuditState(revisedBundle);
  expect(state.obligations.find((item) => item.id === "file_disposition")?.state).toBe("stale");
});

test("runtime_validation_current obligation: stale when report exists but tasks incomplete", () => {
  // Case 1: report exists but the task's result is 'pending' -> obligation is 'stale'.
  const bundleWithPendingResult = {
    runtime_validation_tasks: {
      tasks: [{ id: "rv-task-1", type: "test" }],
    },
    runtime_validation_report: {
      results: [{ task_id: "rv-task-1", status: "pending" }],
    },
  };
  const stateStale = deriveAuditState(bundleWithPendingResult);
  expect(stateStale.obligations.find((o) => o.id === "runtime_validation_current")?.state, "obligation should be 'stale' when report exists but result is pending").toBe("stale");

  // Case 2: no report at all -> obligation is 'missing'.
  const bundleNoReport = {
    runtime_validation_tasks: {
      tasks: [{ id: "rv-task-1", type: "test" }],
    },
  };
  const stateMissing = deriveAuditState(bundleNoReport);
  expect(stateMissing.obligations.find((o) => o.id === "runtime_validation_current")?.state, "obligation should be 'missing' when no report exists").toBe("missing");

  // Case 3: report exists and result has a non-pending status -> obligation is 'satisfied'.
  const bundleComplete = {
    runtime_validation_tasks: {
      tasks: [{ id: "rv-task-1", type: "test" }],
    },
    runtime_validation_report: {
      results: [{ task_id: "rv-task-1", status: "passed" }],
    },
  };
  const stateSatisfied = deriveAuditState(bundleComplete);
  expect(stateSatisfied.obligations.find((o) => o.id === "runtime_validation_current")?.state, "obligation should be 'satisfied' when all tasks have non-pending results").toBe("satisfied");
});

test("external analyzer results invalidate planning-derived artifacts", () => {
  for (const artifact of [
    "coverage_matrix.json",
    "audit_tasks.json",
    "requeue_tasks.json",
    "audit-report.md",
  ]) {
    expect(ARTIFACT_DEPENDENTS_MAP["external_analyzer_results.json"].includes(artifact), `${artifact} should depend on external analyzer results`).toBeTruthy();
  }

  const initialBundle = {
    coverage_matrix: { files: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_report: "# stale\n",
  };
  const bundle = {
    ...initialBundle,
    artifact_metadata: computeArtifactMetadata(initialBundle),
    external_analyzer_results: { tool: "semgrep", results: [] },
  };
  const stale = computeStaleArtifacts(bundle);

  expect(stale.has("coverage_matrix.json")).toBeTruthy();
  expect(stale.has("audit_tasks.json")).toBeTruthy();
  expect(stale.has("requeue_tasks.json")).toBeTruthy();
  expect(stale.has("audit-report.md")).toBeTruthy();
});

test("absent dependency with recordedRevision > 0 marks artifact stale", async () => {
  // Build a bundle where both repo_manifest and file_disposition are present so
  // computeArtifactMetadata can record their dependency_revisions with revision > 0.
  const initialBundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-03-23T00:00:00Z",
      files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/api/auth.ts", status: "included" }],
    },
  };

  const metadata = computeArtifactMetadata(initialBundle);

  // Confirm that file_disposition was recorded with a dependency on repo_manifest
  // and that the recorded revision is > 0 (meaning it was computed after repo_manifest
  // was present).
  const fileDispositionEntry = metadata.artifacts["file_disposition.json"];
  expect(fileDispositionEntry, "file_disposition.json must have a metadata entry").toBeTruthy();
  const recordedRevision =
    fileDispositionEntry.dependency_revisions["repo_manifest.json"];
  expect(recordedRevision > 0, `recordedRevision for repo_manifest must be > 0 (got ${recordedRevision})`).toBeTruthy();

  // Now build a revised bundle that keeps artifact_metadata but OMITS repo_manifest,
  // simulating it being removed after having been recorded. file_disposition is still
  // present, so computeStaleArtifacts must mark it stale (the recordedRevision > 0
  // absent-was-present branch on staleness.ts lines 44-48).
  const revisedBundle = {
    file_disposition: initialBundle.file_disposition,
    artifact_metadata: metadata,
    // repo_manifest intentionally omitted
  };
  const stale = computeStaleArtifacts(revisedBundle);
  expect(stale.has("file_disposition.json"), "file_disposition.json must be stale when its dep repo_manifest is absent but recordedRevision > 0").toBeTruthy();

  // Also verify the continue branch: when a dependency appears in dependency_revisions
  // with revision 0 and is absent, the artifact should NOT be stale from this branch.
  // Construct metadata manually where the recorded revision for the absent dep is 0.
  const zeroRevisionMetadata = {
    metadata_schema_version: 1,
    artifacts: {
      "file_disposition.json": {
        revision: 1,
        content_hash: fileDispositionEntry.content_hash,
        dependency_revisions: {
          "repo_manifest.json": 0,
        },
      },
    },
  };
  const bundleWithZeroRevision = {
    file_disposition: initialBundle.file_disposition,
    artifact_metadata: zeroRevisionMetadata,
    // repo_manifest absent, but recordedRevision === 0 → continue branch, NOT stale
  };
  const staleZero = computeStaleArtifacts(bundleWithZeroRevision);
  expect(!staleZero.has("file_disposition.json"), "file_disposition.json must NOT be stale when absent dep has recordedRevision === 0 (continue branch)").toBeTruthy();
});

test("external analyzer results do not falsely mark unrelated upstream artifacts stale", () => {
  // graph_bundle and unit_manifest are NOT downstream of external_analyzer_results
  // in the dependency map — they should not be marked stale when it is added.
  const initialBundle = {
    graph_bundle: { graphs: {} },
    unit_manifest: {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          kind: "interface",
          files: ["src/api/auth.ts"],
          required_lenses: ["correctness"],
          risk_score: 3,
          critical_flows: [],
        },
      ],
    },
    coverage_matrix: { files: [] },
    audit_tasks: [],
    requeue_tasks: [],
    audit_report: "# stale\n",
  };
  const bundle = {
    ...initialBundle,
    artifact_metadata: computeArtifactMetadata(initialBundle),
    external_analyzer_results: { tool: "semgrep", results: [] },
  };
  const stale = computeStaleArtifacts(bundle);

  // Upstream artifacts must NOT be marked stale.
  expect(!stale.has("graph_bundle.json"), "graph_bundle.json should not be stale").toBeTruthy();
  expect(!stale.has("unit_manifest.json"), "unit_manifest.json should not be stale").toBeTruthy();

  // Downstream artifacts must still be stale (positive path).
  expect(stale.has("coverage_matrix.json"), "coverage_matrix.json should be stale").toBeTruthy();
  expect(stale.has("audit_tasks.json"), "audit_tasks.json should be stale").toBeTruthy();
});

// TST-aa3c406e: computeStaleArtifacts must handle an absent artifact_metadata field
// without throwing or returning a non-empty stale set (no metadata → can't determine
// freshness → nothing is stale by comparison).
test("computeStaleArtifacts returns empty set when artifact_metadata is absent", () => {
  const stale = computeStaleArtifacts({});
  expect(stale instanceof Set, "must return a Set").toBeTruthy();
  expect(stale.size, "empty bundle → no artifact_metadata → no stale artifacts").toBe(0);
});

test("computeStaleArtifacts returns empty set when artifact_metadata key is present but undefined", () => {
  const stale = computeStaleArtifacts({ artifact_metadata: undefined });
  expect(stale instanceof Set, "must return a Set").toBeTruthy();
  expect(stale.size, "undefined artifact_metadata → no stale artifacts").toBe(0);
});

// ---------------------------------------------------------------------------
// F1-granular-staleness boundary tests
// ---------------------------------------------------------------------------

const {
  buildTaskContentSignature,
  buildResultContentDiscriminator,
  contentKey,
  idempotencyKey,
} = await import("../../src/shared/contentKey.ts");
const {
  deriveLiveResultKeys,
  recordResultBaseline,
  isMetadataManifestCurrent,
} = await import("../../src/audit/orchestrator/resultBaseline.ts");
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.ts"
);

test("F1 inv: computeArtifactMetadata stamps the current metadata_schema_version", () => {
  const metadata = computeArtifactMetadata(makeBaseBundle());
  expect(metadata.metadata_schema_version).toBe(METADATA_SCHEMA_VERSION);
  expect(METADATA_SCHEMA_VERSION >= 1).toBeTruthy();
});

test("F1 seam-equality: per-element verdict equals the verdict from the contentKey seam directly", () => {
  const coordinate = {
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: buildTaskContentSignature({ goal: "audit auth" }),
  };
  // Derive the keys the same way a caller would, straight from the seam.
  const disc = buildResultContentDiscriminator({ source: "base" });
  const seamIk = idempotencyKey({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    result_content_discriminator: disc,
  });
  const seamCk = contentKey({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    result_content_discriminator: disc,
    task_content_signature: coordinate.task_content_signature,
  });
  const liveKeys = deriveLiveResultKeys(coordinate);
  expect(liveKeys.idempotency_key, "idempotency_key from the seam").toBe(seamIk);
  expect(liveKeys.content_key, "content_key from the seam").toBe(seamCk);
});

test("F1 inv-1 [CP-NODE-2]: per-element identity comes only from contentKey seam (seam-equality + discriminator-in-key)", () => {
  // Seam-equality: deriveLiveResultKeys must reproduce, bit-for-bit, the keys a
  // caller derives straight from src/shared/contentKey.ts — proving there is NO
  // parallel/independent hashing path. {unit_id,task_id,lens,pass_id} + the
  // result_content_discriminator are the SOLE identity inputs.
  const coordinate = {
    unit_id: "uX",
    task_id: "tX",
    lens: "security",
    pass_id: "pX",
    source: "base",
    task_content_signature: buildTaskContentSignature({
      task_id: "tX",
      goal: "confirm seam is the only source of identity",
    }),
  };
  const disc = buildResultContentDiscriminator({ source: "base" });
  const seamIk = idempotencyKey({
    unit_id: coordinate.unit_id,
    lens: coordinate.lens,
    pass_id: coordinate.pass_id,
    result_content_discriminator: disc,
  });
  const seamCk = contentKey({
    unit_id: coordinate.unit_id,
    lens: coordinate.lens,
    pass_id: coordinate.pass_id,
    result_content_discriminator: disc,
    task_content_signature: coordinate.task_content_signature,
  });
  const liveKeys = deriveLiveResultKeys(coordinate);
  expect(liveKeys.idempotency_key, "idempotency_key MUST come from the contentKey seam (no parallel hashing)").toBe(seamIk);
  expect(liveKeys.content_key, "content_key MUST come from the contentKey seam (no parallel hashing)").toBe(seamCk);

  // task_id is stripped from the signature (FC-002): renumbering task_id alone
  // must NOT move the seam keys — identity is the discriminated coordinate, not
  // a task_id-bearing hash.
  const renumbered = deriveLiveResultKeys({
    ...coordinate,
    task_id: "tX-renamed",
    task_content_signature: buildTaskContentSignature({
      task_id: "tX-renamed",
      goal: "confirm seam is the only source of identity",
    }),
  });
  expect(renumbered.content_key, "task_id is stripped by the seam — renumbering must not move the contentKey").toBe(seamCk);

  // Discriminator-in-key: the result_content_discriminator is a key input, so a
  // distinct same-grouping-coordinate result is NEVER collapsed onto the base.
  const redispatch = deriveLiveResultKeys({
    ...coordinate,
    source: "redispatch",
    attempt: 1,
  });
  expect(liveKeys.idempotency_key, "discriminator must be in the idempotencyKey").not.toBe(redispatch.idempotency_key);
  expect(liveKeys.content_key, "discriminator must be in the contentKey").not.toBe(redispatch.content_key);
});

test("F1 discriminator-in-key: two same-grouping-coordinate results with distinct sources produce DISTINCT contentKeys → not collapsed", () => {
  const sig = buildTaskContentSignature({ goal: "audit auth" });
  const base = deriveLiveResultKeys({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: sig,
  });
  const redispatch = deriveLiveResultKeys({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "redispatch",
    attempt: 1,
    task_content_signature: sig,
  });
  // Same {unit_id,lens,pass_id} grouping coordinate, different discriminator.
  expect(base.idempotency_key).not.toBe(redispatch.idempotency_key);
  expect(base.content_key).not.toBe(redispatch.content_key);
});

test("F1 inv-2 [CP-NODE-3]: distinct discriminator yields a distinct contentKey (incl. O3 re-dispatch)", () => {
  const sig = buildTaskContentSignature({ goal: "audit auth", body: "v1" });
  const baseCoord = {
    unit_id: "uX",
    lens: "security",
    pass_id: "p3",
    source: "base",
    task_content_signature: sig,
  };
  const baseKeys = deriveLiveResultKeys(baseCoord);

  // O3 stage-3 re-dispatch: same {unit_id,lens,pass_id} grouping coordinate, distinct
  // discriminator → distinct keys (CE-009).
  const redispatchCoord = {
    unit_id: "uX",
    lens: "security",
    pass_id: "p3",
    source: "redispatch",
    stage: "O3",
    attempt: 3,
    task_content_signature: sig,
  };
  const redispatchKeys = deriveLiveResultKeys(redispatchCoord);
  expect(redispatchKeys.content_key, "O3 re-dispatch must have a distinct contentKey from the base result").not.toBe(baseKeys.content_key);
});

test("F1 metadata-migration fail-safe: old-shape (pre-F1) manifest → ALL present artifacts stale, no throw", () => {
  const initialBundle = makeBaseBundle();
  const metadata = computeArtifactMetadata(initialBundle);
  // Simulate a pre-F1 on-disk manifest: same whole-artifact hashes, but NO
  // metadata_schema_version (and strip per-element data). The whole-artifact
  // hashes still MATCH the current artifacts → a naive reader would skip all.
  const preF1Manifest = {
    artifacts: Object.fromEntries(
      Object.entries(metadata.artifacts).map(([name, entry]) => [
        name,
        {
          revision: entry.revision,
          content_hash: entry.content_hash,
          dependency_revisions: entry.dependency_revisions,
        },
      ]),
    ),
  };
  delete preF1Manifest.metadata_schema_version;
  expect(isMetadataManifestCurrent(preF1Manifest)).toBe(false);

  const bundle = { ...initialBundle, artifact_metadata: preF1Manifest };
  let stale;
  assert.doesNotThrow(() => {
    stale = computeStaleArtifacts(bundle);
  }, "old-shape manifest must degrade, never throw");
  // Every present DAG artifact is stale (no false-skip off matching hashes).
  for (const name of ["repo_manifest.json", "file_disposition.json", "unit_manifest.json", "audit-report.md"]) {
    expect(stale.has(name), `${name} must be all-stale under migration fail-safe`).toBeTruthy();
  }
});

test("F1 metadata-migration fail-safe: strict-decode-mismatch manifest → all-stale, no throw", () => {
  const initialBundle = makeBaseBundle();
  // A manifest that would not decode to the F1 shape (garbage entries) but is
  // present. Absent metadata_schema_version → treated as old-shape → all-stale.
  const garbageManifest = { artifacts: { "repo_manifest.json": "not-an-entry" } };
  const bundle = { ...initialBundle, artifact_metadata: garbageManifest };
  let stale;
  assert.doesNotThrow(() => {
    stale = computeStaleArtifacts(bundle);
  });
  expect(stale.has("repo_manifest.json")).toBeTruthy();
  expect(stale.size > 0, "must degrade to a non-empty stale set").toBeTruthy();
});

test("F1 reproducible DAG: persist/reload cycle yields identical stale set + per-element verdicts", () => {
  const initialBundle = makeBaseBundle();
  const metadata = computeArtifactMetadata(initialBundle);
  // Round-trip the manifest through JSON (persist/reload).
  const reloaded = JSON.parse(JSON.stringify(metadata));
  expect(reloaded.metadata_schema_version).toBe(METADATA_SCHEMA_VERSION);

  const stale1 = computeStaleArtifacts({ ...initialBundle, artifact_metadata: metadata });
  const stale2 = computeStaleArtifacts({ ...initialBundle, artifact_metadata: reloaded });
  expect([...stale1].sort()).toEqual([...stale2].sort());
});

test("F1 single-adjacency: ARTIFACT_DEPENDENTS_MAP is the derived inversion of the one canonical table", () => {
  // Rebuild the inversion independently and assert equality (no second hand-authored list).
  const rebuilt = {};
  for (const [artifact, ups] of Object.entries(ARTIFACT_DEPENDS_ON_MAP)) {
    if (!ups) continue;
    for (const up of ups) {
      (rebuilt[up] ??= []).push(artifact);
    }
  }
  const norm = (m) =>
    Object.fromEntries(
      Object.entries(m)
        .map(([k, v]) => [k, [...v].sort()])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  expect(norm(ARTIFACT_DEPENDENTS_MAP)).toEqual(norm(rebuilt));
});

test("F1 inv-5 [CP-NODE-6]: dependents map is the derived inversion of the single adjacency table", () => {
  // ARTIFACT_DEPENDS_ON_MAP is the ONLY hand-authored adjacency; the dependents
  // map MUST be exactly invertDependencyMap(ARTIFACT_DEPENDS_ON_MAP), not a
  // second hand-maintained list. Assert against the exported derivation itself
  // so any drift (or a re-introduced hand-authored dependents table) fails.
  const norm = (m) =>
    Object.fromEntries(
      Object.entries(m)
        .map(([k, v]) => [k, [...v].sort()])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  expect(norm(ARTIFACT_DEPENDENTS_MAP)).toEqual(norm(invertDependencyMap(ARTIFACT_DEPENDS_ON_MAP)));
});

// F1 inv-7: transcription-not-authorship. The git_history.json upstream edge
// set F1 registers MUST be EXACTLY F6's declared {repo_manifest, file_disposition}
// — F1 neither guesses nor infers. Pinning the set so any divergence fails.
test("inv-7: git_history.json upstream set is exactly F6's declared {repo_manifest, file_disposition}", () => {
  expect([...ARTIFACT_DEPENDS_ON_MAP["git_history.json"]].sort()).toEqual(["file_disposition.json", "repo_manifest.json"]);
});

// F1 inv-4 [CP-NODE-5]: old-shape manifest => all-stale, no throw (CE-007).
// Covers the explicit-older-version variant of the migration fail-safe: a
// manifest tagged with metadata_schema_version BELOW the current one (not merely
// absent) is still pre-F1, so its still-matching whole-artifact hashes must
// NEVER false-skip a present element, and computeStaleArtifacts must never throw.
test("F1 inv-4 [CP-NODE-5]: old-shape manifest => all-stale, no throw", () => {
  const initialBundle = makeBaseBundle();
  const metadata = computeArtifactMetadata(initialBundle);
  expect(METADATA_SCHEMA_VERSION >= 1).toBeTruthy();

  // Pre-F1 manifest: an EXPLICIT older schema version (current - 1, floored at 0)
  // with whole-artifact hashes that still MATCH the live artifacts. A naive
  // hash-only reader would skip every element off these matching hashes.
  const olderShapeManifest = {
    metadata_schema_version: Math.max(0, METADATA_SCHEMA_VERSION - 1),
    artifacts: Object.fromEntries(
      Object.entries(metadata.artifacts).map(([name, entry]) => [
        name,
        {
          revision: entry.revision,
          content_hash: entry.content_hash,
          dependency_revisions: entry.dependency_revisions,
        },
      ]),
    ),
  };
  // Not recognized as F1-current → fail-safe path engages.
  expect(isMetadataManifestCurrent(olderShapeManifest)).toBe(false);

  const bundle = { ...initialBundle, artifact_metadata: olderShapeManifest };
  let stale;
  assert.doesNotThrow(() => {
    stale = computeStaleArtifacts(bundle);
  }, "older-shape manifest must degrade to all-stale, never throw (CE-007)");

  // Never a false-skip off matching whole-artifact hashes: EVERY present DAG
  // artifact is stale (artifact_metadata.json itself is excluded by the gate).
  for (const name of [
    "repo_manifest.json",
    "file_disposition.json",
    "unit_manifest.json",
    "audit-report.md",
  ]) {
    expect(stale.has(name), `${name} must be all-stale under inv-4 fail-safe`).toBeTruthy();
  }
  expect(stale.size > 0, "fail-safe must yield a non-empty stale set").toBeTruthy();
  expect(stale.has("artifact_metadata.json"), "the manifest artifact itself is never marked stale by the gate").toBe(false);
});

// F1 inv-6 [CP-NODE-7]: dep-map.md literal parity incl. git_history.json upstream
// edges. The declarative reference (spec/audit/dependency-map.md) and the
// canonical TS table (ARTIFACT_DEPENDS_ON_MAP) must agree LITERALLY over the
// transcribed edge set — neither may carry an edge the other omits. The .md is
// authored in the dependents view (`### <upstream>` → `Downstream:` bullet
// list); the TS table is the inverse depends-on view. We parse the .md into a
// dependents map and compare both directions for git_history.json's upstream
// edges {repo_manifest, file_disposition}: (a) git_history.json's upstream set
// in the TS table matches the .md, and (b) every .md upstream that lists
// git_history.json downstream is exactly that TS upstream set. Any divergence
// (a dropped or extra edge on either side) fails.
test("F1 inv-6 [CP-NODE-7]: dep-map.md literal parity incl. git_history.json upstream edges", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "../../spec/audit/dependency-map.md");
  const md = readFileSync(mdPath, "utf8");

  // Parse the declarative map: each `| \`<artifact>\` | \`dep\`, \`dep\`, ... |`
  // table row (under the "Depends on" tables) names the artifact's upstream
  // dependencies directly — the same direction as ARTIFACT_DEPENDS_ON_MAP, so
  // no inversion is needed. Build { artifact -> Set(dependsOn) }.
  const mdDependsOn = {};
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/;
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    const row = line.match(rowPattern);
    if (!row) continue;
    const [, artifact, depsCell] = row;
    // Only artifact edges (`*.json`) are upstream dependencies. The same
    // `| \`artifact\` | \`x\` | … |` row shape is ALSO used by the producer table
    // (`| \`git_history.json\` | \`structure_executor\` | — |`), whose middle
    // column is an executor, not a dependency — filtering to `.json` keeps that
    // (and any other non-artifact cell) out of the depends-on set for every
    // dual-listed artifact, not just git_history.
    const deps = [...depsCell.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((d) => d.endsWith(".json"));
    if (deps.length > 0) {
      const set = (mdDependsOn[artifact] ??= new Set());
      for (const dep of deps) set.add(dep);
    }
  }

  // git_history.json's own "Depends on" row already names its upstreams
  // directly — no inversion needed with this table's direction.
  const mdGitHistoryUpstreams = [
    ...(mdDependsOn["git_history.json"] ?? []),
  ].sort();

  const tsGitHistoryUpstreams = [
    ...ARTIFACT_DEPENDS_ON_MAP["git_history.json"],
  ].sort();

  // (a) The TS table records git_history.json's declared upstream set.
  expect(tsGitHistoryUpstreams, "ARTIFACT_DEPENDS_ON_MAP git_history.json upstreams must be exactly {file_disposition, repo_manifest}").toEqual(["file_disposition.json", "repo_manifest.json"]);

  // (b) Literal parity, .md ⟺ TS, over the git_history.json edge set: every TS
  // upstream is reflected in the .md and vice versa (no dropped/extra edge).
  expect(mdGitHistoryUpstreams, "dependency-map.md and ARTIFACT_DEPENDS_ON_MAP must agree literally on git_history.json's upstream edges").toEqual(tsGitHistoryUpstreams);

  // And the .md's git_history.json row actually carries BOTH upstreams (guards
  // a regression that drops one edge while leaving the other).
  for (const upstream of tsGitHistoryUpstreams) {
    expect(mdDependsOn["git_history.json"]?.has(upstream), `dependency-map.md must list ${upstream} as a git_history.json dependency`).toBeTruthy();
  }
});

test("F1 inv-8 [CP-NODE-9 r2]: persist/reload recomputes identical stale set (provenance-stripped)", async () => {
  // F1 inv-8 reproducible-DAG guard, distinct angle from the existing
  // "persist/reload cycle yields identical stale set" test: that one round-trips
  // the SAME manifest through JSON. This one proves the *recompute* path is
  // reproducible across two independent runs whose only difference is PROVENANCE
  // (wall-clock `generated_at` stamps, a run-id-bearing field). The persisted
  // content keys/verdicts must recompute an identical stale set on the later
  // run, with no wall-clock / run-id leakage — guaranteed because
  // normalizeForMetadataHash strips provenance before hashing.
  const { normalizeForMetadataHash } = await import(
    "../../src/audit/orchestrator/artifactFreshness.ts"
  );

  // Run 1: build manifest at an early wall-clock, then PERSIST + RELOAD it.
  const run1Bundle = makeBaseBundle();
  run1Bundle.repo_manifest.generated_at = "2026-01-01T00:00:00Z";
  const manifest1 = computeArtifactMetadata(run1Bundle);
  const persisted = JSON.stringify(manifest1);
  const reloaded = JSON.parse(persisted);
  expect(reloaded.metadata_schema_version).toBe(METADATA_SCHEMA_VERSION);

  // Run 2: a LATER run with identical content but a different wall-clock stamp
  // (provenance only). recompute metadata against the reloaded baseline.
  const run2Bundle = makeBaseBundle();
  run2Bundle.repo_manifest.generated_at = "2026-12-31T23:59:59Z";
  const manifest2 = computeArtifactMetadata(run2Bundle, reloaded);

  // (a) normalizeForMetadataHash strips the provenance stamp → the two bundles'
  // normalized repo_manifest forms are byte-identical despite differing stamps.
  const norm1 = stableStringify(
    normalizeForMetadataHash("repo_manifest.json", run1Bundle.repo_manifest),
  );
  const norm2 = stableStringify(
    normalizeForMetadataHash("repo_manifest.json", run2Bundle.repo_manifest),
  );
  expect(norm1, "normalizeForMetadataHash must strip generated_at so provenance does not leak into the hash").toBe(norm2);
  expect(!norm2.includes("2026-12-31"), "stripped normalized form must not carry the wall-clock provenance stamp").toBeTruthy();

  // (b) No revision churn: the provenance-only delta must NOT bump repo_manifest's
  // revision, so the recomputed content hash is identical across runs.
  expect(manifest2.artifacts["repo_manifest.json"].content_hash, "content hash must be reproducible across runs (no wall-clock leakage)").toBe(reloaded.artifacts["repo_manifest.json"].content_hash);
  expect(manifest2.artifacts["repo_manifest.json"].revision, "a provenance-only change must not churn the revision").toBe(reloaded.artifacts["repo_manifest.json"].revision);

  // (c) The recomputed stale set is IDENTICAL to the persisted/reloaded run's —
  // the DAG is reproducible across runs.
  const stalePersisted = computeStaleArtifacts({
    ...run1Bundle,
    artifact_metadata: reloaded,
  });
  const staleRecomputed = computeStaleArtifacts({
    ...run2Bundle,
    artifact_metadata: manifest2,
  });
  expect([...staleRecomputed].sort(), "persisted + recomputed runs must yield an identical stale set").toEqual([...stalePersisted].sort());

  // (d) The overall state signature (content-hash basis) is identical across the
  // two runs — a final reproducibility anchor with no run-id/wall-clock leakage.
  expect(computeArtifactStateSignature({ ...run2Bundle, artifact_metadata: manifest2 }), "artifact state signature must be reproducible across runs").toBe(computeArtifactStateSignature({ ...run1Bundle, artifact_metadata: reloaded }));
});

test("F1 fail-8 [CP-NODE-19 r2]: provenance (wall-clock/run-id) never leaks into per-element hash", async () => {
  // F1 fail-8 per-element-hash boundary: distinct from the inv-8 recompute test
  // above (which proves the *manifest-level* recompute is reproducible). This
  // one drills into the single primitive — hashArtifactValue, the per-element
  // content hash — and proves directly that provenance (a wall-clock stamp and a
  // run-id-bearing field) can NEVER change the digest of an artifact element.
  // If it could, every rebuild would churn the element's revision and
  // perpetually re-stale its downstreams. The guarantee comes from
  // normalizeForMetadataHash stripping provenance before stableStringify.
  const { normalizeForMetadataHash } = await import(
    "../../src/audit/orchestrator/artifactFreshness.ts"
  );

  // Two artifact element values, byte-identical in CONTENT but differing only in
  // provenance: a wall-clock `generated_at` stamp (early vs. late) plus a
  // run-id-bearing variant of that same stamp.
  const semanticContent = {
    repository: { name: "fixture" },
    files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 100 }],
  };
  const earlyRun = {
    generated_at: "2026-01-01T00:00:00.000Z",
    ...semanticContent,
  };
  const lateRun = {
    generated_at: "2026-12-31T23:59:59.999Z",
    ...semanticContent,
  };

  // (a) The per-element content hash is identical across the two runs despite the
  // differing wall-clock provenance — no leakage into the digest.
  const hashEarly = hashArtifactValue("repo_manifest.json", earlyRun);
  const hashLate = hashArtifactValue("repo_manifest.json", lateRun);
  expect(hashEarly, "per-element content hash must not change when only the wall-clock provenance stamp differs").toBe(hashLate);

  // (b) The normalized + serialized form carries NO trace of either wall-clock
  // stamp — the stripped bytes never reach stableStringify, so they cannot
  // possibly reach the digest.
  const serializedEarly = stableStringify(
    normalizeForMetadataHash("repo_manifest.json", earlyRun),
  );
  const serializedLate = stableStringify(
    normalizeForMetadataHash("repo_manifest.json", lateRun),
  );
  expect(serializedEarly, "stripped normalized forms must be byte-identical across provenance-only deltas").toBe(serializedLate);
  expect(!serializedEarly.includes("2026-01-01") &&
      !serializedEarly.includes("2026-12-31"), "stripped normalized form must not carry any wall-clock provenance stamp").toBeTruthy();

  // (c) Negative control: a real CONTENT change (not provenance) DOES move the
  // per-element hash — proving the stripping is surgical, not a blanket no-op.
  const contentChanged = hashArtifactValue("repo_manifest.json", {
    generated_at: "2026-01-01T00:00:00.000Z",
    repository: { name: "fixture" },
    files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 101 }],
  });
  expect(hashEarly, "a genuine content change must still move the per-element hash").not.toBe(contentChanged);

  // (d) Provenance-stripping holds even for an artifact whose stamp is the ONLY
  // top-level non-content field, simulating a run-id-bearing element: the same
  // semantic body under two distinct stamps hashes equal.
  const runIdEarly = hashArtifactValue("synthesis-narrative.json", {
    generated_at: "run-2026-01-01T00:00:00Z",
    theme_count: 3,
    finding_count: 7,
  });
  const runIdLate = hashArtifactValue("synthesis-narrative.json", {
    generated_at: "run-2026-12-31T23:59:59Z",
    theme_count: 3,
    finding_count: 7,
  });
  expect(runIdEarly, "run-id-bearing provenance stamp must not leak into a narrative element's per-element hash").toBe(runIdLate);
});

test("F1 inv-9 [CP-NODE-10 r2]: git_history.json co-registered in dependencyMap.ts AND dependency-map.md", async () => {
  // F1 inv-9 atomic co-commit guard (CCU-git-history-registration, CE-001): F1's
  // dep-map-registration half and F6's git_history.json writer+declaration half
  // are ONE scheduler-enforced co-commit unit — neither may land independently.
  // Distinct angle from inv-7 (the exact upstream SET) and inv-6 (literal .md⟺TS
  // parity of that set): this pins the BOTH-SIDES PRESENCE of the registration
  // itself. If a future change registers git_history.json in only one of the two
  // sources (TS table OR the .md declarative reference), the atomicity is broken
  // and this fails — the two halves cannot drift apart.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // (a) Side 1 — the canonical TS adjacency table keys git_history.json.
  expect(Object.prototype.hasOwnProperty.call(
      ARTIFACT_DEPENDS_ON_MAP,
      "git_history.json",
    ), "git_history.json MUST be registered as a key in ARTIFACT_DEPENDS_ON_MAP (dependencyMap.ts)").toBeTruthy();
  expect(Array.isArray(ARTIFACT_DEPENDS_ON_MAP["git_history.json"]) &&
      ARTIFACT_DEPENDS_ON_MAP["git_history.json"].length > 0, "git_history.json's TS registration must carry its upstream edge set, not an empty stub").toBeTruthy();

  // (b) Side 2 — the declarative reference (.md) carries git_history.json as a
  // backticked artifact token. Parse for the literal `git_history.json` bullet so
  // a prose mention alone does not satisfy the guard.
  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "../../spec/audit/dependency-map.md");
  const md = readFileSync(mdPath, "utf8");
  const mdHasGitHistory = md
    .split(/\r?\n/)
    .some((line) => /`git_history\.json`/.test(line));
  expect(mdHasGitHistory, "git_history.json MUST be registered in spec/audit/dependency-map.md (co-commit with the TS table)").toBeTruthy();

  // (c) Atomicity: BOTH sides present together — the co-commit unit landed whole.
  expect(Object.prototype.hasOwnProperty.call(
      ARTIFACT_DEPENDS_ON_MAP,
      "git_history.json",
    ) && mdHasGitHistory, "F1+F6 co-commit unit requires git_history.json in BOTH dependencyMap.ts and dependency-map.md — neither half may land alone").toBeTruthy();
});

test("F1 fail-7 [CP-NODE-18 r2]: git_history.json never half-registered (present in dependencyMap.ts iff present in dependency-map.md)", async () => {
  // F1 fail-7 (CCU-git-history-registration): landing F1's dep-map registration
  // without F6's producer (or vice versa) in a separate commit yields a
  // half-registered DAG node. The single scheduler-enforced co-commit unit
  // prevents either half from landing alone. Distinct angle from inv-9 (which
  // asserts BOTH sides are PRESENT): this pins the BICONDITIONAL — presence in
  // the TS adjacency table must equal presence in the declarative .md. It fires
  // in EITHER drift direction (TS-only OR md-only), catching the "vice versa"
  // half-registration that a both-present assertion cannot distinguish from a
  // clean removal.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const presentInTs = Object.prototype.hasOwnProperty.call(
    ARTIFACT_DEPENDS_ON_MAP,
    "git_history.json",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "../../spec/audit/dependency-map.md");
  const md = readFileSync(mdPath, "utf8");
  const presentInMd = md
    .split(/\r?\n/)
    .some((line) => /`git_history\.json`/.test(line));

  expect(presentInTs, `git_history.json must be co-registered: present in dependencyMap.ts (${presentInTs}) iff present in dependency-map.md (${presentInMd}) — a mismatch is a half-registered DAG node from a non-atomic commit`).toBe(presentInMd);
});

test("F1 fail-9 [CP-NODE-20 r2]: per-element verdicts are order-canonicalized => key-order-independent stable hash", async () => {
  // F1 fail-9 (order-canonicalized persisted verdicts): persisting per-element
  // verdict objects whose keys land in producer-dependent insertion order yields
  // byte-varying-but-semantically-equal metadata, which then hashes to differing
  // digests and falsely flags downstream artifacts stale. stableStringify-based
  // canonicalization (the basis of hashArtifactValue) must collapse key-order
  // differences so two verdict lists that differ ONLY in element key order — and
  // in the order of nested keys — produce an identical serialization and hash.
  const verdictsForward = [
    {
      element_id: "src-api-auth",
      lens: "correctness",
      grounded: true,
      evidence: { file: "src/api/auth.ts", line: 42 },
    },
    {
      element_id: "src-api-session",
      lens: "security",
      grounded: false,
      evidence: { line: 7, file: "src/api/session.ts" },
    },
  ];
  // Same data, every object built with a different key insertion order
  // (including the nested `evidence` object), simulating a different producer run.
  const verdictsShuffled = [
    {
      evidence: { line: 42, file: "src/api/auth.ts" },
      grounded: true,
      lens: "correctness",
      element_id: "src-api-auth",
    },
    {
      grounded: false,
      evidence: { file: "src/api/session.ts", line: 7 },
      element_id: "src-api-session",
      lens: "security",
    },
  ];

  // Raw JSON serialization differs byte-for-byte (the failure mode)...
  expect(JSON.stringify(verdictsForward), "precondition: the two verdict lists must differ in raw key order, else the test proves nothing").not.toBe(JSON.stringify(verdictsShuffled));

  // ...but canonicalization collapses them to an identical serialization...
  expect(stableStringify(verdictsForward), "stableStringify must order-canonicalize per-element verdicts (and nested keys) so insertion order does not leak").toBe(stableStringify(verdictsShuffled));

  // ...and therefore to an identical artifact hash (no spurious staleness).
  expect(hashArtifactValue("audit_results.jsonl", verdictsForward), "key-order-only differences in persisted verdicts must not change the artifact hash").toBe(hashArtifactValue("audit_results.jsonl", verdictsShuffled));
});

// F1 fail-2 [CP-NODE-13]: a per-element verdict must NEVER be keyed on the bare
// grouping coordinate {unit_id,lens,pass_id} — the result_content_discriminator
// (source/attempt/stage) is part of the identity, so two results sharing one
// grouping coordinate but differing only in their discriminator produce DISTINCT
// keys and never collapse to one verdict.
test("F1 fail-2 [CP-NODE-13]: per-element verdict never keyed on the bare grouping coordinate (distinct result_content_discriminator never collapses)", () => {
  const sig = buildTaskContentSignature({ goal: "audit auth", body: "v1" });
  const grouping = { unit_id: "uG", lens: "security", pass_id: "p1", task_content_signature: sig };

  // Two results, identical grouping coordinate, DISTINCT discriminator.
  const base = deriveLiveResultKeys({ ...grouping, source: "base" });
  const redispatch = deriveLiveResultKeys({ ...grouping, source: "redispatch", attempt: 2, stage: "O3" });

  // Distinct keys: the discriminator is part of identity, not the bare coordinate.
  expect(base.content_key, "discriminator distinguishes the contentKey").not.toBe(redispatch.content_key);
  expect(base.idempotency_key, "discriminator distinguishes the idempotencyKey").not.toBe(redispatch.idempotency_key);
});
