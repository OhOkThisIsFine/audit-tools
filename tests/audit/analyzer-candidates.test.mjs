import { test, expect } from "vitest";

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
  clippyCandidate,
  rubocopCandidate,
  hadolintCandidate,
  parseHadolint,
  HADOLINT_VERSION,
  actionlintCandidate,
  parseActionlint,
  ACTIONLINT_VERSION,
  typeCoverageCandidate,
  parseTypeCoverage,
} = await import("../../src/audit/extractors/analyzers/candidates.ts");
const { OWNED_TOOL_IDS, registerExternalAnalyzers } = await import(
  "../../src/audit/extractors/analyzers/acquisitionEngine.ts"
);

test("secret scanning is ACQUIRED, not owned — gitleaks is registered and admitted", () => {
  expect(OWNED_TOOL_IDS.has("secrets")).toBe(false);
  expect(OWNED_TOOL_IDS.has("secret-scan")).toBe(false);
  // git-history stays owned.
  expect(OWNED_TOOL_IDS.has("git-history")).toBe(true);
  const accepted = registerExternalAnalyzers(EXTERNAL_ANALYZER_CANDIDATES);
  expect(accepted.find((c) => c.id === "gitleaks"), "gitleaks must register").toBeTruthy();
});

test("gitleaks is the default-on member; semgrep + eslint are consent-gated", () => {
  expect(gitleaksCandidate.defaultRun).toBe(true);
  expect(gitleaksCandidate.runner).toBe("binary");
  expect(semgrepCandidate.defaultRun).toBe(false);
  expect(eslintCandidate.defaultRun).toBe(false);
});

test("gitleaks always applies (secrets are ecosystem-agnostic) and reports to a file", () => {
  expect(gitleaksCandidate.detect("/any/repo")).toBe(true);
  expect(typeof gitleaksCandidate.reportFile?.("/repo")).toBe("string");
  const argv = gitleaksCandidate.buildArgv(["/cache/gitleaks"], "/repo");
  expect(argv[0]).toBe("/cache/gitleaks");
  expect(argv.includes("dir")).toBeTruthy();
  expect(argv.includes("--report-format") && argv.includes("json")).toBeTruthy();
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
  expect(items.length).toBe(1);
  expect(items[0].id).toBe("fp-1");
  expect(items[0].category).toBe("security");
  expect(items[0].path).toBe("src/config.ts");
  expect(items[0].line_start).toBe(12);
  expect(items[0].rule).toBe("aws-access-token");
  const serialized = JSON.stringify(items[0]);
  expect(serialized, "raw secret must never appear").not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  expect(serialized, "raw match must never appear").not.toMatch(/key = AKIA/);
});

test("parseGitleaks degrades to empty on malformed / empty report", () => {
  expect(parseGitleaks("")).toEqual([]);
  expect(parseGitleaks("not json")).toEqual([]);
  expect(parseGitleaks("{}")).toEqual([]);
});

