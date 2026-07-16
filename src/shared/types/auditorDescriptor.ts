import type { HostModelRosterEntry } from "../quota/scheduler.js";
import type { HostDispatchInventory } from "./sessionConfig.js";

/**
 * The host-emitted scalars describing the auditor DRIVING this run — the
 * dispatch-capability handshake for the current driver's own model/context. All
 * optional: a field is present only when the host declared it this invocation.
 * (G1: collapsed from the former `--host-*` flag bag onto `descriptor.self`.)
 */
export interface AuditorSelf {
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
  /** Tristate: host can dispatch subagents (was `--host-can-dispatch-subagents`). */
  can_dispatch_subagents?: boolean;
  /** Host can restrict subagent tools (was `--host-can-restrict-subagent-tools`). */
  can_restrict_subagent_tools?: boolean;
  /** Host can select subagent model (was `--host-can-select-subagent-model`). */
  can_select_subagent_model?: boolean;
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
  /** The host-emitted scalars for the driving auditor's own model. */
  self: AuditorSelf;
  /**
   * The per-auditor dispatch inventory (backends/launch blocks/sources) — resolved
   * from the auditor's environment, never the repo session-config
   * ([[capability-is-per-auditor-not-per-audit]]). `null` and `{}` are OPPOSITE
   * semantics under `applyDispatchInventory` (null ⇒ deprecated repo-config
   * fallback; `{}` ⇒ authoritatively-empty inventory = host-only), so absence is
   * carried as `null`, never collapsed to `{}`. Resliced to `sources` in G2.
   */
  inventory?: HostDispatchInventory | null;
}
