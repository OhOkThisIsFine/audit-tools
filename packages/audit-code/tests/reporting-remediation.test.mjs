import test from "node:test";
import assert from "node:assert/strict";

const { mergeFindings } = await import("../dist/reporting/mergeFindings.js");
const {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} = await import("../dist/reporting/synthesis.js");

test("mergeFindings deduplicates duplicate findings and aggregates runtime plus analyzer evidence", () => {
  const merged = mergeFindings(
    [
      {
        task_id: "task-1",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 20 }],
        findings: [
          {
            id: "finding-1",
            title: "Missing audit trail",
            category: "security",
            severity: "medium",
            confidence: "low",
            lens: "security",
            summary: "Authentication failures are not logged.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 3, line_end: 5 },
              { path: "src/lib/session.ts", line_start: 8, line_end: 9 },
            ],
            evidence: ["manual-review", "shared-evidence"],
            systemic: true,
          },
          {
            id: "finding-aux",
            title: "Secondary note",
            category: "maintainability",
            severity: "low",
            confidence: "medium",
            lens: "maintainability",
            summary: "Helper naming can be clearer.",
            affected_files: [{ path: "src/lib/session.ts", line_start: 20 }],
            evidence: ["maint-note"],
          },
        ],
      },
      {
        task_id: "task-2",
        unit_id: "src-api-auth",
        pass_id: "pass:correctness",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 20 }],
        findings: [
          {
            id: "finding-2",
            title: "Missing audit trail",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary:
              "Authentication failures are not logged consistently across the auth/session boundary.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 3, line_end: 5 },
              {
                path: "src/lib/session.ts",
                line_start: 2,
                line_end: 4,
                symbol: "createSession",
              },
            ],
            impact: "Investigations lose audit fidelity.",
            likelihood: "High for repeated login failures.",
            evidence: ["shared-evidence", "second-pass-review"],
          },
        ],
      },
    ],
    {
      results: [
        {
          task_id: "rv-pending",
          status: "pending",
          summary: "Pending runtime evidence should stay out of findings.",
        },
        {
          task_id: "rv-confirmed",
          status: "confirmed",
          summary: "Runtime replay reproduced the missing log path.",
        },
      ],
    },
    {
      tool: "semgrep",
      results: [
        {
          id: "sg-auth",
          category: "security",
          severity: "warning",
          path: "src/api/auth.ts",
          summary: "Analyzer corroborates missing auth logging.",
        },
      ],
    },
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "Missing audit trail");
  assert.equal(merged[0].severity, "high");
  assert.equal(merged[0].confidence, "high");
  assert.equal(
    merged[0].summary,
    "Authentication failures are not logged consistently across the auth/session boundary.",
  );
  assert.equal(merged[0].impact, "Investigations lose audit fidelity.");
  assert.equal(merged[0].likelihood, "High for repeated login failures.");
  assert.equal(merged[0].systemic, true);
  assert.deepEqual(
    merged[0].affected_files.map((file) => `${file.path}:${file.line_start ?? ""}`),
    [
      "src/api/auth.ts:3",
      "src/lib/session.ts:2",
      "src/lib/session.ts:8",
    ],
  );
  assert.deepEqual(merged[0].evidence, [
    "manual-review",
    "shared-evidence",
    "second-pass-review",
    "rv-confirmed: confirmed — Runtime replay reproduced the missing log path.",
    "external:semgrep:src/api/auth.ts:Analyzer corroborates missing auth logging.",
  ]);
  assert.equal(
    merged[0].evidence.some((entry) => /pending runtime evidence/i.test(entry)),
    false,
  );
  assert.equal(merged[1].title, "Secondary note");
});

