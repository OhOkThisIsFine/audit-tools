/**
 * seam-worker-affected-files-policy.test.mjs
 *
 * Cross-module seam test: worker-affected-files-policy
 *
 * Verifies the reconciled contract between:
 *   - packages/audit-code/src/prompts/renderWorkerPrompt.ts  (audit-infra)
 *     The worker prompt explicitly states that affected_files entries must
 *     reference the task's assigned file_paths (scope constraint).
 *
 *   - packages/audit-code/src/validation/auditResults.ts  (audit-dispatch)
 *     The merge validator applies a documented strip-and-warn policy for
 *     out-of-scope affected_files entries: the entry is flagged as a WARNING
 *     (not an error), the containing finding is RETAINED (not rejected), and
 *     the overall result is accepted. The whole result is never stranded because
 *     one affected_files path was out-of-scope.
 *
 * Seam obligation: TEST-SEAM-worker-affected-files-policy
 *
 *   SCOPE-CONSTRAINT-1: renderWorkerPrompt (agent mode) explicitly instructs
 *     workers to reference only files in the task's file_paths via affected_files.
 *
 *   SCOPE-CONSTRAINT-2: renderWorkerPrompt output mentions the file_paths scope
 *     restriction via the file_coverage instruction: workers declare file_coverage
 *     per task file_paths, and affected_files must fall within declared coverage.
 *
 *   STRIP-AND-WARN-1: validateAuditResults produces a WARNING (not error) when
 *     an affected_files entry references a path absent from file_coverage.
 *
 *   STRIP-AND-WARN-2: an out-of-scope affected_files path does NOT produce an
 *     error-severity issue; the result passes the error gate.
 *
 *   STRIP-AND-WARN-3: the finding containing the out-of-scope affected_files entry
 *     is RETAINED in the result (the whole result is not stranded).
 *
 *   STRIP-AND-WARN-4: a result with ALL in-scope affected_files entries produces no
 *     warnings or errors for affected_files path scope — the happy path is clean.
 *
 *   STRIP-AND-WARN-5: when the entire result's affected_files are out-of-scope,
 *     the result still passes the error gate (the finding is retained, not stranded).
 *
 *   INTERFACE-PARITY: the file_coverage entries declared in the result (which map
 *     to the task's file_paths) are the sole scope authority — the validator must
 *     not invent a separate allowed-paths list independent of file_coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── Import live modules ───────────────────────────────────────────────────────

const { renderWorkerPrompt } = await import("../src/prompts/renderWorkerPrompt.ts");
const { validateAuditResults } = await import("../src/validation/auditResults.ts");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal WorkerTask in "agent" mode (preferred_executor: "agent"). */
function makeTask(overrides = {}) {
  return {
    contract_version: "remediation-worker/v1alpha1",
    run_id: "seam-run-001",
    repo_root: "/repo",
    artifacts_dir: "/repo/.audit-tools/audit",
    obligation_id: null,
    preferred_executor: "agent",
    result_path: "/repo/.audit-tools/runs/seam-001/result.json",
    audit_results_path: "/repo/.audit-tools/runs/seam-001/audit-results.json",
    pending_audit_tasks_path: "/repo/.audit-tools/runs/seam-001/pending-audit-tasks.json",
    worker_command: ["audit-code", "merge-and-ingest", "--run-id", "seam-001"],
    ...overrides,
  };
}

/** Minimal AuditTask with one assigned file_path. */
function makeAuditTask(overrides = {}) {
  return {
    task_id: "seam-task:correctness",
    unit_id: "seam-unit",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: ["src/auth.ts"],
    rationale: "seam test task",
    ...overrides,
  };
}

/** Minimal valid AuditResult with affected_files within scope (src/auth.ts). */
function makeInScopeResult(overrides = {}) {
  return {
    task_id: "seam-task:correctness",
    unit_id: "seam-unit",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/auth.ts", total_lines: 100 }],
    findings: [
      {
        id: "SEAM-F001",
        title: "In-scope finding",
        category: "General",
        severity: "medium",
        confidence: "medium",
        lens: "correctness",
        summary: "An in-scope finding on the assigned file.",
        affected_files: [{ path: "src/auth.ts", line_start: 10, line_end: 20 }],
        evidence: ["src/auth.ts:10 — unsafe deserialization"],
      },
    ],
    ...overrides,
  };
}

/** AuditResult with one out-of-scope affected_files entry. */
function makeOutOfScopeResult() {
  return {
    task_id: "seam-task:correctness",
    unit_id: "seam-unit",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/auth.ts", total_lines: 100 }],
    findings: [
      {
        id: "SEAM-F002",
        title: "Out-of-scope finding",
        category: "General",
        severity: "medium",
        confidence: "medium",
        lens: "correctness",
        summary: "A finding that mentions a file outside the task scope.",
        // src/other.ts is NOT in file_coverage → out-of-scope
        affected_files: [{ path: "src/other.ts", line_start: 5, line_end: 15 }],
        evidence: ["src/other.ts:5 — related issue"],
      },
    ],
  };
}

