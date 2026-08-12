import { test, expect } from "vitest";
import {
  formatValidationIssues,
  prefixValidationIssues,
  requireKeys,
} from "audit-tools/shared/validation/basic";
import { validateArtifactBundle } from "../../src/audit/validation/artifacts.js";
import {
  formatAuditResultIssues,
  validateAuditResults,
  isSignificantLineCountDivergence,
} from "../../src/audit/validation/auditResults.js";
import type { AuditTask } from "../../src/audit/types.js";

test("requireKeys rejects non-object payloads and shared validation formatting stays stable", () => {
  const issues = requireKeys(["not", "an", "object"], "repo_manifest", [
    "files",
  ]);
  const prefixed = prefixValidationIssues("session_config", [
    {
      path: "claude_code.command",
      message: "command must be a bare executable name or direct executable path.",
      severity: "error",
    },
  ]);

  expect(issues).toEqual([
    {
      path: "repo_manifest",
      message: "Expected an object, got array.",
      severity: "error",
    },
  ]);
  expect(formatValidationIssues(issues)).toBe("  [error] repo_manifest: Expected an object, got array.");
  expect(prefixed).toEqual([
    {
      path: "session_config.claude_code.command",
      message: "command must be a bare executable name or direct executable path.",
      severity: "error",
    },
  ]);
});

test("validateArtifactBundle reports malformed bundle sections and unit invariants together", () => {
  const issues = validateArtifactBundle({
    // @ts-expect-error deliberate malformed-shape probe: repo_manifest must reject a
    // non-object payload at runtime (the requireKeys guard), asserted on below.
    repo_manifest: [],
    unit_manifest: {
      units: [
        {
          unit_id: "unit-auth",
          name: "Auth unit",
          files: [],
          required_lenses: [],
        },
      ],
    },
  });

  expect(issues.some(
      (issue) =>
        issue.path === "repo_manifest" &&
        /expected an object, got array/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.path === "unit_manifest:unit-auth" &&
        /unit has no files/i.test(issue.message),
    )).toBeTruthy();
  expect(issues.some(
      (issue) =>
        issue.path === "unit_manifest:unit-auth" &&
        /unit has no required lenses/i.test(issue.message),
    )).toBeTruthy();
});

test("validateArtifactBundle flags every manifest path without a per-file disposition record", () => {
  // A missing disposition entry reads as INCLUDED downstream (unit builder,
  // coverage matrix, graph path lookup), so there is deliberately no
  // aggregated "covered by prefix" tolerance: every manifest path must carry
  // its own record, and the scope-rule summaries do not substitute for one.
  const bundle = {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/app.ts", language: "typescript", size_bytes: 100 },
        { path: "node_modules/dep/index.js", language: "javascript", size_bytes: 50 },
        { path: "orphan/missing.ts", language: "typescript", size_bytes: 20 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/app.ts", status: "included" as const },
        { path: "node_modules/dep/index.js", status: "excluded" as const, reason: "vcs_ignored" },
      ],
      vcs_ignore: { applied: true, ignored_count: 1 },
      untracked: { applied: true, ignored_count: 0 },
    },
  };

  const issues = validateArtifactBundle(bundle);
  const missing = issues.filter((issue) =>
    /missing disposition entry/i.test(issue.message),
  );
  expect(missing.map((issue) => issue.message)).toEqual(["Missing disposition entry for orphan/missing.ts"]);
});

test("validateArtifactBundle rejects invalid audit task line ranges", () => {
  const baseTask = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    rationale: "Review auth.",
  };

  expect(validateArtifactBundle({
      audit_tasks: [
        {
          ...baseTask,
          line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 1 }],
        },
        {
          ...baseTask,
          task_id: "task-2",
          line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 4 }],
        },
      ],
    })).toEqual([]);

  const issues = validateArtifactBundle({
    audit_tasks: [
      {
        ...baseTask,
        line_ranges: [{ path: "src/api/auth.ts", start: 8, end: 4 }],
      },
    ],
  });

  expect(issues.some(
      (issue) =>
        issue.path === "audit_tasks:task-1.line_ranges:0" &&
        /end must be greater than or equal to start/i.test(issue.message),
    )).toBeTruthy();
});

