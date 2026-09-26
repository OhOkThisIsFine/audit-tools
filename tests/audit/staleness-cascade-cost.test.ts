import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import {
  describeStalenessRecovery,
  emitStalenessRecord,
  measureCascadeCost,
  resetStalenessDedup,
} from "../../src/audit/orchestrator/staleness.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import {
  runIntentEquivalenceResolve,
  deriveIntentEquivalenceStatus,
} from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";
import { computeGateVersion, normalizeCheckpointForms } from "../../src/audit/orchestrator/intentCheckpointGate.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";

function buildPopulatedBundle(): ArtifactBundle {
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-09-20T00:00:00Z",
      files: [
        { path: "src/index.ts", language: "ts", size_bytes: 120, hash: "sha-src-1" },
        { path: "docs/readme.md", language: "md", size_bytes: 350, hash: "sha-doc-1" },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/index.ts", status: "included" },
        { path: "docs/readme.md", status: "included" },
      ],
    },
    surface_manifest: { surfaces: [] },
    unit_manifest: {
      units: [
        {
          unit_id: "u-1",
          name: "u-1",
          kind: "unit",
          files: ["src/index.ts"],
          required_lenses: ["correctness"],
          risk_score: 1,
          critical_flows: [],
        },
      ],
    },
    critical_flows: {
      flows: [],
      fallback_required: false,
    },
    structure_decomposition: {
      generated_at: "2026-09-20T00:00:00Z",
      target: "structure",
      node_universe_size: 2,
      source_ids: ["directory", "call_import"],
      consensus: [
        {
          node_id: "node-1",
          members: ["src/index.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
      findings: [],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-09-20T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "Initial scope description",
      intent_summary: "Initial intent overview",
      free_form_intent: "Detailed operator intent prose",
      filters: {},
    },
    design_assessment: {
      generated_at: "2026-09-20T00:00:00Z",
      findings: [
        {
          id: "design-note-1",
          title: "Design assessment rationale",
          summary: "A design concern described in initial prose.",
          severity: "low",
          confidence: "medium",
          category: "design",
          lens: "architecture",
          affected_files: [{ path: "src/index.ts" }],
          evidence: [],
        },
      ],
      rejected_submissions: [],
    },
    conceptual_review_adjudication: {
      schema_version: 1,
      generated_at: "2026-09-20T00:00:00Z",
      round_id: "round-1",
      contributors: [],
      candidate_dispositions: [],
      final_finding_shares: [],
      candidate_disposition_breakdown: {},
      candidate_verification_status_breakdown: {},
    },
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-09-20T00:00:00Z",
      target: "charter",
      ceiling: { rung: "deep" },
      lanes: [],
      candidates: [],
      correspondences: [],
      differences: [],
      findings: [],
      validation_issues: [],
      citation_validation: {
        status: "no_citations",
        citation_count: 0,
        checked_count: 0,
        failed_count: 0,
        delivered_evidence_checked: false,
        quote_presence_checked: false,
      },
      evidence_coverage: [],
    },
    charter_clarification: {
      generated_at: "2026-09-20T00:00:00Z",
      target: "charter_clarification",
      ceiling: { rung: "deep" },
      attention: 0,
      asked: [],
      banked: [],
      findings: [],
      validation_issues: [],
    },
    systemic_challenge: {
      generated_at: "2026-09-20T00:00:00Z",
      target: "systemic_challenge",
      ceiling: { rung: "deep" },
      converged: true,
      rounds: [],
      findings: [],
      validation_issues: [],
    },
    audit_report: "# Audit Report\n\nInitial report content.",
  };

  bundle.artifact_metadata = computeArtifactMetadata(bundle);
  return bundle;
}

