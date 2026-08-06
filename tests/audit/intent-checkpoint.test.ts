import { test, expect } from "vitest";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { decideNextStep } from "../../src/audit/orchestrator/nextStep.js";
import { computeScopePreDigest } from "../../src/audit/orchestrator/intentCheckpointExecutor.js";
import { renderConfirmIntentPrompt } from "../../src/audit/cli/confirmIntentStep.js";
import { MANDATORY_LENSES } from "../../src/audit/orchestrator/lensSelection.js";
import { validateArtifactBundle } from "../../src/audit/validation/artifacts.js";
import { applyIntentExclusionsToCoverage } from "../../src/audit/orchestrator/scope.js";
import { renderAuditReportMarkdown } from "../../src/audit/reporting/synthesis.js";
import { buildPacketPrompt } from "../../src/audit/cli/dispatch.js";
import { runIntentEquivalenceResolve } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { ARTIFACT_DEFINITIONS } from "../../src/audit/io/artifacts.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { ObligationState } from "../../src/audit/types/auditState.js";
import type { CoverageMatrix, CoverageFileRecord } from "../../src/audit/types.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import type { RenderableAuditReport } from "../../src/audit/reporting/synthesis.js";
import type { ReviewPacket } from "../../src/audit/types/reviewPlanning.js";
import type { IntentCheckpoint } from "audit-tools/shared";

function obligationState(bundle: ArtifactBundle, id: string): ObligationState | undefined {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id)?.state;
}

// Settle the DD-9 intent-equivalence baseline: stamp artifact_metadata.intent_baseline
// from the live checkpoint (deterministic first-contact arm) so
// intent_equivalence_current is satisfied and decisions reach the obligations these
// tests target. The full computeArtifactMetadata manifest (not an empty one) keeps
// the staleness pass clean and makes the stamp arm's entry-hash check consistent.
function settleIntentBaseline(bundle: ArtifactBundle): ArtifactBundle {
  return runIntentEquivalenceResolve({
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle),
  }).updated;
}

// An omitted (shallow-ceiling) charter register — satisfies charter_extraction_current
// so a test can assert the obligation AFTER the Phase-C charter pass.
function omittedCharterRegister(): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter",
    ceiling: { rung: "shallow" },
    status: "omitted",
    subsystems: [],
    goal_graph: { nodes: [], edges: [] },
    deltas: [],
    findings: [],
    triangulated: [],
    disagreement: [],
    validation_issues: [],
  };
}

// A bundle where every obligation up to and including design_assessment_current
// is satisfied, but the intent checkpoint has not yet been written.
function readyForIntentBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: { generated_at: "2026-01-01T00:00:00.000Z", findings: [], reviewed: false },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
  };
}

function validCheckpoint(): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-09T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "src only",
    intent_summary: "full-audit",
  };
}

// ── Obligation reachability ─────────────────────────────────────────────────

await test("intent_checkpoint_current: missing when the checkpoint is absent", () => {
  expect(obligationState(readyForIntentBundle(), "intent_checkpoint_current")).toBe("missing");
});

await test("intent_checkpoint_current: satisfied once the checkpoint is present", () => {
  const bundle = { ...readyForIntentBundle(), intent_checkpoint: validCheckpoint() };
  expect(obligationState(bundle, "intent_checkpoint_current")).toBe("satisfied");
});

// ── Priority ordering: after design_assessment_current, before design_review_contract_completed ───────

await test("decideNextStep selects intent_checkpoint after design assessment, before design review", () => {
  const decision = decideNextStep(readyForIntentBundle());
  expect(decision.selected_obligation).toBe("intent_checkpoint_current");
  expect(decision.selected_executor).toBe("intent_checkpoint_executor");
});

await test("decideNextStep advances to charter_extraction once the checkpoint exists", () => {
  // Phase C: the charter-extraction pass sits between the checkpoint and the
  // design-review passes (it needs the confirmed ceiling). Once charter extraction
  // is satisfied (omitted at a shallow ceiling), design_review_contract is next.
  // DD-9: the intent-equivalence baseline is settled first — otherwise
  // intent_equivalence_current (directly after the checkpoint) is selected.
  const bundle = settleIntentBaseline({ ...readyForIntentBundle(), intent_checkpoint: validCheckpoint() });
  expect(decideNextStep(bundle).selected_obligation).toBe("charter_extraction_current");
  const withCharters = { ...bundle, charter_register: omittedCharterRegister() };
  expect(decideNextStep(withCharters).selected_obligation).toBe("design_review_contract_completed");
});

