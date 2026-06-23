import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  BaseHttpQuotaSource,
  fetchJsonOrNull,
  clampFraction,
  parseProviderModelKey,
  type HttpQuotaSourceOptions,
  type UsageFetchContext,
} from "./httpQuotaSource.js";

/**
 * Proactive Claude-subscription quota source — reads the local Claude OAuth
 * credential and queries the undocumented `api.anthropic.com/api/oauth/usage`
 * endpoint (the only proactive remaining-quota signal Claude Code exposes),
 * mapping the most-constraining window to a {@link QuotaUsageSnapshot}. The
 * cross-cutting cache/guard/degrade behavior lives in {@link BaseHttpQuotaSource}.
 */

const CLAUDE_PROVIDER_NAMES = new Set(["claude-code", "claude"]);
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_USER_AGENT = "claude-cli (external, cli)";

// Re-exported for back-compat (tests + index import these from here).
export { parseProviderModelKey };

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

export interface ClaudeOAuthQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Defaults to `~/.claude/.credentials.json`. */
  credentialsPath?: string;
  /** Override the provider-name gate (mainly for tests). */
  claudeProviderNames?: Iterable<string>;
}

export class ClaudeOAuthQuotaSource extends BaseHttpQuotaSource {
  readonly name = "claude-oauth";
  private readonly credentialsPath: string;
  private readonly providerNames: Set<string>;

  constructor(options: ClaudeOAuthQuotaSourceOptions = {}) {
    super(options, DEFAULT_USER_AGENT);
    this.credentialsPath =
      options.credentialsPath ?? path.join(homedir(), ".claude", ".credentials.json");
    this.providerNames = new Set(options.claudeProviderNames ?? CLAUDE_PROVIDER_NAMES);
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  protected async fetchSnapshot(
    _provider: string,
    model: string | null,
    nowMs: number,
  ): Promise<QuotaUsageSnapshot | null> {
    const accessToken = this.readAccessToken(nowMs);
    if (!accessToken) return null;
    return fetchClaudeUsage({ accessToken, model }, this.fetchContext());
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
}

/**
 * Reusable Claude `/usage` probe (no creds-file read, no guard) — used by the
 * source above and by the OpenCode broker with OpenCode's stored anthropic token.
 * The `User-Agent: claude-…` header materially matters: without a first-party-shaped
 * UA the request lands in an aggressively rate-limited bucket.
 */
export async function fetchClaudeUsage(
  creds: { accessToken: string; model: string | null },
  ctx: UsageFetchContext,
): Promise<QuotaUsageSnapshot | null> {
  const body = await fetchJsonOrNull(ctx.fetchImpl, USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
    },
  });
  if (body == null) return null;
  return mapUsageToSnapshot(body as UsageResponse, creds.model, ctx.now());
}

/**
 * Maps a `/usage` response to the most-constraining remaining-quota snapshot.
 * `remaining_pct` is a 0–1 FRACTION (scheduler thresholds 0.1/0.3).
 */
export function mapUsageToSnapshot(
  body: UsageResponse,
  model: string | null,
  nowMs: number,
): QuotaUsageSnapshot | null {
  // A malformed / non-object payload degrades to null and never throws (mirrors
  // the codex/copilot/antigravity mappers' null-safety).
  if (body == null || typeof body !== "object") return null;
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
