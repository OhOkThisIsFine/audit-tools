import test from "node:test";
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
  assert.equal(sigOf(base), sigOf(bumpedRevisions));
  // A genuine content change -> different signature (real progress).
  const changedContent = {
    ...base,
    "audit-report.md": { revision: 3, content_hash: "ccc", dependency_revisions: {} },
  };
  assert.notEqual(sigOf(base), sigOf(changedContent));
  // Order-independent, and no metadata -> a stable sentinel.
  assert.equal(
    sigOf(base),
    sigOf({
      "audit-report.md": base["audit-report.md"],
      "repo_manifest.json": base["repo_manifest.json"],
    }),
  );
  assert.equal(computeArtifactStateSignature({}), "no-metadata");
});

test("artifact freshness helpers normalize deterministic metadata hashes", () => {
  assert.equal(
    stableStringify({ b: [2, { d: 4, c: 3 }], a: 1 }),
    stableStringify({ a: 1, b: [2, { c: 3, d: 4 }] }),
  );
  assert.equal(
    hashArtifactValue("repo_manifest.json", {
      generated_at: "a",
      files: [],
    }),
    hashArtifactValue("repo_manifest.json", {
      generated_at: "b",
      files: [],
    }),
  );
  assert.notEqual(
    hashArtifactValue("coverage_matrix.json", {
      generated_at: "a",
      files: [],
    }),
    hashArtifactValue("coverage_matrix.json", {
      generated_at: "b",
      files: [],
    }),
  );
  assert.ok(
    ARTIFACT_DEPENDS_ON_MAP["coverage_matrix.json"].includes(
      "external_analyzer_results.json",
    ),
  );
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
  assert.ok(stale.has("file_disposition.json"));
  assert.ok(stale.has("unit_manifest.json"));
  assert.ok(stale.has("coverage_matrix.json"));
  assert.ok(stale.has("audit-report.md"));

  const state = deriveAuditState(revisedBundle);
  assert.equal(
    state.obligations.find((item) => item.id === "file_disposition")?.state,
    "stale",
  );
  assert.equal(
    state.obligations.find((item) => item.id === "structure_artifacts")?.state,
    "stale",
  );
  assert.equal(
    state.obligations.find((item) => item.id === "planning_artifacts")?.state,
    "stale",
  );
  assert.equal(
    state.obligations.find((item) => item.id === "synthesis_current")?.state,
    "stale",
  );
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
  assert.ok(stale.has("repo_manifest.json"));
  assert.ok(stale.has("file_disposition.json"));

  const state = deriveAuditState(revisedBundle);
  assert.equal(
    state.obligations.find((item) => item.id === "file_disposition")?.state,
    "stale",
  );
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
  assert.equal(
    stateStale.obligations.find((o) => o.id === "runtime_validation_current")?.state,
    "stale",
    "obligation should be 'stale' when report exists but result is pending",
  );

  // Case 2: no report at all -> obligation is 'missing'.
  const bundleNoReport = {
    runtime_validation_tasks: {
      tasks: [{ id: "rv-task-1", type: "test" }],
    },
  };
  const stateMissing = deriveAuditState(bundleNoReport);
  assert.equal(
    stateMissing.obligations.find((o) => o.id === "runtime_validation_current")?.state,
    "missing",
    "obligation should be 'missing' when no report exists",
  );

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
  assert.equal(
    stateSatisfied.obligations.find((o) => o.id === "runtime_validation_current")?.state,
    "satisfied",
    "obligation should be 'satisfied' when all tasks have non-pending results",
  );
});