test("knip is consent-gated like eslint/semgrep, npx runner, no positional/cwd arg", () => {
  expect(knipCandidate.defaultRun).toBe(false);
  expect(knipCandidate.runner).toBe("npx");
  const argv = knipCandidate.buildArgv(["npx", "knip@6"], "/repo");
  expect(argv).toEqual([
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
  expect(items.length).toBe(4);
  const byRule = Object.fromEntries(items.map((i) => [i.rule, i]));
  expect(byRule["knip-exports"].path).toBe("src/foo.ts");
  expect(byRule["knip-exports"].line_start).toBe(12);
  expect(byRule["knip-exports"].category).toBe("maintainability");
  expect(byRule["knip-exports"].summary).toMatch(/unusedFn/);
  expect(byRule["knip-exports"].summary).toMatch(/confirm truly dead or refute/);
  expect(byRule["knip-types"].path).toBe("src/foo.ts");
  expect(byRule["knip-nsExports"].path).toBe("src/bar.ts");
  expect(byRule["knip-nsTypes"].path).toBe("src/bar.ts");
});

test("parseKnip ignores non-export-shaped issue types (files/dependencies/etc) and degrades to empty on malformed input", () => {
  expect(parseKnip("")).toEqual([]);
  expect(parseKnip("not json")).toEqual([]);
  expect(parseKnip("{}")).toEqual([]);
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
  expect(items.length).toBe(1);
  expect(items[0].rule).toBe("knip-exports");
});

test("parseSemgrep + parseEslint degrade to empty on malformed input", () => {
  expect(semgrepCandidate.parse("nonsense")).toEqual([]);
  expect(eslintCandidate.parse("nonsense")).toEqual([]);
  expect(semgrepCandidate.parse(
      JSON.stringify({
        results: [
          { check_id: "rule.x", path: "a.py", start: { line: 3 }, end: { line: 3 }, extra: { message: "bad", severity: "ERROR" } },
        ],
      }),
    ).map((i) => [i.rule, i.severity, i.line_start])).toEqual([["rule.x", "high", 3]]);
  expect(eslintCandidate.parse(
      JSON.stringify([
        { filePath: "a.js", messages: [{ ruleId: "no-var", line: 2, message: "use const", severity: 2 }] },
      ]),
    ).map((i) => [i.rule, i.severity, i.line_start])).toEqual([["no-var", "medium", 2]]);
});

test("jscpd is registered, consent-gated like eslint/semgrep/knip, npx runner", () => {
  expect(EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "jscpd"), "jscpd must be registered").toBeTruthy();
  expect(jscpdCandidate.defaultRun).toBe(false);
  expect(jscpdCandidate.runner).toBe("npx");
  expect(jscpdCandidate.detect("/repo")).toBe(false);
  expect(typeof jscpdCandidate.reportFile?.("/repo")).toBe("string");
  const argv = jscpdCandidate.buildArgv(["npx", "jscpd@4"], "/repo");
  expect(argv.includes("--reporters") && argv.includes("json")).toBeTruthy();
  expect(argv.includes("--output")).toBeTruthy();
  expect(argv.includes("/repo")).toBeTruthy();
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
  expect(items.length).toBe(1);
  expect(items[0].path).toBe("src/a.ts");
  expect(items[0].line_start).toBe(10);
  expect(items[0].line_end).toBe(25);
  expect(items[0].category).toBe("maintainability");
  expect(items[0].summary).toMatch(/src\/b\.ts/);
});

test("parseJscpd degrades to empty on malformed/empty/missing-duplicates input", () => {
  expect(parseJscpd("")).toEqual([]);
  expect(parseJscpd("not json")).toEqual([]);
  expect(parseJscpd("{}")).toEqual([]);
  expect(parseJscpd(JSON.stringify({ duplicates: "not-an-array" }))).toEqual([]);
});

test("osv-scanner is registered, consent-gated, binary runner, ecosystem-agnostic (like gitleaks) but raw (non-archived) asset", () => {
  expect(EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "osv-scanner"), "osv-scanner must be registered").toBeTruthy();
  expect(osvScannerCandidate.defaultRun).toBe(false);
  expect(osvScannerCandidate.runner).toBe("binary");
  expect(osvScannerCandidate.detect("/any/repo")).toBe(true);
  expect(osvScannerCandidate.binary?.archived).toBe(false);
  const argv = osvScannerCandidate.buildArgv(["/cache/osv-scanner"], "/repo");
  expect(argv).toEqual([
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
  expect(spec.assetFor("linux", "x64")).toBe("osv-scanner_linux_amd64");
  expect(spec.assetFor("darwin", "arm64")).toBe("osv-scanner_darwin_arm64");
  expect(spec.assetFor("win32", "x64")).toBe("osv-scanner_windows_amd64.exe");
  expect(spec.assetFor("linux", "ia32"), "no 32-bit release asset exists").toBe(null);
  expect(spec.assetFor("sunos", "x64"), "no sunos release asset exists").toBe(null);
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
  expect(items.length).toBe(1);
  expect(items[0].category).toBe("security");
  expect(items[0].severity).toBe("high");
  expect(items[0].path).toBe("package-lock.json");
  expect(items[0].rule).toBe("GHSA-c3h9-896r-86jm");
  expect(items[0].summary).toMatch(/gogo\/protobuf@1\.3\.1/);
  expect(items[0].summary).toMatch(/Index validation issue/);
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
  expect(parseOsvScanner(makeReport("CRITICAL"))[0].severity).toBe("high");
  expect(parseOsvScanner(makeReport("MODERATE"))[0].severity).toBe("medium");
  expect(parseOsvScanner(makeReport("LOW"))[0].severity).toBe("low");
  expect(parseOsvScanner(makeReport(""))[0].severity).toBe("medium");

  const noIds = JSON.stringify({
    results: [
      {
        source: { path: "go.sum" },
        packages: [{ package: { name: "pkg" }, vulnerabilities: [], groups: [{ ids: [] }] }],
      },
    ],
  });
  expect(parseOsvScanner(noIds)).toEqual([]);
});

test("parseOsvScanner degrades to empty on malformed/empty input", () => {
  expect(parseOsvScanner("")).toEqual([]);
  expect(parseOsvScanner("not json")).toEqual([]);
  expect(parseOsvScanner("{}")).toEqual([]);
  expect(parseOsvScanner(JSON.stringify({ results: "not-an-array" }))).toEqual([]);
});

// --- CP-NODE-1: clippy / rubocop / hadolint / actionlint / type-coverage ---

const NEW_ANALYZER_IDS = ["clippy", "rubocop", "hadolint", "actionlint", "type-coverage"];

test("all five new analyzers are registered, consent-gated (defaultRun:false)", () => {
  for (const id of NEW_ANALYZER_IDS) {
    const c = EXTERNAL_ANALYZER_CANDIDATES.find((x) => x.id === id);
    expect(c, `${id} must be registered`).toBeTruthy();
    expect(c.defaultRun, `${id} must be consent-gated`).toBe(false);
  }
});

test("new analyzers emit ONLY the generic item shape (no classification field)", () => {
  const samples = [
    parseClippySample(),
    parseRubocop_shape(),
    parseHadolintSample(),
    parseActionlintSample(),
    parseTypeCoverageSample(),
  ];
  const allowed = new Set([
    "id",
    "category",
    "severity",
    "path",
    "line_start",
    "line_end",
    "summary",
    "rule",
    "raw",
  ]);
  for (const items of samples) {
    for (const item of items) {
      for (const key of Object.keys(item)) {
        expect(allowed.has(key), `unexpected field '${key}' — no classification allowed`).toBeTruthy();
      }
      expect("classification" in item, "classification must never be emitted").toBe(false);
    }
  }
});

// clippy — cargo runner, --message-format=json, no --fix; NDJSON parse.
test("clippy: cargo runner, read-only argv (no --fix), detects Rust", () => {
  expect(clippyCandidate.runner).toBe("cargo");
  expect(clippyCandidate.spec).toBe("clippy");
  const argv = clippyCandidate.buildArgv(["cargo", "clippy"], "/repo");
  expect(argv.includes("--message-format=json")).toBeTruthy();
  expect(!argv.some((a) => /--fix/.test(a)), "clippy argv must never request fixes").toBeTruthy();
  expect(clippyCandidate.detect("/repo")).toBe(false);
});

function parseClippySample() {
  // Real cargo message-format=json stream: one JSON object per line.
  const stream = [
    JSON.stringify({ reason: "compiler-artifact", package_id: "x" }),
    JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "warning",
        message: "unused variable: `x`",
        code: { code: "clippy::unused" },
        spans: [{ file_name: "src/main.rs", line_start: 10, line_end: 10, is_primary: true }],
      },
    }),
    JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "error",
        message: "mismatched types",
        code: null,
        spans: [{ file_name: "src/lib.rs", line_start: 3, line_end: 4, is_primary: true }],
      },
    }),
    JSON.stringify({ reason: "build-finished", success: true }),
  ].join("\n");
  return clippyCandidate.parse(stream);
}

