import { readFileSync } from "node:fs";

/**
 * Render the per-dispatch-target TOKEN BUDGET VIEW for the orchestrating host, from
 * a written `dispatch-quota.json`. This surfaces the real constraints the host
 * driver dispatches against — per pool: the remaining quota %, the remaining token
 * budget the gate spent against (MIN across that pool's own windows), the tokens
 * already in flight, the reset horizon, and which cap bound the wave — plus the
 * total upcoming (pending) token load. Concurrency is governed ONLY by the
 * provider/IDE subagent allowance and this token budget; the view makes both
 * legible instead of an opaque slot count.
 *
 * Shared so both orchestrators surface the IDENTICAL block (no drift). Reads the
 * contract's `capacity_pools[]` defensively; returns "" when the file is
 * absent/unreadable or no pool carries any quota/budget signal (a quota-disabled
 * or no-snapshot run adds nothing to the prompt).
 */
export function renderTokenBudgetView(quotaPath: string | null | undefined): string {
  if (!quotaPath) return "";
  let pools: PoolView[];
  let upcomingTokens: number | null;
  try {
    const data = JSON.parse(readFileSync(quotaPath, "utf8")) as {
      capacity_pools?: unknown;
      estimated_wave_tokens?: unknown;
    };
    pools = Array.isArray(data?.capacity_pools) ? (data.capacity_pools as PoolView[]) : [];
    upcomingTokens =
      typeof data?.estimated_wave_tokens === "number" ? data.estimated_wave_tokens : null;
  } catch {
    return "";
  }
  // Only render when at least one pool carries a live snapshot or a derived budget
  // — otherwise there is no token-budget signal worth showing.
  const rows = pools.filter(
    (p) =>
      p?.quota_source_snapshot != null ||
      (typeof p?.remaining_token_budget === "number" && p.remaining_token_budget != null),
  );
  if (rows.length === 0) return "";

  const lines: string[] = [];
  lines.push("### Dispatch token budget (per target)");
  lines.push(
    "Concurrency is governed by your provider/IDE subagent allowance and the token " +
      "budget below — dispatch within these, not a fixed slot count. A pool's budget is " +
      "the MIN across its own quota windows; when a budget is unknown (cold start) the " +
      "tool admits a small calibration batch to learn it.",
  );
  lines.push("");
  lines.push("| Target | Slots | Remaining | Budget (tok) | In-flight (tok) | Resets | Bound by |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of rows) {
    const snap = p.quota_source_snapshot ?? null;
    const remainingPct =
      snap && typeof snap.remaining_pct === "number"
        ? `${Math.round(snap.remaining_pct * 100)}%`
        : "—";
    const budget =
      typeof p.remaining_token_budget === "number" && p.remaining_token_budget != null
        ? Math.round(p.remaining_token_budget).toLocaleString("en-US")
        : "cold-start";
    const inFlight =
      typeof p.in_flight_tokens === "number"
        ? Math.round(p.in_flight_tokens).toLocaleString("en-US")
        : "0";
    const reset = snap?.reset_at ?? "—";
    lines.push(
      `| \`${String(p.pool_id ?? "?")}\` | ${p.slots ?? "?"} | ${remainingPct} | ${budget} | ` +
        `${inFlight} | ${reset} | ${p.binding_cap ?? "none"} |`,
    );
    // Per-window breakdown when the provider exposes multiple windows that scale
    // differently (e.g. a 5-hour session vs a 7-day weekly window).
    const windows = Array.isArray(snap?.windows) ? snap!.windows : [];
    if (windows.length > 1) {
      const parts = windows
        .filter((w) => w && typeof w.remaining_pct === "number")
        .map((w) => `${w.label}: ${Math.round((w.remaining_pct as number) * 100)}%`);
      if (parts.length > 0) lines.push(`| ↳ windows | | ${parts.join(", ")} | | | | |`);
    }
  }
  if (upcomingTokens != null) {
    lines.push("");
    lines.push(
      `Upcoming (this wave) estimated input load: **~${Math.round(upcomingTokens).toLocaleString("en-US")} tok**.`,
    );
  }
  return lines.join("\n");
}

interface PoolView {
  pool_id?: unknown;
  slots?: number;
  binding_cap?: string;
  remaining_token_budget?: number | null;
  in_flight_tokens?: number;
  quota_source_snapshot?: {
    remaining_pct?: number | null;
    reset_at?: string | null;
    windows?: Array<{ label?: string; remaining_pct?: number | null }>;
  } | null;
}