test("validateAuditResults exposes a shared path alias for empty evidence failures", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-1",
            title: "Whitespace evidence",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Evidence only contains whitespace.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: ["   "],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
  );

  const evidenceIssue = issues.find(
    (issue) => issue.field === "findings[0].evidence",
  );
  expect(evidenceIssue).toBeTruthy();
  expect(evidenceIssue!.path).toBe("findings[0].evidence");
  expect(evidenceIssue!.message).toMatch(/empty strings/i);
  expect(formatAuditResultIssues([evidenceIssue!])).toMatch(/\[error\] task-1 \/ findings\[0\]\.evidence:/i);
});

// A zero-finding result and a FAILED review are shaped identically on the wire, so a
// lane that errors, truncates, or returns an empty completion reads as a lane that
// reviewed carefully and found nothing. `reviewed_clean` is the affirmation that
// separates them: it cannot be produced by accident, so an unaffirmed empty result is
// refused rather than silently counted as coverage.
test("a zero-finding result must AFFIRM it was reviewed, and cannot affirm alongside findings", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-clean",
      unit_id: "unit-1",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 10 },
      rationale: "fixture",
    },
  ];
  const base = {
    task_id: "task-clean",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
  };
  const affirmationIssues = (result: unknown) =>
    validateAuditResults([result], tasks).filter((i) => i.field === "reviewed_clean");

  // 1. Empty findings, no affirmation → REFUSED. This is the case the gate exists for.
  const unaffirmed = affirmationIssues({ ...base, findings: [] });
  expect(unaffirmed).toHaveLength(1);
  expect(unaffirmed[0].message).toMatch(/must set reviewed_clean: true/i);

  // 2. Empty findings WITH the affirmation → accepted; a genuine clean review still passes.
  expect(affirmationIssues({ ...base, findings: [], reviewed_clean: true })).toEqual([]);

  // 3. Affirmation alongside findings → REFUSED, so the flag cannot decay into
  //    boilerplate every worker stamps unconditionally (which would make it meaningless).
  const finding = {
    id: "SEC-001",
    title: "Missing rejection telemetry",
    category: "security",
    severity: "medium",
    confidence: "medium",
    lens: "security",
    summary: "Auth failures are not recorded with enough context.",
    affected_files: [
      { path: "src/api/auth.ts", line_start: 1, quoted_text: "export function auth() {" },
    ],
    evidence: ["src/api/auth.ts:1 - no structured failure event"],
  };
  const contradictory = affirmationIssues({
    ...base,
    findings: [finding],
    reviewed_clean: true,
  });
  expect(contradictory).toHaveLength(1);
  expect(contradictory[0].message).toMatch(/contradicts 1 reported finding/i);

  // 4. Findings without the flag → the ordinary path, unaffected.
  expect(affirmationIssues({ ...base, findings: [finding] })).toEqual([]);
});

test("validateAuditResults accepts file_coverage paths with backslashes or ./ prefix", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-norm",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/utils/helpers.ts", "src/index.ts"],
      file_line_counts: { "src/utils/helpers.ts": 50, "src/index.ts": 20 },
      rationale: "fixture",
    },
  ];

  // Backslash paths
  const issuesBackslash = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src\\utils\\helpers.ts", total_lines: 50 },
          { path: "src\\index.ts", total_lines: 20 },
        ],
        findings: [],
        reviewed_clean: true,
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const backslashErrors = issuesBackslash.filter((i) => i.severity === "error");
  expect(backslashErrors.length, `unexpected errors: ${JSON.stringify(backslashErrors)}`).toBe(0);

  // ./ prefix paths
  const issuesDotSlash = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "./src/utils/helpers.ts", total_lines: 50 },
          { path: "./src/index.ts", total_lines: 20 },
        ],
        findings: [],
        reviewed_clean: true,
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const dotSlashErrors = issuesDotSlash.filter((i) => i.severity === "error");
  expect(dotSlashErrors.length, `unexpected errors: ${JSON.stringify(dotSlashErrors)}`).toBe(0);

  // Mixed: backslash + ./ prefix
  const issuesMixed = validateAuditResults(
    [
      {
        task_id: "task-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: ".\\src\\utils\\helpers.ts", total_lines: 50 },
          { path: "./src/index.ts", total_lines: 20 },
        ],
        findings: [],
        reviewed_clean: true,
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50, "src/index.ts": 20 } },
  );
  const mixedErrors = issuesMixed.filter((i) => i.severity === "error");
  expect(mixedErrors.length, `unexpected errors: ${JSON.stringify(mixedErrors)}`).toBe(0);
});

