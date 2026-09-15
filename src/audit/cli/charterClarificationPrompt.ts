// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-clarification.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { CharterDifferenceQuestion, Ceiling } from "audit-tools/shared";

/**
 * Render the charter-clarification host prompt (Phase D; approved host text:
 * docs/reviews/prompt-refinement-2026-09-13.md §10). The tool has already run the
 * deterministic loop and surfaces the top of the VOI queue. The host relays each
 * n-ary question — every account in the correspondence, side by side, with its
 * citation — and records one answer: the governing channel, a rewrite of all, or
 * leave open. Only reached at a `deep`+ ceiling WITH attention > 0.
 */
export function renderCharterClarificationPrompt(
  bundle: ArtifactBundle,
  opts: { answersPath: string; continueCommand: string; ceiling: Ceiling },
): string {
  const asked: CharterDifferenceQuestion[] = bundle.charter_clarification?.asked ?? [];

  const questionBlocks = asked.length
    ? asked.flatMap((q, i) => {
        const split = !q.split
          ? q.relation
          : q.split.kind === "three_way"
            ? "three_way"
            : `two_against_one: ${q.split.odd}`;
        const subsystem = q.subsystem_id ? `subsystem \`${q.subsystem_id}\` · ` : "";
        return [
          `### Q${i + 1} — ${subsystem}${q.dimension} · ${q.relation} · ${split}`,
          `- request_id: \`${q.request_id}\``,
          `- blast radius: ${q.value.blast_radius}; cascade: ${q.value.cascade_count}`,
          ...q.accounts.map((a) => {
            const cite = a.provenance[0];
            const ref = cite ? ` — \`${cite.ref}\`${cite.quote ? ` "${cite.quote}"` : ""}` : "";
            return `- **${a.kind}** says: ${a.claim}${ref}`;
          }),
          "",
          q.question,
          "",
        ];
      })
    : ["- (no interactive questions this round — nothing to ask)"];

  return [
    "# Design review — charter clarification",
    "",
    "Below are this run's highest-leverage charter questions, pre-ranked. Each comes from a verified",
    "difference between accounts of the same goal. Any account may move — including what the docs",
    "state — so never frame a question as \"your code violates your intent, shall we fix the code?\"",
    "",
    "Relay each question to the user and record ONE answer per question:",
    "",
    "- `governs: <channel>` — that channel's account governs; the others move to match.",
    "- `rewrite_all` — none as-is; the accounts rewrite to a third thing.",
    "- `leave_open` — a deliberate held tension (a decision, not a failure).",
    "",
    "## Questions",
    "",
    ...questionBlocks,
    "## Output",
    "",
    `Write the answers as JSON to \`${opts.answersPath}\`:`,
    "",
    "```json",
    "{",
    '  "answers": [',
    '    { "request_id": "<one of the request_ids above>", "answer": { "governs": "stated | structural | revealed" } },',
    '    { "request_id": "<one of the request_ids above>", "answer": "rewrite_all" },',
    '    { "request_id": "<one of the request_ids above>", "answer": "leave_open" }',
    "  ]",
    "}",
    "```",
    "",
    "If the user stops mid-loop, write answers for what is resolved and leave the rest unanswered",
    "(unanswered questions stay `leave_open`). When the answers are written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}
