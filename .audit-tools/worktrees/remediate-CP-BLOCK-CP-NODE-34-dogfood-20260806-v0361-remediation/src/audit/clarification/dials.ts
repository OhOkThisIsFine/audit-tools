// Phase D — D2: the ATTENTION dial (control surface, currency #3).
//
// The three control-surface dials each meter a currency no other touches (design
// of record spec/conceptual-design-review-design.md §"Control surface — three
// currencies, three dials"): intensity = compute/tokens (auto-scaled), ceiling =
// premise-height/consent (the intent checkpoint, defaulted), and ATTENTION = human
// attention — how many rounds / how far down the VOI-ranked question queue the user
// will converse. Attention is independent of tokens (you can be compute-rich but
// attention-poor), which is why it earns its own dial.
//
// Zero attention = the AUTONOMOUS mode: appetite 0 → every charter-delta becomes a
// written finding, nothing interactive, no human in the loop. Attended and
// unattended are two SETTINGS OF ONE DIAL, not a forked path — so the same partition
// pipeline runs at every appetite; only how far down the queue you take differs.
//
// PURE + deterministic: no IO, no LLM. Exported for phase-e reuse.

import type { CharterClarificationRequest } from "audit-tools/shared";
import { voiQueue } from "./voiQueue.js";

/**
 * The attention appetite — how many VOI-ranked questions the user will answer this
 * round. `0` is the autonomous mode (nothing interactive). A finite N takes the top
 * N of the VOI queue. `"all"` takes every interactive question (attention-rich).
 */
export type AttentionAppetite = number | "all";

/** How a partitioned queue splits under a given attention appetite. */
export interface AttentionSplit {
  /** The questions to ASK this round — the top slice of the VOI queue. */
  asked: CharterClarificationRequest[];
  /**
   * The questions to WRITE AS FINDINGS this round — everything not asked: the
   * `finding_only` questions the risk gate downgraded, plus interactive questions
   * beyond the appetite's cut. Under appetite 0 this is every question.
   */
  banked: CharterClarificationRequest[];
}

/**
 * Split a set of risk-gated questions by the attention appetite. Only `interactive`
 * questions are eligible to be asked; they are VOI-ranked and the top `appetite`
 * are `asked`. Everything else (`finding_only`, or interactive-beyond-appetite) is
 * `banked` as a written finding — so low appetite still gets the HIGHEST-LEVERAGE
 * questions (VOI order), not merely fewer, and appetite 0 banks everything (the
 * autonomous mode). Deterministic: same inputs → same split.
 */
export function splitByAttention(
  requests: CharterClarificationRequest[],
  appetite: AttentionAppetite,
): AttentionSplit {
  const interactive = requests.filter((r) => r.disposition === "interactive");

  const ranked = voiQueue(interactive);
  const take = appetite === "all" ? ranked.length : Math.max(0, appetite);
  const asked = ranked.slice(0, take);
  const askedIds = new Set(asked.map((r) => r.request_id));

  const banked = requests.filter((r) => !askedIds.has(r.request_id));
  // Keep `banked` in a stable content-derived order (VOI) so the persisted
  // register never churns on input order.
  return { asked, banked: voiQueue(banked) };
}
