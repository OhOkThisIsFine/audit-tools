import test from "node:test";
import assert from "node:assert/strict";

const {
  EXTERNAL_ANALYZER_CANDIDATES,
  gitleaksCandidate,
  parseGitleaks,
  semgrepCandidate,
  eslintCandidate,
} = await import("../../src/audit/extractors/analyzers/candidates.ts");
const { OWNED_TOOL_IDS, registerExternalAnalyzers } = await import(
  "../../src/audit/extractors/analyzers/acquisitionEngine.ts"
);

test("secret scanning is ACQUIRED, not owned — gitleaks is registered and admitted", () => {
  assert.equal(OWNED_TOOL_IDS.has("secrets"), false);
  assert.equal(OWNED_TOOL_IDS.has("secret-scan"), false);
  // git-history stays owned.
  assert.equal(OWNED_TOOL_IDS.has("git-history"), true);
  const accepted = registerExternalAnalyzers(EXTERNAL_ANALYZER_CANDIDATES);
  assert.ok(accepted.find((c) => c.id === "gitleaks"), "gitleaks must register");
});

test("gitleaks is the default-on member; semgrep + eslint are consent-gated", () => {
  assert.equal(gitleaksCandidate.defaultRun, true);
  assert.equal(gitleaksCandidate.runner, "binary");
  assert.equal(semgrepCandidate.defaultRun, false);
  assert.equal(eslintCandidate.defaultRun, false);
});

test("gitleaks always applies (secrets are ecosystem-agnostic) and reports to a file", () => {
  assert.equal(gitleaksCandidate.detect("/any/repo"), true);
  assert.equal(typeof gitleaksCandidate.reportFile?.("/repo"), "string");
  const argv = gitleaksCandidate.buildArgv(["/cache/gitleaks"], "/repo");
  assert.equal(argv[0], "/cache/gitleaks");
  assert.ok(argv.includes("dir"));
  assert.ok(argv.includes("--report-format") && argv.includes("json"));
});

test("parseGitleaks maps findings and NEVER carries the raw secret", () => {
  const report = JSON.stringify([
    {
      Description: "AWS Access Key",
      StartLine: 12,
      EndLine: 12,
      File: "src/config.ts",
      Secret: "AKIAIOSFODNN7EXAMPLE",
      Match: "key = AKIAIOSFODNN7EXAMPLE",
      RuleID: "aws-access-token",
      Fingerprint: "fp-1",
      Entropy: 3.4,
    },
  ]);
  const items = parseGitleaks(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "fp-1");
  assert.equal(items[0].category, "security");
  assert.equal(items[0].path, "src/config.ts");
  assert.equal(items[0].line_start, 12);
  assert.equal(items[0].rule, "aws-access-token");
  const serialized = JSON.stringify(items[0]);
  assert.doesNotMatch(serialized, /AKIAIOSFODNN7EXAMPLE/, "raw secret must never appear");
  assert.doesNotMatch(serialized, /key = AKIA/, "raw match must never appear");
});

test("parseGitleaks degrades to empty on malformed / empty report", () => {
  assert.deepEqual(parseGitleaks(""), []);
  assert.deepEqual(parseGitleaks("not json"), []);
  assert.deepEqual(parseGitleaks("{}"), []);
});

test("parseSemgrep + parseEslint degrade to empty on malformed input", () => {
  assert.deepEqual(semgrepCandidate.parse("nonsense"), []);
  assert.deepEqual(eslintCandidate.parse("nonsense"), []);
  assert.deepEqual(
    semgrepCandidate.parse(
      JSON.stringify({
        results: [
          { check_id: "rule.x", path: "a.py", start: { line: 3 }, end: { line: 3 }, extra: { message: "bad", severity: "ERROR" } },
        ],
      }),
    ).map((i) => [i.rule, i.severity, i.line_start]),
    [["rule.x", "high", 3]],
  );
  assert.deepEqual(
    eslintCandidate.parse(
      JSON.stringify([
        { filePath: "a.js", messages: [{ ruleId: "no-var", line: 2, message: "use const", severity: 2 }] },
      ]),
    ).map((i) => [i.rule, i.severity, i.line_start]),
    [["no-var", "medium", 2]],
  );
});
