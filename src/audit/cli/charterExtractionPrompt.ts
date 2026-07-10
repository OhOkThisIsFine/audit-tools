import type { ArtifactBundle } from "../io/artifacts.js";
import type { Ceiling } from "audit-tools/shared";

/**
 * Render the charter-extraction host prompt (Phase C.1). The host supplies JUDGMENT
 * (the charter families per confident subsystem, in TELOS terms) while the tool
 * supplies ENFORCEMENT (id assignment, dedup, the Phase-A True gate) at ingest.
 *
 * Independence is a first-class contract here, not host discretion: the prompt
 * directs the host to author each kind with a SEPARATE, ACCESS-SCOPED subagent
 * (revealed reads only code, stated reads only docs, each blind to the others), so
 * the later stated↔revealed delta is genuine disagreement rather than one author's
 * self-consistent story (design of record §"independently-sourced views … never
 * reconciled"). The per-kind results merge by `node_id` at ingest (`assembleCharters`).
 * Deltas are NOT authored here — an independent delta-miner mines them in Phase C.2.
 */
export function renderCharterExtractionPrompt(
  bundle: ArtifactBundle,
  opts: { submissionPath: string; continueCommand: string; ceiling: Ceiling },
): string {
  const consensus = bundle.structure_decomposition?.consensus ?? [];
  const deepest = opts.ceiling.rung === "deepest";
  // The True charter is only requested at the deepest rung; at deep the ceiling
  // asks for three (stated/inferred/revealed). Keep the count word in lockstep
  // with the enumerated kinds below so the prompt never advertises a kind it
  // then tells the host not to nominate.
  const charterCountWord = deepest ? "four" : "three";
  const kindList = deepest
    ? "stated, inferred, revealed, true"
    : "stated, inferred, revealed";

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
    `For each confident subsystem below, state up to **${charterCountWord} charters**, each a`,
    "purpose in **telos terms — never mechanism**. A charter that merely restates",
    'the code ("it manages quota") is useless — the delta against the impl collapses',
    'to zero. State the telos ("exists so N cooperating auditors extract max value',
    `from finite provider budgets"). The ${charterCountWord}:`,
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
    "Tag each charter's `confidence`. You author the charters ONLY — an INDEPENDENT",
    "delta-miner reads them in a later pass and mines the gaps between them (no author",
    "marks its own homework), so do NOT emit deltas here.",
    "",
    "## Author these INDEPENDENTLY — one blind, access-scoped subagent per kind",
    "",
    `Do NOT author the ${charterCountWord} kinds in a single pass. Dispatch one`,
    `independent subagent per kind (${kindList}), each BLIND to the others' output, so`,
    "the later stated↔revealed delta is genuine disagreement — not one author's",
    "self-consistent story. Give each subagent ONLY its scope:",
    "",
    "- **stated** subagent — read ONLY docs / specs / READMEs / header comments for the",
    "  subsystem's files; cite the doc. Do NOT open the implementation to guess intent.",
    "- **inferred** subagent — reason about intent from the subsystem's shape + docs;",
    "  your model of what it is FOR, read between the lines.",
    "- **revealed** subagent — read ONLY the subsystem's CODE; cite code. Do NOT read",
    "  the docs/READMEs — anchor purely on what the implementation optimizes for.",
    ...(deepest
      ? [
          "- **true** subagent — the shining-city provocation (a concrete alternative +",
          "  the cost paid unaware); nominate only if certain.",
        ]
      : []),
    "",
    "Each subagent returns `{ subsystems: [{ node_id, charters: [<its one kind>] }] }`",
    "for the subsystems below. MERGE the per-kind results into the single submission",
    "(concatenate the `subsystems` arrays — the tool merges charters by `node_id`).",
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
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "When the submission is written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}
