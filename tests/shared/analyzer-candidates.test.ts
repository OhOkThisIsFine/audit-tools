import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
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
  lizardCandidate,
  parseLizard,
} from "../../src/shared/analyzers/candidates.js";
import { OWNED_TOOL_IDS, registerExternalAnalyzers } from "../../src/shared/analyzers/acquisitionEngine.js";
import type { ExternalAnalyzerCandidate } from "../../src/shared/analyzers/acquisitionEngine.js";
import {
  readParseOutcome,
  type ExternalAnalyzerParseOutcome,
} from "../../src/shared/analyzers/types.js";

/** The item list of a parse outcome, whichever form the parser returned. */
const itemsOf = (outcome: ExternalAnalyzerParseOutcome) => readParseOutcome(outcome).items;
/** The degradation report of a parse outcome. */
const reportOf = (outcome: ExternalAnalyzerParseOutcome) => readParseOutcome(outcome);

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
  const items = itemsOf(parseGitleaks(report));
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

test("parseGitleaks yields no items on an empty report and REPORTS a malformed one", () => {
  // An empty report is a legitimately clean scan: no items, no degradation claimed.
  expect(reportOf(parseGitleaks(""))).toEqual({ items: [] });
  // Malformed / wrong-shape payloads are affirmed as parse failures, never as clean.
  for (const bad of ["not json", "{}"]) {
    const report = reportOf(parseGitleaks(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseGitleaks(${JSON.stringify(bad)}) must report the failure`).toBe(true);
    expect(report.note).toMatch(/gitleaks/);
  }
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
    "exports,types,nsExports,nsTypes,files,dependencies",
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
  const items = itemsOf(parseKnip(report));
  expect(items.length).toBe(4);
  const byRule: Record<string, (typeof items)[number]> = Object.fromEntries(items.map((i) => [i.rule ?? "", i]));
  expect(byRule["knip-exports"].path).toBe("src/foo.ts");
  expect(byRule["knip-exports"].line_start).toBe(12);
  expect(byRule["knip-exports"].category).toBe("maintainability");
  expect(byRule["knip-exports"].summary).toMatch(/unusedFn/);
  expect(byRule["knip-exports"].summary).toMatch(/confirm truly dead or refute/);
  expect(byRule["knip-types"].path).toBe("src/foo.ts");
  expect(byRule["knip-nsExports"].path).toBe("src/bar.ts");
  expect(byRule["knip-nsTypes"].path).toBe("src/bar.ts");
});

test("parseKnip reports a malformed/shape-drifted payload instead of a clean scan", () => {
  for (const bad of ["", "not json", "{}"]) {
    const report = reportOf(parseKnip(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseKnip(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
  // The shape-drift case the finding names: a renamed key, valid JSON, zero items.
  const drifted = reportOf(parseKnip(JSON.stringify({ problems: [{ file: "a.ts" }] })));
  expect(drifted.items).toEqual([]);
  expect(drifted.parse_failed, "renamed top-level key is a parse failure, not a clean repo").toBe(true);
});

// Whole-file dead code (`files`) and unused manifest dependencies (`dependencies`)
// are a distinct signal class from unused exports — the one the crude low-in-degree
// `deletion_candidate` graph signal only approximates. Both are surfaced as LEADS.
test("parseKnip surfaces whole-file + dependency dead-code leads alongside exports", () => {
  const report = JSON.stringify({
    issues: [
      {
        file: "src/dead.ts",
        files: [{ name: "src/dead.ts", pos: 0 }],
        exports: [{ name: "onlyThis", line: 1 }],
      },
      {
        file: "package.json",
        dependencies: [
          { name: "leftpad", line: 12 },
          { name: "unusedDep" },
        ],
      },
    ],
  });
  const items = itemsOf(parseKnip(report));
  const byRule = items.reduce<Record<string, typeof items>>((acc, i) => {
    (acc[i.rule ?? ""] ??= []).push(i);
    return acc;
  }, {});

  // One whole-file lead for the unused module (path === the file itself).
  expect(byRule["knip-files"].length).toBe(1);
  expect(byRule["knip-files"][0].path).toBe("src/dead.ts");
  expect(byRule["knip-files"][0].category).toBe("maintainability");
  expect(byRule["knip-files"][0].summary).toMatch(/appears unused/);
  expect(byRule["knip-files"][0].summary).toMatch(/confirm truly dead or refute/);

  // One dependency lead per unused dependency name (path === the manifest).
  expect(byRule["knip-dependencies"].length).toBe(2);
  expect(byRule["knip-dependencies"].map((i) => i.path)).toEqual(["package.json", "package.json"]);
  expect(byRule["knip-dependencies"].map((i) => i.id)).toEqual([
    "knip-dependencies:package.json:leftpad",
    "knip-dependencies:package.json:unusedDep",
  ]);
  expect(byRule["knip-dependencies"][0].line_start).toBe(12);
  expect(byRule["knip-dependencies"][0].summary).toMatch(/appears unused/);

  // The export lead still flows on the same row.
  expect(byRule["knip-exports"].length).toBe(1);
  expect(byRule["knip-exports"][0].path).toBe("src/dead.ts");
});

test("parseSemgrep + parseEslint report malformed input; map real payloads", () => {
  for (const [id, candidate] of [["semgrep", semgrepCandidate], ["eslint", eslintCandidate]] as const) {
    const report = reportOf(candidate.parse("nonsense"));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `${id} must report a malformed payload`).toBe(true);
  }
  expect(itemsOf(semgrepCandidate.parse(
      JSON.stringify({
        results: [
          { check_id: "rule.x", path: "a.py", start: { line: 3 }, end: { line: 3 }, extra: { message: "bad", severity: "ERROR" } },
        ],
      }),
    )).map((i) => [i.rule, i.severity, i.line_start])).toEqual([["rule.x", "high", 3]]);
  expect(itemsOf(eslintCandidate.parse(
      JSON.stringify([
        { filePath: "a.js", messages: [{ ruleId: "no-var", line: 2, message: "use const", severity: 2 }] },
      ]),
    )).map((i) => [i.rule, i.severity, i.line_start])).toEqual([["no-var", "medium", 2]]);
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
  const items = itemsOf(parseJscpd(report));
  expect(items.length).toBe(1);
  expect(items[0].path).toBe("src/a.ts");
  expect(items[0].line_start).toBe(10);
  expect(items[0].line_end).toBe(25);
  expect(items[0].category).toBe("maintainability");
  expect(items[0].summary).toMatch(/src\/b\.ts/);
});

test("parseJscpd reports malformed/empty/missing-duplicates input", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ duplicates: "not-an-array" })]) {
    const report = reportOf(parseJscpd(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseJscpd(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
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
  const spec = osvScannerCandidate.binary!;
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
  const items = itemsOf(parseOsvScanner(report));
  expect(items.length).toBe(1);
  expect(items[0].category).toBe("security");
  expect(items[0].severity).toBe("high");
  expect(items[0].path).toBe("package-lock.json");
  expect(items[0].rule).toBe("GHSA-c3h9-896r-86jm");
  expect(items[0].summary).toMatch(/gogo\/protobuf@1\.3\.1/);
  expect(items[0].summary).toMatch(/Index validation issue/);
});

test("parseOsvScanner maps max_severity to the engine's severity strings and skips groups with no ids", () => {
  const makeReport = (maxSeverity: string) =>
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
  expect(itemsOf(parseOsvScanner(makeReport("CRITICAL")))[0].severity).toBe("high");
  expect(itemsOf(parseOsvScanner(makeReport("MODERATE")))[0].severity).toBe("medium");
  expect(itemsOf(parseOsvScanner(makeReport("LOW")))[0].severity).toBe("low");
  expect(itemsOf(parseOsvScanner(makeReport("")))[0].severity).toBe("medium");

  const noIds = JSON.stringify({
    results: [
      {
        source: { path: "go.sum" },
        packages: [{ package: { name: "pkg" }, vulnerabilities: [], groups: [{ ids: [] }] }],
      },
    ],
  });
  expect(itemsOf(parseOsvScanner(noIds)), "a group with no ids yields no item, and that is not a parse failure").toEqual([]);
});

test("parseOsvScanner reports malformed/empty input", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ results: "not-an-array" })]) {
    const report = reportOf(parseOsvScanner(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseOsvScanner(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
});

// --- CP-NODE-1: clippy / rubocop / hadolint / actionlint / type-coverage ---

// inv-13: the roster is DERIVED from EXTERNAL_ANALYZER_CANDIDATES. A hand-copied id
// list cannot assert anything about a candidate registered after it was written —
// and the stale "all seven" name it used to carry read as coverage of twelve.
test("every registered candidate is exported as its own named binding", () => {
  // Deriving the partition (see the inv-13 test further down) only proves things
  // about ids that reached the registry; this proves the registry is the roster the
  // module actually exposes, so no candidate can be registered invisibly.
  const registered = EXTERNAL_ANALYZER_CANDIDATES.map((c) => c.id);
  const namedExports = [
    gitleaksCandidate,
    semgrepCandidate,
    eslintCandidate,
    knipCandidate,
    jscpdCandidate,
    osvScannerCandidate,
    clippyCandidate,
    rubocopCandidate,
    hadolintCandidate,
    actionlintCandidate,
    typeCoverageCandidate,
    lizardCandidate,
  ].map((c) => c.id);
  expect([...registered].sort(), "the registry and the named exports are the same set").toEqual(
    [...namedExports].sort(),
  );
});

test("new analyzers emit ONLY the generic item shape (no classification field)", () => {
  const samples = [
    parseClippySample(),
    parseRubocop_shape(),
    parseHadolintSample(),
    parseActionlintSample(),
    parseTypeCoverageSample(),
  ].map(itemsOf);
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
  const items = itemsOf(parseClippySample());
  expect(items.length).toBe(2);
  const warn = items.find((i) => i.severity === "medium")!;
  const err = items.find((i) => i.severity === "high")!;
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
  const items = itemsOf(parseRubocop_shape());
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("app/models/user.rb");
  expect(items[0].line_start).toBe(7);
  expect(items[0].severity).toBe("medium");
  expect(items[0].rule).toBe("Layout/LineLength");
  expect(items[1].severity).toBe("high");
  expect(items[1].line_start).toBe(12);
});

test("parseRubocop REPORTS a malformed payload — the channel the adapter could never reach", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ files: "nope" })]) {
    const report = reportOf(rubocopCandidate.parse(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `rubocop parse of ${JSON.stringify(bad)} must report the failure`).toBe(true);
    expect(report.note).toMatch(/rubocop/);
  }
  // A genuinely clean Ruby tree is NOT a parse failure — the two must stay apart.
  const clean = reportOf(rubocopCandidate.parse(JSON.stringify({ files: [] })));
  expect(clean.items).toEqual([]);
  expect(clean.parse_failed).toBe(undefined);
});

// hadolint — binary runner, RAW (non-archived) asset, per-asset checksum file.
test("hadolint: binary runner, non-archived asset, detects Dockerfile", () => {
  expect(hadolintCandidate.runner).toBe("binary");
  expect(hadolintCandidate.binary!.archived).toBe(false);
  expect(hadolintCandidate.detect("/repo")).toBe(false);
  const argv = hadolintCandidate.buildArgv(["/cache/hadolint"], "/repo");
  expect(argv[0]).toBe("/cache/hadolint");
  expect(argv.includes("--format") && argv.includes("json")).toBeTruthy();
});

test("hadolint binary spec maps platform/arch to real release assets + per-asset checksum file", () => {
  const spec = hadolintCandidate.binary!;
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
  if (typeof spec.checksumsAsset !== "function") throw new Error("expected function");
  expect(spec.checksumsAsset("hadolint-linux-x86_64")).toBe("hadolint-linux-x86_64.sha256");
});

test("parseHadolint maps the flat array shape; degrades to empty", () => {
  const report = JSON.stringify([
    { file: "Dockerfile", line: 3, column: 1, code: "DL3008", level: "warning", message: "Pin versions in apt-get install." },
    { file: "Dockerfile", line: 5, column: 1, code: "DL3002", level: "error", message: "Do not switch to root." },
  ]);
  const items = itemsOf(parseHadolint(report));
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("Dockerfile");
  expect(items[0].line_start).toBe(3);
  expect(items[0].rule).toBe("DL3008");
  expect(items[0].severity).toBe("medium");
  expect(items[0].category).toBe("config_deployment");
  expect(items[1].severity).toBe("high");
  for (const bad of ["not json", "{}"]) {
    const report = reportOf(parseHadolint(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseHadolint(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
  expect(reportOf(parseHadolint("")), "an empty report is a clean Dockerfile, not a failure").toEqual({ items: [] });
});

function parseHadolintSample() {
  return parseHadolint(
    JSON.stringify([{ file: "Dockerfile", line: 1, code: "DL3006", level: "warning", message: "Tag the image." }]),
  );
}

// actionlint — binary runner, ARCHIVED asset, -format {{json .}}.
test("actionlint: binary runner, archived asset, detects .github/workflows, JSON template argv", () => {
  expect(actionlintCandidate.runner).toBe("binary");
  expect(actionlintCandidate.binary!.archived).toBe(true);
  expect(actionlintCandidate.detect("/repo")).toBe(false);
  const argv = actionlintCandidate.buildArgv(["/cache/actionlint"], "/repo");
  expect(argv).toEqual(["/cache/actionlint", "-format", "{{json .}}"]);
});

test("actionlint binary spec maps platform/arch to real release assets (archive ext)", () => {
  const spec = actionlintCandidate.binary!;
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
  const items = itemsOf(parseActionlint(report));
  expect(items.length).toBe(1);
  expect(items[0].path).toBe(".github/workflows/ci.yml");
  expect(items[0].line_start).toBe(21);
  expect(items[0].rule).toBe("shellcheck");
  expect(items[0].category).toBe("config_deployment");
  for (const bad of ["not json", "{}"]) {
    const report = reportOf(parseActionlint(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseActionlint(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
  expect(reportOf(parseActionlint("")), "no workflow findings is a clean run, not a failure").toEqual({ items: [] });
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
  const items = itemsOf(parseTypeCoverage(report));
  expect(items.length).toBe(2);
  expect(items[0].path).toBe("src/a.ts");
  expect(items[0].line_start).toBe(4);
  expect(items[0].rule).toBe("type-coverage-any");
  expect(items[0].category).toBe("maintainability");
  expect(items[0].summary).toMatch(/foo/);
  for (const bad of ["", "not json", "{}"]) {
    const report = reportOf(parseTypeCoverage(bad));
    expect(report.items).toEqual([]);
    expect(report.parse_failed, `parseTypeCoverage(${JSON.stringify(bad)}) must report the failure`).toBe(true);
  }
});

function parseTypeCoverageSample() {
  return parseTypeCoverage(JSON.stringify({ anys: [{ file: "src/x.ts", line: 1, text: "z" }] }));
}

// lizard — complexity metrics via pipx runner.
test("lizard: pipx runner, CSV format, detects Python/Rust/Ruby ecosystems", () => {
  expect(lizardCandidate.runner).toBe("pipx");
  expect(lizardCandidate.defaultRun).toBe(true);
  const argv = lizardCandidate.buildArgv(["pipx", "run", "--spec", "lizard==1.17.10"], "/repo");
  expect(argv.includes("-l")).toBeTruthy();
  expect(argv.includes("--csv")).toBeTruthy();
});

test("parseLizard: CSV format with quoted fields (function signatures with commas)", () => {
  // Lizard CSV format: NLOC,CCN,Token,PARAM,Length,Location,File,Function
  // Test with a function signature that contains commas (quoted in CSV)
  const report = `NLOC,CCN,Token,PARAM,Length,Location,File,Function
150,12,500,6,180,"src/module.py:10-160","src/module.py","def process(a, b, c, d, e, f)"
250,25,1200,8,300,"src/utils.py:20-280","src/utils.py","def complex_func(x, y, z)"
50,5,200,2,60,"src/helper.py:1-50","src/helper.py","helper"`;

  const items = itemsOf(parseLizard(report));
  // First function: CCN=12 (> 10) + PARAM=6 (> 5) = 2 issues
  // Second function: CCN=25 (> 10) + PARAM=8 (> 5) = 2 issues
  // Third function: all below thresholds = 0 issues
  // Total: 4 issues + 1 extra for NLOC=250 > 200 = 5 issues
  expect(items.length).toBeGreaterThan(0);
  // Verify lizard-ccn reports for high-complexity functions
  expect(items.filter((i) => i.rule === "lizard-ccn").length).toBeGreaterThan(0);
  expect(items.filter((i) => i.rule === "lizard-params").length).toBeGreaterThan(0);
  // Verify that quoted function signature with commas parsed correctly
  const ccnItems = items.filter((i) => i.rule === "lizard-ccn");
  expect(ccnItems.some((i) => i.summary?.includes("process"))).toBeTruthy();
  // Last item: all metrics below thresholds
  const helperItems = items.filter((i) => i.path === "src/helper.py");
  expect(helperItems.length).toBe(0); // No issues reported for this function
});

test("parseLizard: an empty/header-only CSV is clean; dropped rows are TALLIED, never silent", () => {
  // Nothing to parse at all — clean, no degradation claimed.
  for (const empty of ["", "header only\n", "not a csv", "NLOC,CCN,Token,PARAM,Length,Location,File,Function"]) {
    const report = reportOf(parseLizard(empty));
    expect(report.items, `parseLizard(${JSON.stringify(empty)}) yields no items`).toEqual([]);
    expect(report.dropped_rows ?? 0, "no data rows means nothing was dropped").toBe(0);
  }
  // Data rows the CSV shape does not fit are COUNTED. Without the tally these rows
  // are byte-identical to a repo whose functions are all under threshold.
  const drifted = reportOf(
    parseLizard(
      [
        "NLOC,CCN,Token,PARAM,Length,Location,File,Function",
        "150,12,500",
        "not,a,valid,row,at,all,,",
        "x,y,500,z,180,loc,src/a.py,fn",
      ].join("\n"),
    ),
  );
  expect(drifted.items).toEqual([]);
  expect(drifted.dropped_rows, "every unusable data row must be tallied").toBe(3);
});

// ───────────────────────────────────────────────────────────────────────────
// The acquisition chokepoint: admission, classification, and the status record.
//
// `admitSpawn` is the ONE place a recorded operator decision can be enforced, and
// `runExternalAnalyzer` is the ONE place a run's outcome is classified. Both are
// exercised here against the real registry rather than only against fixtures.
// ───────────────────────────────────────────────────────────────────────────

const {
  admitSpawn,
  runExternalAnalyzer,
  ANALYZER_DENIAL_REASONS,
  detectNodeEcosystem,
  detectPythonEcosystem,
  detectRustEcosystem,
  detectRubyEcosystem,
  detectDockerEcosystem,
  detectGithubActionsEcosystem,
} = await import("../../src/shared/analyzers/acquisitionEngine.js");

const engineCandidate = (
  overrides: Partial<ExternalAnalyzerCandidate> = {},
): ExternalAnalyzerCandidate => ({
  id: "eslint",
  runner: "npx",
  spec: "eslint@9",
  safetyProfile: {
    config_execution: "executable",
    network_egress: false,
    version_pinning: "pinned",
  },
  defaultRun: false,
  detect: () => true,
  buildArgv: (prefix: string[], root: string) => [...prefix, "--format", "json", root],
  parse: () => [],
  ...overrides,
});

/** A per-run consent GRANT naming the candidate under test (the only token form). */
function grantFor(id: string, value = "tok"): { value: string; tools: string[] } {
  return { value, tools: [id] };
}

/** An ASYNC runner whose `--version` probe succeeds and whose tool spawn is scripted. */
function scriptedRunner(
  tool: () => { status: number; stdout: string; stderr: string },
  spawned: string[][] = [],
) {
  return async (argv: string[]) => {
    spawned.push(argv);
    if (argv.includes("--version")) {
      return { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 };
    }
    return { ...tool(), argv, duration_ms: 1 };
  };
}

test("inv-1: a recorded 'declined' vetoes the spawn BEFORE the token and BEFORE the default-set short-circuit", () => {
  // The two cases HEAD could not refuse. A non-default tool with a token: the token
  // branch admitted it. A DEFAULT-set tool: the defaultRun short-circuit returned
  // admitted before the recorded decision was ever read.
  expect(
    typeof admitSpawn(
      engineCandidate({ defaultRun: false }),
      "auto",
      grantFor("eslint"),
      "declined",
    ),
    "a per-run grant must NEVER override a recorded decline",
  ).toBe("string");
  expect(
    typeof admitSpawn(engineCandidate({ defaultRun: true }), "auto", undefined, "declined"),
    "a decline must be enforceable for a DEFAULT-set tool too",
  ).toBe("string");
  // …and the positive controls still admit, so the veto is not just "deny everything".
  expect(admitSpawn(engineCandidate({ defaultRun: true }), "auto", undefined)).toBe(undefined);
  expect(
    admitSpawn(engineCandidate({ defaultRun: false }), "auto", grantFor("eslint")),
  ).toBe(undefined);
});

test("inv-2: declined and undecided are DISTINCT reasons, and the reason reaches the status record", async () => {
  const declined = admitSpawn(engineCandidate(), "auto", undefined, "declined");
  const undecided = admitSpawn(engineCandidate(), "auto", undefined, undefined);
  expect(declined).toBe(ANALYZER_DENIAL_REASONS.consent_declined);
  expect(undecided).toBe(ANALYZER_DENIAL_REASONS.consent_not_decided);
  expect(declined, "an operator refusal must not read the same as 'nobody decided'").not.toBe(
    undecided,
  );

  // The cause survives onto the emitted status — the only post-run evidence there is.
  const spawned: string[][] = [];
  const outcome = await runExternalAnalyzer(engineCandidate(), "/root", {
    run: scriptedRunner(() => ({ status: 0, stdout: "[]", stderr: "" }), spawned),
    analyzerConsent: { eslint: "declined" },
  });
  expect(outcome.status.status).toBe("skipped");
  expect(outcome.status.error).toBe(ANALYZER_DENIAL_REASONS.consent_declined);
  expect(spawned.length, "a declined tool spawns nothing — not even the capability probe").toBe(0);
});

test("inv-3: a SCOPED consent token issued for tool A denies tool B", () => {
  const grant = { value: "issued-for-eslint", tools: ["eslint"] };
  expect(admitSpawn(engineCandidate({ id: "eslint" }), "auto", grant, undefined)).toBe(undefined);
  expect(
    admitSpawn(engineCandidate({ id: "semgrep" }), "auto", grant, undefined),
    "a grant obtained by offering eslint must not admit semgrep",
  ).toBe(ANALYZER_DENIAL_REASONS.consent_token_scope);
  // An empty grant value is not a token at all — it falls through to "undecided".
  expect(admitSpawn(engineCandidate(), "auto", { value: "  ", tools: ["eslint"] })).toBe(
    ANALYZER_DENIAL_REASONS.consent_not_decided,
  );
  // A scoped grant still cannot override a recorded decline.
  expect(admitSpawn(engineCandidate(), "auto", grant, "declined")).toBe(
    ANALYZER_DENIAL_REASONS.consent_declined,
  );
});

test("inv-7: a non-zero exit with diagnostics on stderr is `failed`, never `success`", async () => {
  const outcome = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: scriptedRunner(() => ({ status: 2, stdout: "", stderr: "config error: bad rule set" })),
  });
  expect(outcome.status.status, "a broken analyzer must not read as a clean repo").toBe("failed");
  expect(outcome.status.exit_code).toBe(2);
  expect(outcome.status.stderr_snippet, "stderr is the evidence of WHY it failed").toMatch(
    /bad rule set/,
  );
  expect(outcome.results.results.length).toBe(0);

  // The exit code alone is decisive — a silent non-zero exit is still not a clean
  // scan, so this half must hold with nothing on stderr to fall back on.
  const silentFailure = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: scriptedRunner(() => ({ status: 3, stdout: "[]", stderr: "" })),
  });
  expect(silentFailure.status.status, "exit 3 with parsable-but-empty output is a failure").toBe(
    "failed",
  );
  expect(silentFailure.status.exit_code).toBe(3);
});

test("inv-7: a run whose only output is stderr is `failed`; a genuinely clean run is `success`", async () => {
  const stderrOnly = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: scriptedRunner(() => ({ status: 0, stdout: "   ", stderr: "warning: no config found" })),
  });
  expect(stderrOnly.status.status).toBe("failed");
  expect(stderrOnly.status.stderr_snippet).toMatch(/no config found/);

  const clean = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: scriptedRunner(() => ({ status: 0, stdout: "[]", stderr: "" })),
  });
  expect(clean.status.status, "exit 0 + parsed + nothing on stderr IS a clean scan").toBe("success");
});

test("inv-8: a reported parse failure classifies `parse_error`, and dropped rows classify too", async () => {
  const parseFailed = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => ({ items: [], parse_failed: true, note: "shape drift: renamed key" }),
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "{}", stderr: "" })) },
  );
  expect(parseFailed.status.status).toBe("parse_error");
  expect(parseFailed.status.error).toMatch(/shape drift/);

  const dropped = await runExternalAnalyzer(
    engineCandidate({ defaultRun: true, parse: () => ({ items: [], dropped_rows: 4 }) }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "rows", stderr: "" })) },
  );
  expect(dropped.status.status, "every row dropped is not a clean scan").toBe("parse_error");
  expect(dropped.status.dropped_rows).toBe(4);
});

test("inv-10 + inv-11: absolute tool paths persist repo-relative, and an unreadable source is COUNTED", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp1-paths-"));
  try {
    await writeFile(join(root, "a.ts"), "line one\nline two\nline three\n");
    const outcome = await runExternalAnalyzer(
      engineCandidate({
        defaultRun: true,
        parse: () => [
          {
            path: join(root, "a.ts"),
            line_start: 1,
            line_end: 2,
            summary: "lead in a.ts",
            rule: "r1",
          },
          {
            path: join(root, "gone.ts"),
            line_start: 1,
            summary: "lead in a missing file",
            rule: "r2",
          },
        ],
      }),
      root,
      { run: scriptedRunner(() => ({ status: 0, stdout: "x", stderr: "" })) },
    );
    const [anchored, unreadable] = outcome.results.results;
    // inv-10: the persisted path is repo-relative — never the operator's absolute path.
    expect(anchored.path, "an absolute emitter must be normalized at the boundary").toBe("a.ts");
    expect(unreadable.path).toBe("gone.ts");
    // …and BECAUSE it was normalized, the provenance read now resolves.
    expect(anchored.provenance?.path).toBe("a.ts");
    expect(typeof anchored.provenance?.snippet_hash).toBe("string");
    // inv-11: the item that HAD an anchor but could not be read is recorded, not silent.
    expect(unreadable.provenance).toBe(undefined);
    expect(outcome.status.source_read_failures).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inv-11: an item with no line anchor is NOT counted as a read failure", async () => {
  const outcome = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => [{ path: "nowhere.ts", summary: "no anchor at all" }],
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "x", stderr: "" })) },
  );
  expect(outcome.status.status).toBe("findings");
  expect(
    outcome.status.source_read_failures,
    "no anchor is a benign absence, not a broken read seam",
  ).toBe(undefined);
});

test("fail-7: an absent runner degrades to not_resolved carrying the probe reason, never success", async () => {
  const outcome = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: async (argv: string[]) => ({
      status: 127,
      stdout: "",
      stderr: "command not found",
      argv,
      duration_ms: 1,
      error: new Error("ENOENT"),
    }),
  });
  expect(outcome.status.status).toBe("not_resolved");
  expect(outcome.status.error).toMatch(/not available/);
  expect(outcome.results.results.length).toBe(0);
});

// ───────────────────────────────────────────────────────────────────────────
// inv-12: detect() asserted TRUE against a tree that carries the marker.
//
// Asserting only `detect("/repo") === false` against a path that does not exist is
// vacuous: a detector regressed to always-false passes it, and every acquired
// analyzer would silently stop running while the suite stayed green.
// ───────────────────────────────────────────────────────────────────────────

const MARKER_ECOSYSTEMS: ReadonlyArray<{
  name: string;
  marker: string;
  detect: (root: string) => boolean;
}> = [
  { name: "node", marker: "package.json", detect: detectNodeEcosystem },
  { name: "python", marker: "pyproject.toml", detect: detectPythonEcosystem },
  { name: "rust", marker: "Cargo.toml", detect: detectRustEcosystem },
  { name: "ruby", marker: "Gemfile", detect: detectRubyEcosystem },
  { name: "docker", marker: "Dockerfile", detect: detectDockerEcosystem },
  {
    name: "github-actions",
    marker: join(".github", "workflows", "ci.yml"),
    detect: detectGithubActionsEcosystem,
  },
];

for (const ecosystem of MARKER_ECOSYSTEMS) {
  test(`inv-12: ${ecosystem.name} detect() is TRUE with its marker and FALSE on a sibling without it`, async () => {
    const withMarker = await mkdtemp(join(tmpdir(), `cp1-${ecosystem.name}-`));
    const without = await mkdtemp(join(tmpdir(), `cp1-${ecosystem.name}-bare-`));
    try {
      await mkdir(dirname(join(withMarker, ecosystem.marker)), { recursive: true });
      await writeFile(join(withMarker, ecosystem.marker), "\n");
      expect(
        ecosystem.detect(withMarker),
        `${ecosystem.name} must DETECT a tree carrying ${ecosystem.marker}`,
      ).toBe(true);
      expect(
        ecosystem.detect(without),
        `${ecosystem.name} must not detect a tree without ${ecosystem.marker}`,
      ).toBe(false);
    } finally {
      await rm(withMarker, { recursive: true, force: true });
      await rm(without, { recursive: true, force: true });
    }
  });
}

test("inv-12: every registered candidate's detect() reports TRUE on a tree carrying every marker", async () => {
  // Derived from the registry, so a NEW candidate whose detector is always-false is
  // caught here without anyone remembering to add a case.
  const root = await mkdtemp(join(tmpdir(), "cp1-allmarkers-"));
  try {
    for (const marker of [
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "Gemfile",
      "Dockerfile",
    ]) {
      await writeFile(join(root, marker), marker === "package.json" ? "{}" : "\n");
    }
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "\n");
    // lizard detects SOURCES, not manifests — give the tree one non-JS/TS source.
    await writeFile(join(root, "main.py"), "print(1)\n");
    for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
      expect(
        candidate.detect(root),
        `${candidate.id}.detect() must be TRUE on a tree carrying every ecosystem marker`,
      ).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// inv-13: the roster is DERIVED, so a newly registered candidate cannot slip in
// unasserted behind a hand-copied literal set (and a stale "all seven" name).
// ───────────────────────────────────────────────────────────────────────────

test("inv-13: every registered candidate is partitioned by its OWN defaultRun flag", () => {
  const defaultSet = EXTERNAL_ANALYZER_CANDIDATES.filter((c) => c.defaultRun).map((c) => c.id);
  const consentGated = EXTERNAL_ANALYZER_CANDIDATES.filter((c) => !c.defaultRun).map((c) => c.id);

  expect(defaultSet.length + consentGated.length, "the partition covers the whole registry").toBe(
    EXTERNAL_ANALYZER_CANDIDATES.length,
  );
  expect(defaultSet.length, "the default set is non-empty").toBeGreaterThan(0);
  expect(consentGated.length, "the consent-gated set is non-empty").toBeGreaterThan(0);
  expect(new Set(EXTERNAL_ANALYZER_CANDIDATES.map((c) => c.id)).size, "ids are unique").toBe(
    EXTERNAL_ANALYZER_CANDIDATES.length,
  );

  // The property that matters per member, asserted over the DERIVED partition: a
  // default-set member runs unprompted; a consent-gated member does not.
  for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
    const admitted = admitSpawn(candidate, "auto", undefined, undefined) === undefined;
    expect(
      admitted,
      `${candidate.id} (defaultRun: ${candidate.defaultRun}) must ${
        candidate.defaultRun ? "run unprompted" : "require consent"
      }`,
    ).toBe(candidate.defaultRun);
    expect(typeof candidate.purpose, `${candidate.id} must carry an operator-facing purpose`).toBe(
      "string",
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// inv-18: ONE exported status vocabulary, consumed through an EXHAUSTIVE mapping,
// and ONE declared merge helper for entries from both producers.
// ───────────────────────────────────────────────────────────────────────────

const {
  EXTERNAL_ANALYZER_TOOL_STATUSES,
  EXTERNAL_ANALYZER_STATUS_CLASSIFICATION,
  isDegradedExternalAnalyzerStatus,
  ExternalAnalyzerToolStatusSchema,
  upsertExternalToolResults,
} = await import("../../src/shared/analyzers/types.js");

test("inv-18: the status union, the zod enum, and the exhaustive classification map agree", () => {
  // The schema enum is BUILT from the tuple, so they cannot drift; the classification
  // map is a Record over the same tuple, so a new member without a row fails `check`.
  for (const status of EXTERNAL_ANALYZER_TOOL_STATUSES) {
    expect(
      ExternalAnalyzerToolStatusSchema.safeParse({ tool: "t", resolved: true, status }).success,
      `${status} must be accepted by the persisted status schema`,
    ).toBe(true);
    expect(
      EXTERNAL_ANALYZER_STATUS_CLASSIFICATION[status],
      `${status} must be classified for coverage`,
    ).toBeTruthy();
  }
  // Only the two affirmative members may be read as "this tool produced coverage",
  // and only on a record carrying no degradation marker.
  const affirmative = EXTERNAL_ANALYZER_TOOL_STATUSES.filter(
    (s) => !isDegradedExternalAnalyzerStatus({ status: s, exit_code: 0 }),
  );
  expect([...affirmative].sort()).toEqual(["findings", "success"]);
  // A checksum mismatch is its own member — never flattened into not_resolved.
  expect(EXTERNAL_ANALYZER_TOOL_STATUSES).toContain("checksum_mismatch");
  expect(
    ExternalAnalyzerToolStatusSchema.safeParse({ tool: "t", resolved: true, status: "invented" })
      .success,
    "the vocabulary is closed",
  ).toBe(false);
});

test("inv-18: upsertExternalToolResults is the single merge helper — same tool replaces, others survive", () => {
  const first = upsertExternalToolResults(undefined, { tool: "gitleaks", results: [] });
  const second = upsertExternalToolResults(first, {
    tool: "eslint",
    results: [{ id: "e1", category: "c", severity: "low", path: "a.ts", summary: "s" }],
  });
  const replaced = upsertExternalToolResults(second, { tool: "eslint", results: [] });
  expect(
    replaced.map((entry) => entry.tool),
    "sorted, one entry per tool",
  ).toEqual(["eslint", "gitleaks"]);
  expect(
    replaced.find((entry) => entry.tool === "eslint")!.results.length,
    "a fresh run supersedes",
  ).toBe(0);
  expect(
    replaced.find((entry) => entry.tool === "gitleaks"),
    "the other producer survives",
  ).toBeTruthy();
});

// ───────────────────────────────────────────────────────────────────────────
// inv-15 / fail-10 / fail-11: the durable policy merge is lock-guarded and an
// invalid artifact fails CLOSED. A lost decline is an unenforceable veto — exactly
// what the admission ladder above exists to enforce.
// ───────────────────────────────────────────────────────────────────────────

const {
  loadAnalyzerPolicy,
  persistAnalyzerConsent,
  persistAnalyzerSettings,
  getAnalyzerPolicyPath,
} = await import("../../src/shared/analyzerPolicy.js");

test("inv-15 / fail-11: concurrent consent + settings writes both land, neither is lost or torn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp1-policy-"));
  try {
    await mkdir(join(root, ".audit-tools", "audit"), { recursive: true });
    // Interleave many writers against the one artifact. Without the locked
    // read-modify-write, a plain write drops whichever decision it did not read.
    await Promise.all([
      ...["eslint", "knip", "semgrep", "jscpd"].map((id) =>
        persistAnalyzerConsent(root, { [id]: "declined" }),
      ),
      ...["clippy", "rubocop"].map((id) => persistAnalyzerSettings(root, { [id]: "skip" })),
    ]);
    const policy = await loadAnalyzerPolicy(root);
    for (const id of ["eslint", "knip", "semgrep", "jscpd"]) {
      expect(
        policy.analyzer_consent?.[id],
        `${id}'s decline must survive concurrent writers`,
      ).toBe("declined");
    }
    for (const id of ["clippy", "rubocop"]) {
      expect(policy.analyzers?.[id], `${id}'s setting must survive concurrent writers`).toBe("skip");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fail-10: a malformed policy artifact throws — it never degrades to an empty policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp1-policy-bad-"));
  try {
    await mkdir(join(root, ".audit-tools", "audit"), { recursive: true });
    // A value outside the decision vocabulary. Degrading to `{}` here would silently
    // discard every recorded decline, which the chokepoint could then never enforce.
    await writeFile(
      getAnalyzerPolicyPath(root),
      JSON.stringify({ analyzer_consent: { eslint: "maybe" } }),
      "utf8",
    );
    await expect(loadAnalyzerPolicy(root)).rejects.toThrow(/analyzer_consent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Adversarial-review fixes (RV-1, RV-3, RV-4, RV-5).
// ───────────────────────────────────────────────────────────────────────────

test("RV-1: a signal-killed analyzer (null exit status) is `failed`, never a clean scan", async () => {
  // RunTrackedResult carries no signal field, so a null status is the ONLY trace that
  // the child never exited on its own (SIGKILL / OOM). Reading `typeof status ===
  // "number" && status !== 0` skipped it entirely — and win32 reports the same kill as
  // status 1, so the identical event classified differently per OS.
  const killed = await runExternalAnalyzer(engineCandidate({ defaultRun: true }), "/root", {
    run: async (argv: string[]) =>
      argv.includes("--version")
        ? { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 }
        : { status: null, stdout: "", stderr: "", argv, duration_ms: 1 },
  });
  expect(killed.status.status, "a killed analyzer produced no coverage").toBe("failed");
  expect(killed.status.error).toMatch(/exit status|signal/i);
  expect(
    isDegradedExternalAnalyzerStatus(killed.status),
    "and the record answers the coverage question the same way",
  ).toBe(true);
});

test("RV-3: items the NORMALIZER drops are counted — an all-dropped run is not clean", async () => {
  // Two items parse fine and both are discarded for a missing summary. Counting only
  // the parser's own drops left this reading as `success` with no drop count at all.
  const outcome = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => [{ path: "a.ts" }, { path: "b.ts" }],
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "[]", stderr: "" })) },
  );
  expect(outcome.status.status, "every item dropped is not a clean scan").toBe("parse_error");
  expect(outcome.status.dropped_rows).toBe(2);
  expect(isDegradedExternalAnalyzerStatus(outcome.status)).toBe(true);
});

test("RV-3: parser-dropped and normalizer-dropped counts land on ONE field", async () => {
  const outcome = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => ({ items: [{ path: "a.ts" }], dropped_rows: 3 }),
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "rows", stderr: "" })) },
  );
  expect(outcome.status.dropped_rows, "3 parser rows + 1 normalizer item").toBe(4);
});

