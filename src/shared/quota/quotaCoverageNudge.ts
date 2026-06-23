import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseProviderModelKey } from "./httpQuotaSource.js";
import { renderUnestablishedQuotaNudge } from "./coverage.js";

/**
 * Gate the full unestablished-quota nudge to ONCE per environment: the first time
 * an unsupported host provider is seen in an artifact dir, emit the full two-path
 * nudge ({@link renderUnestablishedQuotaNudge}); afterward callers carry only the
 * terse `quota_coverage: unestablished` status. State is a per-provider marker file
 * in the artifact dir, so it survives across steps/runs of the same run dir.
 *
 * Returns true exactly once per (artifactDir, provider) — it writes the marker on
 * the first true. All fs failures are swallowed: a missing/unwritable artifact dir
 * degrades to "emit" (better a repeated nudge than a silently-swallowed gap).
 */
export function shouldEmitQuotaNudge(artifactDir: string, provider: string): boolean {
  const markerPath = path.join(artifactDir, quotaNudgeMarkerName(provider));
  try {
    if (existsSync(markerPath)) return false;
  } catch {
    return true; // can't tell → emit
  }
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(markerPath, provider);
  } catch {
    // Couldn't persist the marker — still emit this time (may re-emit next time).
  }
  return true;
}

/** Marker filename for a provider, with non-filename-safe chars folded to `-`. */
export function quotaNudgeMarkerName(provider: string): string {
  const safe = provider.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `quota-coverage-nudged-${safe}.marker`;
}

/**
 * Build the dispatch-prompt quota-coverage nudge block from a written
 * `dispatch-quota.json`: for each DISTINCT provider whose pool reported
 * `quota_coverage: "unestablished"`, emit the full two-path nudge the FIRST time
 * (once per environment, via {@link shouldEmitQuotaNudge}) and a terse one-liner
 * after. Returns "" when the file is absent/unreadable or no provider is
 * unestablished — so a supported environment adds nothing to the prompt. Shared so
 * both orchestrators surface the identical block (no drift). Reads the contract's
 * `capacity_pools[]` (each `{ pool_id, quota_coverage }`) defensively.
 */
export function renderQuotaCoverageNudge(
  quotaPath: string | null | undefined,
  artifactsDir: string,
): string {
  if (!quotaPath) return "";
  let pools: Array<{ pool_id?: unknown; quota_coverage?: unknown }>;
  try {
    const data = JSON.parse(readFileSync(quotaPath, "utf8")) as { capacity_pools?: unknown };
    pools = Array.isArray(data?.capacity_pools)
      ? (data.capacity_pools as Array<{ pool_id?: unknown; quota_coverage?: unknown }>)
      : [];
  } catch {
    return "";
  }
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const pool of pools) {
    if (pool?.quota_coverage !== "unestablished") continue;
    const { provider } = parseProviderModelKey(String(pool.pool_id ?? ""));
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  if (providers.length === 0) return "";
  return providers
    .map((provider) =>
      shouldEmitQuotaNudge(artifactsDir, provider)
        ? renderUnestablishedQuotaNudge(provider)
        : `⚠️ quota_coverage: unestablished for \`${provider}\` — no proactive quota source wired; ` +
          `pacing is reactive-429 only. See dispatch-quota.json and the earlier nudge.`,
    )
    .join("\n\n");
}
