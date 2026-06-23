import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import { withFileLock } from "./fileLock.js";
import {
  BaseHttpQuotaSource,
  fetchJsonOrNull,
  clampFraction,
  parseProviderModelKey,
  type FetchLike,
  type HttpQuotaSourceOptions,
  type UsageFetchContext,
} from "./httpQuotaSource.js";

/**
 * Proactive Claude-subscription quota source — resolves a Claude OAuth access
 * token (see {@link resolveAccessToken}) and queries the undocumented
 * `api.anthropic.com/api/oauth/usage` endpoint (the only proactive
 * remaining-quota signal Claude Code exposes), mapping the most-constraining
 * window to a {@link QuotaUsageSnapshot}. The cross-cutting cache/guard/degrade
 * behavior lives in {@link BaseHttpQuotaSource}.
 *
 * Credential resolution (first hit wins; see
 * docs/quota-claude-credential-resolution.md):
 *  1. `CLAUDE_CODE_OAUTH_TOKEN` — the only docs-blessed subprocess handoff
 *     (`claude setup-token`). Used as-is, NO file is read or written. This is
 *     what lets a non-CLI host (e.g. the Claude Desktop app, whose own token
 *     lives in an OS-encrypted store we must not decrypt) still get a proactive
 *     account-level reading.
 *  2. `~/.claude/.credentials.json` (the CLI credential) with REFRESH-ON-EXPIRY:
 *     when the access token is missing/expired (or `/usage` 401s) but a refresh
 *     token is present, the refresh grant is run and the ROTATED credential is
 *     persisted atomically under {@link withFileLock} (double-checked: the file
 *     is re-read after the lock is acquired, so concurrent probes never
 *     double-rotate and invalidate each other's refresh token).
 *  3. Otherwise degrade to null — the {@link CompositeQuotaSource} falls through
 *     to the reactive host-session source.
 */

const CLAUDE_PROVIDER_NAMES = new Set(["claude-code", "claude"]);
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_USER_AGENT = "claude-cli (external, cli)";
/** Claude Code's public OAuth client id + token endpoint (refresh grant). */
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

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
interface ClaudeOAuthBlock {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}
interface ClaudeOAuthCredentials {
  claudeAiOauth?: ClaudeOAuthBlock;
}

/** Where a resolved access token came from — governs 401-driven refresh. */
type TokenOrigin = "env" | "file";
interface ResolvedToken {
  accessToken: string;
  origin: TokenOrigin;
}

/** Shape of a successful refresh-grant response (defensive subset). */
interface RefreshGrantResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface ClaudeOAuthQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Defaults to `~/.claude/.credentials.json`. */
  credentialsPath?: string;
  /** Override the provider-name gate (mainly for tests). */
  claudeProviderNames?: Iterable<string>;
  /**
   * Supplies the docs-blessed `CLAUDE_CODE_OAUTH_TOKEN` handoff. Defaults to
   * reading `process.env.CLAUDE_CODE_OAUTH_TOKEN` at probe time; injectable for
   * tests. A non-empty return short-circuits the credential file entirely.
   */
  readEnvToken?: () => string | null | undefined;
  /** Override the OAuth client id (refresh grant). Defaults to Claude Code's public client. */
  oauthClientId?: string;
  /** Override the token endpoint (refresh grant). */
  oauthTokenEndpoint?: string;
}

export class ClaudeOAuthQuotaSource extends BaseHttpQuotaSource {
  readonly name = "claude-oauth";
  private readonly credentialsPath: string;
  private readonly usingDefaultCredentialsPath: boolean;
  private readonly providerNames: Set<string>;
  private readonly readEnvToken: () => string | null | undefined;
  private readonly oauthClientId: string;
  private readonly oauthTokenEndpoint: string;