test("RV-4: a partially-crashed run carrying items still classifies as DEGRADED", async () => {
  // The status member lands on `findings` — an affirmative value — because items
  // survived. Asking the member alone reports a crashed run as trustworthy coverage.
  const partial = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => [{ path: "a.ts", summary: "one surviving lead" }],
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 2, stdout: "partial", stderr: "crashed midway" })) },
  );
  expect(partial.status.status, "items survived, so the member is affirmative").toBe("findings");
  expect(partial.status.exit_code).toBe(2);
  expect(
    isDegradedExternalAnalyzerStatus(partial.status),
    "…but the RECORD must still answer 'not trustworthy coverage'",
  ).toBe(true);

  // Same for dropped rows and unresolved provenance alongside surviving items.
  const dropped = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => ({ items: [{ path: "a.ts", summary: "kept" }], dropped_rows: 5 }),
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "rows", stderr: "" })) },
  );
  expect(dropped.status.status).toBe("findings");
  expect(isDegradedExternalAnalyzerStatus(dropped.status)).toBe(true);

  // …and a genuinely clean run is NOT degraded, so the predicate still discriminates.
  const clean = await runExternalAnalyzer(
    engineCandidate({
      defaultRun: true,
      parse: () => [{ path: "a.ts", summary: "kept" }],
    }),
    "/root",
    { run: scriptedRunner(() => ({ status: 0, stdout: "[]", stderr: "" })) },
  );
  expect(clean.status.status).toBe("findings");
  expect(isDegradedExternalAnalyzerStatus(clean.status)).toBe(false);
});

