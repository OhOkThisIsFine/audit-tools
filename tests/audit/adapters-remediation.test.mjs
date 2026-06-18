import test from "node:test";
import assert from "node:assert/strict";

const { normalizeCoverageSummary } = await import("../../src/audit/adapters/coverageSummary.ts");
const { normalizeEslintJson } = await import("../../src/audit/adapters/eslint.ts");
const { normalizeNpmAuditJson } = await import("../../src/audit/adapters/npmAudit.ts");
const { normalizeSemgrepJson } = await import("../../src/audit/adapters/semgrep.ts");
const { normalizeGenericExternalResults } = await import("../../src/audit/adapters/normalizeExternal.ts");

test("normalizeCoverageSummary keeps only below-threshold files and preserves severity boundaries", () => {
  const normalized = normalizeCoverageSummary([
    { path: "src/covered.ts", lines_pct: 80 },
    { path: "src/warn.ts", lines_pct: 79.9 },
    { path: "src/fail.ts", lines_pct: 49.5, branches_pct: 12.3 },
  ]);

  assert.equal(normalized.tool, "coverage-summary");
  assert.deepEqual(
    normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    })),
    [
      {
        id: "coverage-1",
        severity: "medium",
        path: "src/warn.ts",
        summary: "Low line coverage: 79.9%.",
      },
      {
        id: "coverage-2",
        severity: "high",
        path: "src/fail.ts",
        summary: "Low line coverage: 49.5%, branch coverage 12.3%.",
      },
    ],
  );
});

test("normalizeEslintJson maps known severities and safely downgrades malformed values to info", () => {
  const normalized = normalizeEslintJson([
    {
      filePath: "src/app.ts",
      messages: [
        {
          severity: 2,
          message: "Unexpected error path.",
          ruleId: "no-bad-error",
          line: 2,
          endLine: 3,
        },
        { severity: 1, message: "Style warning." },
        { severity: 0, message: "Unknown severity." },
        { severity: -1, message: "Negative severity." },
        { severity: null, message: "Null severity." },
        { severity: "2", message: "String severity." },
      ],
    },
    {
      messages: [{ severity: 2, message: "Missing file path should be dropped." }],
    },
    {
      filePath: "src/skip.ts",
      messages: [{ severity: 2 }],
    },
  ]);

  assert.equal(normalized.tool, "eslint");
  assert.deepEqual(
    normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    })),
    [
      {
        id: "src/app.ts:1",
        severity: "medium",
        path: "src/app.ts",
        summary: "Unexpected error path.",
      },
      {
        id: "src/app.ts:2",
        severity: "low",
        path: "src/app.ts",
        summary: "Style warning.",
      },
      {
        id: "src/app.ts:3",
        severity: "info",
        path: "src/app.ts",
        summary: "Unknown severity.",
      },
      {
        id: "src/app.ts:4",
        severity: "info",
        path: "src/app.ts",
        summary: "Negative severity.",
      },
      {
        id: "src/app.ts:5",
        severity: "info",
        path: "src/app.ts",
        summary: "Null severity.",
      },
      {
        id: "src/app.ts:6",
        severity: "info",
        path: "src/app.ts",
        summary: "String severity.",
      },
    ],
  );
  assert.equal(normalized.results[0].line_start, 2);
  assert.equal(normalized.results[0].line_end, 3);
  assert.equal(normalized.results[0].rule, "no-bad-error");
});

test("normalizeNpmAuditJson preserves 0-based ids and fills unknown vulnerability detail safely", () => {
  const normalized = normalizeNpmAuditJson({
    vulnerabilities: {
      lodash: { severity: "high", range: "<4.17.21" },
      minimist: {},
    },
  });

  assert.equal(normalized.tool, "npm-audit");
  assert.deepEqual(
    normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
      rule: result.rule,
    })),
    [
      {
        id: "npm-audit-0",
        severity: "high",
        path: "package.json",
        summary:
          "Package lodash has a high severity vulnerability in range <4.17.21.",
        rule: "lodash",
      },
      {
        id: "npm-audit-1",
        severity: "low",
        path: "package.json",
        summary:
          "Package minimist has a low severity vulnerability in range unknown.",
        rule: "minimist",
      },
    ],
  );
});

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