// ── Deterministic scope pre-digest ──────────────────────────────────────────

await test("computeScopePreDigest counts auditable files and surfaces auto-exclusions", () => {
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 10 },
        { path: "src/b.ts", language: "typescript", size_bytes: 10 },
        { path: "lib/c.ts", language: "typescript", size_bytes: 10 },
        { path: "node_modules/x/y.js", language: "javascript", size_bytes: 10 },
        { path: "dist/out.js", language: "javascript", size_bytes: 10 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "src/b.ts", status: "included" },
        { path: "lib/c.ts", status: "included" },
        { path: "node_modules/x/y.js", status: "vendor" },
        { path: "dist/out.js", status: "generated" },
      ],
    },
  };
  const pre = computeScopePreDigest(bundle, "/repo");
  expect(pre.mode).toBe("full");
  expect(pre.since).toBe(null);
  expect(pre.files_in_scope).toBe(3);
  expect(pre.scope_dirs).toEqual([
    { dir: "src", files: 2 },
    { dir: "lib", files: 1 },
  ]);
  // excluded_summary replaces the old auto_excluded flat list — it uses
  // collapsed aggregate rows or individual rows.
  const totalExcluded = pre.excluded_summary.reduce(
    (acc, row) => acc + ("prefix" in row ? row.file_count : 1),
    0,
  );
  expect(totalExcluded).toBe(2);
  // node_modules/ is a single-file vendor exclusion in this fixture — appears as individual row
  expect(pre.excluded_summary.some(
      (e) => "path" in e && e.path === "node_modules/x/y.js" && e.status === "vendor",
    ) ||
    pre.excluded_summary.some(
      (e) => "prefix" in e && e.prefix === "node_modules" && e.status === "vendor",
    ), "node_modules vendor file should appear in excluded_summary").toBeTruthy();
});

// ── Change 3 (scope-confirmation context) ───────────────────────────────────
// Prompt/process critique 2026-08-05 §2 / design resolution 3: the scope
// confirmation was starved of semantic context that exists elsewhere in the
// pipeline. Both tests were pinned RED (`test.fails`) by the design-check and
// flipped green by the implementation.

await test("computeScopePreDigest reads design_assessment: a lens-tagged structural finding flips that lens's heuristic exclude", () => {
  const bundle: ArtifactBundle = {
    ...readyForIntentBundle(),
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [
        {
          id: "DA-001",
          title: "Duplicated code: src/a.ts",
          category: "code_duplication",
          severity: "low",
          confidence: "medium",
          lens: "maintainability",
          summary: "src/a.ts duplication evidence from the deterministic assessment",
          affected_files: [{ path: "src/a.ts" }],
        },
      ],
    },
  };
  // Today buildLensPropositions receives only unit manifest + paths +
  // disposition (intentCheckpointExecutor.ts), so maintainability stays an
  // unconditional recommend_exclude even when the deterministic design
  // assessment carries direct lens-tagged evidence for it.
  const pre = computeScopePreDigest(bundle, "/repo");
  expect(
    pre.lens_propositions.find((p) => p.lens === "maintainability")?.disposition,
  ).toBe("recommend_include");
});

await test("docs_digest is a registered artifact feeding the confirm-intent prompt", () => {
  expect(Object.keys(ARTIFACT_DEFINITIONS)).toContain("docs_digest");
});

await test("renderConfirmIntentPrompt renders the docs digest as the repo's stated purpose, and omits the section when empty", () => {
  const base = {
    mode: "full" as const,
    since: null,
    files_in_scope: 3,
    scope_dirs: [{ dir: "src", files: 2 }],
    excluded_summary: [],
    disposition_override_proposals: [],
    lens_propositions: [],
  };
  const opts = {
    intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
    continueCommand: "audit-code next-step",
  };
  const withDocs = renderConfirmIntentPrompt(
    {
      ...base,
      docs_digest: [
        {
          path: "README.md",
          title: "Fixture Project",
          excerpt: "A tool that audits codebases and reports findings.",
        },
      ],
    },
    opts,
  );
  expect(withDocs).toMatch(/Repository purpose \(from its docs\)/);
  expect(withDocs).toMatch(/`README\.md` — Fixture Project/);
  expect(withDocs).toMatch(/audits codebases and reports findings/);

  const withoutDocs = renderConfirmIntentPrompt({ ...base, docs_digest: [] }, opts);
  expect(withoutDocs).not.toMatch(/Repository purpose/);
});

