import { test, expect } from "vitest";

const { normalizeCoverageSummary } = await import("../../src/audit/adapters/coverageSummary.ts");
const { normalizeEslintJson } = await import("../../src/audit/adapters/eslint.ts");
const { normalizeNpmAuditJson } = await import("../../src/audit/adapters/npmAudit.ts");
const { normalizeSemgrepJson } = await import("../../src/audit/adapters/semgrep.ts");
const { normalizeGenericExternalResults } = await import("../../src/audit/adapters/normalizeExternal.ts");
const { normalizeClippyJson, parseClippy } = await import("../../src/audit/adapters/clippy.ts");
const { normalizeRubocopJson, parseRubocop } = await import("../../src/audit/adapters/rubocop.ts");

test("normalizeCoverageSummary keeps only below-threshold files and preserves severity boundaries", () => {
  const normalized = normalizeCoverageSummary([
    { path: "src/covered.ts", lines_pct: 80 },
    { path: "src/warn.ts", lines_pct: 79.9 },
    { path: "src/fail.ts", lines_pct: 49.5, branches_pct: 12.3 },
  ]);

  expect(normalized.tool).toBe("coverage-summary");
  expect(normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    }))).toEqual([
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
    ]);
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

  expect(normalized.tool).toBe("eslint");
  expect(normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    }))).toEqual([
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
    ]);
  expect(normalized.results[0].line_start).toBe(2);
  expect(normalized.results[0].line_end).toBe(3);
  expect(normalized.results[0].rule).toBe("no-bad-error");
});

test("normalizeNpmAuditJson preserves 0-based ids and fills unknown vulnerability detail safely", () => {
  const normalized = normalizeNpmAuditJson({
    vulnerabilities: {
      lodash: { severity: "high", range: "<4.17.21" },
      minimist: {},
    },
  });

  expect(normalized.tool).toBe("npm-audit");
  expect(normalized.results.map((result) => ({
      id: result.id,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
      rule: result.rule,
    }))).toEqual([
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
    ]);
});

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

test("normalizeNpmAuditJson maps 'moderate' severity to 'medium'", () => {
  const normalized = normalizeNpmAuditJson({
    vulnerabilities: {
      "test-pkg": { severity: "moderate", range: ">=1.0.0" },
    },
  });
  expect(normalized.results[0].severity).toBe("medium");
  expect(VALID_SEVERITIES.has(normalized.results[0].severity), "normalized severity must be a valid schema enum member").toBeTruthy();
});

test("normalizeNpmAuditJson passes through valid schema severities unchanged", () => {
  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    const normalized = normalizeNpmAuditJson({
      vulnerabilities: { pkg: { severity: sev } },
    });
    expect(normalized.results[0].severity, `${sev} should map to ${sev}`).toBe(sev);
  }
});

test("normalizeNpmAuditJson defaults unknown/missing severities to a valid schema value", () => {
  const withUndefined = normalizeNpmAuditJson({
    vulnerabilities: { pkg: {} },
  });
  expect(VALID_SEVERITIES.has(withUndefined.results[0].severity), `undefined severity produced '${withUndefined.results[0].severity}', not in enum`).toBeTruthy();

  const withBogus = normalizeNpmAuditJson({
    vulnerabilities: { pkg: { severity: "bogus" } },
  });
  expect(VALID_SEVERITIES.has(withBogus.results[0].severity), `'bogus' severity produced '${withBogus.results[0].severity}', not in enum`).toBeTruthy();
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

  expect(normalized.tool).toBe("semgrep");
  expect(normalized.results.map((result) => ({
      id: result.id,
      category: result.category,
      severity: result.severity,
      path: result.path,
      summary: result.summary,
    }))).toEqual([
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
    ]);
  expect(normalized.results[0].line_start).toBe(4);
  expect(normalized.results[0].line_end).toBe(8);
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
    expect(normalized.results[0]?.severity, `severity '${input}' should map to '${expected}'`).toBe(expected);
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
  expect(normalized.results[0]?.severity, "mixed-case 'Warning' should map to 'medium'").toBe("medium");
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
  expect(VALID_SEVERITIES.has(withMissing.results[0]?.severity), `missing severity produced '${withMissing.results[0]?.severity}', not in schema enum`).toBeTruthy();

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
  expect(VALID_SEVERITIES.has(withUnknown.results[0]?.severity), `unknown severity produced '${withUnknown.results[0]?.severity}', not in schema enum`).toBeTruthy();
});

test("normalizeGenericExternalResults maps absent severity to 'info' (COR-0a17639f)", () => {
  const result = normalizeGenericExternalResults("my-tool", [
    { path: "src/a.ts", summary: "finding with no severity" },
  ]);
  expect(result.results.length).toBe(1);
  expect(result.results[0].severity).toBe("info");
  const severityEnum = ["critical", "high", "medium", "low", "info"];
  expect(severityEnum.includes(result.results[0].severity), `severity '${result.results[0].severity}' must be a member of the schema enum`).toBeTruthy();
});

test("normalizeCoverageSummary respects COVERAGE_THRESHOLD_LOW: files at or above 80% are excluded", () => {
  const atThreshold = normalizeCoverageSummary([{ path: "src/ok.ts", lines_pct: 80 }]);
  expect(atThreshold.results, "lines_pct === 80 must not be flagged").toEqual([]);

  const belowThreshold = normalizeCoverageSummary([{ path: "src/low.ts", lines_pct: 79 }]);
  expect(belowThreshold.results.length, "lines_pct === 79 must be flagged").toBe(1);
  expect(belowThreshold.results[0].path).toBe("src/low.ts");
});

