/** One normalized result imported from an external analyzer such as eslint or tsc. */
export interface ExternalAnalyzerResultItem {
  id: string;
  category: string;
  severity: string;
  path: string;
  line_start?: number;
  line_end?: number;
  summary: string;
  rule?: string;
  /** Preserves the analyzer-native payload when consumers need original detail. */
  raw?: unknown;
}

/** A normalized analyzer hint that a bounded set of files belongs to a root. */
export interface ExternalAnalyzerOwnershipRoot {
  root: string;
  paths: string[];
  kind?: string;
  confidence?: number;
  reason?: string;
}

export interface ExternalAnalyzerToolStatus {
  tool: string;
  command?: string;
  resolved: boolean;
  status:
    | "skipped"
    | "success"
    | "findings"
    | "not_resolved"
    | "spawn_error"
    | "parse_error"
    | "failed";
  exit_code?: number | null;
  error?: string;
  output_snippet?: string;
}

/** Imported analyzer output captured at a single generation time. */
export interface ExternalAnalyzerResults {
  tool: string;
  generated_at?: string;
  ownership_roots?: ExternalAnalyzerOwnershipRoot[];
  tool_statuses?: ExternalAnalyzerToolStatus[];
  results: ExternalAnalyzerResultItem[];
}