// ── SCOPE-CONSTRAINT-1: renderWorkerPrompt mentions file_paths scope ──────────

test("SCOPE-CONSTRAINT-1: renderWorkerPrompt (agent mode) prompt explicitly references file_paths scoping", () => {
  const task = makeTask();
  const prompt = renderWorkerPrompt(task);

  // The prompt must refer to file_paths and the scope restriction so workers
  // know that affected_files must reference only their assigned files.
  assert.ok(
    typeof prompt === "string" && prompt.length > 0,
    "renderWorkerPrompt must return a non-empty string for agent-mode tasks",
  );

  // The worker prompt must reference "file_paths" to establish the scope contract.
  assert.ok(
    prompt.includes("file_paths"),
    "renderWorkerPrompt must mention 'file_paths' to establish the affected_files scope contract for workers",
  );
});

// ── SCOPE-CONSTRAINT-2: prompt includes file_coverage instruction ─────────────

test("SCOPE-CONSTRAINT-2: renderWorkerPrompt (agent mode) instructs workers to declare file_coverage per assigned files", () => {
  const task = makeTask();
  const prompt = renderWorkerPrompt(task);

  // The prompt must mention file_coverage to close the loop between the
  // task's assigned files and the finding's affected_files scope.
  assert.ok(
    prompt.includes("file_coverage"),
    "renderWorkerPrompt must mention 'file_coverage' — workers scope findings via coverage of assigned files",
  );

  // The prompt must mention affected_files so workers know how to structure findings.
  assert.ok(
    prompt.includes("affected_files"),
    "renderWorkerPrompt must mention 'affected_files' so workers understand the finding structure",
  );
});

// ── STRIP-AND-WARN-1: out-of-scope affected_files produces a WARNING ──────────

test("STRIP-AND-WARN-1: validateAuditResults emits a warning (not error) for an out-of-scope affected_files path", () => {
  const result = makeOutOfScopeResult();
  const task = makeAuditTask();
  const issues = validateAuditResults([result], [task]);

  const affectedFileIssues = issues.filter(
    (i) => i.field && i.field.includes("affected_files") && i.field.includes("path"),
  );
  assert.ok(
    affectedFileIssues.length > 0,
    "validateAuditResults must produce at least one issue for out-of-scope affected_files path",
  );

  // All affected_files path issues for this case must be warnings, not errors.
  const errors = affectedFileIssues.filter((i) => i.severity === "error");
  assert.equal(
    errors.length,
    0,
    `Out-of-scope affected_files must produce warning(s), not error(s). Got: ${JSON.stringify(errors.map((e) => e.message))}`,
  );
  const warnings = affectedFileIssues.filter((i) => i.severity === "warning");
  assert.ok(
    warnings.length > 0,
    "validateAuditResults must emit a warning for out-of-scope affected_files path (strip-and-warn policy)",
  );
});

// ── STRIP-AND-WARN-2: no error-severity issues from an out-of-scope path ──────

test("STRIP-AND-WARN-2: validateAuditResults produces NO error-severity issue for an out-of-scope affected_files path", () => {
  const result = makeOutOfScopeResult();
  const task = makeAuditTask();
  const issues = validateAuditResults([result], [task]);

  // Errors from anything OTHER than the out-of-scope path are permissible (e.g.
  // missing evidence, wrong lens). What we guard: the out-of-scope path itself
  // must not emit an error that would block the whole result.
  const outOfScopeErrors = issues.filter(
    (i) =>
      i.severity === "error" &&
      i.field &&
      i.field.includes("affected_files") &&
      i.message &&
      i.message.includes("src/other.ts"),
  );
  assert.equal(
    outOfScopeErrors.length,
    0,
    "No error-severity issue must be emitted for the out-of-scope path itself; found: " +
      JSON.stringify(outOfScopeErrors.map((e) => e.message)),
  );
});

// ── STRIP-AND-WARN-3: finding with out-of-scope path is retained ──────────────

test("STRIP-AND-WARN-3: a result with an out-of-scope affected_files path passes the error gate (finding is retained, not stranded)", () => {
  const result = makeOutOfScopeResult();
  const task = makeAuditTask();
  const issues = validateAuditResults([result], [task]);

  // The result must pass the error gate: zero error-severity issues overall
  // (the out-of-scope path triggers warnings only, so the result is accepted).
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(
    errors.length,
    0,
    "A result with an out-of-scope affected_files path must pass the error gate " +
      "(finding retained, not stranded); errors: " +
      JSON.stringify(errors.map((e) => e.message)),
  );
});

// ── STRIP-AND-WARN-4: happy path — in-scope affected_files produces no issues ──

