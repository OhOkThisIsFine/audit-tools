import type { ArtifactBundle } from "../io/artifacts.js";
import type { CharterClarificationRequest, Ceiling } from "audit-tools/shared";

/**
 * Render the charter-clarification host prompt (Phase D). The tool has already run
 * the deterministic triangulation loop — partition → VOI-rank → risk-gate → split
 * by attention — and surfaces the top of the VOI queue here. The host's job is only
 * to relay each SYMMETRIC question to the user and record the answer (any charter
 * may move, including Stated; "leave open" is first-class), then write the answers
 * back. Nothing here anoints a side; the tool never asked "shall we fix the code?"
 * (design of record spec/conceptual-design-review-design.md §"The triangulation
 * loop"). Only reached at a `deep`+ ceiling WITH attention > 0 and ≥1 interactive
 * question; a shallow ceiling or zero attention runs autonomously with no host turn.
 */
export function renderCharterClarificationPrompt(
  bundle: ArtifactBundle,
  opts: { answersPath: string; continueCommand: string; ceiling: Ceiling },
): string {
  const asked: CharterClarificationRequest[] =
    bundle.charter_clarification?.asked ?? [];

  const questionBlocks = asked.length
    ? asked.flatMap((q, i) => [
        `### Q${i + 1} — subsystem \`${q.node_id}\` (${q.pair[0]} ↔ ${q.pair[1]})`,
        `- request_id: \`${q.request_id}\``,
        `- blast radius: ${q.value.blast_radius}; cascade: ${q.value.cascade_count}`,
        "",
        q.question,
        "",
      ])
    : ["- (no interactive questions this round — nothing to ask)"];

  return [
    "# Design review — charter clarification (triangulation loop)",
    "",
    "The tool has mined the charter deltas into decidable, VOI-ranked questions and",
    "surfaces the highest-leverage ones below. Each is **symmetric**: any of the four",
    "charters may move — **including Stated** — so do NOT frame this as \"where does",
    "your code violate your intent, shall we fix the code?\" That silently anoints",
    "Stated as ground truth and throws away the True-charter payload.",
    "",
    "Relay each question to the user and record ONE answer per question:",
    "- `this_side_wins` — the FIRST charter in the pair governs.",
    "- `that_side_wins` — the SECOND charter in the pair governs.",
    "- `rewrite_both` — neither as-is; both rewrite to a third thing.",
    "- `leave_open` — a deliberate held tension (a first-class decision, not a failure).",
    "",
    "## Questions (VOI-ranked, highest-leverage first)",
    ...questionBlocks,
    "## Output",
    `Write the answers as JSON to \`${opts.answersPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "answers": [',
    '    { "request_id": "<one of the request_ids above>",',
    '      "answer": "this_side_wins|that_side_wins|rewrite_both|leave_open" }',
    "  ]",
    "}",
    "```",
    "",
    "The user may tap out mid-loop — the loop is interruptible; bank what is resolved",
    "and leave the rest open. When the answers are written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}
