/**
 * Fold a confirmed checkpoint's structured `InterpretedIntent` into remediation
 * block / finding ORDERING (DC-1, remediate half).
 *
 * The user's `free_form_intent` is interpreted ONCE, deterministically, by the
 * single shared interpreter (`interpretFreeFormIntent`) into lens weights,
 * priority signals, and scope emphases. This module consumes that structured
 * signal to reorder the plan's findings (and the blocks that carry them) so the
 * work the user emphasised is dispatched first.
 *
 * Hard boundaries (mirroring audit's planning boost):
 * - ORDERING ONLY. Intent never drops, filters, or mutates a finding — dropping
 *   is the review/clarification gate's job (DC-1 tradeoff note). Every input
 *   finding/block is present in the output; only their order changes.
 * - INV-S04: the verbatim `free_form_intent` string is never read here. Only the
 *   derived `InterpretedIntent` (lens weights / priority / scope) is consumed, so
 *   the raw directive can never leak into a worker prompt via the ordering path.
 * - STABLE. Equal-weight findings keep their original relative order, so ordering
 *   is deterministic across runs.
 *
 * Pure and synchronous — no IO, no LLM.
 */

import type { InterpretedIntent } from "audit-tools/shared";
import type { Finding, RemediationBlock } from "../state/types.js";

/** Severity → base ordering weight (most-severe-first). Higher sorts earlier. */
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/** Boost added to a finding whose lens the intent emphasised (lensWeights). */
const LENS_EMPHASIS_BOOST = 10;
/** Boost added to a finding whose file path matches a scope-emphasis clause. */
const SCOPE_EMPHASIS_BOOST = 5;
/** Flat boost when the intent carried any priority/urgency signal at all. */
const PRIORITY_SIGNAL_BOOST = 3;

// Leading scope-verb phrases (focus on / prioritise / ignore / …) that prefix a
// scope-emphasis clause; stripped so the needles are the path/identifier targets,
// not the directive verb. Mirrors the shared SCOPE_PATTERNS lead-ins.
const SCOPE_LEADIN_RE =
  /^(?:focus(?:ing)?\s+on|focused\s+on|prioriti[sz]e?d?|prioriti[sz]ing|ignore|ignoring|skip(?:ping)?|exclude?d?|excluding|concentrate\s+on|look\s+at|check(?:\s+only)?(?:\s+the)?|limit(?:ed)?\s+to|restrict(?:ed)?\s+to|only\s+(?:in|within|for|\w+))\s+/i;

/**
 * Lower-cased path/identifier needles extracted from each scope-emphasis clause.
 * A clause like "focus on src/auth" yields the needle "src/auth" (the directive
 * verb is stripped); multi-target clauses split into one needle per token. These
 * are substring-matched against a finding's file paths.
 */
function scopeNeedles(intent: InterpretedIntent): string[] {
  const needles: string[] = [];
  for (const clause of intent.scopeEmphasis) {
    const target = clause.toLowerCase().replace(SCOPE_LEADIN_RE, "").trim();
    if (target.length === 0) continue;
    for (const token of target.split(/[\s,]+/)) {
      const t = token.replace(/[.;:!?]+$/g, "").trim();
      // Keep path-like or identifier-like tokens; drop bare stop-words.
      if (t.length >= 2 && /[a-z0-9/_.-]/i.test(t)) needles.push(t);
    }
  }
  return needles;
}

/** True when any of the finding's affected-file paths contains a scope needle. */
function matchesScope(finding: Finding, needles: string[]): boolean {
  if (needles.length === 0) return false;
  for (const file of finding.affected_files ?? []) {
    const path = (file.path ?? "").toLowerCase().replace(/\\/g, "/");
    if (path.length === 0) continue;
    for (const needle of needles) {
      if (path.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * The intent-derived ordering weight for a single finding: its severity base
 * plus boosts for an emphasised lens, an emphasised scope path, and any priority
 * signal. Higher weight sorts earlier. When the intent is empty (no lens
 * weights, scope, or priority), this collapses to the severity base, so an
 * absent/empty `free_form_intent` leaves ordering driven purely by severity.
 */
export function findingIntentWeight(
  finding: Finding,
  intent: InterpretedIntent,
  needles: string[] = scopeNeedles(intent),
): number {
  let weight = SEVERITY_WEIGHT[finding.severity] ?? 0;
  const lens = (finding.lens ?? "").trim();
  if (lens.length > 0 && intent.lensWeights[lens as keyof typeof intent.lensWeights] !== undefined) {
    weight += LENS_EMPHASIS_BOOST;
  }
  if (matchesScope(finding, needles)) {
    weight += SCOPE_EMPHASIS_BOOST;
  }
  if (intent.prioritySignals.length > 0) {
    weight += PRIORITY_SIGNAL_BOOST;
  }
  return weight;
}

/** True when the interpreted intent carries no ordering signal at all. */
function intentIsEmpty(intent: InterpretedIntent): boolean {
  return (
    Object.keys(intent.lensWeights).length === 0 &&
    intent.prioritySignals.length === 0 &&
    intent.scopeEmphasis.length === 0
  );
}

export interface IntentOrderingResult {
  findings: Finding[];
  blocks: RemediationBlock[];
}

/**
 * Reorder `findings` and `blocks` by intent-derived weight (descending), stably.
 *
 * - Findings sort by `findingIntentWeight` desc, ties broken by original index.
 * - Blocks sort by the MAX intent weight of their member findings (so a block
 *   carrying an emphasised finding is dispatched first), ties broken by original
 *   index. A block's internal item order is left untouched.
 * - When the intent carries no signal, both arrays are returned UNCHANGED (no
 *   reordering, no severity-shuffle) so behaviour is a strict no-op without a
 *   `free_form_intent`.
 *
 * Never adds, drops, or mutates a finding/block — ordering only.
 */
export function applyIntentOrdering(
  findings: Finding[],
  blocks: RemediationBlock[],
  intent: InterpretedIntent,
): IntentOrderingResult {
  if (intentIsEmpty(intent)) {
    return { findings, blocks };
  }

  const needles = scopeNeedles(intent);
  const weightByFinding = new Map<string, number>();
  for (const finding of findings) {
    weightByFinding.set(finding.id, findingIntentWeight(finding, intent, needles));
  }

  // Stable sort: decorate with original index, compare on (weight desc, index asc).
  const orderedFindings = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const wa = weightByFinding.get(a.finding.id) ?? 0;
      const wb = weightByFinding.get(b.finding.id) ?? 0;
      return wb - wa || a.index - b.index;
    })
    .map((entry) => entry.finding);

  const blockWeight = (block: RemediationBlock): number => {
    let max = -Infinity;
    for (const id of block.items) {
      const w = weightByFinding.get(id);
      if (w !== undefined && w > max) max = w;
    }
    return max === -Infinity ? 0 : max;
  };
  const orderedBlocks = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => blockWeight(b.block) - blockWeight(a.block) || a.index - b.index)
    .map((entry) => entry.block);

  return { findings: orderedFindings, blocks: orderedBlocks };
}
