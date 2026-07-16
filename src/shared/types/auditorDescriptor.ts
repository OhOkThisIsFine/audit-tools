import type { HostModelRosterEntry } from "../quota/scheduler.js";
import type {
  AntigravityConfig,
  ClaudeCodeConfig,
  DispatchableSource,
  ProviderName,
  VSCodeTaskConfig,
} from "./sessionConfig.js";

/**
 * The host-emitted description of the auditor DRIVING this run — its provider
 * identity, own launch transport, and dispatch-capability handshake for its own
 * model/context. All optional: a field is present only when the host declared it
 * this invocation. (G1: collapsed the former `--host-*` flag bag onto
 * `descriptor.self`. G2: folded the driver's provider identity + its own launch
 * blocks onto `self`, so the descriptor fully describes WHO drives + HOW to launch
 * it, with the reachable dispatch pool on {@link AuditorDescriptor.sources}.)
 */
export interface AuditorSelf {
  /**
   * The driver's provider identity — the conversation-host/quota-attribution key
   * for THIS run (collapsed from the retired inventory's `provider` /
   * `host_provider`, which were the same identity). Absent ⇒ resolve() leaves the
   * effective provider to env auto-detection (`resolveConversationHostProvider`).
   */
  provider?: ProviderName;
  /** Opaque model identity (was `--host-model-id`); a quota-key segment only. */
  model_id?: string;
  /** Ordered model roster, lowest rank first (was `--host-models`). */
  roster?: HostModelRosterEntry[];
  /** Context-window (input) tokens the host reports (was `--host-context-tokens`). */
  context_tokens?: number;
  /** Output-token cap the host reports (was `--host-output-tokens`). */
  output_tokens?: number;
  /** Operator override for in-flight subagent cap (was `--host-max-active-subagents`). */
  max_active_subagents?: number;
  /**
   * The driver's declared parallel-worker concurrency cap (the former
   * `sessionConfig.parallel_workers`) — dispatch capability, so it rides the
   * descriptor, not the repo config. Feeds `resolveHostConcurrencyLimit` /
   * `resolveHostActiveSubagentLimit` via the resolved effective config.
   */
  parallel_workers?: number;
  /** Tristate: host can dispatch subagents (was `--host-can-dispatch-subagents`). */
  can_dispatch_subagents?: boolean;
  /** Host can restrict subagent tools (was `--host-can-restrict-subagent-tools`). */
  can_restrict_subagent_tools?: boolean;
  /** Host can select subagent model (was `--host-can-select-subagent-model`). */
  can_select_subagent_model?: boolean;
  /**
   * The driver's OWN launch transport, for the host/IDE providers that are NOT
   * generic dispatchable sources ({@link DispatchableSource} excludes exactly
   * `claude-code`/`vscode-task`/`antigravity`, which are driven through their
   * host/IDE, not an endpoint+parameters source). The dispatchable backends'
   * launch config rides `sources[]` instead. Present only for a configured
   * non-default host command or IDE-task template; absent ⇒ the driver
   * self-launches with defaults.
   */
  claude_code?: ClaudeCodeConfig;
  vscode_task?: VSCodeTaskConfig;
  antigravity?: AntigravityConfig;
}

/**
 * The current driver's dispatch handshake, carried as ONE `--auditor <json>` flag
 * (G1 replaced the N `--host-*` flags with this single JSON transport). Re-emitted
 * onto every continue-command so the descriptor RIDES the command the driver runs
 * to advance — surviving that driver's own steps without the host re-appending
 * flags each time (auditor-agnostic robustness; the founding capability-inheritance
 * bug was that a bare continue-command dropped the handshake, so a resume fell back
 * to the stored session config). A *different* driver entering through its own
 * loader supplies its own `--auditor`, overriding this descriptor.
 * [[capability-is-per-auditor-not-per-audit]] [[unified-dispatch-worker-model]]
 */
export interface AuditorDescriptor {
  /** Never-inherit auditor id STAMP — wired in G5; optional/unused in G1. */
  auditor_id?: string;
  /** When the descriptor was resolved — wired in G5; optional/unused in G1. */
  resolved_at?: number;
  /** The driving auditor's identity, own launch transport, and model scalars. */
  self: AuditorSelf;
  /**
   * The reachable dispatch pool the CURRENT auditor can spill work onto — the
   * uniform `DispatchableSource[]` (NIM/vLLM endpoints, headless CLIs, subprocess
   * templates), each with its own endpoint/parameters/quota. Resolved from the
   * auditor's OWN environment (the deterministic source-emitter's `declared ∩
   * ambient-verifiable` intersection), never the repo session-config
   * ([[capability-is-per-auditor-not-per-audit]]). Absent/empty ⇒ the driver
   * self-drives with no additional backends. (G2 resliced the retired
   * `inventory` — provider + host/IDE launch blocks moved to {@link self}, the
   * per-backend dispatch blocks folded here as sources.)
   */
  sources?: DispatchableSource[];
}

/**
 * The descriptor for a driver that had NO host handshake — it can report nothing
 * about itself, but it still has an environment.
 *
 * The descriptor's fields split along a verified line, and this helper is that line
 * made explicit:
 * - **ENVIRONMENT-class** (`sources[]`, provider identity, dispatch capability) — the
 *   backends THIS PROCESS can spawn. Resolved in-process; a handshake was never
 *   needed for them (`resolveAmbientSources`: `declared ∩ ambient-verifiable`).
 * - **HOST-SELF-class** (`model_id` / `context_tokens` / `output_tokens` / `roster`) —
 *   "I am model X with an N-token window." Genuinely unknowable to a spawned CLI: the
 *   running agent's model identity is not on PATH, not an env var, not a file. Absent
 *   here, so the host pool sizes to the conservative floor. That is a fidelity
 *   degradation, never a block.
 *
 * ⚠ NOT interchangeable with a `null` descriptor. `resolveSessionConfig(intent, null)`
 * FAILS CLOSED to driver-self-only — "resolve no pool at all" — and short-circuits
 * before ambient resolution. This says "resolve my pool from ambient reach; I just
 * can't tell you about myself." Remediate passing `null` (it has no `--auditor` flag)
 * is what made it dispatch with NO pool — an un-released capability regression vs
 * v0.32.68, where `sources[]` was read straight off disk. Returns a FRESH object per
 * call so no caller can mutate a shared literal.
 * [[capability-is-per-auditor-not-per-audit]]
 */
export function ambientAuditorDescriptor(): AuditorDescriptor {
  return { self: {} };
}