test("parseClippy maps compiler-message diagnostics (NDJSON), skips non-diagnostic lines", () => {
  const items = parseClippySample();
  expect(items.length).toBe(2);
  const warn = items.find((i) => i.severity === "medium");
  const err = items.find((i) => i.severity === "high");
  expect(warn.path).toBe("src/main.rs");
  expect(warn.line_start).toBe(10);
  expect(warn.rule).toBe("clippy::unused");
  expect(warn.category).toBe("correctness");
  expect(err.path).toBe("src/lib.rs");
  expect(err.rule).toBe("clippy");
});

test("parseClippy degrades to empty on malformed/empty input", () => {
  expect(clippyCandidate.parse("")).toEqual([]);
  expect(clippyCandidate.parse("not json")).toEqual([]);
  expect(clippyCandidate.parse("{}")).toEqual([]);
});

// rubocop — bundle runner, --format json, no autocorrect.
test("rubocop: bundle runner, read-only argv (no --autocorrect), detects Ruby", () => {
  expect(rubocopCandidate.runner).toBe("bundle");
  const argv = rubocopCandidate.buildArgv(["bundle", "exec", "rubocop"], "/repo");
  expect(argv.includes("--format") && argv.includes("json")).toBeTruthy();
  expect(!argv.some((a) => /--autocorrect|^-a$|^-A$/.test(a)), "rubocop argv must never request autocorrect").toBeTruthy();
  expect(rubocopCandidate.detect("/repo")).toBe(false);
});