test("normalizeCoverageSummary assigns severity correctly around COVERAGE_SEVERITY_HIGH", () => {
  const high = normalizeCoverageSummary([{ path: "src/high.ts", lines_pct: 49 }]);
  expect(high.results[0].severity, "lines_pct === 49 should be high").toBe("high");

  const mediumAtBoundary = normalizeCoverageSummary([{ path: "src/med50.ts", lines_pct: 50 }]);
  expect(mediumAtBoundary.results[0].severity, "lines_pct === 50 should be medium").toBe("medium");

  const mediumBeforeThreshold = normalizeCoverageSummary([{ path: "src/med79.ts", lines_pct: 79 }]);
  expect(mediumBeforeThreshold.results[0].severity, "lines_pct === 79 should be medium").toBe("medium");
});

test("normalizeCoverageSummary pins the lines_pct=50 boundary to medium and lines_pct=49.9 to high", () => {
  const normalized = normalizeCoverageSummary([
    { path: "src/boundary-high.ts", lines_pct: 49.9 },
    { path: "src/boundary-medium.ts", lines_pct: 50 },
  ]);

  expect(normalized.results.length, "both files below 80% threshold must be flagged").toBe(2);

  const highEntry = normalized.results.find((r) => r.path === "src/boundary-high.ts");
  const mediumEntry = normalized.results.find((r) => r.path === "src/boundary-medium.ts");

  expect(highEntry, "src/boundary-high.ts must be present in results").toBeTruthy();
  expect(mediumEntry, "src/boundary-medium.ts must be present in results").toBeTruthy();

  expect(highEntry.severity, "lines_pct=49.9 is strictly below 50 so severity must be 'high'").toBe("high");
  expect(mediumEntry.severity, "lines_pct=50 is not strictly below 50 so severity must be 'medium'").toBe("medium");
});

// --- CP-NODE-1: dedicated clippy / rubocop severity adapters ---

const CLIPPY_STREAM = [
  JSON.stringify({
    reason: "compiler-message",
    message: {
      level: "error",
      message: "mismatched types",
      code: { code: "E0308" },
      spans: [{ file_name: "src/lib.rs", line_start: 3, line_end: 3, is_primary: true }],
    },
  }),
  JSON.stringify({
    reason: "compiler-message",
    message: {
      level: "warning",
      message: "unused import",
      code: { code: "clippy::unused" },
      spans: [{ file_name: "src/main.rs", line_start: 1, line_end: 1, is_primary: true }],
    },
  }),
].join("\n");

test("normalizeClippyJson maps clippy severities and validates through the generic seam", () => {
  const normalized = normalizeClippyJson(CLIPPY_STREAM);
  expect(normalized.tool).toBe("clippy");
  expect(normalized.results.map((r) => ({ severity: r.severity, path: r.path, rule: r.rule }))).toEqual([
      { severity: "high", path: "src/lib.rs", rule: "E0308" },
      { severity: "medium", path: "src/main.rs", rule: "clippy::unused" },
    ]);
  for (const r of normalized.results) {
    expect(VALID_SEVERITIES.has(r.severity), `severity '${r.severity}' must be a schema enum member`).toBeTruthy();
  }
});

test("normalizeClippyJson downgrades malformed input to an empty result set (no throw)", () => {
  for (const bad of ["", "not json", "{}", "garbage\nmore garbage"]) {
    const normalized = normalizeClippyJson(bad);
    expect(normalized.tool).toBe("clippy");
    expect(normalized.results).toEqual([]);
  }
  expect(parseClippy("not json")).toEqual([]);
});

const RUBOCOP_REPORT = JSON.stringify({
  files: [
    {
      path: "app/foo.rb",
      offenses: [
        { severity: "fatal", message: "fatal issue", cop_name: "Lint/Fatal", location: { start_line: 2 } },
        { severity: "convention", message: "style nit", cop_name: "Style/Nit", location: { line: 9 } },
      ],
    },
  ],
});

test("normalizeRubocopJson maps rubocop severities (fatal→high, convention→low) through the generic seam", () => {
  const normalized = normalizeRubocopJson(RUBOCOP_REPORT);
  expect(normalized.tool).toBe("rubocop");
  expect(normalized.results.map((r) => ({ severity: r.severity, path: r.path, rule: r.rule, line_start: r.line_start }))).toEqual([
      { severity: "high", path: "app/foo.rb", rule: "Lint/Fatal", line_start: 2 },
      { severity: "low", path: "app/foo.rb", rule: "Style/Nit", line_start: 9 },
    ]);
  for (const r of normalized.results) {
    expect(VALID_SEVERITIES.has(r.severity), `severity '${r.severity}' must be a schema enum member`).toBeTruthy();
  }
});

test("normalizeRubocopJson downgrades malformed input to an empty result set (no throw)", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ files: "nope" })]) {
    const normalized = normalizeRubocopJson(bad);
    expect(normalized.tool).toBe("rubocop");
    expect(normalized.results).toEqual([]);
  }
  expect(parseRubocop("not json")).toEqual([]);
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
    expect(result.results[0].severity, `severity '${input}' should map to '${expected}'`).toBe(expected);
  }
});
