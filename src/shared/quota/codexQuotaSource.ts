import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  BaseHttpQuotaSource,
  fetchJsonOrNull,
  remainingFromUsedPercent,
  type HttpQuotaSourceOptions,
  type UsageFetchContext,
} from "./httpQuotaSource.js";

/**
 * Proactive Codex (OpenAI ChatGPT-subscription) quota source. Reads the local
 * Codex OAuth credential and GETs the undocumented
 * `chatgpt.com/backend-api/wham/usage` endpoint — a free standalone probe the
 * Codex CLI itself polls (no completion consumed). Two windows: `primary_window`
 * (5h rolling) + `secondary_window` (weekly). Verified against `openai/codex`
 * Rust source. Cross-cutting cache/guard/degrade live in {@link BaseHttpQuotaSource}.
 */

const CODEX_PROVIDER_NAMES = new Set(["codex"]);
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_USER_AGENT = "codex_cli_rs (external, cli)";

interface CodexWindow {
  used_percent?: number | null;
  reset_at?: number | null; // unix seconds
  reset_after_seconds?: number | null;
  limit_window_seconds?: number | null;
}
interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
}
interface CodexCredentials {
  tokens?: { access_token?: string; account_id?: string };
}

export interface CodexQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Defaults to `~/.codex/auth.json`. */
  credentialsPath?: string;
  /** Override the provider-name gate (mainly for tests). */
  codexProviderNames?: Iterable<string>;
}

export class CodexQuotaSource extends BaseHttpQuotaSource {
  readonly name = "codex";
  private readonly credentialsPath: string;
  private readonly usingDefaultCredentialsPath: boolean;
  private readonly providerNames: Set<string>;

  constructor(options: CodexQuotaSourceOptions = {}) {
    super(options, DEFAULT_USER_AGENT);
    this.usingDefaultCredentialsPath = options.credentialsPath === undefined;
    this.credentialsPath = options.credentialsPath ?? path.join(homedir(), ".codex", "auth.json");
    this.providerNames = new Set(options.codexProviderNames ?? CODEX_PROVIDER_NAMES);
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  protected async fetchSnapshot(): Promise<QuotaUsageSnapshot | null> {
    const creds = this.readCredentials();
    if (!creds) return null;
    return fetchCodexUsage(creds, this.fetchContext());
  }

  /** Account id = the ChatGPT `account_id` from `~/.codex/auth.json`. */
  protected readAccountId(_provider: string): string | null {
    if (this.shouldSkipCredentialRead(this.usingDefaultCredentialsPath)) return null;
    return this.readCredentials()?.accountId ?? null;
  }

  /** Reads `{ access_token, account_id }` from `~/.codex/auth.json`, or null. */
  private readCredentials(): { accessToken: string; accountId: string } | null {
    let parsed: CodexCredentials;
    try {
      parsed = JSON.parse(readFileSync(this.credentialsPath, "utf8")) as CodexCredentials;
    } catch {
      return null; // missing / unparseable → degrade
    }
    const t = parsed.tokens;
    if (!t?.access_token || !t.account_id) return null;
    return { accessToken: t.access_token, accountId: t.account_id };
  }
}

/**
 * Reusable Codex `wham/usage` probe (no creds-file read, no guard) — used by the
 * source above and by the OpenCode broker with OpenCode's stored openai token.
 * Expiry isn't pre-checked: an expired token yields a non-200 → degrade.
 */
export async function fetchCodexUsage(
  creds: { accessToken: string; accountId: string },
  ctx: UsageFetchContext,
): Promise<QuotaUsageSnapshot | null> {
  const body = await fetchJsonOrNull(ctx.fetchImpl, USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "ChatGPT-Account-Id": creds.accountId,
      originator: "codex_cli_rs",
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
    },
  });
  if (body == null) return null;
  return mapCodexUsage(body as CodexUsageResponse, ctx.now());
}

/**
 * Maps a `wham/usage` payload to the most-constraining window. `remaining_pct` is
 * a 0–1 fraction; `reset_at` is the absolute reset (unix seconds → ISO).
 */
export function mapCodexUsage(body: CodexUsageResponse, nowMs: number): QuotaUsageSnapshot | null {
  if (body == null || typeof body !== "object") return null;
  const rl = body.rate_limit;
  const windows = [rl?.primary_window, rl?.secondary_window].filter(
    (w): w is CodexWindow => !!w && typeof w.used_percent === "number",
  );
  if (windows.length === 0) return null;
  const binding = windows.reduce((a, b) => (b.used_percent! > a.used_percent! ? b : a));
  return {
    remaining_pct: remainingFromUsedPercent(binding.used_percent as number),
    reset_at: codexResetAt(binding, nowMs),
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(nowMs).toISOString(),
    source: "codex",
  };
}

function codexResetAt(w: CodexWindow, nowMs: number): string | null {
  if (typeof w.reset_at === "number") return new Date(w.reset_at * 1000).toISOString();
  if (typeof w.reset_after_seconds === "number") {
    return new Date(nowMs + w.reset_after_seconds * 1000).toISOString();
  }
  return null;
}
