import test from "node:test";
import assert from "node:assert/strict";

const { mergeFindings } = await import("../src/reporting/mergeFindings.ts");
const {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} = await import("../src/reporting/synthesis.ts");

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

test("renderAuditReportMarkdown includes finding categories", () => {
  const report = {
    summary: {
      finding_count: 2,
      work_block_count: 0,
      severity_breakdown: { medium: 2 },
      lens_breakdown: { architecture: 2 },
      audited_file_count: 1,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    work_blocks: [],
    findings: [
      {
        id: "DR-001",
        title: "Implicit tenant boundary is unenforced",
        category: "inferred_contract_gap",
        severity: "medium",
        confidence: "high",
        lens: "architecture",
        summary: "The code assumes a tenant boundary without enforcing it.",
        affected_files: [{ path: "src/tenant.ts", line_start: 12 }],
        evidence: ["design-review"],
      },
      {
        id: "DR-002",
        title: "Trust boundary is unclear",
        category: "trust_boundary_gap",
        severity: "medium",
        confidence: "medium",
        lens: "architecture",
        summary: "External input crosses into internal state without a named boundary.",
        affected_files: [{ path: "src/input.ts", line_start: 7 }],
        evidence: ["design-review"],
      },
    ],
  };

  const markdown = renderAuditReportMarkdown(report);

  assert.match(markdown, /- Category: inferred_contract_gap/);
  assert.match(markdown, /- Category: trust_boundary_gap/);
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

// ── designAssessment branch ────────────────────────────────────────────────

test("mergeFindings includes designAssessment.findings in output", () => {
  const designFinding = makeFinding({
    id: "DA-001",
    title: "Architectural coupling violation",
    severity: "high",
    lens: "architecture",
  });
  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    { generated_at: "2026-01-01T00:00:00Z", findings: [designFinding] },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Architectural coupling violation");
  assert.equal(merged[0].severity, "high");
  assert.equal(merged[0].lens, "architecture");
});

test("mergeFindings includes designAssessment.review_findings in output", () => {
  const designFinding = makeFinding({
    id: "DA-001",
    title: "Design finding A",
    severity: "medium",
    lens: "architecture",
  });
  const reviewFinding = makeFinding({
    id: "DA-002",
    title: "Design review finding B",
    category: "Coupling",
    severity: "low",
    lens: "architecture",
    affected_files: [{ path: "src/bar.ts", line_start: 5, line_end: 15 }],
  });
  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [designFinding],
      review_findings: [reviewFinding],
    },
  );
  assert.equal(merged.length, 2);
  const titles = merged.map((f) => f.title);
  assert.ok(titles.includes("Design finding A"));
  assert.ok(titles.includes("Design review finding B"));
});

test("mergeFindings merges an AuditResult finding into a matching designAssessment finding", () => {
  // The designAssessment finding and the AuditResult finding share the same
  // findingKey (lens|category|title|primaryPath|line_start|line_end), so
  // mergeFindings should update the existing entry rather than add a duplicate.
  const sharedProps = {
    title: "Unchecked null dereference",
    category: "General",
    lens: "correctness",
    affected_files: [{ path: "src/foo.ts", line_start: 1, line_end: 10 }],
  };
  const designFinding = makeFinding({
    id: "DA-001",
    ...sharedProps,
    severity: "medium",
    confidence: "medium",
    evidence: ["design-ev"],
  });
  const auditResultFinding = makeFinding({
    id: "AR-001",
    ...sharedProps,
    severity: "high",
    confidence: "high",
    evidence: ["audit-ev"],
  });
  const merged = mergeFindings(
    [
      {
        task_id: "t-2",
        unit_id: "u-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/foo.ts", total_lines: 100 }],
        findings: [auditResultFinding],
      },
    ],
    undefined,
    undefined,
    { generated_at: "2026-01-01T00:00:00Z", findings: [designFinding] },
  );
  assert.equal(merged.length, 1, "no duplicate — AuditResult finding merged into design finding");
  assert.equal(merged[0].severity, "high", "higher severity from AuditResult is preserved");
  assert.equal(merged[0].confidence, "high", "higher confidence from AuditResult is preserved");
  assert.ok(
    merged[0].evidence.includes("design-ev"),
    "design-assessment evidence is retained",
  );
  assert.ok(
    merged[0].evidence.includes("audit-ev"),
    "AuditResult evidence is unioned in",
  );
});
