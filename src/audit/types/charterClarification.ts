import type { Finding } from "../types.js";
import type {
  CharterClarificationRequest,
  Ceiling,
} from "audit-tools/shared";

/**
 * The `charter_clarification.json` artifact — Phase D of the conceptual
 * design-review: the charter-alignment TRIANGULATION LOOP that converts the Phase-C
 * routed charter deltas into decidable, VOI-ranked, risk-gated questions and banks
 * their resolutions (design of record spec/conceptual-design-review-design.md §"The
 * triangulation loop" + §"Control surface — three currencies, three dials"). Where
 * Phase C answers "what are the pieces FOR," this answers "which charter governs
 * where they collide" — one coordinate at a time, triangulating toward the True
 * charter that is inexpressible cold.
 *
 * It is an OUTPUT artifact (the ceiling/attention seed rides on the
 * `intent_checkpoint`), depending on the Phase-C `charter_register` (the deltas it
 * questions). `status:"omitted"` when the ceiling did not request the charter layer
 * (shallow — the default), so the obligation is satisfied without a host turn.
 *
 * `asked` is the VOI-ranked interactive queue surfaced to the host this round;
 * `banked` is every question written as a finding instead (risk-gate-downgraded, or
 * beyond the attention appetite — under zero attention, that is every question:
 * the autonomous mode). `findings` are the banked questions surfaced as leads for
 * synthesis.
 */
export interface CharterClarificationRegister {
  generated_at: string;
  /** The decomposition target — `"charter_clarification"` at this layer. */
  target: "charter_clarification";
  /**
   * The ceiling authorized at `intent_checkpoint` — echoed so the register is
   * self-describing about the depth that produced it.
   */
  ceiling: Ceiling;
  /**
   * The attention appetite this round: `0` (autonomous — nothing interactive), a
   * finite N (top-N of the VOI queue), or `"all"`. Echoed for self-description.
   */
  attention: number | "all";
  /**
   * `"omitted"` when the ceiling was `shallow` (no charter layer requested) — the
   * register is written empty so the obligation is satisfied without an LLM pass.
   */
  status?: "omitted";
  /** The VOI-ranked interactive questions surfaced to the host this round. */
  asked: CharterClarificationRequest[];
  /** Questions written as findings (risk-gated or beyond appetite), VOI-ordered. */
  banked: CharterClarificationRequest[];
  /** The banked questions surfaced as Finding leads for synthesis. */
  findings: Finding[];
  /** Gate/partition notes (e.g. deltas that sourced no question) — surfaced. */
  validation_issues: string[];
}