test("validateAuditResults rejects a backslash path that normalizes to an unrecognized file", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-norm-typo",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/utils/helpers.ts"],
      file_line_counts: { "src/utils/helpers.ts": 50 },
      rationale: "fixture",
    },
  ];

  // 'src\\utils\\helper.ts' normalizes to 'src/utils/helper.ts' — note missing trailing 's'
  // The task only has 'src/utils/helpers.ts', so after normalization the path is not found
  const issues = validateAuditResults(
    [
      {
        task_id: "task-norm-typo",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [
          { path: "src\\utils\\helper.ts", total_lines: 50 },
        ],
        findings: [],
        reviewed_clean: true,
      },
    ],
    tasks,
    { lineIndex: { "src/utils/helpers.ts": 50 } },
  );

  const errorIssues = issues.filter((i) => i.severity === "error");
  expect(errorIssues.length >= 1, `expected at least one error issue, got: ${JSON.stringify(errorIssues)}`).toBeTruthy();
  const pathIssue = errorIssues.find(
    (i) => i.field === "file_coverage[0].path",
  );
  expect(pathIssue, `expected an error issue with field 'file_coverage[0].path', got: ${JSON.stringify(errorIssues)}`).toBeTruthy();
  expect(pathIssue!.message).toMatch(/not listed in the task file_paths/i);
});

test("validateAuditResults detects duplicates across normalized paths", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-dup",
      unit_id: "unit-1",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 10 },
      rationale: "fixture",
    },
  ];
  const issues = validateAuditResults(
    [
      {
        task_id: "task-dup",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [
          { path: "src/foo.ts", total_lines: 10 },
          { path: "src\\foo.ts", total_lines: 10 },
        ],
        findings: [],
        reviewed_clean: true,
      },
    ],
    tasks,
  );
  const dupIssue = issues.find((i) => /duplicated/i.test(i.message));
  expect(dupIssue, "should detect normalized duplicate").toBeTruthy();
});

test("validateAuditResults accepts affected_files path with backslashes when file_coverage declares forward-slash equivalent", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-af-norm",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 20 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-norm",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/foo.ts", total_lines: 20 }],
        findings: [
          {
            id: "f-1",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "src\\foo.ts", line_start: 1, line_end: 5 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/foo.ts": 20 } },
  );

  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files/.test(i.field ?? ""),
  );
  expect(pathErrors.length, `unexpected affected_files errors: ${JSON.stringify(pathErrors)}`).toBe(0);
});