test("STRIP-AND-WARN-4: validateAuditResults produces no errors or affected_files warnings for a fully in-scope result", () => {
  const result = makeInScopeResult();
  const task = makeAuditTask();
  const issues = validateAuditResults([result], [task]);

  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(
    errors.length,
    0,
    "A fully in-scope result must pass with no errors; found: " +
      JSON.stringify(errors.map((e) => e.message)),
  );

  // No affected_files path warnings either — in-scope is the clean path.
  const affectedPathWarnings = issues.filter(
    (i) =>
      i.severity === "warning" &&
      i.field &&
      i.field.includes("affected_files") &&
      i.field.includes("path"),
  );
  assert.equal(
    affectedPathWarnings.length,
    0,
    "In-scope affected_files must not trigger path warnings; got: " +
      JSON.stringify(affectedPathWarnings.map((w) => w.message)),
  );
});

// ── STRIP-AND-WARN-5: all affected_files out-of-scope → result still passes ───

test("STRIP-AND-WARN-5: result with every affected_files entry out-of-scope passes the error gate (strip-and-warn, not reject-all)", () => {
  // A finding where ALL affected_files are out-of-scope — the strip-and-warn
  // policy must still accept the result at the error gate (not strand it).
  const result = {
    task_id: "seam-task:correctness",
    unit_id: "seam-unit",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/auth.ts", total_lines: 100 }],
    findings: [
      {
        id: "SEAM-F003",
        title: "All out-of-scope finding",
        category: "General",
        severity: "low",
        confidence: "low",
        lens: "correctness",
        summary: "Every affected_files entry references a non-assigned file.",
        affected_files: [
          { path: "src/unrelated-a.ts", line_start: 1, line_end: 5 },
          { path: "src/unrelated-b.ts", line_start: 10, line_end: 20 },
        ],
        evidence: ["unrelated code identified"],
      },
    ],
  };
  const task = makeAuditTask();
  const issues = validateAuditResults([result], [task]);

  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(
    errors.length,
    0,
    "Result with all out-of-scope affected_files must still pass the error gate; errors: " +
      JSON.stringify(errors.map((e) => e.message)),
  );

  // Warnings ARE expected — one per out-of-scope path.
  const affectedPathWarnings = issues.filter(
    (i) => i.severity === "warning" && i.field && i.field.includes("affected_files"),
  );
  assert.ok(
    affectedPathWarnings.length >= 2,
    "Each out-of-scope affected_files path must produce at least one warning; " +
      `got ${affectedPathWarnings.length}`,
  );
});

// ── INTERFACE-PARITY: scope authority is file_coverage (from task's file_paths) ─

test("INTERFACE-PARITY: the file_coverage paths from the assigned task are the sole scope authority for affected_files", () => {
  // Verify the contract: file_coverage declares scope; a path in file_coverage
  // is "in-scope" and a path absent from it is "out-of-scope". The task's
  // file_paths set the declaration authority — a file declared in file_coverage
  // that matches a task file_path is in-scope for affected_files.
  const assignedPath = "src/router.ts";
  const unassignedPath = "src/unrelated.ts";
  const task = makeAuditTask({ file_paths: [assignedPath] });

  // In-scope: affected_files path matches file_coverage path (which matches file_paths).
  const inScopeResult = makeInScopeResult({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: [{ path: assignedPath, total_lines: 50 }],
    findings: [
      {
        id: "SEAM-F004",
        title: "In-scope router finding",
        category: "General",
        severity: "low",
        confidence: "low",
        lens: "correctness",
        summary: "Issue in the assigned file.",
        affected_files: [{ path: assignedPath, line_start: 1, line_end: 5 }],
        evidence: ["src/router.ts:1 — issue here"],
      },
    ],
  });
  const inScopeIssues = validateAuditResults([inScopeResult], [task]);
  const inScopeAffectedErrors = inScopeIssues.filter(
    (i) => i.severity === "error" && i.field && i.field.includes("affected_files"),
  );
  assert.equal(
    inScopeAffectedErrors.length,
    0,
    `Path '${assignedPath}' declared in file_coverage must be in-scope for affected_files`,
  );

  // Out-of-scope: affected_files path NOT in file_coverage.
  const outOfScopeResult = {
    ...inScopeResult,
    findings: [
      {
        ...inScopeResult.findings[0],
        id: "SEAM-F005",
        affected_files: [{ path: unassignedPath, line_start: 1, line_end: 5 }],
        evidence: ["src/unrelated.ts:1 — cross-file reference"],
      },
    ],
  };
  const outOfScopeIssues = validateAuditResults([outOfScopeResult], [task]);
  const outOfScopeErrors = outOfScopeIssues.filter(
    (i) =>
      i.severity === "error" &&
      i.field &&
      i.field.includes("affected_files") &&
      i.message &&
      i.message.includes(unassignedPath),
  );
  assert.equal(
    outOfScopeErrors.length,
    0,
    `Path '${unassignedPath}' absent from file_coverage must not produce an error (strip-and-warn policy)`,
  );

  const outOfScopeWarnings = outOfScopeIssues.filter(
    (i) =>
      i.severity === "warning" &&
      i.field &&
      i.field.includes("affected_files"),
  );
  assert.ok(
    outOfScopeWarnings.length > 0,
    `Path '${unassignedPath}' absent from file_coverage must produce a warning (strip-and-warn policy)`,
  );
});
