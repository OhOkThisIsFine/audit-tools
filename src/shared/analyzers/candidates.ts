import { join } from "node:path";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";
import { AUDIT_TOOLS_DIRNAME } from "../io/auditToolsPaths.js";
import type { ExternalAnalyzerCandidate } from "./acquisitionEngine.js";
import {
  detectNodeEcosystem,
  detectPythonEcosystem,
  detectRustEcosystem,
  detectRubyEcosystem,
  detectDockerEcosystem,
  detectGithubActionsEcosystem,
} from "./acquisitionEngine.js";
import type { BinarySpec } from "./binaryAcquisition.js";
import type {
  ExternalAnalyzerParsedItem,
  ExternalAnalyzerParseReport,
} from "./types.js";
import { parseClippy } from "./clippy.js";
import { parseRubocopOutcome } from "./rubocop.js";

/**
 * The value-curated EXTERNAL analyzer candidate registry. This is the only place
 * concrete tools are named; the engine is tool-agnostic. Membership in the
 * DEFAULT set is per-candidate `defaultRun: true` — those run without the
 * per-run consent token; every `defaultRun: false` candidate runs only when the
 * operator supplies the token. The flag on each registry row below is the
 * authoritative roster — this comment enumerates nothing.
 */

// Pinned gitleaks release (own-vs-acquire: acquire the mature tool, pinned for
// reproducibility; the asset is SHA256-verified against the release checksums
// before execution — see binaryAcquisition.ts).
const GITLEAKS_VERSION = "8.21.2";
const GITLEAKS_RELEASE_BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;

/** A clean parse that produced exactly these items and dropped nothing. */
function items(parsed: ExternalAnalyzerParsedItem[]): ExternalAnalyzerParseReport {
  return { items: parsed };
}

/**
 * A parse that could not read the payload at all. This is the affirmation that
 * replaces the bare `[]` every parser used to return: an empty item list plus
 * `parse_failed` is what lets the engine classify the run `parse_error` instead of
 * labelling upstream schema drift a clean scan.
 */
