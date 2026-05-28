import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getQuotaStatePath } from "@audit-tools/shared";

export interface DiscoveredRateLimits {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
  source: string;
}

export interface DiscoveredLimitsCacheEntry {
  requests_per_minute?: number;
  input_tokens_per_minute?: number;
  discovered_at: string;
  source: string;
}

export interface DiscoveredLimitsCache {
  version: 1;
  entries: Record<string, DiscoveredLimitsCacheEntry>;
}

function getCachePath(): string {
  return getQuotaStatePath().replace(/quota-state\.json$/, "discovered-limits.json");
}

export async function readDiscoveredLimitsCache(): Promise<DiscoveredLimitsCache> {
  try {
    const raw = await readFile(getCachePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["version"] === 1
    ) {
      return parsed as DiscoveredLimitsCache;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[quota] ignoring unreadable discovered-limits cache: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  return { version: 1, entries: {} };
}

export async function writeDiscoveredLimitsCache(cache: DiscoveredLimitsCache): Promise<void> {
  const cachePath = getCachePath();
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

export async function updateDiscoveredLimits(
  providerModelKey: string,
  limits: DiscoveredRateLimits,
): Promise<void> {
  const cache = await readDiscoveredLimitsCache();
  const existing = cache.entries[providerModelKey];
  const entry: DiscoveredLimitsCacheEntry = {
    ...existing,
    discovered_at: new Date().toISOString(),
    source: limits.source,
  };
  if (limits.requests_per_minute != null) {
    entry.requests_per_minute = limits.requests_per_minute;
  }
  if (limits.input_tokens_per_minute != null) {
    entry.input_tokens_per_minute = limits.input_tokens_per_minute;
  }
  cache.entries[providerModelKey] = entry;
  await writeDiscoveredLimitsCache(cache);
}

export async function lookupDiscoveredLimits(
  providerModelKey: string,
): Promise<DiscoveredRateLimits | null> {
  const cache = await readDiscoveredLimitsCache();
  const entry = cache.entries[providerModelKey];
  if (!entry) return null;
  if (entry.requests_per_minute == null && entry.input_tokens_per_minute == null) return null;
  return {
    requests_per_minute: entry.requests_per_minute ?? null,
    input_tokens_per_minute: entry.input_tokens_per_minute ?? null,
    source: entry.source,
  };
}

export function mergeDiscoveredLimits(
  ...sources: (DiscoveredRateLimits | null | undefined)[]
): DiscoveredRateLimits | null {
  let merged: DiscoveredRateLimits | null = null;
  for (const source of sources) {
    if (!source) continue;
    if (!merged) {
      merged = { ...source };
      continue;
    }
    merged.requests_per_minute ??= source.requests_per_minute;
    merged.input_tokens_per_minute ??= source.input_tokens_per_minute;
    merged.output_tokens_per_minute ??= source.output_tokens_per_minute;
  }
  return merged;
}