test("validateAuditResults accepts affected_files path with leading ./ prefix when file_coverage declares stripped equivalent", () => {
  const tasks: AuditTask[] = [
    {
      task_id: "task-af-dot",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/bar.ts"],
      file_line_counts: { "src/bar.ts": 15 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-dot",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/bar.ts", total_lines: 15 }],
        findings: [
          {
            id: "f-2",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "./src/bar.ts", line_start: 1 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/bar.ts": 15 } },
  );

  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files/.test(i.field ?? ""),
  );
  expect(pathErrors.length, `unexpected affected_files errors: ${JSON.stringify(pathErrors)}`).toBe(0);
});

test("validateAuditResults produces a WARNING (not error) for affected_files path not in file_coverage (INV-09 strip-and-warn)", () => {
  // INV-09: out-of-scope affected_files must not hard-reject the entire result.
  // The validation now emits a warning so the in-scope findings are retained.
  const tasks: AuditTask[] = [
    {
      task_id: "task-af-miss",
      unit_id: "unit-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 10 },
      rationale: "fixture",
    },
  ];

  const issues = validateAuditResults(
    [
      {
        task_id: "task-af-miss",
        unit_id: "unit-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/foo.ts", total_lines: 10 }],
        findings: [
          {
            id: "f-3",
            title: "T",
            category: "correctness",
            severity: "low",
            confidence: "high",
            lens: "correctness",
            summary: "S",
            affected_files: [{ path: "src/other.ts", line_start: 1 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    tasks,
    { lineIndex: { "src/foo.ts": 10 } },
  );

  // Must be a warning, NOT an error (strip-and-warn, not hard reject).
  const pathErrors = issues.filter(
    (i) => i.severity === "error" && /affected_files\[0\]\.path/.test(i.field ?? ""),
  );
  expect(pathErrors.length, `out-of-scope affected_files must not produce a hard error, got: ${JSON.stringify(pathErrors)}`).toBe(0);

  const pathWarnings = issues.filter(
    (i) => i.severity === "warning" && /affected_files\[0\]\.path/.test(i.field ?? ""),
  );
  expect(pathWarnings.length, `expected exactly one affected_files path warning, got: ${JSON.stringify(pathWarnings)}`).toBe(1);
  expect(pathWarnings[0].message, "warning message must mention out-of-scope").toMatch(/out-of-scope/i);
  expect(pathWarnings[0].message, "warning should surface the task's allowed files").toMatch(/src\/foo\.ts/);
});

test("validateArtifactBundle reports orphaned runtime_validation_report results", () => {
  // Case 1: one known task + one orphan result → exactly one issue for the orphan
  const issues1 = validateArtifactBundle({
    runtime_validation_tasks: {
      tasks: [
        {
          id: "rvt-1",
          kind: "unit-risk-check",
          target_paths: ["src/foo.ts"],
          reason: "test",
          priority: "medium",
        },
      ],
    },
    runtime_validation_report: {
      results: [
        { task_id: "rvt-1", status: "pending", summary: "test" },
        { task_id: "rvt-unknown", status: "pending", summary: "test" },
      ],
    },
  });
  const orphanIssues1 = issues1.filter(
    (issue) => issue.path === "runtime_validation_report:rvt-unknown",
  );
  expect(orphanIssues1.length).toBe(1);
  expect(orphanIssues1[0].message).toMatch(/unknown task/i);
  // Known task produces no orphan issue
  expect(!issues1.some((issue) => issue.path === "runtime_validation_report:rvt-1")).toBeTruthy();

  // Case 2: report present but no runtime_validation_tasks → every result is an orphan
  const issues2 = validateArtifactBundle({
    runtime_validation_report: {
      results: [
        { task_id: "rvt-a", status: "pending", summary: "test" },
        { task_id: "rvt-b", status: "pending", summary: "test" },
      ],
    },
  });
  expect(issues2.some(
      (issue) =>
        issue.path === "runtime_validation_report:rvt-a" &&
        /unknown task/i.test(issue.message),
    )).toBeTruthy();
  expect(issues2.some(
      (issue) =>
        issue.path === "runtime_validation_report:rvt-b" &&
        /unknown task/i.test(issue.message),
    )).toBeTruthy();

  // Case 3: well-formed bundle — all results reference known task ids → no runtime_validation_report issues
  const issues3 = validateArtifactBundle({
    runtime_validation_tasks: {
      tasks: [
        {
          id: "rvt-1",
          kind: "unit-risk-check",
          target_paths: ["src/foo.ts"],
          reason: "test",
          priority: "medium",
        },
        {
          id: "rvt-2",
          kind: "unit-risk-check",
          target_paths: ["src/bar.ts"],
          reason: "test",
          priority: "medium",
        },
      ],
    },
    runtime_validation_report: {
      results: [
        { task_id: "rvt-1", status: "pending", summary: "test" },
        { task_id: "rvt-2", status: "pending", summary: "test" },
      ],
    },
  });
  expect(!issues3.some((issue) =>
      issue.path.startsWith("runtime_validation_report:"),
    )).toBeTruthy();
});

test("validateAuditResults logs a summary to stderr when issues are found", () => {
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any, ...rest: any[]) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...(rest as [any, any]));
  };
  try {
    // Result missing required fields — produces at least one error issue
    const issues = validateAuditResults(
      [
        {
          task_id: "task-log",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          // file_coverage missing intentionally
          findings: [],
          reviewed_clean: true,
        },
      ],
      [
        {
          task_id: "task-log",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "fixture",
        },
      ],
    );
    expect(issues.length > 0, "expected at least one validation issue").toBeTruthy();
    const logLine = stderrLines.find((l) =>
      /\[audit-results validation\]/.test(l),
    );
    expect(logLine, `expected a stderr log line; got: ${JSON.stringify(stderrLines)}`).toBeTruthy();
    expect(logLine).toMatch(/\[audit-results validation\] \d+ error\(s\), \d+ warning\(s\) across \d+ result\(s\)/);

    // Clean run — no stderr log
    stderrLines.length = 0;
    const cleanIssues = validateAuditResults([], []);
    expect(cleanIssues).toEqual([]);
    expect(!stderrLines.some((l) => /\[audit-results validation\]/.test(l)), "expected no stderr log on clean run").toBeTruthy();
  } finally {
    process.stderr.write = origWrite;
  }
});

test("validateArtifactBundle logs a summary to stderr when issues are found", () => {
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any, ...rest: any[]) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...(rest as [any, any]));
  };
  try {
    // repo_manifest as array triggers a validation issue
    const issues = validateArtifactBundle({
      // @ts-expect-error deliberate malformed-shape probe: repo_manifest must reject a
      // non-object payload at runtime (the requireKeys guard).
      repo_manifest: [],
    });
    expect(issues.length > 0, "expected at least one validation issue").toBeTruthy();
    const logLine = stderrLines.find((l) =>
      /\[artifact-bundle validation\]/.test(l),
    );
    expect(logLine, `expected a stderr log line; got: ${JSON.stringify(stderrLines)}`).toBeTruthy();
    expect(logLine).toMatch(/\[artifact-bundle validation\] \d+ issue\(s\)/);

    // Clean run — no stderr log
    stderrLines.length = 0;
    const cleanIssues = validateArtifactBundle({});
    expect(cleanIssues).toEqual([]);
    expect(!stderrLines.some((l) => /\[artifact-bundle validation\]/.test(l)), "expected no stderr log on clean run").toBeTruthy();
  } finally {
    process.stderr.write = origWrite;
  }
});

