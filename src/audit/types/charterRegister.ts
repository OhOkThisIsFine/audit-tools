// sites-pinned: tests/audit/charter-extraction-executor.test.ts, tests/audit/charter-comparison-executor.test.ts, tests/audit/charter-fidelity-executor.test.ts
import type { Finding } from "../types.js";
import type {
  CharterPacketCoverage,
  CitationValidationSummary,
  Ceiling,
  CharterLaneGraph,
  CorrespondenceCandidate,
  CharterCorrespondence,
  CharterDifference,
} from "audit-tools/shared";

/**
 * The stamped register schema version.
 *
 * v5 = the five-step charter layer (design of record 2026-09-15;
 * spec/conceptual-design-review-design.md §"The estimator charters"). The
 * register no longer holds joined subsystems with one charter per kind, routed
 * pairwise deltas, a triangulated telos, a disagreement density, or one goal
 * graph. It holds the THREE lane goal DAGs unmerged, the tool-proposed
 * correspondence candidates, the confirmed correspondences, the typed n-ary
 * difference records (routed, and stamped with their fidelity verdict), and the
 * findings the `supported` records surface. Two pending flags drive the two
 * host passes that follow extraction: `comparison_pending` (the comparison
 * reader is owed a turn) and `fidelity_pending` (the fidelity lane is owed one).
 *
 * v4 added `citation_validation` + `evidence_coverage` (the register no longer
 * self-certifies); v3 stamped delta identity; v2 renamed the estimator kinds.
 *
 * Read policy is DISCARD (regenerable analysis state): a register stamped with
 * any earlier version degrades to ABSENT and the extraction obligation rebuilds
 * it — the taxonomy change is in code, which the content-keyed staleness DAG
 * cannot see, so only the stamp can force re-derivation.
 */
export const CHARTER_REGISTER_SCHEMA_VERSION = "charter-register/v5";

/**
 * The `charter_register.json` artifact — the charter LAYER of the conceptual
 * design-review. Where the structure layer answers "what are the pieces," this
 * answers "what are the pieces FOR": three channel-pure goal DAGs (Stated,
 * Structural, Revealed — each fed only its own evidence packet) held unmerged,
 * the correspondences between them, the differences between corresponding
 * accounts typed on seven dimensions, each verified against its own sources
 * before it may become a finding. It is an OUTPUT artifact (the
 * `intent_checkpoint` carries the ceiling as INPUT) — keeping the charters here
 * rather than back on the checkpoint avoids a staleness cycle.
 */
export interface CharterRegister {
  schema_version: typeof CHARTER_REGISTER_SCHEMA_VERSION;
  generated_at: string;
  /** The decomposition target — `"charter"` at this layer. */
  target: "charter";
  /**
   * The ceiling authorized at `intent_checkpoint` — how far up the premise stack
   * this run's charters may reach. `deepest` additionally authorizes True
   * nominations downstream of the report.
   */
  ceiling: Ceiling;
  /**
   * `"omitted"` when the ceiling was `shallow` (no charter layer requested) — the
   * register is written empty so the obligation is satisfied without an LLM pass.
   */
  status?: "omitted";
  /** Step 1: one persisted goal DAG per lane, in canonical kind order. Never merged. */
  lanes: CharterLaneGraph[];
  /** Step 2 (tool half): the deterministic candidates the comparison reader judged. */
  candidates: CorrespondenceCandidate[];
  /** Step 2 (host half): the confirmed or host-added correspondences. */
  correspondences: CharterCorrespondence[];
  /** Step 3 + 4: the typed difference records, routed and fidelity-stamped. */
  differences: CharterDifference[];
  /** Step 5: the `supported` finding candidates surfaced as Finding leads. */
  findings: Finding[];
  /**
   * true after the lane DAGs are assembled and before the comparison reader has
   * run; drives `charter_comparison_current`. Set when any lane produced ≥1 node.
   */
  comparison_pending?: boolean;
  /**
   * true after the comparison is ingested and before the fidelity lane has run;
   * drives `charter_fidelity_current`. Set when ≥1 finding candidate survived the
   * tool pre-check and awaits a lane verdict.
   */
  fidelity_pending?: boolean;
  /**
   * Gate drops (cycles refused, unknown files, unplaceable differences, refused
   * verdicts) AND failed provenance citations — surfaced, never hidden. Read it
   * beside {@link citation_validation}.
   */
  validation_issues: string[];
  /** The affirmation that the citation check RAN. REQUIRED. */
  citation_validation: CitationValidationSummary;
  /** What each blind lane's evidence packet actually DELIVERED, per evidence class. */
  evidence_coverage: CharterPacketCoverage[];
}