function parseRubocop_shape() {
  const report = JSON.stringify({
    files: [
      {
        path: "app/models/user.rb",
        offenses: [
          {
            severity: "warning",
            message: "Line is too long.",
            cop_name: "Layout/LineLength",
            location: { start_line: 7, last_line: 7 },
          },
          {
            severity: "error",
            message: "Syntax error.",
            cop_name: "Lint/Syntax",
            location: { line: 12 },
          },
        ],
      },
    ],
  });
  return rubocopCandidate.parse(report);
}

test("parseRubocop maps files[].offenses[] with severity mapping", () => {
  const items = parseRubocop_shape();
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("app/models/user.rb");
  expect(items[0].line_start).toBe(7);
  expect(items[0].severity).toBe("medium");
  expect(items[0].rule).toBe("Layout/LineLength");
  expect(items[1].severity).toBe("high");
  expect(items[1].line_start).toBe(12);
});

test("parseRubocop degrades to empty on malformed/empty input", () => {
  expect(rubocopCandidate.parse("")).toEqual([]);
  expect(rubocopCandidate.parse("not json")).toEqual([]);
  expect(rubocopCandidate.parse("{}")).toEqual([]);
  expect(rubocopCandidate.parse(JSON.stringify({ files: "nope" }))).toEqual([]);
});

// hadolint — binary runner, RAW (non-archived) asset, per-asset checksum file.
test("hadolint: binary runner, non-archived asset, detects Dockerfile", () => {
  expect(hadolintCandidate.runner).toBe("binary");
  expect(hadolintCandidate.binary.archived).toBe(false);
  expect(hadolintCandidate.detect("/repo")).toBe(false);
  const argv = hadolintCandidate.buildArgv(["/cache/hadolint"], "/repo");
  expect(argv[0]).toBe("/cache/hadolint");
  expect(argv.includes("--format") && argv.includes("json")).toBeTruthy();
});

test("hadolint binary spec maps platform/arch to real release assets + per-asset checksum file", () => {
  const spec = hadolintCandidate.binary;
  expect(spec.version).toBe(HADOLINT_VERSION);
  expect(spec.assetFor("linux", "x64")).toBe("hadolint-linux-x86_64");
  expect(spec.assetFor("linux", "arm64")).toBe("hadolint-linux-arm64");
  expect(spec.assetFor("darwin", "x64")).toBe("hadolint-macos-x86_64");
  expect(spec.assetFor("darwin", "arm64")).toBe("hadolint-macos-arm64");
  expect(spec.assetFor("win32", "x64")).toBe("hadolint-windows-x86_64.exe");
  expect(spec.assetFor("win32", "arm64"), "no windows/arm64 asset").toBe(null);
  expect(spec.assetFor("linux", "ia32"), "no 32-bit asset").toBe(null);
  expect(spec.assetFor("sunos", "x64"), "unsupported OS → null").toBe(null);
  // Per-asset checksum file derivation.
  expect(typeof spec.checksumsAsset).toBe("function");
  expect(spec.checksumsAsset("hadolint-linux-x86_64")).toBe("hadolint-linux-x86_64.sha256");
});

test("parseHadolint maps the flat array shape; degrades to empty", () => {
  const report = JSON.stringify([
    { file: "Dockerfile", line: 3, column: 1, code: "DL3008", level: "warning", message: "Pin versions in apt-get install." },
    { file: "Dockerfile", line: 5, column: 1, code: "DL3002", level: "error", message: "Do not switch to root." },
  ]);
  const items = parseHadolint(report);
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("Dockerfile");
  expect(items[0].line_start).toBe(3);
  expect(items[0].rule).toBe("DL3008");
  expect(items[0].severity).toBe("medium");
  expect(items[0].category).toBe("config_deployment");
  expect(items[1].severity).toBe("high");
  expect(parseHadolint("")).toEqual([]);
  expect(parseHadolint("not json")).toEqual([]);
  expect(parseHadolint("{}")).toEqual([]);
});

