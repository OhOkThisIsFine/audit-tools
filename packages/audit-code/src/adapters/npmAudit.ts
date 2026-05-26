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

export function normalizeNpmAuditJson(
  input: NpmAuditJson,
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "npm-audit",
    Object.entries(input.vulnerabilities ?? {}).map(([pkg, vuln], index) => ({
      id: `npm-audit-${index}`,
      category: "dependency_risk",
      severity: vuln.severity ?? "unknown",
      path: "package-lock.json",
      summary: `Package ${pkg} has a ${vuln.severity ?? "unknown"} severity vulnerability in range ${vuln.range ?? "unknown"}.`,
      rule: pkg,
      raw: vuln,
    })),
  );
}
