// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-clarification.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { CharterDifferenceQuestion, CharterLaneKind } from "audit-tools/shared";
import { CharterLaneKindSchema } from "audit-tools/shared";

/**
 * Render the charter-clarification host prompt (Phase D; host text reviewed by the
 * owner on 2026-09-17, recorded in docs/reviews/prompt-refinement-2026-09-13.md
 * §10). The tool has already run the deterministic loop and surfaces the top of
 * the VOI queue. The host relays each n-ary question — every account in the
 * correspondence, side by side, with every citation it rests on — and records one
 * answer: the governing channel, a rewrite of all, or leave open. Only reached at
 * a `deep`+ ceiling WITH attention > 0.
 *
 * The prompt states the three answer SHAPES outright, and its worked example is
 * built from the real queue below it. Both are the same repair: the example used
 * to write the three channel names into the value as a menu
 * (`"governs": "stated | structural | revealed"`), which the strict enum refuses,
 * and it used to key every entry on a `<one of the request_ids above>`
 * placeholder, which the gate ACCEPTS and the executor then discards in silence
 * (measured 2026-09-17 — the third prompt in this family carrying an example its
 * own validator rejects).
 */
export function renderCharterClarificationPrompt(
  bundle: ArtifactBundle,
  opts: { answersPath: string; continueCommand: string },
): string {
  const asked: CharterDifferenceQuestion[] = bundle.charter_clarification?.asked ?? [];

  const questionBlocks = asked.length
    ? asked.flatMap((q, i) => [
        `### Q${i + 1} — ${headingFor(q)}`,
        `- request_id: \`${q.request_id}\``,
        `- blast radius: ${q.value.blast_radius}; cascade: ${q.value.cascade_count}`,
        ...silentChannelsLine(q),
        ...q.accounts.flatMap((a) => [
          `- **${a.kind}** says: ${a.claim}`,
          // EVERY citation, one per line. Rendering `provenance[0]` alone showed
          // one line of a multi-line account and dropped the rest, so the reader
          // decided which account governs from a partial account.
          ...a.provenance.map(
            (p) => `  - \`${p.ref}\`${p.quote ? ` — "${p.quote}"` : ""}`,
          ),
        ]),
        "",
        q.question,
        "",
      ])
    : ["- (no interactive questions this round — nothing to ask)"];

  return [
    "# Design review — charter clarification",
    "",
    "Below are this run's highest-leverage charter questions, pre-ranked. Each comes from a verified",
    "difference between accounts of the same goal. Any account may move — including what the docs",
    "state — so never frame a question as \"your code violates your intent, shall we fix the code?\"",
    "",
    "Relay each question to the user. Record ONE answer per question. You may leave a question",
    "unanswered; you may not invent one.",
    "",
    "## Questions",
    "",
    ...questionBlocks,
    "## Output",
    "",
    `Write the answers as JSON to \`${opts.answersPath}\`.`,
    "",
    "An answer takes exactly one of three shapes, and the shapes differ — the first is an object, the",
    "other two are bare strings:",
    "",
    `- \`{ "governs": "<channel>" }\` — that channel's account governs; the others move to match. The channel is one of \`${CharterLaneKindSchema.options.join("`, `")}\`, and it must be a channel the question shows.`,
    '- `"rewrite_all"` — none of the accounts stands as-is; they rewrite to a third thing.',
    '- `"leave_open"` — a deliberate held tension. This is a decision, not a failure.',
    "",
    "```json",
    ...exampleLines(asked),
    "```",
    "",
    "Copy each `request_id` character for character from the question block above. The tool refuses an",
    "id it did not ask, because an id it cannot match is an answer it would discard in silence — and",
    "the questions you did answer would then record as left open.",
    "",
    "If the user stops mid-loop, write the answers you have and omit the rest. An omitted question",
    "records as `leave_open`. When the answers are written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}

/**
 * The question heading: dimension, relation, and the SPLIT when one is recorded.
 *
 * An absent split is omitted rather than filled in. Falling back to the relation
 * printed it twice (`presence · complementary · complementary`), which reads as a
 * repeated word instead of as an absent fact.
 */
function headingFor(q: CharterDifferenceQuestion): string {
  const subsystem = q.subsystem_id ? `subsystem \`${q.subsystem_id}\` · ` : "";
  const split = !q.split
    ? ""
    : q.split.kind === "three_way"
      ? " · split: three ways, no two accounts agree"
      : ` · split: two against one, \`${q.split.odd}\` the odd account`;
  return `${subsystem}${q.dimension} · ${q.relation}${split}`;
}

/**
 * The channels that hold NO account of this goal — the other half of a `presence`
 * difference, and unstated everywhere else. A reader deciding which account
 * governs needs to know that a channel is silent, not absent from the render.
 */
function silentChannelsLine(q: CharterDifferenceQuestion): string[] {
  const spoke = new Set<CharterLaneKind>(q.accounts.map((a) => a.kind));
  const silent = CharterLaneKindSchema.options.filter((k) => !spoke.has(k));
  return silent.length === 0
    ? []
    : [`- silent (no account of this goal at all): ${silent.map((k) => `**${k}**`).join(", ")}`];
}

/**
 * The worked example, built from the REAL queue. Every `request_id` is one the
 * tool asked, and every `governs` channel is one its question shows, so the
 * example is a submission the gate accepts — and a host that copies it cannot
 * copy a placeholder into a value.
 */
function exampleLines(asked: readonly CharterDifferenceQuestion[]): string[] {
  if (asked.length === 0) return ["{", '  "answers": []', "}"];
  const entries = [
    `    { "request_id": ${JSON.stringify(asked[0]!.request_id)}, "answer": { "governs": ${JSON.stringify(asked[0]!.accounts[0]!.kind)} } }`,
    ...(asked.length > 1
      ? [`    { "request_id": ${JSON.stringify(asked[1]!.request_id)}, "answer": "leave_open" }`]
      : []),
  ];
  return ["{", '  "answers": [', entries.join(",\n"), "  ]", "}"];
}
