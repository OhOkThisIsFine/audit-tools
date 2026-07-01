import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExternalAnalyzerCandidate } from "./acquisitionEngine.js";
import {
  detectNodeEcosystem,
  detectPythonEcosystem,
} from "./acquisitionEngine.js";
import type { BinarySpec } from "./binaryAcquisition.js";

/**
 * The value-curated EXTERNAL analyzer candidate registry. This is the only place
 * concrete tools are named; the engine is tool-agnostic. gitleaks is the DEFAULT
 * member (high-value, low-overhead secret scanning, agnostic to the repo's
 * ecosystem); semgrep + eslint are registered but CONSENT-GATED (defaultRun:
 * false) — they pull rule sets / need repo config and so only run when the
 * operator supplies a per-run consent token.
 */

// Pinned gitleaks release (own-vs-acquire: acquire the mature tool, pinned for
// reproducibility; the asset is SHA256-verified against the release checksums
// before execution — see binaryAcquisition.ts).
const GITLEAKS_VERSION = "8.21.2";
const GITLEAKS_RELEASE_BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;

/** Map Node's platform/arch onto the gitleaks release asset naming. */
function gitleaksAsset(platform: NodeJS.Platform, arch: string): string | null {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  if (!os) return null;
  const cpu =
    arch === "x64"
      ? "x64"
      : arch === "arm64"
        ? "arm64"
        : arch === "ia32"
          ? "x32"
          : arch === "arm"
            ? "armv7"
            : null;
  if (!cpu) return null;
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
function parseGitleaks(report: string): ReturnType<ExternalAnalyzerCandidate["parse"]> {
  let findings: unknown;
  try {
    findings = JSON.parse(report || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(findings)) return [];
  return findings
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
    });
}

const gitleaksCandidate: ExternalAnalyzerCandidate = {
  id: "gitleaks",
  runner: "binary",
  spec: GITLEAKS_VERSION,
  binary: GITLEAKS_BINARY,
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
function parseSemgrep(stdout: string): ReturnType<ExternalAnalyzerCandidate["parse"]> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  const results =
    payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: Record<string, unknown>[] }).results)
      : [];
  return results.map((r) => {
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
  });
}

const semgrepCandidate: ExternalAnalyzerCandidate = {
  id: "semgrep",
  runner: "pipx",
  spec: "semgrep",
  // CONSENT-GATED: pulls rule sets and is heavier; only runs with a consent token.
  defaultRun: false,
  detect: (root) => detectPythonEcosystem(root) || detectNodeEcosystem(root),
  buildArgv: (prefix, root) => [...prefix, "--json", "--quiet", "--config", "auto", root],
  parse: parseSemgrep,
};

/** Parse eslint `-f json` stdout (array of file results) into generic items. */
function parseEslint(stdout: string): ReturnType<ExternalAnalyzerCandidate["parse"]> {
  let files: unknown;
  try {
    files = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(files)) return [];
  const items: ReturnType<ExternalAnalyzerCandidate["parse"]> = [];
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
      items.push({
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
  return items;
}

const eslintCandidate: ExternalAnalyzerCandidate = {
  id: "eslint",
  runner: "npx",
  spec: "eslint@9",
  // CONSENT-GATED: needs a repo eslint config to be meaningful.
  defaultRun: false,
  detect: (root) => detectNodeEcosystem(root),
  buildArgv: (prefix, root) => [...prefix, "--format", "json", root],
  parse: parseEslint,
};

/**
 * Parse knip's `--reporter json` stdout — `{ issues: [{ file, exports?, types?,
 * nsExports?, nsTypes? }] }`, each per-type array holding `{ name, line, col }`
 * (grounded against `node_modules/knip/dist/reporters/json.js` in this repo, not
 * guessed). Only the four "unused export"-shaped report types are consumed —
 * unused files/dependencies are a different signal class this candidate does
 * not surface. Every item is a LEAD, not a confirmed finding: standalone knip
 * cannot see dispatch-table/re-export-alias/dynamic wiring, so it is tagged
 * `external_analyzer_signal` (the same generic seam every candidate uses) and
 * left to the per-file lens subauditor to confirm-or-refute, never merged as a
 * finding directly.
 */
const KNIP_EXPORT_ISSUE_TYPES = ["exports", "types", "nsExports", "nsTypes"] as const;

function parseKnip(stdout: string): ReturnType<ExternalAnalyzerCandidate["parse"]> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  const issues =
    payload && typeof payload === "object" && Array.isArray((payload as { issues?: unknown }).issues)
      ? ((payload as { issues: Record<string, unknown>[] }).issues)
      : [];
  const items: ReturnType<ExternalAnalyzerCandidate["parse"]> = [];
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
        items.push({
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
  }
  return items;
}

const knipCandidate: ExternalAnalyzerCandidate = {
  id: "knip",
  runner: "npx",
  spec: "knip@6",
  // CONSENT-GATED: needs repo config to avoid noise, and every flag here is an
  // unverified lead (no graph cross-check yet — see docs/backlog.md), not a
  // confirmed finding; same tier as eslint/semgrep.
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
    "exports,types,nsExports,nsTypes",
    "--no-exit-code",
  ],
  parse: parseKnip,
};

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
function parseJscpd(report: string): ReturnType<ExternalAnalyzerCandidate["parse"]> {
  let payload: unknown;
  try {
    payload = JSON.parse(report || "{}");
  } catch {
    return [];
  }
  const duplicates =
    payload && typeof payload === "object" && Array.isArray((payload as { duplicates?: unknown }).duplicates)
      ? ((payload as { duplicates: Record<string, unknown>[] }).duplicates)
      : [];
  return duplicates
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
    });
}

const jscpdCandidate: ExternalAnalyzerCandidate = {
  id: "jscpd",
  runner: "npx",
  spec: "jscpd@4",
  // CONSENT-GATED: heavier full-repo duplication scan; unverified lead, same
  // tier as eslint/semgrep/knip.
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

/** The curated external analyzer candidate set. gitleaks is the default member. */
export const EXTERNAL_ANALYZER_CANDIDATES: ExternalAnalyzerCandidate[] = [
  gitleaksCandidate,
  semgrepCandidate,
  eslintCandidate,
  knipCandidate,
  jscpdCandidate,
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
};