test("describeStalenessRecovery records affected edges, rederived artifacts, context volume and upstream change classification", () => {
  const bundle = buildPopulatedBundle();

  // Simulate design_assessment.json being stale and invalidating conceptual_review_adjudication.json
  const stale = new Set([
    "design_assessment.json",
    "conceptual_review_adjudication.json",
  ]);

  const recovery = describeStalenessRecovery(stale, bundle, { elapsed_work_ms: 1.5 });
  expect(recovery).toBeDefined();
  expect(recovery!.caused_by).toEqual(["design_assessment.json"]);
  expect(recovery!.rederiving).toBe(2);
  expect(recovery!.rederived_artifacts).toEqual([
    "conceptual_review_adjudication.json",
    "design_assessment.json",
  ]);

  // Edges traversed
  expect(recovery!.affected_edges).toEqual([
    { from: "design_assessment.json", to: "conceptual_review_adjudication.json" },
  ]);

  // Upstream changes classification
  expect(recovery!.upstream_changes).toBeDefined();
  const daChange = recovery!.upstream_changes?.find((u) => u.artifact === "design_assessment.json");
  expect(daChange).toBeDefined();
  expect(daChange!.change_kind).toBe("prose");

  // Context volume distinguishing actual bytes from token estimates
  expect(recovery!.context_volume).toBeDefined();
  expect(recovery!.context_volume!.actual_context_bytes).toBeGreaterThan(0);
  expect(recovery!.context_volume!.estimated_tokens).toBe(
    Math.ceil(recovery!.context_volume!.actual_context_bytes / 4),
  );
  expect(recovery!.context_volume!.is_estimate).toBe(true);
  expect(recovery!.elapsed_work_ms).toBe(1.5);
});

test("emitStalenessRecord outputs enriched recovery fields in JSONL stderr record", () => {
  resetStalenessDedup();
  const bundle = buildPopulatedBundle();
  const stale = new Set([
    "design_assessment.json",
    "conceptual_review_adjudication.json",
  ]);

  const lines: string[] = [];
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    emitStalenessRecord(stale, undefined, bundle, { elapsed_work_ms: 2.1 });
  } finally {
    process.stderr.write = originalStderr;
  }

  expect(lines.length).toBe(1);
  const record = JSON.parse(lines[0]!);
  expect(record.kind).toBe("staleness");
  expect(record.stale_artifacts).toEqual([
    "conceptual_review_adjudication.json",
    "design_assessment.json",
  ]);
  expect(record.recovery).toBeDefined();
  expect(record.recovery.caused_by).toEqual(["design_assessment.json"]);
  expect(record.recovery.rederived_artifacts).toEqual([
    "conceptual_review_adjudication.json",
    "design_assessment.json",
  ]);
  expect(record.recovery.affected_edges).toEqual([
    { from: "design_assessment.json", to: "conceptual_review_adjudication.json" },
  ]);
  expect(record.recovery.context_volume.actual_context_bytes).toBeGreaterThan(0);
  expect(record.recovery.context_volume.is_estimate).toBe(true);
  expect(record.recovery.message).toContain("correct recovery");
});

test("classification timing cannot certify downstream execution cost or semantic necessity", () => {
  const baseline = buildPopulatedBundle();
  const modified = {
    ...baseline,
    design_assessment: {
      ...baseline.design_assessment!,
      findings: baseline.design_assessment!.findings.map((finding) => ({
        ...finding,
        summary: "Reworded finding, with no downstream executor run.",
      })),
    },
  };
  const cost = measureCascadeCost(baseline, modified, "design_assessment.json", "prose");
  expect(cost.unnecessary_invalidation).toBeNull();
  expect(cost.rationale).not.toMatch(/<\s*5ms|0 LLM tokens|negligible/);
});

test("an unchanged already-stale baseline is not attributed to the proposed change", () => {
  const baseline = buildPopulatedBundle();
  baseline.repo_manifest!.files.push({ path: "already-pending.ts", language: "ts", size_bytes: 1 });
  const cost = measureCascadeCost(baseline, baseline, "design_assessment.json", "prose");
  expect(cost.rederived_artifacts).toEqual([]);
  expect(cost.affected_edges).toEqual([]);
});