// ── Confirm-intent prompt rendering ─────────────────────────────────────────

await test("renderConfirmIntentPrompt includes the scope picture, target path, and the JSON shape", () => {
  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 3,
      scope_dirs: [{ dir: "src", files: 2 }],
      excluded_summary: [{ path: "dist/out.js", status: "generated", reason: "build output" }],
      disposition_override_proposals: [],
      lens_propositions: [],
      docs_digest: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
    },
  );
  expect(prompt).toMatch(/Confirm Audit Scope and Intent/);
  expect(prompt).toMatch(/\*\*Files in scope:\*\* 3/);
  expect(prompt).toMatch(/`src` — 2 file/);
  expect(prompt).toMatch(/dist\/out\.js/);
  expect(prompt).toMatch(/intent_checkpoint\.json/);
  expect(prompt).toMatch(/"excluded_scope"/);
  expect(prompt).toMatch(/audit-code next-step/);
});

await test("renderConfirmIntentPrompt mandatory-lens prose is derived from MANDATORY_LENSES, not hardcoded (MNT-df8c4551)", () => {
  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 3,
      scope_dirs: [{ dir: "src", files: 2 }],
      excluded_summary: [],
      disposition_override_proposals: [],
      // A lens proposition so the table + the mandatory-set prose render.
      lens_propositions: [{ lens: "operability", disposition: "recommend_exclude", reason: "no ops surface" }],
      docs_digest: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
    },
  );
  // Every mandatory lens name must appear verbatim in the rendered guidance;
  // if MANDATORY_LENSES changes, this fails unless the prose follows.
  for (const lens of MANDATORY_LENSES) {
    expect(prompt.includes(lens), `rendered prompt must name mandatory lens "${lens}"`).toBeTruthy();
  }
  // The exact joined list rendered in both prose locations.
  expect(prompt).toMatch(new RegExp(`Mandatory lenses \\(${MANDATORY_LENSES.join(", ")}\\)`));
});

await test("renderConfirmIntentPrompt asks for conceptual design-review depth (default shallow) and offers it in the JSON shape", () => {
  const prompt = renderConfirmIntentPrompt(
    {
      mode: "full",
      since: null,
      files_in_scope: 3,
      scope_dirs: [{ dir: "src", files: 2 }],
      excluded_summary: [],
      disposition_override_proposals: [],
      lens_propositions: [],
      docs_digest: [],
    },
    {
      intentCheckpointPath: "/repo/.audit-tools/audit/intent_checkpoint.json",
      continueCommand: "audit-code next-step",
    },
  );
  expect(prompt).toMatch(/Conceptual design-review depth/);
  expect(prompt).toMatch(/shallow.*\(default\)/);
  expect(prompt).toMatch(/\bdeep\b/);
  // The depth choice is part of the single confirmation round, and offered in the JSON shape.
  expect(prompt).toMatch(/Ask the conceptual design-review depth/);
  expect(prompt).toMatch(/"design_review":\s*\{\s*"conceptual_depth":\s*"shallow",\s*"perspectives":\s*5\s*\}/);
});

// ── Validation ──────────────────────────────────────────────────────────────

await test("validateArtifactBundle accepts a well-formed checkpoint", () => {
  const issues = validateArtifactBundle({
    intent_checkpoint: validCheckpoint(),
  }).filter((i) => JSON.stringify(i).includes("intent_checkpoint"));
  expect(issues.length).toBe(0);
});

await test("validateArtifactBundle rejects a checkpoint missing a required key", () => {
  const { confirmed_by, ...missingConfirmedBy } = validCheckpoint();
  const issues = validateArtifactBundle({
    // Deliberate wrong-shaped-input probe: confirmed_by is a required key, and
    // this test asserts the runtime validator flags its absence — the object
    // is intentionally NOT a valid IntentCheckpoint.
    // @ts-expect-error — missingConfirmedBy deliberately lacks the required confirmed_by key
    intent_checkpoint: missingConfirmedBy,
  }).filter((i) => JSON.stringify(i).includes("intent_checkpoint"));
  expect(issues.length > 0).toBeTruthy();
});

