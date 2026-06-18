import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

interface EslintResult {
  filePath?: string;
  messages?: Array<{
    ruleId?: string | null;
    severity?: number;
    line?: number;
    endLine?: number;
    message?: string;
  }>;
}

const ESLINT_SEVERITY_ERROR = 2;
const ESLINT_SEVERITY_WARNING = 1;
const ESLINT_SEVERITY_MAP = {
  [ESLINT_SEVERITY_ERROR]: "medium",
  [ESLINT_SEVERITY_WARNING]: "low",
} as const;

function mapSeverity(value?: number): string {
  // ESLint's JSON formatter emits 2 for errors and 1 for warnings.
  if (typeof value !== "number") {
    return "info";
  }
  return ESLINT_SEVERITY_MAP[value as keyof typeof ESLINT_SEVERITY_MAP] ?? "info";
}

export function normalizeEslintJson(
  input: EslintResult[],
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "eslint",
    input.flatMap((file) =>
      (file.messages ?? []).map((message, index) => ({
        id: `${file.filePath ?? "unknown"}:${index + 1}`,
        category: "maintainability",
        severity: mapSeverity(message.severity),
        path: file.filePath,
        line_start: message.line,
        line_end: message.endLine,
        summary: message.message,
        rule: message.ruleId ?? undefined,
        raw: message,
      })),
    ),
  );
}
