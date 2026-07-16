import type { AuditorDescriptor } from "../types/auditorDescriptor.js";
import {
  DISPATCHABLE_SOURCE_PROVIDERS,
  type RepoSessionIntent,
  type SessionConfig,
} from "../types/sessionConfig.js";
import { sourceProviderConfig } from "../quota/apiPool.js";

const DISPATCHABLE_PROVIDER_SET: ReadonlySet<string> = new Set(
  DISPATCHABLE_SOURCE_PROVIDERS,
);

/**
 * Produce the in-memory EFFECTIVE {@link SessionConfig} every dispatch/provider
 * consumer reads, from the persisted {@link RepoSessionIntent} (audit intent +
 * policy, NO dispatch inventory) overlaid with the per-invocation
 * {@link AuditorDescriptor} (the driver's identity + own launch transport +
 * reachable `sources[]`). This is the single seam that replaces the retired
 * `applyDispatchInventory`: the backend/launch set now comes from the per-auditor
 * descriptor, never the repo session-config, and is never inherited across auditors
 * ([[capability-is-per-auditor-not-per-audit]], `spec/unified-dispatch-worker-model.md`, G2).
 *
 * - `descriptor == null` → FAIL CLOSED to driver-self-only: the intent is returned
 *   with no resolved backends. The driver is definitionally reachable and
 *   self-launches; there is NO stored dispatch value to fall back to. This is the
 *   deliberate G2 behavior change from `applyDispatchInventory(cfg, null) ⇒ cfg`.
 * - `descriptor` present → the driver's `self.provider` becomes the effective
 *   provider + conversation-host attribution key; its own host/IDE launch blocks
 *   (`claude_code` / `vscode_task` / `antigravity`) overlay; and `sources[]` becomes
 *   the effective dispatch pool. When the DRIVER itself is a dispatchable-source
 *   backend (headless single-lane), its flat per-backend block is reconstructed from
 *   the matching source so `createFreshSessionProvider` can build the primary
 *   provider — the pool machinery reads `effective.sources` directly (dedup by
 *   source id), so there is no double-count.
 *
 * Every INTENT field (synthesis / analyzers / graph / quota / block_quota /
 * design_review / dispatch fan-out knobs / …) is preserved identically. Pure —
 * never mutates its inputs.
 */
export function resolveSessionConfig(
  intent: RepoSessionIntent,
  descriptor: AuditorDescriptor | null | undefined,
): SessionConfig {
  // The intent carries NO dispatch-inventory fields and no `dispatch.rolling_engine`
  // (RepoDispatchConfig), so the base effective config is the intent verbatim; its
  // narrower `dispatch` is structurally assignable to DispatchConfig.
  const effective: SessionConfig = { ...intent };
  if (descriptor == null) {
    return effective;
  }
  const self = descriptor.self ?? {};
  if (self.provider !== undefined) {
    effective.provider = self.provider;
    effective.host_provider = self.provider;
  }
  if (self.claude_code !== undefined) effective.claude_code = self.claude_code;
  if (self.vscode_task !== undefined) effective.vscode_task = self.vscode_task;
  if (self.antigravity !== undefined) effective.antigravity = self.antigravity;
  if (self.parallel_workers !== undefined) {
    effective.parallel_workers = self.parallel_workers;
  }
  const sources = descriptor.sources ?? [];
  if (sources.length > 0) {
    effective.sources = sources;
    if (self.provider && DISPATCHABLE_PROVIDER_SET.has(self.provider)) {
      // The FIRST source matching the driver's provider supplies its flat block. With
      // multiple same-provider sources (e.g. two NIM endpoints), the operator orders
      // `sources[]` so the driver's own endpoint is first; the non-primary ones still
      // become their own pools via `effective.sources`.
      const primary = sources.find((s) => s.provider === self.provider);
      if (primary) Object.assign(effective, sourceProviderConfig(primary));
    }
  }
  return effective;
}
