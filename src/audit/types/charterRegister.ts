import type { Finding } from "../types.js";
import type {
  CharterSubsystem,
  CharterDelta,
  GoalGraph,
  Ceiling,
} from "audit-tools/shared";

/**
 * The `charter_register.json` artifact — the charter LAYER of the conceptual
 * design-review (Phase C), the teleological counterpart to Phase B's
 * `structure_decomposition.json`. Where the structure layer answers "what are the
 * pieces," this answers "what are the pieces FOR": per confident subsystem, the
 * four charter families (Stated/Inferred/Revealed/True) held un-reconciled and
 * mined for their pairwise deltas, each delta routed to who acts on it and gated
 * by the Phase-A hard gates. The surviving deltas are surfaced as `findings`
 * (leads) into synthesis. It is an OUTPUT artifact (the `intent_checkpoint` carries
 * the ceiling/seed as INPUT) — keeping the charters here rather than back on the
 * checkpoint avoids a staleness cycle with the checkpoint it depends on.
 */
export interface CharterRegister {
  generated_at: string;
  /** The decomposition target — `"charter"` at this layer. */
  target: "charter";
  /**
   * The ceiling authorized at `intent_checkpoint` — how far up the premise stack
   * this run's charters may reach. Echoed so the register is self-describing about
   * what depth produced it.
   */
  ceiling: Ceiling;
  /**
   * `"omitted"` when the ceiling was `shallow` (no charter layer requested) — the
   * register is written empty so the obligation is satisfied without an LLM pass
   * (conversation-first: the charter layer is opt-in at a `deep`+ ceiling).
   */
  status?: "omitted";
  /**
   * true after charters are assembled but before the independent delta-miner has
   * run; drives charter_delta_current. The charter-extraction pass sets this when
   * it produces ≥1 subsystem so the independent delta phase is owed a turn; the
   * delta pass clears it once the deltas + goal_graph are mined (or when there are
   * no subsystems to mine, in which case it is never set).
   */
  deltas_pending?: boolean;
  /** Per confident subsystem: its members + the surviving (gated) charters. */
  subsystems: CharterSubsystem[];
  /** The goal DAG (blast-radius substrate). Empty until the host supplies one. */
  goal_graph: GoalGraph;
  /** The routed + gated pairwise charter deltas across all subsystems. */
  deltas: CharterDelta[];
  /** The deltas surfaced as Finding leads for synthesis. */
  findings: Finding[];
  /** Gate drops (un-falsifiable True, invented subsystems, …) — surfaced, not hidden. */
  validation_issues: string[];
}
