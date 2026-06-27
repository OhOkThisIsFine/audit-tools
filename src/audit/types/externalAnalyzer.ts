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

/**
 * A normalized language-neutral graph edge contributed by an EXTERNAL analyzer
 * (ast-grep / broader-semgrep dataflow / CodeQL dataflow). `from`/`to` are repo
 * paths (resolved against the path lookup at extraction); `kind`/`confidence`/
 * `reason` are optional provenance, mirroring the in-tree {@link GraphEdge}
 * shape so external dataflow enriches the same edge set the language analyzers
 * feed — no per-ecosystem fork. Carried on the adapter contract so a malformed
 * native payload degrades to an empty edge list rather than throwing.
 */
export const ExternalAnalyzerGraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.string().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ExternalAnalyzerGraphEdge = z.infer<
  typeof ExternalAnalyzerGraphEdgeSchema
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
    /**
     * Language-neutral graph edges contributed by an external dataflow analyzer.
     * Optional so legacy/finding-only imports still parse under `.strict()`.
     */
    graph_edges: z.array(ExternalAnalyzerGraphEdgeSchema).optional(),
    tool_statuses: z.array(ExternalAnalyzerToolStatusSchema).optional(),
    results: z.array(ExternalAnalyzerResultItemSchema),
  })
  .strict();
export type ExternalAnalyzerResults = z.infer<
  typeof ExternalAnalyzerResultsSchema
>;

/**
 * Merge one tool's results into the per-tool array artifact: the entry with the
 * same `tool` is REPLACED (a fresh run supersedes the prior one); otherwise the
 * entry is appended. Multiple producers (import / syntax-resolution / the
 * acquisition engine) each contribute their own tool entry without clobbering
 * the others. Returns a new array sorted by `tool` for deterministic output.
 */
export function upsertExternalToolResults(
  existing: ExternalAnalyzerResults[] | undefined,
  incoming: ExternalAnalyzerResults,
): ExternalAnalyzerResults[] {
  const next = (existing ?? []).filter((entry) => entry.tool !== incoming.tool);
  next.push(incoming);
  return next.sort((a, b) => a.tool.localeCompare(b.tool));
}
