import type { ArtifactBundle } from "../io/artifacts.js";

/**
 * Render the charter-DELTA host prompt (Phase C.2). The host here is the
 * INDEPENDENT delta-miner: it did NOT author the charters below (a different pass
 * did, blind to the deltas), so it reasons over the merged charter set as an
 * outside critic — finding the real GAPS between charter kinds within each
 * subsystem and building the goal DAG across subsystems. The tool supplies the
 * ENFORCEMENT half at ingest (the routing table, the Phase-A low-confidence gate);
 * the miner never picks routing. Mirrors renderCharterExtractionPrompt's style
 * (design of record spec/conceptual-design-review-design.md).
 */
export function renderCharterDeltaPrompt(
  bundle: ArtifactBundle,
  opts: { submissionPath: string; continueCommand: string },
): string {
  const subsystems = bundle.charter_register?.subsystems ?? [];

  const subsystemBlocks = subsystems.length
    ? subsystems.flatMap((sub) => {
        const memberPreview = sub.members.slice(0, 12).join(", ");
        const more =
          sub.members.length > 12
            ? ` (+${sub.members.length - 12} more)`
            : "";
        const charterLines = sub.charters.length
          ? sub.charters.map(
              (c) => `  - **${c.kind}** (confidence: ${c.confidence}) — ${c.purpose}`,
            )
          : ["  - (no surviving charters)"];
        return [
          `- **${sub.node_id}** — ${sub.members.length} file(s): ${memberPreview}${more}`,
          ...charterLines,
        ];
      })
    : ["- (no subsystems carry charters — submit an empty `subsystems` array)"];

  return [
    "# Design review — charter delta-mining (conceptual, teleological)",
    "",
    "You are the **independent delta-miner**. You did NOT author the charters below",
    "— a separate pass extracted them, blind to the gaps you are about to find. Read",
    "them as an outside critic: for each subsystem, find the real **GAPS between its",
    "charter kinds** (a genuine gap, not every pair), and build the **goal_graph**",
    "(nodes/edges) linking the subsystems' purposes across the whole set.",
    "",
    "Give each delta a `pair` (two charter kinds) + a `summary` of the gap. The tool",
    "ROUTES them (you do not): inferred↔stated → a clarification; stated↔revealed →",
    "the remediator; anything↔true → the human. A shaky charter downgrades its deltas",
    "to the human channel automatically.",
    "",
    "## Anti-slop discipline (do NOT emit)",
    "- No **manufactured** deltas — a `pair` whose two charters genuinely agree is not",
    "  a gap; skip it. Only surface a real divergence.",
    "- No delta against a charter kind a subsystem does not have below.",
    "- Only mine the subsystems listed — they are the assembled charter set, nothing",
    "  more. Do not add a `node_id` that is not below.",
    "",
    "## Assembled charters (from the charter-extraction pass)",
    ...subsystemBlocks,
    "",
    "## Output",
    `Write your submission as JSON to \`${opts.submissionPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "subsystems": [',
    "    {",
    '      "node_id": "<one of the subsystems above>",',
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
