import { z } from "zod";

export const QuotaUsageSnapshotSchema = z
  .object({
    remaining_pct: z.number().nullable(),
    reset_at: z.string().nullable(),
    requests_remaining: z.number().int().nullable(),
    tokens_remaining: z.number().int().nullable(),
    captured_at: z.string(),
    source: z.string(),
  })
  .strict();
export type QuotaUsageSnapshot = z.infer<typeof QuotaUsageSnapshotSchema>;

export interface QuotaSource {
  readonly name: string;
  queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null>;
}
