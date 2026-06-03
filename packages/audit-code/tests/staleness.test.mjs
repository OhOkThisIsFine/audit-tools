import test from "node:test";
import assert from "node:assert/strict";

const { computeArtifactMetadata, computeArtifactStateSignature } =
  await import("../src/orchestrator/artifactMetadata.ts");
const { computeStaleArtifacts } =
  await import("../src/orchestrator/staleness.ts");
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { ARTIFACT_DEPENDENTS_MAP } = await import(
  "../src/orchestrator/dependencyMap.ts"
);
const {
  buildReverseDependencyMap,
  hashArtifactValue,
  stableStringify,
} = await import("../src/orchestrator/artifactFreshness.ts");

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
    buildReverseDependencyMap()["coverage_matrix.json"].includes(
      "external_analyzer_results.json",
    ),
  );
});

test("dependency revision changes mark downstream artifacts stale under the new audit-report model", () => {
  const initialBundle = {
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
  };

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

test("external analyzer results invalidate planning-derived artifacts", () => {
  for (const artifact of [
    "coverage_matrix.json",
    "audit_tasks.json",
    "review_packets.json",
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
    review_packets: [],
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
  assert.ok(stale.has("review_packets.json"));
  assert.ok(stale.has("requeue_tasks.json"));
  assert.ok(stale.has("audit-report.md"));
});
