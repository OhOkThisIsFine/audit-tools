import { z } from "zod";

/**
 * Historical per-run summary of covered and edited paths. Retained for readers
 * of archived artifacts. Recency is measured in ledger ordinals.
 */
export const ACCESS_MEMORY_VERSION = 1;

/**
 * Optional symbol-level detail supported by the historical wire format.
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