test("D-2: an unresolved provenance anchor is NOT lost coverage — it does not make a run degraded", async () => {
  // Provenance is optional everywhere on this contract, so an item whose anchor could
  // not be read is still a fully reported lead: a weaker join key, not a lost finding.
  // The count stays on the record because it is worth surfacing.
  const root = await mkdtemp(join(tmpdir(), "cp1-anchor-"));
  try {
    const outcome = await runExternalAnalyzer(
      engineCandidate({
        defaultRun: true,
        parse: () => [
          { path: "gone.ts", line_start: 1, summary: "reported, but unanchorable", rule: "r" },
        ],
      }),
      root,
      { run: scriptedRunner(() => ({ status: 0, stdout: "x", stderr: "" })) },
    );
    expect(outcome.status.status).toBe("findings");
    expect(outcome.status.source_read_failures, "still recorded on the record").toBe(1);
    expect(outcome.results.results.length, "the lead itself is reported in full").toBe(1);
    expect(
      isDegradedExternalAnalyzerStatus(outcome.status),
      "an optional anchor that did not resolve is not untrustworthy coverage",
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RV-5: a recorded decline outranks setting=skip — the reason names the OPERATOR's decision", () => {
  // Both refuse, so a member-level assertion cannot tell them apart. What matters is
  // WHICH cause the record names: `setting=skip` points at a config value and would
  // have masked the operator's own decline behind it.
  expect(admitSpawn(engineCandidate(), "skip", undefined, "declined")).toBe(
    ANALYZER_DENIAL_REASONS.consent_declined,
  );
  expect(
    admitSpawn(engineCandidate({ defaultRun: true }), "skip", grantFor("eslint"), "declined"),
  ).toBe(ANALYZER_DENIAL_REASONS.consent_declined);
  // With no recorded decision, `skip` is still the decisive (and honest) reason.
  expect(admitSpawn(engineCandidate({ defaultRun: true }), "skip", grantFor("eslint"))).toBe(
    ANALYZER_DENIAL_REASONS.setting_skip,
  );
});

test("RV-5: every CONSENT-channel reason names consent; the settings-channel one does not", () => {
  // The doc comment used to claim ALL reasons name consent, which `setting=skip` never
  // did. Out-of-scope suites match denial reasons with /consent/i, and they only ever
  // exercise consent denials — so the split has to hold in both directions.
  for (const key of ["consent_declined", "consent_not_decided", "consent_token_scope"] as const) {
    expect(ANALYZER_DENIAL_REASONS[key], `${key} must name the consent channel`).toMatch(
      /consent/i,
    );
  }
  expect(
    ANALYZER_DENIAL_REASONS.setting_skip,
    "setting=skip comes from the settings channel and must not claim to be a consent decision",
  ).not.toMatch(/consent/i);
});
