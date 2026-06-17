import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  BaseHttpQuotaSource,
  type HttpQuotaSourceOptions,
  type UsageFetchContext,
} from "./httpQuotaSource.js";
import { fetchClaudeUsage } from "./claudeOAuthQuotaSource.js";
import { fetchCodexUsage } from "./codexQuotaSource.js";
import { fetchCopilotUsage } from "./copilotQuotaSource.js";

/**
 * OpenCode quota broker. OpenCode has no quota of its own — it is a multi-provider
 * router. So this source resolves the UNDERLYING provider for the dispatched model
 * and delegates to that provider's reusable `fetchXxxUsage` probe, using
 * OpenCode's OWN stored token for it (`~/.local/share/opencode/auth.json`).
 *
 * Routing is data-driven, NOT model-name-based (INV-QD-04): OpenCode model ids are
 * provider-namespaced (`anthropic/…`, `openai/…`, `github-copilot/…`, `google/…`),
 * so the quota key `opencode/<provider>/<model>` carries the underlying provider in
 * its first model segment. An un-namespaced or unknown-provider model → null
 * (degrade). `google` is an API key (no proactive endpoint) → null.
 *
 * Each route sends the underlying provider's first-party-shaped User-Agent (the
 * anthropic usage endpoint in particular rate-limits a generic UA aggressively).
 */

const OPENCODE_PROVIDER_NAMES = new Set(["opencode"]);

// Per-route first-party-shaped User-Agents (match the standalone sources' defaults).
const ROUTE_USER_AGENT: Record<string, string> = {
  anthropic: "claude-cli (external, cli)",
  openai: "codex_cli_rs (external, cli)",
  "github-copilot": "GithubCopilot (external, cli)",
};

interface OpenCodeAuthEntry {
  type?: string;
  access?: string;
  key?: string;
  expires?: number;
  accountId?: string;
}
type OpenCodeAuth = Record<string, OpenCodeAuthEntry | undefined>;

export interface OpenCodeQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Defaults to `~/.local/share/opencode/auth.json`. */
  authPath?: string;
  /** Override the provider-name gate (mainly for tests). */
  openCodeProviderNames?: Iterable<string>;
}

export class OpenCodeQuotaSource extends BaseHttpQuotaSource {
  readonly name = "opencode";
  private readonly authPath: string;
  private readonly providerNames: Set<string>;

  constructor(options: OpenCodeQuotaSourceOptions = {}) {
    super(options, "opencode");
    this.authPath =
      options.authPath ??
      path.join(homedir(), ".local", "share", "opencode", "auth.json");
    this.providerNames = new Set(options.openCodeProviderNames ?? OPENCODE_PROVIDER_NAMES);
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  protected async fetchSnapshot(
    _provider: string,
    model: string | null,
    nowMs: number,
  ): Promise<QuotaUsageSnapshot | null> {
    const under = model ? model.split("/")[0] : null;
    if (!under) return null; // un-namespaced model → can't route → degrade

    const auth = this.readAuth();
    const entry = auth?.[under];
    if (!entry) return null;
    // Pre-check expiry so we don't burn a doomed call (the probes also 401-degrade).
    if (typeof entry.expires === "number" && nowMs >= entry.expires) return null;

    const ctx: UsageFetchContext = {
      fetchImpl: this.fetchImpl,
      now: this.now,
      userAgent: ROUTE_USER_AGENT[under] ?? this.userAgent,
    };
    // The model id after the provider-namespace prefix (used for per-model scoping).
    const subModel = model && model.includes("/") ? model.slice(model.indexOf("/") + 1) : null;

    switch (under) {
      case "anthropic":
        return entry.access ? fetchClaudeUsage({ accessToken: entry.access, model: subModel }, ctx) : null;
      case "openai":
        return entry.access && entry.accountId
          ? fetchCodexUsage({ accessToken: entry.access, accountId: entry.accountId }, ctx)
          : null;
      case "github-copilot":
        return entry.access ? fetchCopilotUsage({ token: entry.access }, ctx) : null;
      default:
        return null; // google (API key, no proactive endpoint) + unknown providers
    }
  }

  private readAuth(): OpenCodeAuth | null {
    try {
      return JSON.parse(readFileSync(this.authPath, "utf8")) as OpenCodeAuth;
    } catch {
      return null; // missing / unparseable → degrade
    }
  }
}
