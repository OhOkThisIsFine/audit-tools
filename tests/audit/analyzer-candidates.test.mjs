import test from "node:test";
import assert from "node:assert/strict";

const {
  EXTERNAL_ANALYZER_CANDIDATES,
  gitleaksCandidate,
  parseGitleaks,
  semgrepCandidate,
  eslintCandidate,
  knipCandidate,
  parseKnip,
  jscpdCandidate,
  parseJscpd,
  osvScannerCandidate,
  parseOsvScanner,
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

test("knip is consent-gated like eslint/semgrep, npx runner, no positional/cwd arg", () => {
  assert.equal(knipCandidate.defaultRun, false);
  assert.equal(knipCandidate.runner, "npx");
  const argv = knipCandidate.buildArgv(["npx", "knip@6"], "/repo");
  assert.deepEqual(argv, [
    "npx",
    "knip@6",
    "--reporter",
    "json",
    "--include",
    "exports,types,nsExports,nsTypes",
    "--no-exit-code",
  ]);
});

// Shape grounded against node_modules/knip/dist/reporters/json.js in this repo:
// { issues: [{ file, exports?, types?, nsExports?, nsTypes? }] }, each entry
// { name, line, col, pos, namespace }.
test("parseKnip maps unused-export issues across all four report types", () => {
  const report = JSON.stringify({
    issues: [
      {
        file: "src/foo.ts",
        exports: [{ name: "unusedFn", line: 12, col: 1, pos: 200 }],
        types: [{ name: "UnusedType", line: 20, col: 1, pos: 400 }],
      },
      {
        file: "src/bar.ts",
        nsExports: [{ name: "nsThing", line: 5, col: 1, pos: 50 }],
        nsTypes: [{ name: "NsType", line: 8, col: 1, pos: 90 }],
      },
    ],
  });
  const items = parseKnip(report);
  assert.equal(items.length, 4);
  const byRule = Object.fromEntries(items.map((i) => [i.rule, i]));
  assert.equal(byRule["knip-exports"].path, "src/foo.ts");
  assert.equal(byRule["knip-exports"].line_start, 12);
  assert.equal(byRule["knip-exports"].category, "maintainability");
  assert.match(byRule["knip-exports"].summary, /unusedFn/);
  assert.match(byRule["knip-exports"].summary, /confirm truly dead or refute/);
  assert.equal(byRule["knip-types"].path, "src/foo.ts");
  assert.equal(byRule["knip-nsExports"].path, "src/bar.ts");
  assert.equal(byRule["knip-nsTypes"].path, "src/bar.ts");
});

test("parseKnip ignores non-export-shaped issue types (files/dependencies/etc) and degrades to empty on malformed input", () => {
  assert.deepEqual(parseKnip(""), []);
  assert.deepEqual(parseKnip("not json"), []);
  assert.deepEqual(parseKnip("{}"), []);
  const withUnrelatedTypes = JSON.stringify({
    issues: [
      {
        file: "src/dead.ts",
        files: [{}],
        dependencies: [{ name: "leftpad" }],
        exports: [{ name: "onlyThis", line: 1 }],
      },
    ],
  });
  const items = parseKnip(withUnrelatedTypes);
  assert.equal(items.length, 1);
  assert.equal(items[0].rule, "knip-exports");
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

test("jscpd is registered, consent-gated like eslint/semgrep/knip, npx runner", () => {
  assert.ok(EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "jscpd"), "jscpd must be registered");
  assert.equal(jscpdCandidate.defaultRun, false);
  assert.equal(jscpdCandidate.runner, "npx");
  assert.equal(jscpdCandidate.detect("/repo"), false);
  assert.equal(typeof jscpdCandidate.reportFile?.("/repo"), "string");
  const argv = jscpdCandidate.buildArgv(["npx", "jscpd@4"], "/repo");
  assert.ok(argv.includes("--reporters") && argv.includes("json"));
  assert.ok(argv.includes("--output"));
  assert.ok(argv.includes("/repo"));
});

test("parseJscpd maps duplicates into generic items", () => {
  const report = JSON.stringify({
    duplicates: [
      {
        lines: 15,
        firstFile: { name: "src/a.ts", startLoc: { line: 10 }, endLoc: { line: 25 } },
        secondFile: { name: "src/b.ts", startLoc: { line: 40 }, endLoc: { line: 55 } },
      },
    ],
  });
  const items = parseJscpd(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "src/a.ts");
  assert.equal(items[0].line_start, 10);
  assert.equal(items[0].line_end, 25);
  assert.equal(items[0].category, "maintainability");
  assert.match(items[0].summary, /src\/b\.ts/);
});

test("parseJscpd degrades to empty on malformed/empty/missing-duplicates input", () => {
  assert.deepEqual(parseJscpd(""), []);
  assert.deepEqual(parseJscpd("not json"), []);
  assert.deepEqual(parseJscpd("{}"), []);
  assert.deepEqual(parseJscpd(JSON.stringify({ duplicates: "not-an-array" })), []);
});

test("osv-scanner is registered, consent-gated, binary runner, ecosystem-agnostic (like gitleaks) but raw (non-archived) asset", () => {
  assert.ok(EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "osv-scanner"), "osv-scanner must be registered");
  assert.equal(osvScannerCandidate.defaultRun, false);
  assert.equal(osvScannerCandidate.runner, "binary");
  assert.equal(osvScannerCandidate.detect("/any/repo"), true);
  assert.equal(osvScannerCandidate.binary?.archived, false);
  const argv = osvScannerCandidate.buildArgv(["/cache/osv-scanner"], "/repo");
  assert.deepEqual(argv, [
    "/cache/osv-scanner",
    "scan",
    "--format",
    "json",
    "--recursive",
    "/repo",
  ]);
});

test("osv-scanner binary spec maps platform/arch to the real release asset naming", () => {
  const spec = osvScannerCandidate.binary;
  assert.equal(spec.assetFor("linux", "x64"), "osv-scanner_linux_amd64");
  assert.equal(spec.assetFor("darwin", "arm64"), "osv-scanner_darwin_arm64");
  assert.equal(spec.assetFor("win32", "x64"), "osv-scanner_windows_amd64.exe");
  assert.equal(spec.assetFor("linux", "ia32"), null, "no 32-bit release asset exists");
  assert.equal(spec.assetFor("sunos", "x64"), null, "no sunos release asset exists");
});

// Shape grounded against pkg/models/results.go (VulnerabilityResults) in
// google/osv-scanner, not guessed: results[].source.path, results[].packages[]
// .{package:{name,version}, vulnerabilities:[{id,summary,details}], groups:
// [{ids,max_severity}]}.
test("parseOsvScanner maps one item per group (alias-collapsed), not per raw vulnerability id", () => {
  const report = JSON.stringify({
    results: [
      {
        source: { path: "package-lock.json", type: "lockfile" },
        packages: [
          {
            package: { name: "gogo/protobuf", version: "1.3.1", ecosystem: "Go" },
            vulnerabilities: [
              {
                id: "GHSA-c3h9-896r-86jm",
                summary: "Index validation issue",
                details: "An issue was discovered...",
              },
              { id: "GO-2021-0053", summary: "" },
            ],
            groups: [
              {
                ids: ["GHSA-c3h9-896r-86jm", "GO-2021-0053"],
                aliases: ["CVE-2021-3121"],
                max_severity: "HIGH",
              },
            ],
          },
        ],
      },
    ],
  });
  const items = parseOsvScanner(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "security");
  assert.equal(items[0].severity, "high");
  assert.equal(items[0].path, "package-lock.json");
  assert.equal(items[0].rule, "GHSA-c3h9-896r-86jm");
  assert.match(items[0].summary, /gogo\/protobuf@1\.3\.1/);
  assert.match(items[0].summary, /Index validation issue/);
});

test("parseOsvScanner maps max_severity to the engine's severity strings and skips groups with no ids", () => {
  const makeReport = (maxSeverity) =>
    JSON.stringify({
      results: [
        {
          source: { path: "go.sum" },
          packages: [
            {
              package: { name: "pkg", version: "1.0.0" },
              vulnerabilities: [],
              groups: [{ ids: ["OSV-1"], max_severity: maxSeverity }],
            },
          ],
        },
      ],
    });
  assert.equal(parseOsvScanner(makeReport("CRITICAL"))[0].severity, "high");
  assert.equal(parseOsvScanner(makeReport("MODERATE"))[0].severity, "medium");
  assert.equal(parseOsvScanner(makeReport("LOW"))[0].severity, "low");
  assert.equal(parseOsvScanner(makeReport(""))[0].severity, "medium");

  const noIds = JSON.stringify({
    results: [
      {
        source: { path: "go.sum" },
        packages: [{ package: { name: "pkg" }, vulnerabilities: [], groups: [{ ids: [] }] }],
      },
    ],
  });
  assert.deepEqual(parseOsvScanner(noIds), []);
});

test("parseOsvScanner degrades to empty on malformed/empty input", () => {
  assert.deepEqual(parseOsvScanner(""), []);
  assert.deepEqual(parseOsvScanner("not json"), []);
  assert.deepEqual(parseOsvScanner("{}"), []);
  assert.deepEqual(parseOsvScanner(JSON.stringify({ results: "not-an-array" })), []);
});
