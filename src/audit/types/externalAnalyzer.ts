import { z } from "zod";

/** One normalized result imported from an external analyzer such as eslint or tsc. */
export const ExternalAnalyzerResultItemSchema = z
  .object({
    id: z.string(),
    category: z.string(),
    severity: z.string(),
    path: z.string(),
    line_start: z.number().optional(),
    line_end: z.number().optional(),
    summary: z.string(),
    rule: z.string().optional(),
    /** Preserves the analyzer-native payload when consumers need original detail. */
    raw: z.unknown().optional(),
  })
  .strict();
export type ExternalAnalyzerResultItem = z.infer<
  typeof ExternalAnalyzerResultItemSchema
>;

/** A normalized analyzer hint that a bounded set of files belongs to a root. */
export const ExternalAnalyzerOwnershipRootSchema = z
  .object({
    root: z.string(),
    paths: z.array(z.string()),
    kind: z.string().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ExternalAnalyzerOwnershipRoot = z.infer<
  typeof ExternalAnalyzerOwnershipRootSchema
>;

export const ExternalAnalyzerToolStatusSchema = z
  .object({
    tool: z.string(),
    command: z.string().optional(),
    resolved: z.boolean(),
    status: z.enum([
      "skipped",
      "success",
      "findings",
      "not_resolved",
      "spawn_error",
      "parse_error",
      "failed",
    ]),
    exit_code: z.number().nullable().optional(),
    error: z.string().optional(),
    output_snippet: z.string().optional(),
  })
  .strict();
export type ExternalAnalyzerToolStatus = z.infer<
  typeof ExternalAnalyzerToolStatusSchema
>;

/** Imported analyzer output captured at a single generation time. */
export const ExternalAnalyzerResultsSchema = z
  .object({
    tool: z.string(),
    generated_at: z.string().optional(),
    ownership_roots: z.array(ExternalAnalyzerOwnershipRootSchema).optional(),
    tool_statuses: z.array(ExternalAnalyzerToolStatusSchema).optional(),
    results: z.array(ExternalAnalyzerResultItemSchema),
  })
  .strict();
export type ExternalAnalyzerResults = z.infer<
  typeof ExternalAnalyzerResultsSchema
>;
