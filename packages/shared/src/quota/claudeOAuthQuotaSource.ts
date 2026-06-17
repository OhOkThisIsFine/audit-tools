import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";

/**
 * Proactive Claude-subscription quota source.
 *
 * Reads the local Claude OAuth credential and queries the undocumented
 * `api.anthropic.com/api/oauth/usage` endpoint — the only proactive
 * remaining-quota signal Claude Code exposes. Maps the most-constraining usage
 * window to a {@link QuotaUsageSnapshot} so the scheduler can throttle/spill
 * BEFORE hitting a 429 (the learned/reactive source only learns after a limit
 * is hit).
 *
 * Everything-agnostic + graceful degrade: returns `null` for any non-Claude
 * provider key, a missing/expired credential, a non-200 response, or a schema
 * it can't parse — the {@link CompositeQuotaSource} then falls through to the
 * learned source. Token refresh is intentionally NOT performed here: that is
 * owned by the host `claude` CLI, and rewriting the user's rotating credential
 * chain from a read-only quota probe risks breaking their auth.
 */

const CLAUDE_PROVIDER_NAMES = new Set(["claude-code", "claude"]);

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_USER_AGENT = "claude-cli (external, cli)";
const DEFAULT_CACHE_TTL_MS = 45_000;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

/** Defensive subset of one `/usage` `limits[]` entry. */
interface UsageLimitEntry {
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null;
}

/** Defensive subset of a top-level `/usage` window (five_hour, seven_day, …). */
interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  limits?: UsageLimitEntry[] | null;
}

interface ClaudeOAuthCredentials {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

export interface ClaudeOAuthQuotaSourceOptions {
  /** Defaults to `~/.claude/.credentials.json`. */
  credentialsPath?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Snapshot cache TTL; defaults to 45s (one probe per dispatch burst). */
  cacheTtlMs?: number;
  /** User-Agent sent to the endpoint. */
  userAgent?: string;
  /** Override the provider-name gate (mainly for tests). */
  claudeProviderNames?: Iterable<string>;
}

interface CachedSnapshot {
  fetchedAtMs: number;
  snapshot: QuotaUsageSnapshot | null;
}

export class ClaudeOAuthQuotaSource implements QuotaSource {
  readonly name = "claude-oauth";

  private readonly credentialsPath: string;
  private readonly fetchImpl: FetchLike;
  private readonly usingDefaultFetch: boolean;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly userAgent: string;
  private readonly providerNames: Set<string>;
  private readonly cache = new Map<string, CachedSnapshot>();

  constructor(options: ClaudeOAuthQuotaSourceOptions = {}) {
    this.credentialsPath =
      options.credentialsPath ?? path.join(homedir(), ".claude", ".credentials.json");
    this.usingDefaultFetch = options.fetchImpl === undefined;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.providerNames = new Set(options.claudeProviderNames ?? CLAUDE_PROVIDER_NAMES);
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    const { provider, model } = parseProviderModelKey(providerModelKey);
    if (!this.providerNames.has(provider)) return null;

    const nowMs = this.now();
    const cached = this.cache.get(providerModelKey);
    if (cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return cached.snapshot;
    }

    const snapshot = await this.fetchSnapshot(model, nowMs);
    this.cache.set(providerModelKey, { fetchedAtMs: nowMs, snapshot });
    return snapshot;
  }

  private async fetchSnapshot(
    model: string | null,
    nowMs: number,
  ): Promise<QuotaUsageSnapshot | null> {
    if (this.shouldSkipNetwork()) return null;
    const token = this.readAccessToken(nowMs);
    if (!token) return null;

    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(USAGE_ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });
    } catch {
      return null; // network error → degrade to the next source
    }
    if (!res.ok) return null; // 401 (expired) / 403 / 5xx → degrade

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    return mapUsageToSnapshot(body as UsageResponse, model, nowMs);
  }

  /** Reads a non-expired access token from the local credential file, or null. */
  private readAccessToken(nowMs: number): string | null {
    let raw: string;
    try {
      raw = readFileSync(this.credentialsPath, "utf8");
    } catch {
      return null; // missing file (e.g. creds in an OS keychain) → degrade
    }
    let parsed: ClaudeOAuthCredentials;
    try {
      parsed = JSON.parse(raw) as ClaudeOAuthCredentials;
    } catch {
      return null;
    }
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (typeof oauth.expiresAt === "number" && nowMs >= oauth.expiresAt) return null;
    return oauth.accessToken;
  }

  /**
   * Guards the LIVE endpoint: skip it when proactive quota is explicitly
   * disabled, or — for the default global fetch only — under a test runner, so
   * suites never make a real network call. An injected fetchImpl (unit tests)
   * is always honored.
   */
  private shouldSkipNetwork(): boolean {
    if (isTruthyEnv(process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA)) return true;
    if (this.usingDefaultFetch && isUnderTestRunner()) return true;
    return false;
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

/**
 * Maps a `/usage` response to the most-constraining remaining-quota snapshot.
 * `remaining_pct` is a 0–1 FRACTION (the scheduler's thresholds are 0.1/0.3),
 * computed as `1 - utilization/100` of the window with the LEAST remaining.
 */
export function mapUsageToSnapshot(
  body: UsageResponse,
  model: string | null,
  nowMs: number,
): QuotaUsageSnapshot | null {
  const binding = pickBindingWindow(body, model);
  if (binding == null) return null;
  return {
    // (100 - util)/100 (not 1 - util/100) so integer percents stay exact: 20/100 === 0.2.
    remaining_pct: clampFraction((100 - binding.utilization) / 100),
    reset_at: binding.resets_at ?? null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(nowMs).toISOString(),
    source: "claude-oauth",
  };
}

interface BindingWindow {
  utilization: number;
  resets_at: string | null;
}

/** The window closest to its cap (highest utilization) across limits[] + top-level windows. */
function pickBindingWindow(body: UsageResponse, model: string | null): BindingWindow | null {
  const candidates: BindingWindow[] = [];

  for (const lim of Array.isArray(body.limits) ? body.limits : []) {
    if (typeof lim?.percent !== "number") continue;
    if (!limitAppliesToModel(lim, model)) continue;
    candidates.push({ utilization: lim.percent, resets_at: lim.resets_at ?? null });
  }

  for (const w of topLevelWindows(body)) {
    if (typeof w.utilization === "number") {
      candidates.push({ utilization: w.utilization, resets_at: w.resets_at ?? null });
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.utilization > a.utilization ? b : a));
}

function limitAppliesToModel(lim: UsageLimitEntry, model: string | null): boolean {
  const scopeModel = lim.scope?.model?.display_name ?? lim.scope?.model?.id ?? null;
  if (!scopeModel) return true; // unscoped → applies to everything
  if (!model) return false; // model-scoped but our model is unknown → skip
  return model.toLowerCase().includes(String(scopeModel).toLowerCase());
}

// Aggregate windows only. Per-model constraints come from the data-driven
// `limits[].scope.model` entries — never hardcoded model-family names (INV-QD-04).
function topLevelWindows(body: UsageResponse): UsageWindow[] {
  const out: UsageWindow[] = [];
  if (body.five_hour) out.push(body.five_hour);
  if (body.seven_day) out.push(body.seven_day);
  return out;
}

function clampFraction(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

/** True under `node --test` (NODE_TEST_CONTEXT) or vitest (VITEST). */
function isUnderTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT != null || process.env.VITEST != null;
}
