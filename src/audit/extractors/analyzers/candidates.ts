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

/** The curated external analyzer candidate set. gitleaks is the default member. */
export const EXTERNAL_ANALYZER_CANDIDATES: ExternalAnalyzerCandidate[] = [
  gitleaksCandidate,
  semgrepCandidate,
  eslintCandidate,
];

export {
  gitleaksCandidate,
  semgrepCandidate,
  eslintCandidate,
  parseGitleaks,
  GITLEAKS_VERSION,
};
