import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

interface NpmAuditVuln {
  name?: string;
  severity?: string;
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string };
}

interface NpmAuditJson {
  vulnerabilities?: Record<string, NpmAuditVuln>;
}

const NPM_SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  medium: "medium",
  low: "low",
  info: "info",
};

export function normalizeNpmAuditJson(
  input: NpmAuditJson,
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "npm-audit",
    Object.entries(input.vulnerabilities ?? {}).map(([pkg, vuln], index) => {
      const severity = NPM_SEVERITY_MAP[vuln.severity ?? ""] ?? "low";
      return {
        id: `npm-audit-${index}`,
        category: "dependency_risk",
        severity,
        path: "package-lock.json",
        summary: `Package ${pkg} has a ${severity} severity vulnerability in range ${vuln.range ?? "unknown"}.`,
        rule: pkg,
        raw: vuln,
      };
    }),
  );
}
