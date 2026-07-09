import { z } from "zod";

/**
 * Per-run access-memory record: a deterministic, artifact-derived summary of
 * which files (and, later, symbols) earlier steps actually covered or edited,
 * used to bias later packet composition toward continuity (files earlier steps
 * touched are likelier relevant and cheaper to re-include).
 *
 * Invariants (single-sourced here so both orchestrators conform):
 * - **Deterministic, content-derived serialization.** `paths` is path-sorted and
 *   `lenses` lexically sorted; counters are values, never an access-ordered
 *   array — so the artifact's content hash is stable across re-derivation and
 *   never churns the staleness DAG on iteration incidentals.
 * - **Recency lives in STEP-ORDINAL space, never wall-clock.** `last_ordinal` is
 *   a result's position in the ingested ledger (a step index), so the recency
 *   signal is stable across machines/agents and clock skew.
 * - **Raw counters persisted; continuity SCORES derived JIT at dispatch.** This
 *   record carries only the raw frequency/recency counters; the personalized
 *   ranking that consumes them is computed at dispatch and never persisted.
 */
export const ACCESS_MEMORY_VERSION = 1;

/**
 * Reserved for the `path::symbol` granularity increment. Unpopulated by the
 * audit-side path-level harvest (AuditResult.file_coverage carries no symbol
 * information); a later increment fills it from the extractors' symbol spans.
 */
export const AccessMemorySymbolRecordSchema = z
  .object({
    symbol: z.string(),
    covered_count: z.number().int().min(0),
    last_ordinal: z.number().int().min(0),
  })
  .strict();
export type AccessMemorySymbolRecord = z.infer<
  typeof AccessMemorySymbolRecordSchema
>;

export const AccessMemoryPathRecordSchema = z
  .object({
    path: z.string(),
    /** How many ingested results covered this path (audit-side frequency). */
    covered_count: z.number().int().min(0),
    /** How many resolved remediate items declared this path in their edit surface (parity harvest). */
    edited_count: z.number().int().min(0),
    /** Ledger-position (step) ordinal of the most recent touch — recency seed. */
    last_ordinal: z.number().int().min(0),
    /** Distinct lenses that covered this path, lexically sorted. */
    lenses: z.array(z.string()),
    symbols: z.array(AccessMemorySymbolRecordSchema).optional(),
  })
  .strict();
export type AccessMemoryPathRecord = z.infer<
  typeof AccessMemoryPathRecordSchema
>;

export const AccessMemorySchema = z
  .object({
    version: z.literal(ACCESS_MEMORY_VERSION),
    run_id: z.string().optional(),
    /** Total ordinals in scope (= ledger length), so a scorer can normalize recency. */
    total_ordinals: z.number().int().min(0),
    /** Path records, sorted by path. */
    paths: z.array(AccessMemoryPathRecordSchema),
  })
  .strict();
export type AccessMemory = z.infer<typeof AccessMemorySchema>;
