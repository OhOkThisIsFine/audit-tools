/**
 * ONE shared reporting-test fixture (TST/MNT-1bfd0034, TST/MNT-7b2d18c9):
 * `makeFinding` / `wrapResult` were duplicated verbatim in
 * reporting-invariants.test.mjs and reporting-remediation.test.mjs — two copies
 * of the same canonical shapes that could silently drift apart. Single-sourced
 * here; both suites import from this module and never re-declare them.
 */

/** A canonical Finding literal; override any field per test. */
export function makeFinding(overrides = {}) {
  return {
    id: "F-001",
    title: "Example finding",
    category: "General",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "Example summary.",
    affected_files: [{ path: "src/foo.ts", line_start: 1, line_end: 10 }],
    evidence: ["ev-1"],
    ...overrides,
  };
}

/** Wrap findings in a canonical AuditResult; override any field per test. */
export function wrapResult(findings, overrides = {}) {
  return {
    task_id: "t-1",
    unit_id: "u-1",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/foo.ts", total_lines: 100 }],
    findings,
    ...overrides,
  };
}