function parseFailure(tool: string, cause: string): ExternalAnalyzerParseReport {
  return { items: [], parse_failed: true, note: `${tool}: ${cause}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Look up a release-asset name part (os or cpu) in a per-tool naming table.
 * Every external tool names its assets differently (windows vs macos, x64 vs
 * amd64 vs x86_64), so the TABLES stay per-tool — only the lookup is shared.
 * Absent key ⇒ null ⇒ the tool publishes no asset for that platform/arch.
 */
function lookupAssetPart(
  value: string,
  table: Readonly<Record<string, string>>,
): string | null {
  return Object.prototype.hasOwnProperty.call(table, value)
    ? table[value]
    : null;
}

/** Map Node's platform/arch onto the gitleaks release asset naming. */
function gitleaksAsset(platform: NodeJS.Platform, arch: string): string | null {
  const os = lookupAssetPart(platform, {
    win32: "windows",
    darwin: "darwin",
    linux: "linux",
  });
  const cpu = lookupAssetPart(arch, {
    x64: "x64",
    arm64: "arm64",
    ia32: "x32",
    arm: "armv7",
  });
  if (!os || !cpu) return null;
  const ext = os === "windows" ? "zip" : "tar.gz";
  return `gitleaks_${GITLEAKS_VERSION}_${os}_${cpu}.${ext}`;
}

const GITLEAKS_BINARY: BinarySpec = {
  binaryName: "gitleaks",
  version: GITLEAKS_VERSION,
  versionProbeArgs: ["gitleaks", "version"],
  assetFor: gitleaksAsset,
  checksumsAsset: `gitleaks_${GITLEAKS_VERSION}_checksums.txt`,
  releaseUrlForAsset: (asset) => `${GITLEAKS_RELEASE_BASE}/${asset}`,
};

/** Deterministic per-process report path for gitleaks' JSON output. */
function gitleaksReportPath(): string {
  return join(tmpdir(), `audit-tools-gitleaks-${process.pid}.json`);
}

/**
 * Parse gitleaks' default JSON report (array of findings, PascalCase fields) into
 * the engine's generic item shape. The raw secret value is NEVER carried through
 * (Secret/Match are dropped) so the persisted artifact cannot leak a credential.
 */
function parseGitleaks(report: string): ExternalAnalyzerParseReport {
  let findings: unknown;
  try {
    findings = JSON.parse(report || "[]");
  } catch {
    return parseFailure("gitleaks", "report is not valid JSON");
  }
  if (!Array.isArray(findings)) {
    return parseFailure("gitleaks", "report is not a JSON array of findings");
  }
  return items(findings
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => {
      const ruleId = typeof f.RuleID === "string" ? f.RuleID : "secret";
      const file = typeof f.File === "string" ? f.File : "";
      const startLine = typeof f.StartLine === "number" ? f.StartLine : undefined;
      const endLine = typeof f.EndLine === "number" ? f.EndLine : undefined;
      const description =
        typeof f.Description === "string" && f.Description.trim().length > 0
          ? f.Description
          : `Potential secret (${ruleId})`;
      const fingerprint =
        typeof f.Fingerprint === "string" && f.Fingerprint.length > 0
          ? f.Fingerprint
          : `${ruleId}:${file}:${startLine ?? 0}`;
      return {
        id: fingerprint,
        category: "security",
        severity: "high",
        path: file,
        line_start: startLine,
        line_end: endLine,
        summary: description,
        rule: ruleId,
        // NOTE: Secret / Match deliberately omitted so the artifact never carries
        // the raw credential.
        raw: { rule: ruleId, fingerprint, entropy: f.Entropy },
      };
    }));
}

const gitleaksCandidate: ExternalAnalyzerCandidate = {
  id: "gitleaks",
  runner: "binary",
  spec: GITLEAKS_VERSION,
  purpose: "hardcoded secrets and credentials committed to the repo",
  binary: GITLEAKS_BINARY,
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "pinned",
  },
  defaultRun: true,
  // Secrets can hide in any repo regardless of ecosystem — always applicable.
  detect: () => true,
  reportFile: () => gitleaksReportPath(),
  buildArgv: (prefix, root) => [
    ...prefix,
    "dir",
    root,
    "--report-format",
    "json",
    "--report-path",
    gitleaksReportPath(),
    "--no-banner",
    "--exit-code",
    "0",
  ],
  parse: parseGitleaks,
};

/** Parse semgrep `--json` stdout into generic items. */
function parseSemgrep(stdout: string): ExternalAnalyzerParseReport {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return parseFailure("semgrep", "output is not valid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return parseFailure("semgrep", "output has no `results` array");
  }
  const results = payload.results as Record<string, unknown>[];
  return items(results.map((r) => {
    const extra = (r.extra ?? {}) as Record<string, unknown>;
    const start = (r.start ?? {}) as Record<string, unknown>;
    const end = (r.end ?? {}) as Record<string, unknown>;
    const checkId = typeof r.check_id === "string" ? r.check_id : "semgrep-rule";
    const sev = typeof extra.severity === "string" ? extra.severity.toLowerCase() : "warning";
    return {
      id: `${checkId}:${typeof r.path === "string" ? r.path : ""}:${typeof start.line === "number" ? start.line : 0}`,
      category: sev === "error" ? "correctness" : "maintainability",
      severity: sev === "error" ? "high" : sev === "warning" ? "medium" : "low",
      path: typeof r.path === "string" ? r.path : "",
      line_start: typeof start.line === "number" ? start.line : undefined,
      line_end: typeof end.line === "number" ? end.line : undefined,
      summary: typeof extra.message === "string" ? extra.message : checkId,
      rule: checkId,
    };
  }));
}

const semgrepCandidate: ExternalAnalyzerCandidate = {
  id: "semgrep",
  runner: "pipx",
  spec: "semgrep==1.63.0",
  purpose: "security and correctness anti-patterns via community rule sets (pulls rules from the network)",
  safetyProfile: {
    config_execution: "inert-data",
    network_egress: true,
    version_pinning: "pinned",
  },
  // CONSENT-GATED: pulls rule sets from network and is heavier; only runs with a consent token.
  defaultRun: false,
  detect: (root) => detectPythonEcosystem(root) || detectNodeEcosystem(root),
  buildArgv: (prefix, root) => [...prefix, "--json", "--quiet", "--config", "auto", root],
  parse: parseSemgrep,
};

/** Parse eslint `-f json` stdout (array of file results) into generic items. */
function parseEslint(stdout: string): ExternalAnalyzerParseReport {
  let files: unknown;
  try {
    files = JSON.parse(stdout || "[]");
  } catch {
    return parseFailure("eslint", "output is not valid JSON");
  }
  if (!Array.isArray(files)) {
    return parseFailure("eslint", "output is not a JSON array of file results");
  }
  const parsed: ExternalAnalyzerParsedItem[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const filePath = typeof (file as { filePath?: unknown }).filePath === "string"
      ? (file as { filePath: string }).filePath
      : "";
    const messages = Array.isArray((file as { messages?: unknown }).messages)
      ? ((file as { messages: Record<string, unknown>[] }).messages)
      : [];
    for (const m of messages) {
      const ruleId = typeof m.ruleId === "string" ? m.ruleId : "eslint";
      const line = typeof m.line === "number" ? m.line : undefined;
      parsed.push({
        id: `${ruleId}:${filePath}:${line ?? 0}`,
        category: "maintainability",
        severity: m.severity === 2 ? "medium" : "low",
        path: filePath,
        line_start: line,
        summary: typeof m.message === "string" ? m.message : ruleId,
        rule: ruleId,
      });
    }
  }
  return items(parsed);
}

const eslintCandidate: ExternalAnalyzerCandidate = {
  id: "eslint",
  runner: "npx",
  spec: "eslint@9",
  purpose: "JS/TS lint findings using the repo's own eslint config",
  safetyProfile: {
    config_execution: "executable",
    network_egress: false,
    version_pinning: "pinned",
  },
  // CONSENT-GATED: needs a repo eslint config to be meaningful; config can execute code.
  defaultRun: false,
  detect: (root) => detectNodeEcosystem(root),
  buildArgv: (prefix, root) => [...prefix, "--format", "json", root],
  parse: parseEslint,
};

/**
 * Parse knip's `--reporter json` stdout — `{ issues: [{ file, exports?, types?,
 * nsExports?, nsTypes?, files?, dependencies? }] }`, each per-type array holding
 * `{ name, line, col }` (grounded against `node_modules/knip/dist/reporters/json.js`
 * in this repo, not guessed). Two signal classes are surfaced: unused *exports*
 * (the four symbol-level types below) and whole-file / dependency dead code
 * (`files` = a module nothing imports; `dependencies` = a manifest entry nothing
 * uses) — the latter is the class the crude low-in-degree `deletion_candidate`
 * graph signal only approximates. Every item is a LEAD, not a confirmed finding:
 * standalone knip cannot see dispatch-table/re-export-alias/dynamic/entrypoint
 * wiring, so it is tagged `external_analyzer_signal` (the same generic seam every
 * candidate uses) and left to the per-file lens subauditor to confirm-or-refute,
 * never merged as a finding directly.
 */
const KNIP_EXPORT_ISSUE_TYPES = ["exports", "types", "nsExports", "nsTypes"] as const;

function parseKnip(stdout: string): ExternalAnalyzerParseReport {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return parseFailure("knip", "output is not valid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.issues)) {
    return parseFailure("knip", "output has no `issues` array");
  }
  const issues = payload.issues as Record<string, unknown>[];
  const parsed: ExternalAnalyzerParsedItem[] = [];
  for (const row of issues) {
    const file = typeof row.file === "string" ? row.file : "";
    if (!file) continue;
    for (const issueType of KNIP_EXPORT_ISSUE_TYPES) {
      const symbols = row[issueType];
      if (!Array.isArray(symbols)) continue;
      for (const symbol of symbols) {
        if (!symbol || typeof symbol !== "object") continue;
        const name = typeof (symbol as { name?: unknown }).name === "string"
          ? (symbol as { name: string }).name
          : "unknown";
        const line = typeof (symbol as { line?: unknown }).line === "number"
          ? (symbol as { line: number }).line
          : undefined;
        parsed.push({
          id: `knip-${issueType}:${file}:${name}:${line ?? 0}`,
          category: "maintainability",
          severity: "low",
          path: file,
          line_start: line,
          summary: `knip: unused ${issueType === "types" || issueType === "nsTypes" ? "type" : "export"} '${name}' — unverified against the graph; confirm truly dead or refute as dynamic/entrypoint-only wiring before reporting.`,
          rule: `knip-${issueType}`,
        });
      }
    }
    // Whole-file dead code: a non-empty `files` array on this row means the module
    // itself is imported by nothing. One lead per file (path === the file).
    if (Array.isArray(row.files) && row.files.length > 0) {
      parsed.push({
        id: `knip-files:${file}`,
        category: "maintainability",
        severity: "low",
        path: file,
        summary: `knip: file '${file}' appears unused (nothing imports it) — unverified against the graph; confirm truly dead or refute as a dynamic/entrypoint-only module before reporting.`,
        rule: "knip-files",
      });
    }
    // Unused manifest dependencies: declared in `file` (a package.json) but used
    // nowhere knip can see. One lead per dependency name.
    if (Array.isArray(row.dependencies)) {
      for (const symbol of row.dependencies) {
        if (!symbol || typeof symbol !== "object") continue;
        const name = typeof (symbol as { name?: unknown }).name === "string"
          ? (symbol as { name: string }).name
          : "unknown";
        const line = typeof (symbol as { line?: unknown }).line === "number"
          ? (symbol as { line: number }).line
          : undefined;
        parsed.push({
          id: `knip-dependencies:${file}:${name}`,
          category: "maintainability",
          severity: "low",
          path: file,
          line_start: line,
          summary: `knip: dependency '${name}' declared in '${file}' appears unused — unverified; confirm truly unused or refute as dynamic/optional/peer/tooling usage before reporting.`,
          rule: "knip-dependencies",
        });
      }
    }
  }
  return items(parsed);
}

const knipCandidate: ExternalAnalyzerCandidate = {
  id: "knip",
  runner: "npx",
  spec: "knip@6",
  purpose: "unused files, dependencies, and exports (leads, not verdicts)",
  safetyProfile: {
    config_execution: "executable",
    network_egress: false,
    version_pinning: "pinned",
  },
  // CONSENT-GATED: needs repo config to avoid noise, config can execute code,
  // and every flag here is an unverified lead (no graph cross-check yet — see
  // docs/backlog.md), not a confirmed finding; same tier as eslint/semgrep.
  defaultRun: false,
  detect: (root) => detectNodeEcosystem(root),
  // No positional/cwd flag needed: the acquisition engine already spawns with
  // cwd = root (runExternalAnalyzer's `run(argv, root)`), and knip discovers
  // project files from its own config/tsconfig relative to cwd.
  buildArgv: (prefix) => [
    ...prefix,
    "--reporter",
    "json",
    "--include",
    "exports,types,nsExports,nsTypes,files,dependencies",
    "--no-exit-code",
  ],
  parse: parseKnip,
};

/**
 * Detect if a repo contains source files that Lizard can analyze.
 * Lizard supports: python, rust, ruby, java, go, cpp, c, kotlin.
 * Returns true if any such sources exist.
 */
/**
 * Non-JS/TS languages lizard covers (the in-tree `computeComplexityMetric` owns
 * JS/TS — one signal source per file class, no double-reporting). SOURCE-based
 * detection: ecosystem markers miss exactly the languages that need lizard most
 * (Java/Go/C/C++/Kotlin have no manifest the ecosystem detectors read), so a
 * bounded repo walk over extensions is the honest applicability signal, and the
 * same walk derives the `-l` filter so the argv can never name a language the
 * repo does not contain.
 */
const LIZARD_LANGUAGE_EXTENSIONS: ReadonlyArray<{ lang: string; exts: readonly string[] }> = [
  { lang: "c", exts: [".c", ".h"] },
  { lang: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp"] },
  { lang: "go", exts: [".go"] },
  { lang: "java", exts: [".java"] },
  { lang: "kotlin", exts: [".kt", ".kts"] },
  { lang: "python", exts: [".py"] },
  { lang: "ruby", exts: [".rb"] },
  { lang: "rust", exts: [".rs"] },
];

const LIZARD_WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  AUDIT_TOOLS_DIRNAME,
]);
const LIZARD_WALK_MAX_ENTRIES = 5_000;

/**
 * The lizard-supported languages whose sources exist under `root` — a bounded
 * breadth-first walk (entry-capped, common build/dep dirs skipped), sorted for
 * stable argv output. Degrades to [] on any fs error.
 */
function detectedLizardLanguages(root: string): string[] {
  const extToLang = new Map<string, string>();
  for (const { lang, exts } of LIZARD_LANGUAGE_EXTENSIONS) {
    for (const ext of exts) extToLang.set(ext, lang);
  }
  const found = new Set<string>();
  const queue: string[] = [root];
  let seen = 0;
  while (queue.length > 0 && seen < LIZARD_WALK_MAX_ENTRIES) {
    const dir = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen >= LIZARD_WALK_MAX_ENTRIES) break;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || LIZARD_WALK_SKIP_DIRS.has(entry.name)) continue;
        queue.push(join(dir, entry.name));
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      const lang = extToLang.get(entry.name.slice(dot).toLowerCase());
      if (lang) found.add(lang);
    }
    if (found.size === LIZARD_LANGUAGE_EXTENSIONS.length) break;
  }
  return [...found].sort();
}

function detectLizardSources(root: string): boolean {
  return detectedLizardLanguages(root).length > 0;
}

/** Deterministic per-process output directory for jscpd's JSON reporter. */
function jscpdReportDir(): string {
  return join(tmpdir(), `audit-tools-jscpd-${process.pid}`);
}

/**
 * jscpd's `--reporters json` writes `jscpd-report.json` inside the directory
 * passed to `--output` (its own naming, not configurable) — this is that path
 * for the per-process output directory above.
 */
function jscpdReportPath(): string {
  return join(jscpdReportDir(), "jscpd-report.json");
}

/**
 * Parse jscpd's JSON reporter output (`{ duplicates: [{ firstFile, secondFile,
 * fragment, lines, ... }] }`) into the engine's generic item shape. Degrades to
 * [] on malformed/empty/missing-'duplicates' input. Never calls
 * normalizeGenericExternalResults — that seam belongs to the audit/adapters
 * normalization path, not to a candidate's own parse function (same as
 * parseKnip/parseEslint/parseSemgrep above).
 */
function parseJscpd(report: string): ExternalAnalyzerParseReport {
  let payload: unknown;
  try {
    payload = JSON.parse(report || "{}");
  } catch {
    return parseFailure("jscpd", "report is not valid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.duplicates)) {
    return parseFailure("jscpd", "report has no `duplicates` array");
  }
  const duplicates = payload.duplicates as Record<string, unknown>[];
  return items(duplicates
    .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
    .map((d) => {
      const firstFile = (d.firstFile ?? {}) as Record<string, unknown>;
      const secondFile = (d.secondFile ?? {}) as Record<string, unknown>;
      const path = typeof firstFile.name === "string" ? firstFile.name : "";
      const startLoc = (firstFile.startLoc ?? {}) as Record<string, unknown>;
      const endLoc = (firstFile.endLoc ?? {}) as Record<string, unknown>;
      const startLine = typeof startLoc.line === "number" ? startLoc.line : undefined;
      const endLine = typeof endLoc.line === "number" ? endLoc.line : undefined;
      const otherPath = typeof secondFile.name === "string" ? secondFile.name : "";
      const lines = typeof d.lines === "number" ? d.lines : undefined;
      return {
        id: `jscpd:${path}:${startLine ?? 0}:${otherPath}`,
        category: "maintainability",
        severity: "low",
        path,
        line_start: startLine,
        line_end: endLine,
        summary: `jscpd: duplicate code block (${lines ?? "?"} lines) shared with ${otherPath || "another file"}`,
        rule: "jscpd-duplicate",
      };
    }));
}

const jscpdCandidate: ExternalAnalyzerCandidate = {
  id: "jscpd",
  runner: "npx",
  spec: "jscpd@4",
  purpose: "copy-pasted/duplicated code blocks across the repo",
  safetyProfile: {
    config_execution: "executable",
    network_egress: false,
    version_pinning: "pinned",
  },
  // Duplication scanner: jscpd uses cosmiconfig which loads .jscpd.js files
  // (executable config). While jscpd supports --config flag, it is unverified
  // whether explicit --config suppresses cosmiconfig discovery of .jscpd.js.
  // Stay gated until verified. Candidate for future promotion if cosmiconfig
  // can be reliably disabled.
  defaultRun: false,
  detect: (root) => detectNodeEcosystem(root),
  buildArgv: (prefix, root) => [
    ...prefix,
    "--reporters",
    "json",
    "--output",
    jscpdReportDir(),
    "--silent",
    root,
  ],
  reportFile: () => jscpdReportPath(),
  parse: parseJscpd,
};

// Pinned osv-scanner release (own-vs-acquire: acquire the mature Go binary,
// pinned for reproducibility). Distinct from gitleaks in one respect worth
// noting: osv-scanner's release assets ARE the raw executable
// (`osv-scanner_linux_amd64`, `osv-scanner_windows_amd64.exe`) — not an
// archive — so its BinarySpec sets `archived: false` (binaryAcquisition.ts).
const OSV_SCANNER_VERSION = "2.4.0";
const OSV_SCANNER_RELEASE_BASE = `https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}`;

/** Map Node's platform/arch onto the osv-scanner release asset naming. */
function osvScannerAsset(platform: NodeJS.Platform, arch: string): string | null {
  const os = lookupAssetPart(platform, {
    win32: "windows",
    darwin: "darwin",
    linux: "linux",
  });
  // osv-scanner only publishes amd64/arm64 assets (no 32-bit/arm variants).
  const cpu = lookupAssetPart(arch, { x64: "amd64", arm64: "arm64" });
  if (!os || !cpu) return null;
  const ext = os === "windows" ? ".exe" : "";
  return `osv-scanner_${os}_${cpu}${ext}`;
}

const OSV_SCANNER_BINARY: BinarySpec = {
  binaryName: "osv-scanner",
  version: OSV_SCANNER_VERSION,
  versionProbeArgs: ["osv-scanner", "--version"],
  assetFor: osvScannerAsset,
  checksumsAsset: "osv-scanner_SHA256SUMS",
  releaseUrlForAsset: (asset) => `${OSV_SCANNER_RELEASE_BASE}/${asset}`,
  archived: false,
};

/**
 * Parse osv-scanner's `--format json` stdout — grounded against
 * `pkg/models/results.go` (`VulnerabilityResults`) in google/osv-scanner, not
 * guessed: `{ results: [{ source: {path}, packages: [{ package: {name,
 * version}, vulnerabilities: [...], groups: [{ids, max_severity}] }] }] }`.
 * One item per GROUP (osv-scanner's own alias-collapsed dedup unit), not per
 * raw vulnerability id, so CVE/GHSA aliases for the same underlying issue
 * don't fan out into duplicate items.
 */
function parseOsvScanner(stdout: string): ExternalAnalyzerParseReport {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return parseFailure("osv-scanner", "output is not valid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return parseFailure("osv-scanner", "output has no `results` array");
  }
  const results = payload.results as Record<string, unknown>[];
  const parsed: ExternalAnalyzerParsedItem[] = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const source = (result.source ?? {}) as Record<string, unknown>;
    const sourcePath = typeof source.path === "string" ? source.path : "";
    const packages = Array.isArray(result.packages) ? result.packages : [];
    for (const pkg of packages) {
      if (!pkg || typeof pkg !== "object") continue;
      const pkgRecord = pkg as Record<string, unknown>;
      const pkgInfo = (pkgRecord.package ?? {}) as Record<string, unknown>;
      const pkgName = typeof pkgInfo.name === "string" ? pkgInfo.name : "unknown";
      const pkgVersion = typeof pkgInfo.version === "string" ? pkgInfo.version : "";
      const vulns = Array.isArray(pkgRecord.vulnerabilities)
        ? (pkgRecord.vulnerabilities as Record<string, unknown>[])
        : [];
      const groups = Array.isArray(pkgRecord.groups)
        ? (pkgRecord.groups as Record<string, unknown>[])
        : [];
      for (const group of groups) {
        if (!group || typeof group !== "object") continue;
        const ids = Array.isArray(group.ids)
          ? group.ids.filter((id): id is string => typeof id === "string")
          : [];
        if (ids.length === 0) continue;
        const maxSeverity = typeof group.max_severity === "string" ? group.max_severity.toUpperCase() : "";
        const severity =
          maxSeverity.includes("CRITICAL") || maxSeverity.includes("HIGH")
            ? "high"
            : maxSeverity.includes("LOW")
              ? "low"
              : "medium";
        const primary = vulns.find(
          (v) => v && typeof v === "object" && ids.includes((v as { id?: unknown }).id as string),
        );
        const summaryText =
          primary && typeof primary.summary === "string" && primary.summary.trim().length > 0
            ? primary.summary
            : primary && typeof primary.details === "string"
              ? primary.details.slice(0, 200)
              : `known vulnerability in ${pkgName}`;
        parsed.push({
          id: `osv:${ids.join(",")}:${pkgName}@${pkgVersion}`,
          category: "security",
          severity,
          path: sourcePath,
          summary: `osv-scanner: ${pkgName}@${pkgVersion} — ${ids.join(", ")} — ${summaryText}`,
          rule: ids[0],
        });
      }
    }
  }
  return items(parsed);
}

const osvScannerCandidate: ExternalAnalyzerCandidate = {
  id: "osv-scanner",
  runner: "binary",
  spec: OSV_SCANNER_VERSION,
  purpose: "known-vulnerable dependency versions (queries the OSV.dev database over the network)",
  binary: OSV_SCANNER_BINARY,
  safetyProfile: {
    config_execution: "none",
    network_egress: true,
    version_pinning: "pinned",
  },
  // CONSENT-GATED: network-dependent (queries the OSV vulnerability database)
  // and heavier than gitleaks — same tier as semgrep/eslint/knip/jscpd.
  defaultRun: false,
  // Ecosystem-agnostic by design: osv-scanner recursively discovers whatever
  // lockfiles exist (npm/pip/cargo/go/…) itself, so no per-ecosystem marker
  // gate is needed here (mirrors gitleaks' `() => true`).
  detect: () => true,
  buildArgv: (prefix, root) => [...prefix, "scan", "--format", "json", "--recursive", root],
  parse: parseOsvScanner,
};

// ---------------------------------------------------------------------------
// clippy — Rust lints via `cargo clippy --message-format=json` (read-only).
// ---------------------------------------------------------------------------
const clippyCandidate: ExternalAnalyzerCandidate = {
  id: "clippy",
  runner: "cargo",
  // The `cargo` runner prefix is `["cargo", spec]`; spec is the cargo subcommand.
  spec: "clippy",
  purpose: "Rust lint findings (compiles the crate via the cargo toolchain)",
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "toolchain-resolved",
  },
  // CONSENT-GATED: compiles the crate (heavier), needs the Rust toolchain.
  defaultRun: false,
  detect: (root) => detectRustEcosystem(root),
  // Read-only: NO `--fix`. `--message-format=json` streams NDJSON diagnostics;
  // clippy's own args go after `--`. The engine spawns with cwd=root so no
  // positional path is needed.
  buildArgv: (prefix) => [...prefix, "--message-format=json", "--quiet"],
  parse: parseClippy,
};

// ---------------------------------------------------------------------------
// rubocop — Ruby lints via `bundle exec rubocop --format json` (read-only).
// ---------------------------------------------------------------------------
const rubocopCandidate: ExternalAnalyzerCandidate = {
  id: "rubocop",
  runner: "bundle",
  // The `bundle` runner prefix is `["bundle", "exec", spec]`.
  spec: "rubocop",
  purpose: "Ruby style and correctness findings using the repo bundle",
  safetyProfile: {
    config_execution: "executable",
    network_egress: false,
    version_pinning: "toolchain-resolved",
  },
  // CONSENT-GATED: needs the project's bundle/ruby toolchain + rubocop config;
  // .rubocop.yml can have require: directives that execute code.
  defaultRun: false,
  detect: (root) => detectRubyEcosystem(root),
  // Read-only: NO `--autocorrect`/`-a`/`-A`. `--format json` → single JSON doc.
  buildArgv: (prefix, root) => [...prefix, "--format", "json", root],
  parse: parseRubocopOutcome,
};

// ---------------------------------------------------------------------------
// hadolint — Dockerfile linter, shipped as a RAW (non-archived) release binary
// (`hadolint-linux-x86_64`, `hadolint-windows-x86_64.exe`, …). Each asset has
// its OWN `<asset>.sha256` checksum file (not a release-wide checksums.txt).
// ---------------------------------------------------------------------------
const HADOLINT_VERSION = "2.14.0";
const HADOLINT_RELEASE_BASE = `https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}`;

/** Map Node's platform/arch onto hadolint's release asset naming. */
function hadolintAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") {
    // hadolint publishes only an x86_64 Windows asset.
    return arch === "x64" ? "hadolint-windows-x86_64.exe" : null;
  }
  const os = lookupAssetPart(platform, { darwin: "macos", linux: "linux" });
  const cpu = lookupAssetPart(arch, { x64: "x86_64", arm64: "arm64" });
  if (!os || !cpu) return null;
  return `hadolint-${os}-${cpu}`;
}

const HADOLINT_BINARY: BinarySpec = {
  binaryName: "hadolint",
  version: HADOLINT_VERSION,
  versionProbeArgs: ["hadolint", "--version"],
  assetFor: hadolintAsset,
  // Per-asset checksum file: `<asset>.sha256` holds `<sha256> *<asset>`.
  checksumsAsset: (asset) => `${asset}.sha256`,
  releaseUrlForAsset: (asset) => `${HADOLINT_RELEASE_BASE}/${asset}`,
  // The release asset IS the raw executable — no archive to extract.
  archived: false,
};

/**
 * Parse hadolint's `--format json` stdout — a FLAT array of objects grounded
 * against hadolint's JSON formatter: `[{ file, line, column, code, level,
 * message }]`. `level` ∈ error|warning|info|style. Degrades to `[]` on
 * empty/malformed/non-array input.
 */
function parseHadolint(stdout: string): ExternalAnalyzerParseReport {
  let findings: unknown;
  try {
    findings = JSON.parse(stdout || "[]");
  } catch {
    return parseFailure("hadolint", "output is not valid JSON");
  }
  if (!Array.isArray(findings)) {
    return parseFailure("hadolint", "output is not a JSON array of diagnostics");
  }
  return items(findings
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => {
      const file = typeof f.file === "string" ? f.file : "";
      const line = typeof f.line === "number" ? f.line : undefined;
      const code = typeof f.code === "string" && f.code.length > 0 ? f.code : "hadolint";
      const level = typeof f.level === "string" ? f.level.toLowerCase() : "";
      const severity = level === "error" ? "high" : level === "warning" ? "medium" : "low";
      const message =
        typeof f.message === "string" && f.message.trim().length > 0 ? f.message : code;
      return {
        id: `hadolint:${code}:${file}:${line ?? 0}`,
        category: "config_deployment",
        severity,
        path: file,
        line_start: line,
        summary: message,
        rule: code,
      };
    })
    .filter((item) => item.path.length > 0));
}

const hadolintCandidate: ExternalAnalyzerCandidate = {
  id: "hadolint",
  runner: "binary",
  spec: HADOLINT_VERSION,
  purpose: "Dockerfile best-practice violations",
  binary: HADOLINT_BINARY,
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "pinned",
  },
  // Fast, safe, pinned Dockerfile linter — member of the default set.
  defaultRun: true,
  detect: (root) => detectDockerEcosystem(root),
  // Read-only by nature (a linter). `--format json`; lint the repo's Dockerfile.
  buildArgv: (prefix, root) => [...prefix, "--format", "json", join(root, "Dockerfile")],
  parse: parseHadolint,
};

// ---------------------------------------------------------------------------
// actionlint — GitHub Actions workflow linter, shipped as an ARCHIVED release
// asset (`actionlint_<v>_<os>_<arch>.tar.gz`/`.zip`) + a release-wide
// `actionlint_<v>_checksums.txt`.
// ---------------------------------------------------------------------------
const ACTIONLINT_VERSION = "1.7.12";
const ACTIONLINT_RELEASE_BASE = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;

/** Map Node's platform/arch onto actionlint's release asset naming. */
function actionlintAsset(platform: NodeJS.Platform, arch: string): string | null {
  const os = lookupAssetPart(platform, {
    win32: "windows",
    darwin: "darwin",
    linux: "linux",
  });
  const cpu = lookupAssetPart(arch, {
    x64: "amd64",
    arm64: "arm64",
    ia32: "386",
    arm: "armv6",
  });
  if (!os || !cpu) return null;
  // actionlint does not publish a windows/armv6 asset.
  if (os === "windows" && cpu === "armv6") return null;
  const ext = os === "windows" ? "zip" : "tar.gz";
  return `actionlint_${ACTIONLINT_VERSION}_${os}_${cpu}.${ext}`;
}

const ACTIONLINT_BINARY: BinarySpec = {
  binaryName: "actionlint",
  version: ACTIONLINT_VERSION,
  versionProbeArgs: ["actionlint", "--version"],
  assetFor: actionlintAsset,
  checksumsAsset: `actionlint_${ACTIONLINT_VERSION}_checksums.txt`,
  releaseUrlForAsset: (asset) => `${ACTIONLINT_RELEASE_BASE}/${asset}`,
  // .tar.gz / .zip archive → extract (archived defaults to true; set explicitly).
  archived: true,
};

/**
 * Parse actionlint's `-format '{{json .}}'` stdout — a JSON array grounded
 * against actionlint's template output: `[{ message, filepath, line, column,
 * kind }]`. Degrades to `[]` on empty/malformed/non-array input.
 */
function parseActionlint(stdout: string): ExternalAnalyzerParseReport {
  let findings: unknown;
  try {
    findings = JSON.parse(stdout || "[]");
  } catch {
    return parseFailure("actionlint", "output is not valid JSON");
  }
  if (!Array.isArray(findings)) {
    return parseFailure("actionlint", "output is not a JSON array of diagnostics");
  }
  return items(findings
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .map((f) => {
      const path = typeof f.filepath === "string" ? f.filepath : "";
      const line = typeof f.line === "number" ? f.line : undefined;
      const kind = typeof f.kind === "string" && f.kind.length > 0 ? f.kind : "actionlint";
      const message =
        typeof f.message === "string" && f.message.trim().length > 0 ? f.message : kind;
      return {
        id: `actionlint:${kind}:${path}:${line ?? 0}`,
        category: "config_deployment",
        severity: "medium",
        path,
        line_start: line,
        summary: message,
        rule: kind,
      };
    })
    .filter((item) => item.path.length > 0));
}

const actionlintCandidate: ExternalAnalyzerCandidate = {
  id: "actionlint",
  runner: "binary",
  spec: ACTIONLINT_VERSION,
  purpose: "GitHub Actions workflow errors",
  binary: ACTIONLINT_BINARY,
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "pinned",
  },
  // Fast, safe, pinned GitHub Actions workflow linter — member of the default set.
  defaultRun: true,
  detect: (root) => detectGithubActionsEcosystem(root),
  // Read-only by nature. `-format '{{json .}}'` → JSON array on stdout; run with
  // cwd=root so actionlint discovers `.github/workflows/` itself.
  buildArgv: (prefix) => [...prefix, "-format", "{{json .}}"],
  parse: parseActionlint,
};

// ---------------------------------------------------------------------------
// type-coverage — TypeScript type-coverage ratio reporter via npx (read-only).
// ---------------------------------------------------------------------------
/**
 * Parse type-coverage's `--json --detail` stdout — grounded against
 * type-coverage's JSON shape: `{ percentage, total, correct, anys: [{ file,
 * line, character, text }] }`. Each `anys` entry is one implicit/explicit `any`
 * site; degrades to `[]` on empty/malformed input or a missing `anys` array.
 */
function parseTypeCoverage(stdout: string): ExternalAnalyzerParseReport {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return parseFailure("type-coverage", "output is not valid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.anys)) {
    return parseFailure("type-coverage", "output has no `anys` array");
  }
  const anys = payload.anys as Record<string, unknown>[];
  return items(anys
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => {
      const file = typeof a.file === "string" ? a.file : "";
      const line = typeof a.line === "number" ? a.line : undefined;
      const text = typeof a.text === "string" && a.text.length > 0 ? a.text : "untyped value";
      return {
        id: `type-coverage:${file}:${line ?? 0}`,
        category: "maintainability",
        severity: "low",
        path: file,
        line_start: line,
        summary: `type-coverage: '${text}' has an implicit/explicit any — add an explicit type.`,
        rule: "type-coverage-any",
      };
    })
    .filter((item) => item.path.length > 0));
}

const typeCoverageCandidate: ExternalAnalyzerCandidate = {
  id: "type-coverage",
  runner: "npx",
  spec: "type-coverage@2",
  purpose: "per-file TypeScript any-coverage gaps",
  safetyProfile: {
    config_execution: "inert-data",
    network_egress: false,
    version_pinning: "pinned",
  },
  // Fast type coverage reporter for TS projects — member of the default set.
  // Reads tsconfig (inert-data) but does not execute code.
  defaultRun: true,
  detect: (root) => detectNodeEcosystem(root),
  // Read-only. `--json --detail` prints per-`any` sites as JSON on stdout; run
  // with cwd=root so it resolves the project tsconfig itself.
  buildArgv: (prefix) => [...prefix, "--json", "--detail"],
  parse: parseTypeCoverage,
};

// ---------------------------------------------------------------------------
// lizard — Multi-language complexity metrics via pipx (read-only).
// ---------------------------------------------------------------------------
/**
 * Parse a line of CSV, handling quoted fields that may contain commas.
 * CSV format: "NLOC,CCN,Token,PARAM,Length,Location,File,Function"
 * Quoted fields are surrounded by double quotes and internal quotes are doubled.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote: add one quote and skip the next
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      // Field separator (only when not inside quotes)
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  // Add the last field
  fields.push(current.trim());
  return fields;
}

/**
 * Parse lizard's CSV output (default: `lizard -l <languages> --csv <path>`).
 * CSV format: "NLOC,CCN,Token,PARAM,Length,Location,File,Function"
 * Degrades to `[]` on parse failure; reports lead findings for complexity overages.
 */
function parseLizard(stdout: string): ExternalAnalyzerParseReport {
  if (!stdout || stdout.trim().length === 0) {
    return items([]);
  }
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return items([]); // CSV header only, no data rows
  const parsed: ExternalAnalyzerParsedItem[] = [];
  // A row the CSV shape does not fit is COUNTED, not silently discarded: a schema
  // drift that drops every row must not be reportable as a clean scan.
  let droppedRows = 0;
  // Skip the CSV header (line 0) and process data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Parse CSV line, handling quoted fields with embedded commas
    const parts = parseCsvLine(line);
    if (parts.length < 8) {
      droppedRows += 1;
      continue;
    }
    const nloc = parseInt(parts[0], 10);
    const ccn = parseInt(parts[1], 10);
    const param = parseInt(parts[3], 10);
    const file = parts[6] || "";
    const func = parts[7] || "unknown";
    if (!file || isNaN(nloc) || isNaN(ccn) || isNaN(param)) {
      droppedRows += 1;
      continue;
    }
    // Emit leads for complexity overages: CCN > 10, NLOC > 200, PARAM > 5
    const issues: Array<{ rule: string; threshold: number; actual: number }> = [];
    if (ccn > 10) issues.push({ rule: "lizard-ccn", threshold: 10, actual: ccn });
    if (nloc > 200) issues.push({ rule: "lizard-length", threshold: 200, actual: nloc });
    if (param > 5) issues.push({ rule: "lizard-params", threshold: 5, actual: param });
    for (const issue of issues) {
      parsed.push({
        id: `${issue.rule}:${file}:${func}`,
        category: "maintainability",
        // Threshold bands (leads only, never verdicts): ≥2× the threshold is a
        // stronger lead than a marginal overage.
        severity: issue.actual >= issue.threshold * 2 ? "medium" : "low",
        path: file,
        summary: `lizard: ${func} — ${issue.rule} ${issue.actual} exceeds threshold ${issue.threshold}`,
        rule: issue.rule,
      });
    }
  }
  return { items: parsed, ...(droppedRows > 0 ? { dropped_rows: droppedRows } : {}) };
}

const lizardCandidate: ExternalAnalyzerCandidate = {
  id: "lizard",
  runner: "pipx",
  spec: "lizard==1.17.10",
  purpose: "oversized/over-complex functions in non-JS/TS languages",
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "pinned",
  },
  // Multi-language complexity metrics for non-JS/TS languages — member of the default set.
  // Runs only when non-JS/TS supported languages are detected.
  // Note: Lizard cannot analyze Dockerfiles, so Docker-only repos are excluded.
  defaultRun: true,
  detect: detectLizardSources,
  // Read-only. `--csv` format; the `-l` filter is DERIVED from the same bounded
  // source walk detect() ran, so the argv names exactly the languages the repo
  // contains (JS/TS stay excluded — the in-tree metric owns them).
  buildArgv: (prefix, root) => [
    ...prefix,
    "-l",
    detectedLizardLanguages(root).join(","),
    "--csv",
    root,
  ],
  parse: parseLizard,
};

/** The curated external analyzer candidate set. `defaultRun` marks the consent-free default members. */
export const EXTERNAL_ANALYZER_CANDIDATES: ExternalAnalyzerCandidate[] = [
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
];

export {
  gitleaksCandidate,
  semgrepCandidate,
  knipCandidate,
  parseKnip,
  eslintCandidate,
  parseGitleaks,
  GITLEAKS_VERSION,
  jscpdCandidate,
  parseJscpd,
  osvScannerCandidate,
  parseOsvScanner,
  OSV_SCANNER_VERSION,
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
};
