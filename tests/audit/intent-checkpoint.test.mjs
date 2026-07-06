import { test, expect } from "vitest";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.ts");
const { computeScopePreDigest } = await import("../../src/audit/orchestrator/intentCheckpointExecutor.ts");
const { renderConfirmIntentPrompt } = await import("../../src/audit/cli/confirmIntentStep.ts");
const { MANDATORY_LENSES } = await import("../../src/audit/orchestrator/lensSelection.ts");
const { validateArtifactBundle } = await import("../../src/audit/validation/artifacts.ts");
const { applyIntentExclusionsToCoverage } = await import("../../src/audit/orchestrator/scope.ts");
const { renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.ts");
const { buildPacketPrompt } = await import("../../src/audit/cli/dispatch.ts");

function obligationState(bundle, id) {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id)?.state;
}

// A bundle where every obligation up to and including design_assessment_current
// is satisfied, but the intent checkpoint has not yet been written.
function readyForIntentBundle() {
  return {
    provider_confirmation: {},
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
    design_assessment: { reviewed: false },
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

function validCheckpoint() {
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

await test("decideNextStep advances to design_review_contract_completed once the checkpoint exists", () => {
  const bundle = { ...readyForIntentBundle(), intent_checkpoint: validCheckpoint() };
  expect(decideNextStep(bundle).selected_obligation).toBe("design_review_contract_completed");
});

// ── Deterministic scope pre-digest ──────────────────────────────────────────

await test("computeScopePreDigest counts auditable files and surfaces auto-exclusions", () => {
  const bundle = {
    repo_manifest: {
      files: [
        { path: "src/a.ts" },
        { path: "src/b.ts" },
        { path: "lib/c.ts" },
        { path: "node_modules/x/y.js" },
        { path: "dist/out.js" },
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
    intent_checkpoint: missingConfirmedBy,
  }).filter((i) => JSON.stringify(i).includes("intent_checkpoint"));
  expect(issues.length > 0).toBeTruthy();
});

// ── Phase A: conceptual charter spine gate ──────────────────────────────────

await test("validateArtifactBundle accepts a checkpoint carrying well-formed charters", () => {
  const issues = validateArtifactBundle({
    intent_checkpoint: {
      ...validCheckpoint(),
      design_review: {
        conceptual_depth: "shallow",
        charters: [
          {
            charter_id: "s1",
            kind: "stated",
            purpose: "the pipeline exists to extract max value from finite budgets",
            provenance: [{ kind: "doc", ref: "docs/HANDOFF.md" }],
            confidence: "high",
          },
        ],
      },
    },
  }).filter((i) => JSON.stringify(i).includes("charters"));
  expect(issues.length).toBe(0);
});

await test("validateArtifactBundle emits an issue for a gate-dropped (non-falsifiable) `true` charter", () => {
  const issues = validateArtifactBundle({
    intent_checkpoint: {
      ...validCheckpoint(),
      design_review: {
        charters: [
          {
            charter_id: "t1",
            kind: "true",
            purpose: "you want a personal-finance product, not a tax calculator",
            provenance: [],
            confidence: "medium",
            nominated_alternative: "Quicken",
            // nominated_cost intentionally omitted → non-falsifiable → dropped
          },
        ],
      },
    },
  }).filter((i) => JSON.stringify(i).includes("charters"));
  expect(issues.length).toBe(1);
  expect(JSON.stringify(issues[0])).toContain("t1");
});

// ── A2: consume the accepted scope ──────────────────────────────────────────

function coverageFile(path) {
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
  const coverage = {
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
  expect(pruned.audit_status).toBe("excluded");
  expect(pruned.classification_status).toBe("out_of_scope_intent");
  expect(pruned.required_lenses).toEqual([]);
  expect(coverage.files.find((f) => f.path === "src/scratchpad.ts").audit_status).toBe("pending");
});

await test("applyIntentExclusionsToCoverage is a no-op without exclusions", () => {
  const coverage = { files: [coverageFile("src/a.ts")] };
  expect(applyIntentExclusionsToCoverage(coverage, undefined)).toEqual([]);
  expect(applyIntentExclusionsToCoverage(coverage, [])).toEqual([]);
  expect(coverage.files[0].audit_status).toBe("pending");
});

function emptyRenderableReport() {
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

function minimalPacket() {
  return {
    packet_id: "pkt-1",
    task_ids: ["t1"],
    lenses: ["security"],
    estimated_tokens: 100,
    file_paths: ["src/a.ts"],
    total_lines: 10,
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
