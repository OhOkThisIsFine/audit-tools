import { spawnSync } from "node:child_process";
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
 * Antigravity (Google's agentic IDE) quota source. POSTs the internal
 * `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` endpoint →
 * per-model `quotaInfo.{remainingFraction, resetTime}`, binding on the
 * least-remaining model.
 *
 * This is the LOWEST-confidence source (MED): the endpoint is internal, and
 * Antigravity's Google token lives in an SQLite `state.vscdb` (no clean cred
 * file). Token sourcing is therefore degrade-heavy and opt-in: an explicit
 * `ANTIGRAVITY_ACCESS_TOKEN` env, or an injected `readAccessToken` hook (e.g. the
 * local Antigravity Language Server — the lower-ToS-risk route), or a best-effort
 * `sqlite3` CLI read of `state.vscdb`. Absent all three → null (degrade to
 * reactive). NOTE: Google discourages reverse-proxy use of its AI services;
 * prefer the LS hook over replaying the cloud endpoint with a scraped token.
 */

const ANTIGRAVITY_PROVIDER_NAMES = new Set(["antigravity"]);
const USAGE_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const DEFAULT_USER_AGENT = "antigravity";

interface AntigravityModel {
  quotaInfo?: { remainingFraction?: number | null; resetTime?: string | null } | null;
}
interface AntigravityResponse {
  models?: AntigravityModel[] | null;
  userTier?: { name?: string } | null;
}

export interface AntigravityQuotaSourceOptions extends HttpQuotaSourceOptions {
  /** Resolve the Google access token (overrides the default env/sqlite chain). */
  readAccessToken?: () => string | null;
  /** Antigravity `state.vscdb` path (defaults to the Windows globalStorage location). */
  stateDbPath?: string;
  /** Optional Google project id for the request body. */
  project?: string;
  /** Injectable env (mainly for tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the provider-name gate (mainly for tests). */
  antigravityProviderNames?: Iterable<string>;
}

export class AntigravityQuotaSource extends BaseHttpQuotaSource {
  readonly name = "antigravity";
  private readonly readToken: () => string | null;
  private readonly project?: string;
  private readonly providerNames: Set<string>;

  constructor(options: AntigravityQuotaSourceOptions = {}) {
    super(options, DEFAULT_USER_AGENT);
    const env = options.env ?? process.env;
    const stateDbPath =
      options.stateDbPath ??
      path.join(
        env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    this.readToken = options.readAccessToken ?? (() => readAntigravityToken(env, stateDbPath));
    this.project = options.project ?? env.ANTIGRAVITY_PROJECT;
    this.providerNames = new Set(options.antigravityProviderNames ?? ANTIGRAVITY_PROVIDER_NAMES);
  }

  protected handlesProvider(provider: string): boolean {
    return this.providerNames.has(provider);
  }

  protected async fetchSnapshot(): Promise<QuotaUsageSnapshot | null> {
    const accessToken = this.readToken();
    if (!accessToken) return null;
    return fetchAntigravityUsage({ accessToken, project: this.project }, this.fetchContext());
  }
}

/** Reusable Antigravity usage probe (no token read, no guard). */
export async function fetchAntigravityUsage(
  creds: { accessToken: string; project?: string },
  ctx: UsageFetchContext,
): Promise<QuotaUsageSnapshot | null> {
  const body = await fetchJsonOrNull(ctx.fetchImpl, USAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "User-Agent": ctx.userAgent,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(creds.project ? { project: creds.project } : {}),
  });
  if (body == null) return null;
  return mapAntigravityUsage(body as AntigravityResponse, ctx.now());
}

/** Maps `fetchAvailableModels` → least-remaining model's fraction + its reset. */
export function mapAntigravityUsage(
  body: AntigravityResponse,
  nowMs: number,
): QuotaUsageSnapshot | null {
  if (body == null || typeof body !== "object") return null;
  const infos = (body.models ?? [])
    .map((m) => m.quotaInfo)
    .filter((q): q is { remainingFraction: number; resetTime?: string | null } =>
      !!q && typeof q.remainingFraction === "number",
    );
  if (infos.length === 0) return null;
  const binding = infos.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
  return {
    remaining_pct: clampFraction(binding.remainingFraction),
    reset_at: normalizeIso(binding.resetTime),
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(nowMs).toISOString(),
    source: "antigravity",
  };
}

/** Best-effort token read: env → `sqlite3` CLI on `state.vscdb` (`antigravityAuthStatus`). */
function readAntigravityToken(env: NodeJS.ProcessEnv, stateDbPath: string): string | null {
  if (env.ANTIGRAVITY_ACCESS_TOKEN) return env.ANTIGRAVITY_ACCESS_TOKEN;
  try {
    const r = spawnSync(
      "sqlite3",
      [stateDbPath, "SELECT value FROM ItemTable WHERE key='antigravityAuthStatus'"],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const apiKey = (JSON.parse(r.stdout.trim()) as { apiKey?: string }).apiKey;
    return apiKey ?? null;
  } catch {
    return null; // sqlite3 absent / parse failure → degrade
  }
}

function normalizeIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
