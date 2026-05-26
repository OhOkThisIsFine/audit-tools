export interface QuotaUsageSnapshot {
  remaining_pct: number | null;
  reset_at: string | null;
  requests_remaining: number | null;
  tokens_remaining: number | null;
  captured_at: string;
  source: string;
}

export interface QuotaSource {
  readonly name: string;
  queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null>;
}
