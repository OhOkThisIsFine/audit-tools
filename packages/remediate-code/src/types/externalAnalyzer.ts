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

/** Imported analyzer output captured at a single generation time. */
export interface ExternalAnalyzerResults {
  tool: string;
  generated_at?: string;
  results: ExternalAnalyzerResultItem[];
}