test("external analyzer results invalidate planning-derived artifacts", () => {
  for (const artifact of [
    "coverage_matrix.json",
    "audit_tasks.json",
    "requeue_tasks.json",
    "audit-report.md",
  ]) {
    assert.ok(
      ARTIFACT_DEPENDENTS_MAP["external_analyzer_results.json"].includes(artifact),
      `${artifact} should depend on external analyzer results`,
    );
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

  assert.ok(stale.has("coverage_matrix.json"));
  assert.ok(stale.has("audit_tasks.json"));
  assert.ok(stale.has("requeue_tasks.json"));
  assert.ok(stale.has("audit-report.md"));
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
  assert.ok(fileDispositionEntry, "file_disposition.json must have a metadata entry");
  const recordedRevision =
    fileDispositionEntry.dependency_revisions["repo_manifest.json"];
  assert.ok(
    recordedRevision > 0,
    `recordedRevision for repo_manifest must be > 0 (got ${recordedRevision})`,
  );

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
  assert.ok(
    stale.has("file_disposition.json"),
    "file_disposition.json must be stale when its dep repo_manifest is absent but recordedRevision > 0",
  );

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
  assert.ok(
    !staleZero.has("file_disposition.json"),
    "file_disposition.json must NOT be stale when absent dep has recordedRevision === 0 (continue branch)",
  );
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
  assert.ok(!stale.has("graph_bundle.json"), "graph_bundle.json should not be stale");
  assert.ok(!stale.has("unit_manifest.json"), "unit_manifest.json should not be stale");

  // Downstream artifacts must still be stale (positive path).
  assert.ok(stale.has("coverage_matrix.json"), "coverage_matrix.json should be stale");
  assert.ok(stale.has("audit_tasks.json"), "audit_tasks.json should be stale");
});

// TST-aa3c406e: computeStaleArtifacts must handle an absent artifact_metadata field
// without throwing or returning a non-empty stale set (no metadata → can't determine
// freshness → nothing is stale by comparison).
test("computeStaleArtifacts returns empty set when artifact_metadata is absent", () => {
  const stale = computeStaleArtifacts({});
  assert.ok(stale instanceof Set, "must return a Set");
  assert.equal(stale.size, 0, "empty bundle → no artifact_metadata → no stale artifacts");
});

test("computeStaleArtifacts returns empty set when artifact_metadata key is present but undefined", () => {
  const stale = computeStaleArtifacts({ artifact_metadata: undefined });
  assert.ok(stale instanceof Set, "must return a Set");
  assert.equal(stale.size, 0, "undefined artifact_metadata → no stale artifacts");
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
  perElementStalenessVerdict,
  isMetadataManifestCurrent,
} = await import("../../src/audit/orchestrator/resultBaseline.ts");
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.ts"
);

test("F1 inv: computeArtifactMetadata stamps the current metadata_schema_version", () => {
  const metadata = computeArtifactMetadata(makeBaseBundle());
  assert.equal(metadata.metadata_schema_version, METADATA_SCHEMA_VERSION);
  assert.ok(METADATA_SCHEMA_VERSION >= 1);
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
  assert.equal(liveKeys.idempotency_key, seamIk, "idempotency_key from the seam");
  assert.equal(liveKeys.content_key, seamCk, "content_key from the seam");

  // With a baseline recorded at the seam contentKey, an unchanged element is skipped.
  const baselines = recordResultBaseline(undefined, {
    idempotency_key: seamIk,
    content_key: seamCk,
  });
  assert.equal(perElementStalenessVerdict(baselines, coordinate), "skipped");
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
  assert.equal(
    liveKeys.idempotency_key,
    seamIk,
    "idempotency_key MUST come from the contentKey seam (no parallel hashing)",
  );
  assert.equal(
    liveKeys.content_key,
    seamCk,
    "content_key MUST come from the contentKey seam (no parallel hashing)",
  );

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
  assert.equal(
    renumbered.content_key,
    seamCk,
    "task_id is stripped by the seam — renumbering must not move the contentKey",
  );

  // Discriminator-in-key: the result_content_discriminator is a key input, so a
  // distinct same-grouping-coordinate result is NEVER collapsed onto the base.
  const redispatch = deriveLiveResultKeys({
    ...coordinate,
    source: "redispatch",
    attempt: 1,
  });
  assert.notEqual(
    liveKeys.idempotency_key,
    redispatch.idempotency_key,
    "discriminator must be in the idempotencyKey",
  );
  assert.notEqual(
    liveKeys.content_key,
    redispatch.content_key,
    "discriminator must be in the contentKey",
  );
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
  assert.notEqual(base.idempotency_key, redispatch.idempotency_key);
  assert.notEqual(base.content_key, redispatch.content_key);

  // A baseline for the base result must NOT skip the re-dispatched result.
  const baselines = recordResultBaseline(undefined, base);
  assert.equal(
    perElementStalenessVerdict(baselines, {
      unit_id: "u1",
      lens: "security",
      pass_id: "p1",
      source: "redispatch",
      attempt: 1,
      task_content_signature: sig,
    }),
    "re-derive",
    "distinct same-coordinate result must not be false-skipped (CE-009)",
  );
});

test("F1 inv-2 [CP-NODE-3]: unchanged element skipped, distinct discriminator never collapses (incl. O3 re-dispatch)", () => {
  const sig = buildTaskContentSignature({ goal: "audit auth", body: "v1" });
  const baseCoord = {
    unit_id: "uX",
    lens: "security",
    pass_id: "p3",
    source: "base",
    task_content_signature: sig,
  };
  const baseKeys = deriveLiveResultKeys(baseCoord);
  const baselines = recordResultBaseline(undefined, baseKeys);

  // Skip-by-construction: persisted contentKey == freshly-computed → unchanged → skip.
  assert.equal(
    perElementStalenessVerdict(baselines, baseCoord),
    "skipped",
    "unchanged element (identical contentKey) must skip",
  );

  // O3 stage-3 re-dispatch: same {unit_id,lens,pass_id} grouping coordinate, distinct
  // discriminator → distinct keys → must NOT false-skip against the base baseline (CE-009).
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
  assert.notEqual(
    redispatchKeys.content_key,
    baseKeys.content_key,
    "O3 re-dispatch must have a distinct contentKey from the base result",
  );
  assert.equal(
    perElementStalenessVerdict(baselines, redispatchCoord),
    "re-derive",
    "two distinct same-grouping-coordinate results must never collapse to a false skip (CE-009)",
  );

  // And once the re-dispatch is itself recorded, its own unchanged re-run skips —
  // proving the skip operates at per-result, not grouping, granularity.
  const both = recordResultBaseline(baselines, redispatchKeys);
  assert.equal(perElementStalenessVerdict(both, redispatchCoord), "skipped");
  assert.equal(perElementStalenessVerdict(both, baseCoord), "skipped");
});

test("F1 skip-by-construction: unchanged element skipped, mutated element re-derived", () => {
  const coord = (sig) => ({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: sig,
  });
  const sigA = buildTaskContentSignature({ goal: "g", body: "v1" });
  const keysA = deriveLiveResultKeys(coord(sigA));
  const baselines = recordResultBaseline(undefined, keysA);

  // Run B — same content: unchanged → skipped.
  assert.equal(perElementStalenessVerdict(baselines, coord(sigA)), "skipped");

  // Run B — mutated content (benign edit bumps contentKey): re-derive.
  const sigB = buildTaskContentSignature({ goal: "g", body: "v2 edited" });
  assert.equal(perElementStalenessVerdict(baselines, coord(sigB)), "re-derive");
});

test("F1 fail-safe: missing discriminator (no source) → re-derive, never grouping-key compare", () => {
  const sig = buildTaskContentSignature({ goal: "g" });
  // First establish a baseline under base so a grouping-key compare COULD falsely skip.
  const keys = deriveLiveResultKeys({
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: sig,
  });
  const baselines = recordResultBaseline(undefined, keys);
  // Coordinate omitting `source` (the discriminator) → fail-safe stale (CE-009).
  assert.equal(
    perElementStalenessVerdict(baselines, {
      unit_id: "u1",
      lens: "security",
      pass_id: "p1",
      task_content_signature: sig,
    }),
    "re-derive",
  );
});

test("F1 fail-safe: corrupt/undefined element state → re-derive", () => {
  const coord = {
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: "", // empty signature → seam throws → fail-safe
  };
  assert.equal(perElementStalenessVerdict({}, coord), "re-derive");

  // No baseline recorded for a valid coordinate → first compare → re-derive.
  const sig = buildTaskContentSignature({ goal: "g" });
  assert.equal(
    perElementStalenessVerdict(undefined, {
      unit_id: "u1",
      lens: "security",
      pass_id: "p1",
      source: "base",
      task_content_signature: sig,
    }),
    "re-derive",
    "no recorded baseline → never a false skip",
  );
});

test("F1 inv-3 [CP-NODE-4]: missing/corrupt per-element key => stale (fail-safe)", () => {
  // A persisted per-element contentKey that is missing, deleted, or corrupt
  // (uncomparable) must be treated as CHANGED and re-derived — mirroring the
  // whole-artifact !currentHash => stale path. We corrupt/delete the persisted
  // baseline several ways and assert each fails safe to `re-derive`, never a
  // false `skipped`.
  const sig = buildTaskContentSignature({ goal: "g", body: "v1" });
  const coord = {
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: sig,
  };
  const liveKeys = deriveLiveResultKeys(coord);

  // Sanity: a correctly persisted baseline skips an unchanged element.
  const goodBaselines = recordResultBaseline(undefined, liveKeys);
  assert.equal(perElementStalenessVerdict(goodBaselines, coord), "skipped");

  // (a) Persisted key DELETED from the store → no baseline → re-derive.
  const deleted = { ...goodBaselines };
  delete deleted[liveKeys.idempotency_key];
  assert.equal(
    perElementStalenessVerdict(deleted, coord),
    "re-derive",
    "deleted persisted per-element key must fail safe to re-derive",
  );

  // (b) Persisted key explicitly undefined (uncomparable) → re-derive.
  const undef = { ...goodBaselines, [liveKeys.idempotency_key]: undefined };
  assert.equal(
    perElementStalenessVerdict(undef, coord),
    "re-derive",
    "undefined persisted per-element key must fail safe to re-derive",
  );

  // (c) Persisted key corrupt (a non-matching/garbage value) → re-derive.
  const corrupt = { ...goodBaselines, [liveKeys.idempotency_key]: "CORRUPT" };
  assert.equal(
    perElementStalenessVerdict(corrupt, coord),
    "re-derive",
    "corrupt persisted per-element key must fail safe to re-derive",
  );
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
  assert.equal(isMetadataManifestCurrent(preF1Manifest), false);

  const bundle = { ...initialBundle, artifact_metadata: preF1Manifest };
  let stale;
  assert.doesNotThrow(() => {
    stale = computeStaleArtifacts(bundle);
  }, "old-shape manifest must degrade, never throw");
  // Every present DAG artifact is stale (no false-skip off matching hashes).
  for (const name of ["repo_manifest.json", "file_disposition.json", "unit_manifest.json", "audit-report.md"]) {
    assert.ok(stale.has(name), `${name} must be all-stale under migration fail-safe`);
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
  assert.ok(stale.has("repo_manifest.json"));
  assert.ok(stale.size > 0, "must degrade to a non-empty stale set");
});

test("F1 reproducible DAG: persist/reload cycle yields identical stale set + per-element verdicts", () => {
  const initialBundle = makeBaseBundle();
  const metadata = computeArtifactMetadata(initialBundle);
  // Round-trip the manifest through JSON (persist/reload).
  const reloaded = JSON.parse(JSON.stringify(metadata));
  assert.equal(reloaded.metadata_schema_version, METADATA_SCHEMA_VERSION);

  const stale1 = computeStaleArtifacts({ ...initialBundle, artifact_metadata: metadata });
  const stale2 = computeStaleArtifacts({ ...initialBundle, artifact_metadata: reloaded });
  assert.deepEqual([...stale1].sort(), [...stale2].sort());

  // Per-element verdicts are identical across the reload too.
  const coord = {
    unit_id: "u1",
    lens: "security",
    pass_id: "p1",
    source: "base",
    task_content_signature: buildTaskContentSignature({ goal: "g" }),
  };
  const keys = deriveLiveResultKeys(coord);
  const baselines = recordResultBaseline(undefined, keys);
  const reloadedBaselines = JSON.parse(JSON.stringify(baselines));
  assert.equal(
    perElementStalenessVerdict(baselines, coord),
    perElementStalenessVerdict(reloadedBaselines, coord),
  );
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
  assert.deepEqual(norm(ARTIFACT_DEPENDENTS_MAP), norm(rebuilt));
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
  assert.deepEqual(
    norm(ARTIFACT_DEPENDENTS_MAP),
    norm(invertDependencyMap(ARTIFACT_DEPENDS_ON_MAP)),
  );
});

// F1 inv-7: transcription-not-authorship. The git_history.json upstream edge
// set F1 registers MUST be EXACTLY F6's declared {repo_manifest, file_disposition}
// — F1 neither guesses nor infers. Pinning the set so any divergence fails.
test("inv-7: git_history.json upstream set is exactly F6's declared {repo_manifest, file_disposition}", () => {
  assert.deepEqual(
    [...ARTIFACT_DEPENDS_ON_MAP["git_history.json"]].sort(),
    ["file_disposition.json", "repo_manifest.json"],
  );
});

// F1 inv-4 [CP-NODE-5]: old-shape manifest => all-stale, no throw (CE-007).
// Covers the explicit-older-version variant of the migration fail-safe: a
// manifest tagged with metadata_schema_version BELOW the current one (not merely
// absent) is still pre-F1, so its still-matching whole-artifact hashes must
// NEVER false-skip a present element, and computeStaleArtifacts must never throw.
test("F1 inv-4 [CP-NODE-5]: old-shape manifest => all-stale, no throw", () => {
  const initialBundle = makeBaseBundle();
  const metadata = computeArtifactMetadata(initialBundle);
  assert.ok(METADATA_SCHEMA_VERSION >= 1);

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
  assert.equal(isMetadataManifestCurrent(olderShapeManifest), false);

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
    assert.ok(stale.has(name), `${name} must be all-stale under inv-4 fail-safe`);
  }
  assert.ok(stale.size > 0, "fail-safe must yield a non-empty stale set");
  assert.equal(
    stale.has("artifact_metadata.json"),
    false,
    "the manifest artifact itself is never marked stale by the gate",
  );
});
