import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";

/**
 * Shared scaffolding for PROACTIVE per-provider quota sources (Claude, Codex,
 * Copilot, Antigravity, OpenCode-broker). Each subclass only supplies the
 * provider gate + a `fetchSnapshot` (read its local credential → hit its
 * endpoint → map to a {@link QuotaUsageSnapshot}). This base owns the
 * cross-cutting concerns identically for all of them:
 *
 *  - per-key snapshot cache (~45s → one live probe per dispatch burst);
 *  - the hermeticity guard (never hit the live endpoint with the DEFAULT global
 *    fetch under a test runner, or when explicitly disabled — an injected
 *    `fetchImpl` is always honored so unit tests exercise the real path);
 *  - graceful degrade: a non-matching provider key, or any failure inside
 *    `fetchSnapshot`, yields `null` so the {@link CompositeQuotaSource} falls
 *    through to the next source.
 *
 * Token refresh is the subclass's call, not this base's: most sources degrade on
 * expiry/401 (the host owns their credential). The Claude source is the
 * exception — it refreshes its CLI credential and persists the rotated token
 * under a file lock (double-checked), because that file is otherwise abandoned
 * once the access token expires. Any source that refreshes MUST do so atomically
 * under a lock so a rotated refresh token is never lost — see
 * {@link ClaudeOAuthQuotaSource}.
 */

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

/** Endpoint+mapping context handed to the reusable `fetchXxxUsage` functions. */
export interface UsageFetchContext {
  fetchImpl: FetchLike;
  now: () => number;
  userAgent: string;
}

export interface HttpQuotaSourceOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Snapshot cache TTL; defaults to 45s. */
  cacheTtlMs?: number;
  /** User-Agent sent to the endpoint. */
  userAgent?: string;
}

interface CachedSnapshot {
  fetchedAtMs: number;
  snapshot: QuotaUsageSnapshot | null;
  /** True when a live probe ran (so a null snapshot is a degrade, not a skip). */
  attempted: boolean;
}

/** A handled provider with a snapshot is `ok`; attempted-but-empty is `degraded`. */
function classifyProbe(cached: CachedSnapshot): QuotaProbeResult["status"] {
  if (cached.snapshot) return "ok";
  return cached.attempted ? "degraded" : "not_applicable";
}

const DEFAULT_CACHE_TTL_MS = 45_000;

export abstract class BaseHttpQuotaSource implements QuotaSource {
  abstract readonly name: string;

  protected readonly fetchImpl: FetchLike;
  protected readonly usingDefaultFetch: boolean;
  protected readonly now: () => number;
  protected readonly cacheTtlMs: number;
  protected readonly userAgent: string;
  private readonly cache = new Map<string, CachedSnapshot>();

  constructor(options: HttpQuotaSourceOptions, defaultUserAgent: string) {
    this.usingDefaultFetch = options.fetchImpl === undefined;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.userAgent = options.userAgent ?? defaultUserAgent;
  }

  /** Providers this source answers for. A non-matching key returns null (no I/O). */
  protected abstract handlesProvider(provider: string): boolean;

  /**
   * Provider-specific: read the local credential, call the endpoint, and map the
   * response to a snapshot. Return null to degrade (missing/expired creds,
   * non-200, parse failure). Only invoked when the network is NOT skipped.
   */
  protected abstract fetchSnapshot(
    provider: string,
    model: string | null,
    nowMs: number,
  ): Promise<QuotaUsageSnapshot | null>;

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    return (await this.probeUsage(providerModelKey)).snapshot;
  }

  /**
   * Probe with an explicit status (see {@link QuotaProbeResult}). A non-matching
   * provider key or a network-skipped probe is `not_applicable`; a real query
   * that yields no snapshot (missing creds, 401/5xx, bad payload) is `degraded`
   * — the silent-degrade signal a bare `null` from `queryCurrentUsage` hides.
   * Both paths return through here so the cache and the status stay consistent.
   */
  async probeUsage(providerModelKey: string): Promise<QuotaProbeResult> {
    const { provider, model } = parseProviderModelKey(providerModelKey);
    // Gated out for this provider — no I/O, and no signal was ever expected.
    if (!this.handlesProvider(provider)) {
      return { snapshot: null, status: "not_applicable" };
    }

    const nowMs = this.now();
    const cached = this.cache.get(providerModelKey);
    if (cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return { snapshot: cached.snapshot, status: classifyProbe(cached) };
    }

    // The live probe was intentionally skipped (hermeticity / disabled) — absent
    // by design, not a degrade.
    if (this.shouldSkipNetwork()) {
      const result: CachedSnapshot = { fetchedAtMs: nowMs, snapshot: null, attempted: false };
      this.cache.set(providerModelKey, result);
      return { snapshot: null, status: "not_applicable" };
    }

    // A real query for a handled provider: a null result is a silent degrade.
    const snapshot = await this.fetchSnapshot(provider, model, nowMs);
    const result: CachedSnapshot = { fetchedAtMs: nowMs, snapshot, attempted: true };
    this.cache.set(providerModelKey, result);
    return { snapshot, status: classifyProbe(result) };
  }

  /** Context for the reusable `fetchXxxUsage` helpers. */
  protected fetchContext(): UsageFetchContext {
    return { fetchImpl: this.fetchImpl, now: this.now, userAgent: this.userAgent };
  }

  protected shouldSkipNetwork(): boolean {
    if (isTruthyEnv(process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA)) return true;
    if (this.usingDefaultFetch && isUnderTestRunner()) return true;
    return false;
  }
}

/** GET/POST a JSON endpoint; returns parsed JSON, or null on non-200/network/parse failure. */
export async function fetchJsonOrNull(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<unknown | null> {
  let res: FetchResponseLike;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return null; // network error → degrade
  }
  if (!res.ok) return null; // 401/403/5xx → degrade
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Splits a `provider/model` quota key; `provider/*` and bare `provider` → model null. */
export function parseProviderModelKey(key: string): { provider: string; model: string | null } {
  const idx = key.indexOf("/");
  if (idx < 0) return { provider: key, model: null };
  const provider = key.slice(0, idx);
  const rest = key.slice(idx + 1);
  return { provider, model: rest === "" || rest === "*" ? null : rest };
}

/** Clamp to a 0–1 fraction (the scheduler's `remaining_pct` scale). */
export function clampFraction(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** `remaining_pct` from an integer "percent used" (0–100); exact for integers (20/100 === 0.2). */
export function remainingFromUsedPercent(usedPercent: number): number {
  return clampFraction((100 - usedPercent) / 100);
}

export function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

/** True under `node --test` (NODE_TEST_CONTEXT) or vitest (VITEST). */
export function isUnderTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT != null || process.env.VITEST != null;
}
