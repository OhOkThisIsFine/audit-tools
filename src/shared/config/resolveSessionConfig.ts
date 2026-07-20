import type { AuditorDescriptor } from "../types/auditorDescriptor.js";
import {
  DISPATCHABLE_TRANSPORTS,
  type DispatchableSource,
  type RepoSessionIntent,
  type SessionConfig,
} from "../types/sessionConfig.js";
import { sourceProviderConfig } from "../quota/apiPool.js";
import {
  type AmbientSourceDeps,
  type DroppedSource,
  resolveAmbientSources,
} from "../providers/auditorSources.js";

/**
 * The ambient probes the G2.5 source resolution reads. Production passes nothing —
 * every probe defaults to the real environment (`process.env`, real PATH, real home
 * dir), which is the point: the reach check must read the SAME env the provider reads
 * at launch. Tests inject. `onDroppedSources` overrides the default stderr report
 * for declared-but-unresolved lanes (the reasons must be loud at every draw).
 */
export type ResolveSessionConfigOptions = AmbientSourceDeps & {
  onDroppedSources?: (dropped: DroppedSource[]) => void;
};

const DISPATCHABLE_TRANSPORT_SET: ReadonlySet<string> = new Set(
  DISPATCHABLE_TRANSPORTS,
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
 *   Ambient resolution deliberately does NOT apply here — `null` means "resolve NO
 *   pool", which is a stronger statement than "no handshake happened".
 *
 *   ⚠ A caller that HAS no handshake but DOES have an environment wants
 *   {@link ambientAuditorDescriptor}, NOT `null`. Passing `null` there is a silent
 *   capability loss: it short-circuits before {@link resolveAmbientSources}, so a
 *   declared + reachable lane never becomes a pool. Remediate did exactly that at all
 *   three of its dispatch sites and consequently could not dispatch to any non-self
 *   pool; it now routes through `loadRemediateSessionConfig`, which always supplies the
 *   ambient descriptor.
 * - `descriptor` present → the driver's `self.provider` becomes the effective
 *   provider + conversation-host attribution key; its own host/IDE launch blocks
 *   (`claude_code` / `vscode_task` / `antigravity`) overlay; and `sources[]` becomes
 *   the effective dispatch pool. When the DRIVER itself is a dispatchable-source
 *   backend (headless single-lane), its flat per-backend block is reconstructed from
 *   the matching source so `createFreshSessionProvider` can build the primary
 *   provider — the pool machinery reads `effective.sources` directly (dedup by
 *   source id), so there is no double-count.
 *
 * **Where `sources[]` comes from (G2.5).** The cut is WHO LAUNCHES: `self` is what only
 * the host can know (can-dispatch-subagents, can_proxy, roster, ceilings) and is
 * irreducibly handshake-reported; `sources[]` are the six backends THIS PROCESS spawns
 * (CLI subprocess or HTTP POST), so they are resolved in-process by
 * `resolveAmbientSources` — `declared ∩ ambient-verifiable` over the operator's
 * machine-level declaration — and never routed through the host. An explicit
 * `descriptor.sources` still wins (the operator's escape hatch).
 *
 *   Deliberate deviation from `spec/unified-dispatch-worker-model.md`'s G2.5 sketch (a
 *   pre-`next-step` shell-out printing `sources[]` for the host to merge): that merge is
 *   an LLM hand-composing JSON — the host-discretion anti-pattern the commit exists to
 *   kill, whose failure mode is a silently-empty pool indistinguishable from an
 *   unreachable machine. The spec's shell-out conflated POPULATE (expensive, network-
 *   bound, cacheable) with RESOLVE (local, cheap, must run at the moment of use).
 *   G2.5 builds RESOLVE; POPULATE lands later behind this same seam.
 *
 * Every INTENT field (synthesis / analyzers / graph / quota / block_quota /
 * design_review / dispatch fan-out knobs / …) is preserved identically. Never mutates
 * its inputs.
 *
 * NOT pure since G2.5: when a descriptor omits `sources`, this READS the ambient
 * environment (the declaration file, env vars, PATH). That is deliberate and is the
 * whole point — resolving anywhere else would let the reach check and the launch read
 * different environments. It stays cheap (one small JSON read, and only on the
 * descriptor-present path; `descriptor == null` short-circuits before it) and every
 * probe is injectable via {@link ResolveSessionConfigOptions} for tests.
 */
export function resolveSessionConfig(
  intent: RepoSessionIntent,
  descriptor: AuditorDescriptor | null | undefined,
  options?: ResolveSessionConfigOptions,
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
  // `declared ∩ ambient-verifiable`, resolved IN-PROCESS (G2.5). An explicit
  // hand-authored `--auditor sources[]` still wins — it is the operator's escape
  // hatch and the only way to force a lane this process cannot prove.
  let sources: DispatchableSource[];
  if (descriptor.sources) {
    sources = descriptor.sources;
  } else {
    const ambient = resolveAmbientSources(options);
    // A dropped lane must be LOUD at every draw — the reasons existed since G2.5
    // but were discarded here, so a declared-but-unresolvable lane was silently
    // absent (the [[silent-fail-closed-on-one-draw]] class). Default = stderr;
    // callers with a better channel inject `onDroppedSources`.
    if (ambient.dropped.length > 0) {
      const report =
        options?.onDroppedSources ??
        ((dropped: DroppedSource[]) => {
          for (const d of dropped) {
            process.stderr.write(
              `[audit-tools] declared source "${d.id}" not resolved: ${d.reason}\n`,
            );
          }
        });
      report(ambient.dropped);
    }
    sources = ambient.sources;
  }
  if (sources.length > 0) {
    effective.sources = sources;
    if (self.provider && DISPATCHABLE_TRANSPORT_SET.has(self.provider)) {
      // The FIRST source matching the driver's provider supplies its flat block. With
      // multiple same-provider sources (e.g. two NIM endpoints), the operator orders
      // `sources[]` so the driver's own endpoint is first; the non-primary ones still
      // become their own pools via `effective.sources`.
      const primary = sources.find((s) => s.transport === self.provider);
      if (primary) Object.assign(effective, sourceProviderConfig(primary));
    }
  }
  return effective;
}