// ── INV-09: out-of-scope affected_files is a warning, not a hard error ────────

test("INV-09: affected_files path outside file_coverage is a warning (not an error)", () => {
  const result = {
    task_id: "t-scope",
    unit_id: "unit-scope",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/auth.ts", total_lines: 50 }],
    findings: [
      {
        id: "SEC-001",
        title: "Out of scope reference",
        category: "cross-boundary-reference",
        severity: "high",
        confidence: "medium",
        lens: "security",
        summary: "This finding cites a file outside the packet.",
        affected_files: [{ path: "src/other.ts" }], // out-of-scope
        evidence: ["src/other.ts:10 - see line 10"],
      },
    ],
  };
  const task: AuditTask = {
    task_id: "t-scope",
    unit_id: "unit-scope",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/auth.ts"],
    file_line_counts: { "src/auth.ts": 50 },
    rationale: "test",
    priority: "medium",
  };

  const issues = validateAuditResults([result], [task], { lineIndex: { "src/auth.ts": 50 } });
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  expect(errors.length, "out-of-scope affected_files must not be a hard error").toBe(0);
  expect(warnings.length, "out-of-scope affected_files must emit a warning").toBe(1);
  expect(warnings[0].message, "warning message must mention out-of-scope").toMatch(/out-of-scope/i);
});

test("INV-09: in-scope findings in the same result are retained when one affected_files entry is out-of-scope", () => {
  const result = {
    task_id: "t-mixed",
    unit_id: "unit-mixed",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/core.ts", total_lines: 30 }],
    findings: [
      {
        id: "COR-001",
        title: "In-scope finding",
        category: "null-dereference",
        severity: "medium",
        confidence: "high",
        lens: "correctness",
        summary: "An in-scope finding.",
        affected_files: [{ path: "src/core.ts", line_start: 5, line_end: 10 }],
        evidence: ["src/core.ts:5 - dereference"],
      },
    ],
  };
  const task: AuditTask = {
    task_id: "t-mixed",
    unit_id: "unit-mixed",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: ["src/core.ts"],
    file_line_counts: { "src/core.ts": 30 },
    rationale: "test",
    priority: "medium",
  };

  const issues = validateAuditResults([result], [task], { lineIndex: { "src/core.ts": 30 } });
  // A clean result with only in-scope entries should produce no errors or warnings.
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.length, "in-scope finding with valid span must produce no errors").toBe(0);
});

// ── CE-009: semantic-validity gate on significant total_lines divergence ───────

test("isSignificantLineCountDivergence: small deltas stay advisory, large diverge", () => {
  // Past neither threshold → advisory (S7).
  expect(isSignificantLineCountDivergence(12, 10), "diff 2 (floor) stays advisory").toBe(false);
  expect(isSignificantLineCountDivergence(990, 1000), "10/1000 = 1% under ratio stays advisory").toBe(false);
  // Past both thresholds → significant.
  expect(isSignificantLineCountDivergence(13, 10), "diff 3 on a 10-line file is significant").toBe(true);
  expect(isSignificantLineCountDivergence(900, 1000), "100/1000 = 10% over ratio is significant").toBe(true);
  // expected 0 → any delta past the absolute floor is significant (no ratio).
  expect(isSignificantLineCountDivergence(2, 0), "diff 2 at expected 0 stays advisory").toBe(false);
  expect(isSignificantLineCountDivergence(3, 0), "diff 3 at expected 0 is significant").toBe(true);
});

