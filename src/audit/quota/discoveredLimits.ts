import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getQuotaStatePath } from "audit-tools/shared";

export interface DiscoveredRateLimits {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
  /** Discovered context window for the dispatch model (capability handshake). */
  context_tokens?: number | null;
  /** Discovered output cap for the dispatch model (capability handshake). */
  output_tokens?: number | null;
  source: string;
}

export interface DiscoveredLimitsCacheEntry {
  requests_per_minute?: number;
  input_tokens_per_minute?: number;
  output_tokens_per_minute?: number;
  /** Discovered context window for the dispatch model (capability handshake). */
  context_tokens?: number;
  /** Discovered output cap for the dispatch model (capability handshake). */
  output_tokens?: number;
  discovered_at: string;
  source: string;
}

/**
 * The single-sourced numeric limit field set — the keys shared by
 * {@link DiscoveredRateLimits} and {@link DiscoveredLimitsCacheEntry}. Persist,
 * lookup, and change-detection all iterate this list so no discovered field can
 * be silently dropped on the cache round-trip. Values stay runtime-discovered;
 * this only enumerates the field names, never any model-specific limit value.
 */
export const DISCOVERED_LIMIT_FIELDS = [
  "requests_per_minute",
  "input_tokens_per_minute",
  "output_tokens_per_minute",
  "context_tokens",
  "output_tokens",
] as const satisfies readonly (keyof DiscoveredRateLimits &
  keyof DiscoveredLimitsCacheEntry)[];

export interface DiscoveredLimitsCache {
  version: 1;
  entries: Record<string, DiscoveredLimitsCacheEntry>;
}

function getCachePath(): string {
  return join(dirname(getQuotaStatePath()), "discovered-limits.json");
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
        `[quota] ignoring unreadable discovered-limits cache (${getCachePath()}): ${
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
  for (const field of DISCOVERED_LIMIT_FIELDS) {
    const value = limits[field];
    if (value != null) {
      entry[field] = value;
    }
  }
  // Skip the write if the effective limit values are unchanged (source/timestamp
  // may differ, but only write when a numeric limit actually changed).
  if (
    existing &&
    DISCOVERED_LIMIT_FIELDS.every((field) => existing[field] === entry[field])
  ) {
    return;
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
  if (DISCOVERED_LIMIT_FIELDS.every((field) => entry[field] == null)) {
    return null;
  }
  const result: DiscoveredRateLimits = { source: entry.source };
  for (const field of DISCOVERED_LIMIT_FIELDS) {
    result[field] = entry[field] ?? null;
  }
  return result;
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
    for (const field of DISCOVERED_LIMIT_FIELDS) {
      merged[field] ??= source[field];
    }
  }
  return merged;
}