// ── Phase A: conceptual charter spine gate ──────────────────────────────────
// Retired by design resolution 4: charters no longer embed in the checkpoint.
// They live on charter_register.json (the output artifact) to avoid a staleness
// cycle. The schema now uses .strict() on design_review, rejecting extra fields.

// ── A2: consume the accepted scope ──────────────────────────────────────────

function coverageFile(path: string): CoverageFileRecord {
  return {
    path,
    unit_ids: ["u"],
    classification_status: "classified",
    audit_status: "pending",
    required_lenses: ["security"],
    completed_lenses: [],
  };
}

await test("applyIntentExclusionsToCoverage prunes matching files with directory-prefix semantics", () => {
  const coverage: CoverageMatrix = {
    files: [
      coverageFile("src/a.ts"),
      coverageFile("scratch/tmp.ts"),
      coverageFile("src/scratchpad.ts"),
    ],
  };
  const excluded = applyIntentExclusionsToCoverage(coverage, [
    { path: "scratch", reason: "scratch dir" },
  ]);
  // `scratch` matches the scratch/ directory, NOT the sibling src/scratchpad.ts.
  expect(excluded).toEqual(["scratch/tmp.ts"]);
  const pruned = coverage.files.find((f) => f.path === "scratch/tmp.ts");
  expect(pruned!.audit_status).toBe("excluded");
  expect(pruned!.classification_status).toBe("out_of_scope_intent");
  expect(pruned!.required_lenses).toEqual([]);
  expect(coverage.files.find((f) => f.path === "src/scratchpad.ts")!.audit_status).toBe("pending");
});

await test("applyIntentExclusionsToCoverage is a no-op without exclusions", () => {
  const coverage: CoverageMatrix = { files: [coverageFile("src/a.ts")] };
  expect(applyIntentExclusionsToCoverage(coverage, undefined)).toEqual([]);
  expect(applyIntentExclusionsToCoverage(coverage, [])).toEqual([]);
  expect(coverage.files[0].audit_status).toBe("pending");
});

function emptyRenderableReport(): RenderableAuditReport {
  return {
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings: [],
    work_blocks: [],
    work_block_seams: [],
  };
}

await test("renderAuditReportMarkdown surfaces excluded scope when the checkpoint has exclusions", () => {
  const md = renderAuditReportMarkdown(emptyRenderableReport(), {
    intent_checkpoint: {
      ...validCheckpoint(),
      excluded_scope: [{ path: "dist", reason: "build output" }],
    },
  });
  expect(md).toMatch(/## Excluded \/ Out-of-Scope/);
  expect(md).toMatch(/`dist` — build output/);
});

await test("renderAuditReportMarkdown omits the excluded section without exclusions", () => {
  const md = renderAuditReportMarkdown(emptyRenderableReport(), {});
  expect(md).not.toMatch(/Excluded \/ Out-of-Scope/);
});

function minimalPacket(): ReviewPacket {
  return {
    packet_id: "pkt-1",
    task_ids: ["t1"],
    unit_ids: ["u1"],
    pass_ids: ["pass:security"],
    lenses: ["security"],
    estimated_tokens: 100,
    file_paths: ["src/a.ts"],
    file_line_counts: { "src/a.ts": 10 },
    total_lines: 10,
    priority: "medium",
    quality: {
      cohesion_score: 1,
      internal_edge_count: 0,
      boundary_edge_count: 0,
      unexplained_file_count: 0,
    },
    rationale: "test packet",
  };
}

await test("buildPacketPrompt never threads free_form_intent into the worker prompt (INV-S04)", () => {
  // free_form_intent is interpreted into lens/priority signals at planning time
  // (planningExecutors.interpretFreeFormIntent); it is never pasted into a worker
  // prompt. The renderer takes no intent parameter, so no "## Audit intent"
  // section can ever appear.
  const prompt = buildPacketPrompt({
    packet: minimalPacket(),
    packetTasks: [],
    fileList: "- src/a.ts",
    largeFileSection: [],
    taskSections: ["### t1"],
    resultPath: "/artifacts/runs/run-1/task-results/inline-result.json",
    repoRoot: "/repo",
  });
  expect(prompt).not.toMatch(/## Audit intent/);
});