test("measureCascadeCost on representative prose-heavy changes: design_assessment finding prose reword", () => {
  const baseline = buildPopulatedBundle();
  const modified: ArtifactBundle = {
    ...baseline,
    design_assessment: {
      ...baseline.design_assessment!,
      findings: baseline.design_assessment!.findings.map((finding) => ({
        ...finding,
        summary: "The same design concern expressed with revised prose.",
      })),
    },
  };

  const cost = measureCascadeCost(baseline, modified, "design_assessment.json", "prose");
  expect(cost.upstream_artifact).toBe("design_assessment.json");
  expect(cost.change_kind).toBe("prose");
  expect(cost.rederived_artifacts).toContain("audit-report.md");
  expect(cost.actual_context_bytes).toBeGreaterThan(0);
  expect(cost.estimated_tokens).toBe(Math.ceil(cost.actual_context_bytes / 4));
  expect(cost.unnecessary_invalidation).toBeNull();
  expect(cost.classification_elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(cost.rationale).toContain("were not measured");
});

test("measureCascadeCost on representative prose-heavy changes: intent_checkpoint with DD-9 intent equivalence", () => {
  const baseline = buildPopulatedBundle();
  const forms = normalizeCheckpointForms(baseline.intent_checkpoint);

  // Set baseline intent normal forms on metadata
  baseline.artifact_metadata!.intent_baseline = {
    normalized_structured: forms.structured,
    normalized_prose: forms.prose,
    revision: baseline.artifact_metadata!.artifacts["intent_checkpoint.json"]!.revision,
    gate_version: computeGateVersion(),
  };

  // Case A: equivalent prose reword resolved through DD-9
  const rewordedCheckpoint = {
    ...baseline.intent_checkpoint!,
    intent_summary: "Rephrased overview conveying identical audit goals.",
  };
  const rewordedBundle: ArtifactBundle = {
    ...baseline,
    intent_checkpoint: rewordedCheckpoint,
  };

  const status = deriveIntentEquivalenceStatus(rewordedBundle);
  expect(status.kind).toBe("prose_judgment_pending");

  if (status.kind === "prose_judgment_pending") {
    // Resolve as equivalent
    const resolved = runIntentEquivalenceResolve(rewordedBundle, {
      verdict: "equivalent",
      judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash },
    });
    // Restamp metadata with the resolved baseline
    const restampedBundle: ArtifactBundle = {
      ...resolved.updated,
      artifact_metadata: computeArtifactMetadata(
        resolved.updated,
        resolved.updated.artifact_metadata,
      ),
    };

    const costEquivalent = measureCascadeCost(
      baseline,
      restampedBundle,
      "intent_checkpoint.json",
      "prose",
    );
    expect(costEquivalent.unnecessary_invalidation).toBeNull();
    expect(costEquivalent.rederived_artifacts.length).toBe(0);
    expect(costEquivalent.rationale).toContain("No additional artifacts invalidated");
  }

  // Case B: substantive prose reword resolved as changed
  if (status.kind === "prose_judgment_pending") {
    const resolvedChanged = runIntentEquivalenceResolve(rewordedBundle, {
      verdict: "changed",
      judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash },
    });
    const restampedChanged: ArtifactBundle = {
      ...resolvedChanged.updated,
      artifact_metadata: computeArtifactMetadata(
        resolvedChanged.updated,
        resolvedChanged.updated.artifact_metadata,
      ),
    };
    const costChanged = measureCascadeCost(
      baseline,
      restampedChanged,
      "intent_checkpoint.json",
      "prose",
    );
    expect(costChanged.change_kind).toBe("prose");
    expect(costChanged.unnecessary_invalidation).toBeNull();
  }
});

test("measureCascadeCost on representative changes: repo_manifest churn preserves whole-manifest challenge behavior", () => {
  const baseline = buildPopulatedBundle();
  // Modify repo_manifest with an unrelated file
  const modified: ArtifactBundle = {
    ...baseline,
    repo_manifest: {
      ...baseline.repo_manifest!,
      files: [
        ...baseline.repo_manifest!.files,
        { path: "src/unrelated.ts", language: "ts", size_bytes: 80, hash: "sha-unrelated" },
      ],
    },
  };

  const cost = measureCascadeCost(baseline, modified, "repo_manifest.json", "manifest_churn");
  expect(cost.upstream_artifact).toBe("repo_manifest.json");
  expect(cost.change_kind).toBe("manifest_churn");
  // charter_register has slice protection against member files, while systemic_challenge keeps whole-manifest edge
  expect(cost.unnecessary_invalidation).toBeNull();
});