  constructor(options: ClaudeOAuthQuotaSourceOptions = {}) {
    super(options, DEFAULT_USER_AGENT);
    this.usingDefaultCredentialsPath = options.credentialsPath === undefined;
    this.credentialsPath =
      options.credentialsPath ?? path.join(homedir(), ".claude", ".credentials.json");
    this.providerNames = new Set(options.claudeProviderNames ?? CLAUDE_PROVIDER_NAMES);
    this.readEnvToken =
      options.readEnvToken ?? (() => process.env.CLAUDE_CODE_OAUTH_TOKEN);
    this.oauthClientId = options.oauthClientId ?? OAUTH_CLIENT_ID;
    this.oauthTokenEndpoint = options.oauthTokenEndpoint ?? OAUTH_TOKEN_ENDPOINT;
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  /**
   * Account id = the credential's `organizationUuid` (account/org the token is
   * bound to). Read from the creds file; null when only an env token is present
   * (the org isn't carried there) or the file is absent — the pool then stays
   * account-unkeyed, which is correct for a single-account run.
   */
  protected readAccountId(_provider: string): string | null {
    if (this.shouldSkipCredentialRead(this.usingDefaultCredentialsPath)) return null;
    const full = this.readFullCredentials();
    const org = full?.organizationUuid;
    return typeof org === "string" && org !== "" ? org : null;
  }

  protected async fetchSnapshot(
    _provider: string,
    model: string | null,
    nowMs: number,
  ): Promise<QuotaUsageSnapshot | null> {
    const resolved = await this.resolveAccessToken(nowMs, false);
    if (!resolved) return null;
    const snap = await fetchClaudeUsage(
      { accessToken: resolved.accessToken, model },
      this.fetchContext(),
    );
    if (snap) return snap;
    // A null here means a non-200 (commonly 401: token revoked/expired between
    // resolution and use). For a FILE-origin token we can recover by forcing one
    // refresh and retrying; an env token is operator-owned and not ours to rotate.
    if (resolved.origin !== "file") return null;
    const refreshed = await this.resolveAccessToken(nowMs, true);
    if (!refreshed || refreshed.accessToken === resolved.accessToken) return null;
    return fetchClaudeUsage(
      { accessToken: refreshed.accessToken, model },
      this.fetchContext(),
    );
  }

  /**
   * Resolve an access token via the documented chain (env handoff → CLI file
   * with refresh-on-expiry). `forceRefresh` skips the still-valid fast path and
   * always runs the refresh grant (used to recover from a 401).
   */
  private async resolveAccessToken(
    nowMs: number,
    forceRefresh: boolean,
  ): Promise<ResolvedToken | null> {
    const envToken = this.readEnvToken();
    if (typeof envToken === "string" && envToken.trim() !== "") {
      return { accessToken: envToken.trim(), origin: "env" };
    }

    const oauth = this.readOAuthBlock();
    if (!oauth) return null;

    const valid =
      typeof oauth.accessToken === "string" &&
      oauth.accessToken !== "" &&
      !(typeof oauth.expiresAt === "number" && nowMs >= oauth.expiresAt);
    if (valid && !forceRefresh) {
      return { accessToken: oauth.accessToken as string, origin: "file" };
    }

    // Expired/missing/forced and no refresh token → degrade (nothing to refresh).
    if (typeof oauth.refreshToken !== "string" || oauth.refreshToken === "") {
      return null;
    }

    const refreshed = await this.refreshAndPersist(nowMs, forceRefresh);
    return refreshed ? { accessToken: refreshed, origin: "file" } : null;
  }

  /** Parse the `claudeAiOauth` block from the credential file, or null. */
  private readOAuthBlock(): ClaudeOAuthBlock | null {
    let raw: string;
    try {
      raw = readFileSync(this.credentialsPath, "utf8");
    } catch {
      return null; // missing file (e.g. creds in an OS keychain) → degrade
    }
    try {
      return (JSON.parse(raw) as ClaudeOAuthCredentials).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Run the refresh grant and persist the ROTATED credential under a file lock.
   * Double-checked: after the lock is held the file is re-read, so if a
   * concurrent probe already refreshed (token now valid, and we are not forcing)
   * that fresh token is used instead of rotating again — a second rotation would
   * invalidate the first refresh token and brick the credential.
   */
  private async refreshAndPersist(nowMs: number, forceRefresh: boolean): Promise<string | null> {
    const lockPath = `${this.credentialsPath}.lock`;
    try {
      return await withFileLock(lockPath, async () => {
        const oauth = this.readOAuthBlock();
        if (!oauth) return null;
        const stillValid =
          typeof oauth.accessToken === "string" &&
          oauth.accessToken !== "" &&
          !(typeof oauth.expiresAt === "number" && nowMs >= oauth.expiresAt);
        if (stillValid && !forceRefresh) return oauth.accessToken as string;
        if (typeof oauth.refreshToken !== "string" || oauth.refreshToken === "") return null;

        const grant = await this.runRefreshGrant(oauth.refreshToken);
        if (!grant?.access_token || !grant.refresh_token || typeof grant.expires_in !== "number") {
          return null;
        }
        const next: ClaudeOAuthCredentials & Record<string, unknown> = {
          ...(this.readFullCredentials() ?? {}),
        };
        next.claudeAiOauth = {
          ...(next.claudeAiOauth ?? {}),
          accessToken: grant.access_token,
          refreshToken: grant.refresh_token,
          expiresAt: nowMs + grant.expires_in * 1000,
          scopes: grant.scope ? grant.scope.split(" ") : next.claudeAiOauth?.scopes,
        };
        this.writeCredentialsAtomic(next);
        return grant.access_token;
      });
    } catch {
      return null; // lock timeout / IO failure → degrade, never throw out of a probe
    }
  }

  /** POST the refresh-token grant; null on any non-200/network/parse failure. */
  private async runRefreshGrant(refreshToken: string): Promise<RefreshGrantResponse | null> {
    const body = await fetchJsonOrNull(this.fetchImpl as FetchLike, this.oauthTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.oauthClientId,
      }),
    });
    return body == null ? null : (body as RefreshGrantResponse);
  }

  /** Full credential object (preserves sibling fields like organizationUuid), or null. */
  private readFullCredentials(): (ClaudeOAuthCredentials & Record<string, unknown>) | null {
    let raw: string;
    try {
      raw = readFileSync(this.credentialsPath, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as ClaudeOAuthCredentials & Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Atomic temp-then-rename write so a crash mid-write never truncates the credential. */
  private writeCredentialsAtomic(creds: unknown): void {
    const tmp = `${this.credentialsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(creds, null, 2));
    renameSync(tmp, this.credentialsPath);
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