test("buildAuditReportModel forwards external analyzer context into merged findings and summary counts", () => {
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "task-1",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 12 }],
        findings: [
          {
            id: "finding-1",
            title: "Missing audit trail",
            category: "security",
            severity: "medium",
            confidence: "medium",
            lens: "security",
            summary: "Authentication events are not captured consistently.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 2, line_end: 6 },
            ],
            evidence: ["manual-review"],
          },
        ],
      },
    ],
    unitManifest: {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          files: ["src/api/auth.ts"],
          required_lenses: ["security"],
        },
      ],
    },
    coverageMatrix: {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "complete",
          required_lenses: ["security"],
          completed_lenses: ["security"],
        },
        {
          path: "docs/notes.md",
          unit_ids: [],
          classification_status: "excluded",
          audit_status: "excluded",
          required_lenses: [],
          completed_lenses: [],
        },
      ],
    },
    runtimeValidationReport: {
      results: [
        {
          task_id: "rv-confirmed",
          status: "confirmed",
          summary: "Runtime replay reproduced the missing log path.",
        },
        {
          task_id: "rv-not-required",
          status: "not_required",
          summary: "No deterministic check was needed for docs.",
        },
      ],
    },
    externalAnalyzerResults: {
      tool: "semgrep",
      results: [
        {
          id: "sg-auth",
          category: "security",
          severity: "warning",
          path: "src/api/auth.ts",
          summary: "Analyzer corroboration.",
        },
      ],
    },
  });

  assert.equal(report.summary.finding_count, 1);
  assert.equal(report.summary.work_block_count, 1);
  assert.equal(report.summary.severity_breakdown.medium, 1);
  assert.equal(report.summary.runtime_validation_status_breakdown.confirmed, 1);
  assert.equal(
    report.summary.runtime_validation_status_breakdown.not_required,
    1,
  );
  assert.equal(report.summary.audited_file_count, 1);
  assert.equal(report.summary.excluded_file_count, 1);
  assert.ok(
    report.findings[0].evidence.includes(
      "external:semgrep:src/api/auth.ts:Analyzer corroboration.",
    ),
  );

  const markdown = renderAuditReportMarkdown(report);
  assert.match(markdown, /Severity breakdown: medium: 1/);
  assert.match(
    markdown,
    /external:semgrep:src\/api\/auth\.ts:Analyzer corroboration\./,
  );
});

// ── Cross-lens dedup ────────────────────────────────────────────────────────

function makeFinding(overrides) {
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

function wrapResult(findings) {
  return {
    task_id: "t-1",
    unit_id: "u-1",
    pass_id: "pass:x",
    lens: "correctness",
    file_coverage: [{ path: "src/foo.ts", total_lines: 100 }],
    findings,
  };
}

test("cross-lens dedup merges findings with same title and file from different lenses", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({ id: "TST-001", title: "Suite executes compiled dist", lens: "tests" }),
    ]),
    wrapResult([
      makeFinding({ id: "COR-001", title: "Suite executes compiled dist", lens: "correctness" }),
    ]),
  ]);
  assert.equal(merged.length, 1);
});

test("cross-lens dedup merges findings with similar titles (Jaccard > 0.5) from different lenses", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({
        id: "TST-001",
        title: "Missing test coverage for compiled dist",
        lens: "tests",
        severity: "medium",
      }),
    ]),
    wrapResult([
      makeFinding({
        id: "COR-001",
        title: "Test coverage gaps for compiled dist output",
        lens: "correctness",
        severity: "high",
      }),
    ]),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, "high");
});

test("cross-lens dedup keeps findings with different titles from different lenses", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({ id: "SEC-001", title: "SQL injection in login handler", lens: "security" }),
    ]),
    wrapResult([
      makeFinding({ id: "TST-001", title: "Test coverage below threshold", lens: "tests" }),
    ]),
  ]);
  assert.equal(merged.length, 2);
});

test("cross-lens dedup does not affect same-lens findings with different titles", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({ id: "SEC-001", title: "SQL injection in login", lens: "security" }),
      makeFinding({ id: "SEC-002", title: "Unvalidated query parameters", lens: "security" }),
    ]),
  ]);
  assert.equal(merged.length, 2);
});

test("cross-lens dedup merges evidence from absorbed finding", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({ id: "A-001", title: "Missing validation", lens: "security", evidence: ["ev-sec"] }),
    ]),
    wrapResult([
      makeFinding({ id: "B-001", title: "Missing validation", lens: "correctness", evidence: ["ev-cor"] }),
    ]),
  ]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].evidence.includes("ev-sec"));
  assert.ok(merged[0].evidence.includes("ev-cor"));
});
