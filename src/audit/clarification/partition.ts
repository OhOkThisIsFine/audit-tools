// sites-pinned: tests/audit/charter-clarification.test.ts
// Phase D — D2: PARTITION verified charter differences into n-ary questions.
//
// The charter layer produces routed, fidelity-stamped difference records. The
// triangulation loop turns each record ROUTED TO clarification (or human) and
// verified `supported` into a decidable, symmetric, n-ary question — not "what do
// you want?" but "the stated, structural and revealed accounts of this goal
// collide on <dimension>; which governs?" (design of record
// spec/conceptual-design-review-design.md §"The triangulation loop"). Questions
// show EVERY account in the correspondence; any may move, including Stated.
//
// PURE + deterministic + language-neutral.

import type { CharterDifferenceQuestion, CharterLaneGraph } from "audit-tools/shared";
import { compareCodeUnits, sourcesQuestion } from "audit-tools/shared";
import type { ClarificationDifferenceInput } from "audit-tools/shared";
import { differenceBlastRadius } from "./blastRadius.js";

function describeSplit(q: Pick<CharterDifferenceQuestion, "split" | "relation">): string {
  if (!q.split) return q.relation;
  return q.split.kind === "three_way" ? "three-way" : `${q.split.odd} against the rest`;
}

/**
 * Frame a difference's symmetric decidable question. The accounts are held in
 * tension without anointing any; the gap carries the seam. Mechanical (never an
 * LLM call) so the question text is reproducible from the record alone.
 */
function frameQuestion(input: ClarificationDifferenceInput): string {
  const d = input.difference;
  const kinds = d.accounts.map((a) => `**${a.kind}**`).join(", ");
  const accounts = d.accounts.map((a) => `[${a.kind}] ${a.claim}`).join(" ");
  return (
    `The ${kinds} accounts collide on ${d.dimension} (${describeSplit(d)}): ${d.gap} ${accounts} ` +
    `Which account governs — or should all of them be rewritten to a third thing, or is this a deliberate held tension (leave open)?`
  );
}

/**
 * Partition the verified differences into charter questions. Every
 * clarification/human-routed, supported difference becomes one open question with
 * its VOI axes:
 *   - `blast_radius` = the maximum parent-closure reach over the corresponding
 *     nodes across the three lane graphs (floored at the dimension's tier);
 *   - `cascade_count` = the number of OTHER question-sourcing differences on the
 *     same correspondence (answering one is expected to settle its siblings).
 * `disposition` is left `interactive`; the risk gate downgrades high-blast
 * questions that have not cleared the adversarial bar. Output is sorted by
 * `request_id` (content-derived, stable).
 */
export function partitionDifferencesToQuestions(
  inputs: readonly ClarificationDifferenceInput[],
  graphs: readonly CharterLaneGraph[],
): CharterDifferenceQuestion[] {
  const sourcing = inputs.filter((i) => sourcesQuestion(i.difference));
  const perCorrespondence = new Map<string, number>();
  for (const i of sourcing) {
    const key = i.difference.correspondence_id;
    perCorrespondence.set(key, (perCorrespondence.get(key) ?? 0) + 1);
  }
  const requests = sourcing.map((input): CharterDifferenceQuestion => {
    const d = input.difference;
    const siblings = (perCorrespondence.get(d.correspondence_id) ?? 1) - 1;
    return {
      request_id: `${d.difference_id}:q`,
      difference_id: d.difference_id,
      ...(input.subsystem_id ? { subsystem_id: input.subsystem_id } : {}),
      dimension: d.dimension,
      relation: d.relation,
      ...(d.split ? { split: d.split } : {}),
      accounts: d.accounts,
      question: frameQuestion(input),
      value: {
        blast_radius: differenceBlastRadius(d, input.correspondence, graphs),
        cascade_count: Math.max(0, siblings),
      },
      disposition: "interactive",
    };
  });
  return requests.sort((a, b) => compareCodeUnits(a.request_id, b.request_id));
}