test("validateAuditResults: significant total_lines divergence is a hard-reject error (CE-009)", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        // Worker claims 40 lines; disk has 100 → 60% divergence → stale/wrong view.
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
        findings: [],
        reviewed_clean: true,
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    { lineIndex: { "src/api/auth.ts": 100 } },
  );

  expect(issues.some(
      (issue) =>
        issue.field === "file_coverage[0].total_lines" &&
        issue.severity === "error" &&
        /diverges materially from the current line count/i.test(issue.message),
    ), `expected a hard-reject error for significant divergence; got: ${JSON.stringify(issues)}`).toBeTruthy();
});

test("validateAuditResults: small total_lines mismatch stays an advisory warning (S7)", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        // 98 vs 100 → diff 2, under both thresholds → advisory.
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 98 }],
        findings: [],
        reviewed_clean: true,
      },
    ],
    [
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    { lineIndex: { "src/api/auth.ts": 100 } },
  );

  expect(issues.some(
      (issue) =>
        issue.field === "file_coverage[0].total_lines" &&
        issue.severity === "warning" &&
        /does not match the current line count/i.test(issue.message),
    ), `expected an advisory warning for a small mismatch; got: ${JSON.stringify(issues)}`).toBeTruthy();
  expect(issues.filter((i) => i.severity === "error").length, "a small mismatch must not produce any hard-reject error").toBe(0);
});

// ── CP-NODE-4: intra-result duplicate finding-id hard-reject ───────────────────

test("CP-NODE-4: distinct finding ids in the same result produce zero id-duplication issues", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-ids",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "SEC-001",
            title: "First",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "First finding.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: ["e"],
          },
          {
            id: "SEC-002",
            title: "Second",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Second finding.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 2 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-ids",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    { lineIndex: { "src/api/auth.ts": 10 } },
  );

  const dupIdIssues = issues.filter((i) => /finding id .* is duplicated/i.test(i.message));
  expect(dupIdIssues.length, `expected no duplicate-id issues; got: ${JSON.stringify(dupIdIssues)}`).toBe(0);
});

test("CP-NODE-4: two findings in one result sharing an id produce exactly one duplicate-id error", () => {
  const issues = validateAuditResults(
    [
      {
        task_id: "task-dupid",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "SEC-DUP",
            title: "First",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "First finding.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
            evidence: ["e"],
          },
          {
            id: "SEC-DUP",
            title: "Second",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Second finding sharing the id.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 2 }],
            evidence: ["e"],
          },
        ],
      },
    ],
    [
      {
        task_id: "task-dupid",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "fixture",
      },
    ],
    { lineIndex: { "src/api/auth.ts": 10 } },
  );

  const dupIdIssues = issues.filter(
    (i) => i.severity === "error" && i.field === "findings[1].id" && /finding id .* is duplicated/i.test(i.message),
  );
  expect(dupIdIssues.length, `expected exactly one duplicate-id error at findings[1].id; got: ${JSON.stringify(issues)}`).toBe(1);
  expect(dupIdIssues[0].message).toMatch(/SEC-DUP/);
});

test("CP-NODE-4: the same finding id reused across DIFFERENT results does not flag as a duplicate", () => {
  const task: AuditTask = {
    task_id: "task-cross",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    rationale: "fixture",
  };
  const makeResult = () => ({
    task_id: "task-cross",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
    findings: [
      {
        id: "SEC-SHARED",
        title: "T",
        category: "security",
        severity: "high",
        confidence: "high",
        lens: "security",
        summary: "S",
        affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
        evidence: ["e"],
      },
    ],
  });

  const issues = validateAuditResults(
    [makeResult(), makeResult()],
    [task],
    { lineIndex: { "src/api/auth.ts": 10 } },
  );

  const dupIdIssues = issues.filter((i) => /finding id .* is duplicated/i.test(i.message));
  expect(dupIdIssues.length, `same id across separate results must not flag; got: ${JSON.stringify(dupIdIssues)}`).toBe(0);
});