test("normalizeNpmAuditJson maps 'moderate' severity to 'medium'", () => {
  const normalized = normalizeNpmAuditJson({
    vulnerabilities: {
      "test-pkg": { severity: "moderate", range: ">=1.0.0" },
    },
  });
  assert.equal(normalized.results[0].severity, "medium");
  assert.ok(
    VALID_SEVERITIES.has(normalized.results[0].severity),
    "normalized severity must be a valid schema enum member",
  );
});

test("normalizeNpmAuditJson passes through valid schema severities unchanged", () => {
  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    const normalized = normalizeNpmAuditJson({
      vulnerabilities: { pkg: { severity: sev } },
    });
    assert.equal(normalized.results[0].severity, sev, `${sev} should map to ${sev}`);
  }
});

test("normalizeNpmAuditJson defaults unknown/missing severities to a valid schema value", () => {
  const withUndefined = normalizeNpmAuditJson({
    vulnerabilities: { pkg: {} },
  });
  assert.ok(
    VALID_SEVERITIES.has(withUndefined.results[0].severity),
    `undefined severity produced '${withUndefined.results[0].severity}', not in enum`,
  );

  const withBogus = normalizeNpmAuditJson({
    vulnerabilities: { pkg: { severity: "bogus" } },
  });
  assert.ok(
    VALID_SEVERITIES.has(withBogus.results[0].severity),
    `'bogus' severity produced '${withBogus.results[0].severity}', not in enum`,
  );
});

test("normalizeSemgrepJson drops incomplete results and defaults missing categories to security", () => {
  const normalized = normalizeSemgrepJson({
    results: [
      {
        check_id: "sg.maintainability",
        path: "src/auth.ts",
        start: { line: 4 },
        end: { line: 8 },
        extra: {
          severity: "WARNING",
          message: "Prefer a shared helper here.",
          metadata: { category: "maintainability" },
        },
      },
      {
        check_id: "sg.default-category",
        path: "src/session.ts",
        extra: {
          message: "Analyzer found a noteworthy session path.",
        },
      },
      {
        check_id: "sg.missing-path",
        extra: {
          message: "Missing path should be dropped.",
        },
      },
      {
        check_id: "sg.missing-message",
        path: "src/skip.ts",
        extra: {},
      },
    ],
  });

  assert.equal(normalized.tool, "semgrep");
  assert.deepEqual(
    normalized.results.map((result) => ({
      id: result.id,
      category: result.category,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    })),
    [
      {
        id: "sg.maintainability",
        category: "maintainability",
        severity: "medium",
        path: "src/auth.ts",
        summary: "Prefer a shared helper here.",
      },
      {
        id: "sg.default-category",
        category: "security",
        severity: "info",
        path: "src/session.ts",
        summary: "Analyzer found a noteworthy session path.",
      },
    ],
  );
  assert.equal(normalized.results[0].line_start, 4);
  assert.equal(normalized.results[0].line_end, 8);
});

test("normalizeSemgrepJson maps uppercase semgrep severities to lowercase schema values (COR-cffe3d7b)", () => {
  const cases = [
    { input: "WARNING",  expected: "medium" },
    { input: "ERROR",    expected: "high" },
    { input: "INFO",     expected: "info" },
    { input: "CRITICAL", expected: "critical" },
  ];
  for (const { input, expected } of cases) {
    const normalized = normalizeSemgrepJson({
      results: [
        {
          check_id: "sg.test",
          path: "src/foo.ts",
          extra: { severity: input, message: "test finding" },
        },
      ],
    });
    assert.equal(
      normalized.results[0]?.severity,
      expected,
      `severity '${input}' should map to '${expected}'`,
    );
  }
});

test("normalizeSemgrepJson maps mixed-case semgrep severity to lowercase schema value (COR-cffe3d7b)", () => {
  const normalized = normalizeSemgrepJson({
    results: [
      {
        check_id: "sg.test",
        path: "src/foo.ts",
        extra: { severity: "Warning", message: "mixed-case test" },
      },
    ],
  });
  assert.equal(
    normalized.results[0]?.severity,
    "medium",
    "mixed-case 'Warning' should map to 'medium'",
  );
});

