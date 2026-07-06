import type { ArtifactBundle } from "../io/artifacts.js";
import type { Ceiling } from "audit-tools/shared";

/**
 * Render the charter-extraction host prompt (Phase C). The host is the LLM that
 * supplies JUDGMENT — the four charter families per confident subsystem, in TELOS
 * terms, plus the pairwise deltas it sees — while the tool supplies ENFORCEMENT
 * (id assignment, the routing table, the Phase-A gates) at ingest. The prompt is
 * grounded in the Phase-B consensus scaffold (the subsystems are discovered, never
 * invented by the host) and carries /init's negative-constraint discipline as the
 * anti-slop filter (design of record spec/conceptual-design-review-design.md).
 */
export function renderCharterExtractionPrompt(
  bundle: ArtifactBundle,
  opts: { submissionPath: string; continueCommand: string; ceiling: Ceiling },
): string {
  const consensus = bundle.structure_decomposition?.consensus ?? [];
  const deepest = opts.ceiling.rung === "deepest";

  const subsystemLines = consensus.length
    ? consensus.map((node) => {
        const preview = node.members.slice(0, 12).join(", ");
        const more =
          node.members.length > 12 ? ` (+${node.members.length - 12} more)` : "";
        return `- **${node.node_id}** — ${node.members.length} file(s): ${preview}${more}`;
      })
    : ["- (no confident subsystems were found — submit an empty `subsystems` array)"];

  return [
    "# Design review — charter extraction (conceptual, teleological)",
    "",
    "You are extracting the **charter layer** of the conceptual design review: not",
    '"is this module correct/clean" but *"what is this subsystem FOR, and does it',
    'serve that purpose as well as a better design could."*',
    "",
    "For each confident subsystem below, state up to **four charters**, each a",
    "purpose in **telos terms — never mechanism**. A charter that merely restates",
    'the code ("it manages quota") is useless — the delta against the impl collapses',
    'to zero. State the telos ("exists so N cooperating auditors extract max value',
    'from finite provider budgets"). The four:',
    "",
    "- **stated** — what the user/docs SAY it is for (cite the doc/comment).",
    "- **inferred** — YOUR model of that intent (where you read between the lines).",
    "- **revealed** — what the code actually optimizes for (cite the code). This is",
    "  the objective anchor — far more extractable than any intent charter.",
    ...(deepest
      ? [
          "- **true** — the *shining city* ideal the user may be unaware of. NOMINATABLE,",
          "  NEVER ASSERTED. It MUST name a concrete alternative AND a concrete cost the",
          '  user seems to pay unaware ("Quicken exists; you\'re rebuilding a worse one")',
          "  or it is dropped as slop. Framed as a provocation, never a verdict.",
        ]
      : [
          "- **true** — SKIP unless you are certain. The ceiling for this run does not",
          "  request True provocations; do not nominate one.",
        ]),
    "",
    "Then emit the **deltas** you see between charters of a subsystem — a real GAP,",
    "not every pair. Give each a `pair` (two charter kinds) + a `summary` of the gap.",
    "The tool routes them (you do not): inferred↔stated → a clarification; stated↔",
    "revealed → the remediator; anything↔true → the human. Tag each charter's",
    "`confidence`; a shaky charter downgrades its deltas to the human channel.",
    "",
    "## Anti-slop discipline (do NOT emit)",
    "- No **restated-mechanism** charters (the delta collapses to zero).",
    "- No **generic** telos any subsystem could claim; be specific to THIS one.",
    "- No **fabricated profundity** — every charter cites provenance (revealed cites",
    "  code, stated cites a doc/comment); a True nomination without a concrete",
    "  alternative+cost is slop.",
    "- Only review the subsystems listed — they are discovered, not invented. Do not",
    "  add a `node_id` that is not below.",
    "",
    "## Confident subsystems (from the structure decomposition)",
    ...subsystemLines,
    "",
    "## Output",
    `Write your submission as JSON to \`${opts.submissionPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "subsystems": [',
    "    {",
    '      "node_id": "<one of the subsystems above>",',
    '      "charters": [',
    '        { "kind": "stated|inferred|revealed|true", "purpose": "<telos, not mechanism>",',
    '          "provenance": [{ "kind": "doc|code|comment|inferred|...", "ref": "<path/id>", "quote": "<optional>" }],',
    '          "confidence": "high|medium|low"',
    '          /* true only: "nominated_alternative": "...", "nominated_cost": "..." */ }',
    "      ],",
    '      "deltas": [{ "pair": ["stated", "revealed"], "summary": "<the gap>" }]',
    "    }",
    "  ],",
    '  "goal_graph": { "nodes": [], "edges": [] }',
    "}",
    "```",
    "",
    "When the submission is written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}
