import type { Finding } from "../types.js";
import type {
  CharterSubsystem,
  CharterDelta,
  ChannelDisagreement,
  GoalGraph,
  Ceiling,
  TriangulatedTelos,
} from "audit-tools/shared";

/**
 * The stamped register schema version. v2 = design resolution 4 (2026-08-05):
 * channel-pure estimator kinds (stated/structural/revealed; `inferred` renamed),
 * per-kind teleologies with file scopes on each subsystem, the miner's
 * `triangulated` teloses + tool-computed `disagreement` density. Read policy is
 * DISCARD (regenerable analysis state): a v1/unstamped register read under v2
 * semantics would silently misroute every persisted `inferred` value, and the
 * content-keyed staleness DAG cannot see a code-taxonomy change — so a stale
 * register degrades to absent and the extraction obligation rebuilds it.
 */
export const CHARTER_REGISTER_SCHEMA_VERSION = "charter-register/v2";

/**
 * The `charter_register.json` artifact — the charter LAYER of the conceptual
 * design-review (Phase C), the teleological counterpart to Phase B's
 * `structure_decomposition.json`. Where the structure layer answers "what are the
 * pieces," this answers "what are the pieces FOR": per joined subsystem unit, the
 * channel-pure estimator charters (Stated/Structural/Revealed, each fed only its
 * own evidence channel) held un-reconciled with their self-organized teleologies,
 * mined by the independent delta pass for channel-pair deltas, each delta routed
 * to who acts on it and gated by the Phase-A hard gates. The miner additionally
 * emits a TRIANGULATED TELOS per subsystem — a unified opinion the owner reacts
 * to (a lead; the deltas stay the primary product) — and the tool computes the
 * per-channel-pair `disagreement` density that says where the triangulation most
 * needs clarification. The surviving deltas are surfaced as `findings` (leads)
 * into synthesis. It is an OUTPUT artifact (the `intent_checkpoint` carries the
 * ceiling as INPUT) — keeping the charters here rather than back on the
 * checkpoint avoids a staleness cycle with the checkpoint it depends on.
 */
export interface CharterRegister {
  schema_version: typeof CHARTER_REGISTER_SCHEMA_VERSION;
  generated_at: string;
  /** The decomposition target — `"charter"` at this layer. */
  target: "charter";
  /**
   * The ceiling authorized at `intent_checkpoint` — how far up the premise stack
   * this run's charters may reach. Echoed so the register is self-describing about
   * what depth produced it. `deepest` additionally authorizes the miner's True
   * nominations (the consent gate that used to live on the extraction lane set).
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
   * delta pass clears it once the deltas + triangulation are mined (or when there
   * are no subsystems to mine, in which case it is never set).
   */
  deltas_pending?: boolean;
  /**
   * Per joined subsystem unit: its file members, the tool-selected per-kind
   * charters, and every lane's full teleology slice (levels + file scopes).
   */
  subsystems: CharterSubsystem[];
  /** The goal DAG (blast-radius substrate). Empty until the miner supplies one. */
  goal_graph: GoalGraph;
  /** The routed + gated channel-pair deltas across all subsystems. */
  deltas: CharterDelta[];
  /** The deltas surfaced as Finding leads for synthesis. */
  findings: Finding[];
  /**
   * The miner's per-subsystem triangulated teloses — unified opinions the owner
   * reacts to. LEADS, never reconciliations: no consumer may key on these in
   * place of the charters/deltas.
   */
  triangulated: TriangulatedTelos[];
  /**
   * Tool-computed deltas-per-channel-pair density per subsystem — the
   * quantitative "which parts of the triangulation need clarification" surface.
   */
  disagreement: ChannelDisagreement[];
  /** Gate drops (un-falsifiable True, ungrounded scopes, …) — surfaced, not hidden. */
  validation_issues: string[];
}