test("normalizeSemgrepJson produces undefined/fallback severity for missing or unknown severity (COR-cffe3d7b)", () => {
  const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

  // Missing severity — normalizeGenericExternalResults should supply a fallback
  const withMissing = normalizeSemgrepJson({
    results: [
      {
        check_id: "sg.test",
        path: "src/foo.ts",
        extra: { message: "no severity" },
      },
    ],
  });
  assert.ok(
    VALID_SEVERITIES.has(withMissing.results[0]?.severity),
    `missing severity produced '${withMissing.results[0]?.severity}', not in schema enum`,
  );

  // Unknown severity string — normalizeGenericExternalResults applies its fallback
  const withUnknown = normalizeSemgrepJson({
    results: [
      {
        check_id: "sg.test",
        path: "src/foo.ts",
        extra: { severity: "BOGUS", message: "unknown severity" },
      },
    ],
  });
  assert.ok(
    VALID_SEVERITIES.has(withUnknown.results[0]?.severity),
    `unknown severity produced '${withUnknown.results[0]?.severity}', not in schema enum`,
  );
});

test("normalizeGenericExternalResults maps absent severity to 'info' (COR-0a17639f)", () => {
  const result = normalizeGenericExternalResults("my-tool", [
    { path: "src/a.ts", summary: "finding with no severity" },
  ]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].severity, "info");
  const severityEnum = ["critical", "high", "medium", "low", "info"];
  assert.ok(
    severityEnum.includes(result.results[0].severity),
    `severity '${result.results[0].severity}' must be a member of the schema enum`,
  );
});

test("normalizeCoverageSummary respects COVERAGE_THRESHOLD_LOW: files at or above 80% are excluded", () => {
  const atThreshold = normalizeCoverageSummary([{ path: "src/ok.ts", lines_pct: 80 }]);
  assert.deepEqual(atThreshold.results, [], "lines_pct === 80 must not be flagged");

  const belowThreshold = normalizeCoverageSummary([{ path: "src/low.ts", lines_pct: 79 }]);
  assert.equal(belowThreshold.results.length, 1, "lines_pct === 79 must be flagged");
  assert.equal(belowThreshold.results[0].path, "src/low.ts");
});

test("normalizeCoverageSummary assigns severity correctly around COVERAGE_SEVERITY_HIGH", () => {
  const high = normalizeCoverageSummary([{ path: "src/high.ts", lines_pct: 49 }]);
  assert.equal(high.results[0].severity, "high", "lines_pct === 49 should be high");

  const mediumAtBoundary = normalizeCoverageSummary([{ path: "src/med50.ts", lines_pct: 50 }]);
  assert.equal(mediumAtBoundary.results[0].severity, "medium", "lines_pct === 50 should be medium");

  const mediumBeforeThreshold = normalizeCoverageSummary([{ path: "src/med79.ts", lines_pct: 79 }]);
  assert.equal(mediumBeforeThreshold.results[0].severity, "medium", "lines_pct === 79 should be medium");
});

test("normalizeCoverageSummary pins the lines_pct=50 boundary to medium and lines_pct=49.9 to high", () => {
  const normalized = normalizeCoverageSummary([
    { path: "src/boundary-high.ts", lines_pct: 49.9 },
    { path: "src/boundary-medium.ts", lines_pct: 50 },
  ]);

  assert.equal(normalized.results.length, 2, "both files below 80% threshold must be flagged");

  const highEntry = normalized.results.find((r) => r.path === "src/boundary-high.ts");
  const mediumEntry = normalized.results.find((r) => r.path === "src/boundary-medium.ts");

  assert.ok(highEntry, "src/boundary-high.ts must be present in results");
  assert.ok(mediumEntry, "src/boundary-medium.ts must be present in results");

  assert.equal(
    highEntry.severity,
    "high",
    "lines_pct=49.9 is strictly below 50 so severity must be 'high'",
  );
  assert.equal(
    mediumEntry.severity,
    "medium",
    "lines_pct=50 is not strictly below 50 so severity must be 'medium'",
  );
});

test("normalizeGenericExternalResults maps native severity aliases onto schema enum (COR-0a17639f)", () => {
  const cases = [
    { input: "WARNING",    expected: "medium" },
    { input: "ERROR",      expected: "high" },
    { input: "moderate",   expected: "medium" },
    { input: "note",       expected: "info" },
    { input: "critical",   expected: "critical" },
    { input: "low",        expected: "low" },
    { input: "foobar",     expected: "info" },
    { input: "high",       expected: "high" },
    { input: "info",       expected: "info" },
    { input: "hint",       expected: "info" },
  ];
  for (const { input, expected } of cases) {
    const result = normalizeGenericExternalResults("test-tool", [
      { path: "src/x.ts", summary: "test finding", severity: input },
    ]);
    assert.equal(
      result.results[0].severity,
      expected,
      `severity '${input}' should map to '${expected}'`,
    );
  }
});
