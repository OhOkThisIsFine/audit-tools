import { z } from "zod";
import type { QuotaProbeStatus, QuotaSource } from "./quotaSource.js";

/**
 * Whether audit-tools has PROACTIVE quota tracking wired for a host provider —
 * the explicit signal that replaces silently falling back to reactive 429 in an
 * as-yet-unsupported environment (docs/quota-dispatch-design.md §4):
 *
 *  - `established`   — a proactive QuotaSource in code covers this provider. The
 *                      live-vs-missing-creds split is the orthogonal
 *                      `quota_signal_degraded` flag.
 *  - `reactive_only` — this provider has NO proactive surface BY NATURE (a static
 *                      API key / local model: NIM, vLLM, local-subprocess). Not a
 *                      gap — reactive 429 is the correct and only signal.
 *  - `unestablished` — NO source in code covers this provider. The environment is
 *                      not yet supported; the host agent is nudged to self-track or
 *                      research a source rather than degrading blind.
 */
export const QuotaCoverageStatusSchema = z.enum([
  "established",
  "reactive_only",
  "unestablished",
]);
export type QuotaCoverageStatus = z.infer<typeof QuotaCoverageStatusSchema>;

/**
 * Providers with no proactive quota endpoint by nature — a static API key or a
 * local model. Their absence from the proactive set is intentional, NOT a missing
 * integration, so they classify as `reactive_only` (no nudge). Reactive 429 /
 * local-unbounded is the right model. Keyed by the resolved provider segment of a
 * pool key.
 */
export const REACTIVE_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "nvidia-nim",
  "nvidia-nim-local",
  "local-subprocess",
  "ollama",
]);

/**
 * Classify a host provider's proactive-quota coverage. `covered` is the pure,
 * no-credential capability check ({@link QuotaSource.coversProvider}); `probeStatus`
 * is unused for the coverage axis (it drives the orthogonal degraded flag) and kept
 * for call-site clarity.
 */
export function classifyQuotaCoverage(
  provider: string,
  covered: boolean,
): QuotaCoverageStatus {
  if (covered) return "established";
  if (REACTIVE_ONLY_PROVIDERS.has(provider)) return "reactive_only";
  return "unestablished";
}

/** True when the source advertises proactive coverage for `provider` (no creds read). */
export function sourceCoversProvider(source: QuotaSource, provider: string): boolean {
  return source.coversProvider?.(provider) ?? false;
}

/**
 * The host-facing nudge emitted ONCE per unsupported environment (then a terse
 * status). Two paths, conversation-first: self-report if the host has built-in
 * access to its own usage, else OFFER to research an established source and act
 * only on user consent — the progressive-coverage flywheel (the found endpoint /
 * third-party tool becomes a new QuotaSource).
 */
export function renderUnestablishedQuotaNudge(provider: string): string {
  return [
    `⚠️ Quota tracking is NOT established for host provider \`${provider}\`.`,
    `audit-tools has no proactive quota source wired for it, so dispatch would fall`,
    `back to reactive rate-limit (429) handling only — pacing blind until a wall is hit.`,
    ``,
    `To establish proactive quota tracking for \`${provider}\`:`,
    `  1. If you (the host agent) have BUILT-IN access to your own remaining usage/`,
    `     quota, report it now so the run can pace from it, and note the access method`,
    `     so it can be wired in as a QuotaSource.`,
    `  2. Otherwise, OFFER to the user: search online for \`${provider}\`'s quota/usage`,
    `     endpoint, or a third-party tool that already tracks it, then — with their`,
    `     consent — report the findings (endpoint, auth/credential location, response`,
    `     shape) so a proactive source can be added (see`,
    `     docs/cross-provider-quota-matrix.md for the established recipes).`,
  ].join("\n");
}
