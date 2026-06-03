import test from "node:test";
import assert from "node:assert/strict";

const { normalizeCoverageSummary } = await import(
  "../src/adapters/coverageSummary.ts"
);
const { normalizeEslintJson } = await import("../src/adapters/eslint.ts");
const { normalizeNpmAuditJson } = await import(
  "../src/adapters/npmAudit.ts"
);
const { normalizeSemgrepJson } = await import("../src/adapters/semgrep.ts");

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
        path: "package-lock.json",
        summary:
          "Package lodash has a high severity vulnerability in range <4.17.21.",
        rule: "lodash",
      },
      {
        id: "npm-audit-1",
        severity: "unknown",
        path: "package-lock.json",
        summary:
          "Package minimist has a unknown severity vulnerability in range unknown.",
        rule: "minimist",
      },
    ],
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
        severity: "WARNING",
        path: "src/auth.ts",
        summary: "Prefer a shared helper here.",
      },
      {
        id: "sg.default-category",
        category: "security",
        severity: "unknown",
        path: "src/session.ts",
        summary: "Analyzer found a noteworthy session path.",
      },
    ],
  );
  assert.equal(normalized.results[0].line_start, 4);
  assert.equal(normalized.results[0].line_end, 8);
});