function parseHadolintSample() {
  return parseHadolint(
    JSON.stringify([{ file: "Dockerfile", line: 1, code: "DL3006", level: "warning", message: "Tag the image." }]),
  );
}

// actionlint — binary runner, ARCHIVED asset, -format {{json .}}.
test("actionlint: binary runner, archived asset, detects .github/workflows, JSON template argv", () => {
  expect(actionlintCandidate.runner).toBe("binary");
  expect(actionlintCandidate.binary.archived).toBe(true);
  expect(actionlintCandidate.detect("/repo")).toBe(false);
  const argv = actionlintCandidate.buildArgv(["/cache/actionlint"], "/repo");
  expect(argv).toEqual(["/cache/actionlint", "-format", "{{json .}}"]);
});

test("actionlint binary spec maps platform/arch to real release assets (archive ext)", () => {
  const spec = actionlintCandidate.binary;
  expect(spec.version).toBe(ACTIONLINT_VERSION);
  expect(spec.assetFor("linux", "x64")).toBe(`actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`);
  expect(spec.assetFor("linux", "arm64")).toBe(`actionlint_${ACTIONLINT_VERSION}_linux_arm64.tar.gz`);
  expect(spec.assetFor("darwin", "arm64")).toBe(`actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz`);
  expect(spec.assetFor("win32", "x64")).toBe(`actionlint_${ACTIONLINT_VERSION}_windows_amd64.zip`);
  expect(spec.assetFor("linux", "ia32")).toBe(`actionlint_${ACTIONLINT_VERSION}_linux_386.tar.gz`);
  expect(spec.assetFor("sunos", "x64"), "unsupported OS → null").toBe(null);
  expect(spec.checksumsAsset).toBe(`actionlint_${ACTIONLINT_VERSION}_checksums.txt`);
});

test("parseActionlint maps the array shape; degrades to empty", () => {
  const report = JSON.stringify([
    { message: "shellcheck reported issue", filepath: ".github/workflows/ci.yml", line: 21, column: 9, kind: "shellcheck" },
  ]);
  const items = parseActionlint(report);
  expect(items.length).toBe(1);
  expect(items[0].path).toBe(".github/workflows/ci.yml");
  expect(items[0].line_start).toBe(21);
  expect(items[0].rule).toBe("shellcheck");
  expect(items[0].category).toBe("config_deployment");
  expect(parseActionlint("")).toEqual([]);
  expect(parseActionlint("not json")).toEqual([]);
  expect(parseActionlint("{}")).toEqual([]);
});

function parseActionlintSample() {
  return parseActionlint(
    JSON.stringify([{ message: "m", filepath: ".github/workflows/x.yml", line: 1, kind: "syntax-check" }]),
  );
}

// type-coverage — npx runner, --json, per-any items.
test("type-coverage: npx runner, --json argv, detects Node", () => {
  expect(typeCoverageCandidate.runner).toBe("npx");
  const argv = typeCoverageCandidate.buildArgv(["npx", "-y", "type-coverage@2"], "/repo");
  expect(argv.includes("--json")).toBeTruthy();
  expect(typeCoverageCandidate.detect("/repo")).toBe(false);
});

test("parseTypeCoverage maps anys[] sites; degrades to empty", () => {
  const report = JSON.stringify({
    percentage: 95.5,
    total: 1000,
    correct: 955,
    anys: [
      { file: "src/a.ts", line: 4, character: 10, text: "foo" },
      { file: "src/b.ts", line: 8, character: 2, text: "bar" },
    ],
  });
  const items = parseTypeCoverage(report);
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("src/a.ts");
  expect(items[0].line_start).toBe(4);
  expect(items[0].rule).toBe("type-coverage-any");
  expect(items[0].category).toBe("maintainability");
  expect(items[0].summary).toMatch(/foo/);
  expect(parseTypeCoverage("")).toEqual([]);
  expect(parseTypeCoverage("not json")).toEqual([]);
  expect(parseTypeCoverage("{}")).toEqual([]);
});

function parseTypeCoverageSample() {
  return parseTypeCoverage(JSON.stringify({ anys: [{ file: "src/x.ts", line: 1, text: "z" }] }));
}
