import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  BaseHttpQuotaSource,
  fetchJsonOrNull,
  clampFraction,
  type HttpQuotaSourceOptions,
  type UsageFetchContext,
} from "./httpQuotaSource.js";

/**
 * Proactive GitHub Copilot quota source (the LLM backend behind VS Code). GETs
 * the undocumented `api.github.com/copilot_internal/user` snapshot — including the
 * new premium-requests quota — with a `gho_/ghu_` GitHub OAuth token.
 *
 * Token sourcing on Windows is the hard part: VS Code stores the GitHub token in
 * DPAPI-encrypted SecretStorage (`state.vscdb`), NOT a readable file. So this
 * source extracts a `gho_/ghu_` token from the **CLI** credential stores instead
 * (Copilot CLI `~/.copilot/config.json`, then `gh` CLI `~/.config/gh/hosts.yml`),
 * or an explicit `GH_COPILOT_TOKEN`/`GH_TOKEN` env. When none is available it
 * degrades to null (the scheduler falls back to reactive 429 handling) — the
 * conservative, never-confidently-wrong default.
 */

const COPILOT_PROVIDER_NAMES = new Set(["copilot", "github-copilot"]);
const USAGE_ENDPOINT = "https://api.github.com/copilot_internal/user";
const DEFAULT_USER_AGENT = "GithubCopilot (external, cli)";
const GH_TOKEN_RE = /\bgh[ou]_[A-Za-z0-9_]{20,}\b/;

interface CopilotQuotaDetail {
  entitlement?: number | null;
  remaining?: number | null;
  percent_remaining?: number | null;
  unlimited?: boolean | null;
}
interface CopilotUsageResponse {
  quota_reset_date?: string | null;
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaDetail | null;
    chat?: CopilotQuotaDetail | null;
  } | null;
}

export interface CopilotQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Copilot CLI config (defaults to `$COPILOT_HOME`/`~/.copilot/config.json`). */
  copilotConfigPath?: string;
  /** `gh` CLI hosts file (defaults to `~/.config/gh/hosts.yml`). */
  ghHostsPath?: string;
  /** Injectable env (mainly for tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the provider-name gate (mainly for tests). */
  copilotProviderNames?: Iterable<string>;
}

export class CopilotQuotaSource extends BaseHttpQuotaSource {
  readonly name = "copilot";
  private readonly copilotConfigPath: string;
  private readonly ghHostsPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly providerNames: Set<string>;

  constructor(options: CopilotQuotaSourceOptions = {}) {
    super(options, DEFAULT_USER_AGENT);
    this.env = options.env ?? process.env;
    const copilotHome = this.env.COPILOT_HOME ?? path.join(homedir(), ".copilot");
    this.copilotConfigPath = options.copilotConfigPath ?? path.join(copilotHome, "config.json");
    this.ghHostsPath =
      options.ghHostsPath ?? path.join(homedir(), ".config", "gh", "hosts.yml");
    this.providerNames = new Set(options.copilotProviderNames ?? COPILOT_PROVIDER_NAMES);
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  protected async fetchSnapshot(): Promise<QuotaUsageSnapshot | null> {
    const token = this.readGitHubToken();
    if (!token) return null;
    return fetchCopilotUsage({ token }, this.fetchContext());
  }

  /** Extracts a `gho_/ghu_` token from env / Copilot CLI / gh CLI, or null. */
  private readGitHubToken(): string | null {
    for (const v of [this.env.GH_COPILOT_TOKEN, this.env.GITHUB_COPILOT_TOKEN, this.env.GH_TOKEN]) {
      if (v && GH_TOKEN_RE.test(v)) return v.match(GH_TOKEN_RE)![0];
    }
    for (const p of [this.copilotConfigPath, this.ghHostsPath]) {
      try {
        const m = readFileSync(p, "utf8").match(GH_TOKEN_RE);
        if (m) return m[0];
      } catch {
        // next candidate
      }
    }
    return null;
  }
}

/**
 * Reusable Copilot usage probe (no token-file read, no guard) — used by the source
 * above and by the OpenCode broker with OpenCode's stored github-copilot token.
 */
export async function fetchCopilotUsage(
  creds: { token: string },
  ctx: UsageFetchContext,
): Promise<QuotaUsageSnapshot | null> {
  const body = await fetchJsonOrNull(ctx.fetchImpl, USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Editor-Version": "audit-tools/1",
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
    },
  });
  if (body == null) return null;
  return mapCopilotUsage(body as CopilotUsageResponse, ctx.now());
}

/** Maps a `copilot_internal/user` snapshot (premium-requests preferred) → 0–1 remaining + reset. */
export function mapCopilotUsage(
  body: CopilotUsageResponse,
  nowMs: number,
): QuotaUsageSnapshot | null {
  const q = body.quota_snapshots?.premium_interactions ?? body.quota_snapshots?.chat;
  if (!q) return null;
  let remaining: number;
  if (q.unlimited) {
    remaining = 1;
  } else if (typeof q.percent_remaining === "number") {
    remaining = clampFraction(q.percent_remaining / 100);
  } else if (typeof q.entitlement === "number" && q.entitlement > 0 && typeof q.remaining === "number") {
    remaining = clampFraction(q.remaining / q.entitlement);
  } else {
    return null;
  }
  return {
    remaining_pct: remaining,
    reset_at: normalizeReset(body.quota_reset_date),
    requests_remaining: typeof q.remaining === "number" ? q.remaining : null,
    tokens_remaining: null,
    captured_at: new Date(nowMs).toISOString(),
    source: "copilot",
  };
}

function normalizeReset(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
