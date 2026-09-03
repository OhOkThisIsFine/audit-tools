import type { Finding } from "../types.js";
import type {
  CharterPacketCoverage,
  CharterSubsystem,
  ChannelDisagreement,
  CitationValidationSummary,
  GoalGraph,
  Ceiling,
  TriangulatedTelos,
} from "audit-tools/shared";
import type { StampedCharterDelta } from "../../shared/types/charter.js";

/**
 * The stamped register schema version.
 *
 * v4 = the register no longer self-certifies. `validation_issues: []` printed
 * identically at 1-of-15 correct citations and at 75-of-75, because its only two
 * producers were node-file membership and the True-charter gate while the
 * overshoots lived in `provenance[].ref` — a field nothing read. v4 adds
 * `citation_validation` (the affirmation that the check RAN, with a recorded
 * abstention rather than an implicit pass) and `evidence_coverage` (what each
 * blind lane's packet actually delivered, per evidence class). Both are REQUIRED:
 * an optional affirmation is one a writer can forget, which is the same
 * false-green in a new place.
 *
 * v3 = the deltas carry their own identity: every delta is a
 * {@link StampedCharterDelta} with an explicit `node_id` (and `goal_node_id`
 * when linked), so no consumer recovers a subsystem by parsing `delta_id`. A v2
 * register predates the stamping, and its deltas would every one of them be
 * refused by the clarification join — a silent collapse to zero questions where
 * v2 semantics joined them all. The version key is what makes that impossible:
 * the change is in the code taxonomy, which the content-keyed staleness DAG
 * cannot see, so only the stamp can force re-derivation.
 *
 * v2 = design resolution 4 (2026-08-05): channel-pure estimator kinds
 * (stated/structural/revealed; `inferred` renamed), per-kind teleologies with
 * file scopes on each subsystem, the miner's `triangulated` teloses +
 * tool-computed `disagreement` density.
 *
 * Read policy is DISCARD (regenerable analysis state): a register stamped with
 * any earlier version degrades to ABSENT and the extraction obligation rebuilds
 * it — its upstream inputs all still exist, and the rebuild is what stamps the
 * deltas. The clarification join's own refusal of an unstamped delta stays as
 * defense-in-depth for anything that reaches it anyway.
 */
export const CHARTER_REGISTER_SCHEMA_VERSION = "charter-register/v4";

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
  /**
   * The routed + gated channel-pair deltas across all subsystems, each carrying
   * its own `node_id` (and `goal_node_id` when linked) as an explicit field — the
   * assembler stamps them, so no consumer parses `delta_id` to recover a node.
   */
  deltas: StampedCharterDelta[];
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
  /**
   * Gate drops (un-falsifiable True, ungrounded scopes) AND failed provenance
   * citations — surfaced, not hidden. Read it beside {@link citation_validation}:
   * an empty array means "nothing was wrong" only when the affirmation says the
   * check ran, and how many refs it saw.
   */
  validation_issues: string[];
  /**
   * The affirmation that the citation check RAN. REQUIRED, because an empty
   * `validation_issues` is unfalsifiable on its own — it printed identically at
   * 1-of-15 correct citations and at 75-of-75.
   */
  citation_validation: CitationValidationSummary;
  /**
   * What each blind lane's evidence packet actually DELIVERED, per evidence
   * class, in canonical kind order. The "stated" channel — whose whole job is
   * source comments — once delivered 0 of 72 comment blocks and said so only in
   * prose inside a file that was then deleted, so absent evidence was
   * indistinguishable from thorough work. Empty when no packet manifest was
   * available to fold (the omit path, or an ingest with no artifacts dir).
   */
  evidence_coverage: CharterPacketCoverage[];
}
