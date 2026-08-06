import type { ArtifactBundle } from "../io/artifacts.js";

/**
 * Render the charter-DELTA host prompt (Phase C.2). The host here is the
 * INDEPENDENT delta-miner — the triangulation engine: it did NOT author the
 * charters below (three blind channel lanes did, each fed only its own
 * evidence), so it is the first reader to see all channels together. It mines
 * the real GAPS between channels within each subsystem, distills a TRIANGULATED
 * TELOS per subsystem (a unified opinion the owner reacts to — a lead, never a
 * reconciliation; the deltas stay the primary product), builds the goal DAG
 * across subsystems, and — at the deepest ceiling only — may nominate a True
 * charter. The tool supplies the ENFORCEMENT half at ingest (the routing table,
 * the Phase-A gates, the deepest-rung consent check); the miner never picks
 * routing.
 */
export function renderCharterDeltaPrompt(
  bundle: ArtifactBundle,
  opts: { submissionPath: string },
): string {
  const register = bundle.charter_register;
  const subsystems = register?.subsystems ?? [];
  const deepest = register?.ceiling.rung === "deepest";

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
        const teleologyLines = Object.entries(sub.teleologies ?? {}).flatMap(
          ([kind, nodes]) =>
            (nodes ?? []).map(
              (n) =>
                `  - teleology (${kind}, L${n.premise_height}, ${n.files.length} file(s)) — ${n.purpose}`,
            ),
        );
        return [
          `- **${sub.node_id}** — ${sub.members.length} file(s): ${memberPreview}${more}`,
          ...charterLines,
          ...teleologyLines,
        ];
      })
    : [
        "- (no subsystems carry charters — submit `{ \"subsystems\": [], \"no_deltas\": true }`)",
      ];

  return [
    "# Design review — charter delta-mining + triangulation (conceptual, teleological)",
    "",
    "You are the **independent delta-miner**. You did NOT author the charters below",
    "— three blind lanes did, each fed ONLY its own evidence channel (stated =",
    "testimony from docs/comments; structural = intent frozen into the code's",
    "organization; revealed = behavior from comment-stripped bodies). You are the",
    "first reader to hold all channels together. For each subsystem:",
    "",
    "1. Mine the real **GAPS between channels** (a genuine divergence, not every",
    "   pair). Each channel pair has one meaning: stated↔revealed = the code does",
    "   not do what the testimony says; structural↔revealed = the implementation",
    "   betrays the organization's promise; stated↔structural = doc rot / naming",
    "   drift.",
    "2. Distill a **triangulated telos** — your unified best estimate of what the",
    "   subsystem is FOR, weighing all channels. This is an OPINION the owner",
    "   reacts to, never a replacement for the channels: the deltas stay the",
    "   product, and where channels disagree, say so through deltas rather than",
    "   papering over the disagreement in the telos.",
    "",
    "Across the whole set, build the **goal_graph** (nodes/edges) linking the",
    "subsystems' purposes. Give each delta a `pair` (two charter kinds) + a",
    "`summary` of the gap. The tool ROUTES deltas (you do not): doc rot → the",
    "remediator; stated↔revealed drift → the remediator; structural↔revealed",
    "betrayal → a clarification; anything↔true → the human. A shaky charter",
    "downgrades its deltas to the human channel automatically.",
    "",
    ...(deepest
      ? [
          "## True nominations (deepest ceiling — authorized for this run)",
          "",
          "Downstream of your triangulation, you MAY nominate a **true** charter",
          'for a subsystem: the *shining city* ideal the user may be unaware of.',
          "NOMINATABLE, NEVER ASSERTED — it MUST name a concrete alternative AND a",
          'concrete cost the user seems to pay unaware ("Quicken exists; you\'re',
          'rebuilding a worse one") or it is dropped as slop. Framed as a',
          "provocation, never a verdict. Nominate only if certain.",
          "",
        ]
      : [
          "This run's ceiling does NOT authorize True nominations — do not emit",
          "`true_nominations` (they would be refused at ingest).",
          "",
        ]),
    "## Anti-slop discipline (do NOT emit)",
    "- No **manufactured** deltas — a `pair` whose two charters genuinely agree is not",
    "  a gap; skip it. Only surface a real divergence.",
    "- No delta against a charter kind a subsystem does not have below.",
    "- No **averaged** teloses — a triangulated telos that just splices the three",
    "  purposes together is slop; commit to your best estimate and let the deltas",
    "  carry the disagreement.",
    "- Only mine the subsystems listed — they are the assembled charter set, nothing",
    "  more. Do not add a `node_id` that is not below.",
    "",
    "## Assembled charters + teleologies (from the blind channel lanes)",
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
    '  "triangulated": [',
    '    { "node_id": "<subsystem>", "telos": "<your unified best-estimate purpose>", "confidence": "high|medium|low" }',
    "  ],",
    ...(deepest
      ? [
          '  "true_nominations": [',
          '    { "node_id": "<subsystem>", "purpose": "<the nominated ideal>", "nominated_alternative": "...", "nominated_cost": "...", "confidence": "high|medium|low" }',
          "  ],",
        ]
      : []),
    '  "goal_graph": {',
    '    "nodes": [',
    '      { "node_id": "auth", "premise_height": 0, "statement": "keep sessions trustworthy" },',
    '      { "node_id": "token-store", "premise_height": 1, "statement": "persist tokens durably" }',
    "    ],",
    '    "edges": [{ "from": "token-store", "to": "auth" }]',
    "  }",
    "}",
    "```",
    "",
    "Emit ONE `triangulated` entry per subsystem you examined (even a subsystem",
    "with no deltas has a telos — agreement across channels is high-confidence",
    "evidence for it).",
    "",
    "**If you genuinely found NO deltas anywhere**, affirm it explicitly:",
    "`\"no_deltas\": true` on the submission (an empty submission WITHOUT the",
    "affirmation is refused — a silent empty result is indistinguishable from a",
    "miner that never ran). Never set `no_deltas` alongside deltas; the",
    "affirmation is about DELTAS only, so your `triangulated` entries still ride",
    "a `no_deltas` submission.",
    "",
    "**goal_graph schema (validated — use these exact fields, no others):**",
    "- `nodes[]`: each is `{ node_id, premise_height, statement }`. `node_id` is a",
    "  short slug (a subsystem above, or a purpose you name); `premise_height` is an",
    "  INTEGER ≥ 0 where 0 = the root telos and larger = closer to a leaf mechanism",
    "  (emergent depth — there is no fixed L0/L1/L2 enum); `statement` is the",
    "  purpose in one telos sentence (never code/model/provider literals).",
    "- `edges[]`: each is strictly `{ from, to }` — no `kind`/`label`/`reason`",
    "  field. **Every edge means `from` SERVES `to`** (the child purpose advances",
    "  the parent). It is a DAG, not a tree — a node may serve multiple parents.",
    "- Do NOT use `{id,label}` nodes or `{from,to,kind}` edges — those hard-fail the",
    "  validator.",
    "",
  ].join("\n");
}
