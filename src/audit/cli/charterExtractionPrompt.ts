import type { ArtifactBundle } from "../io/artifacts.js";
import type { Ceiling, CharterKind } from "audit-tools/shared";

/**
 * Per-kind charter-extraction LANE prompts (Phase C.1). The host supplies
 * JUDGMENT (the charter families per confident subsystem, in TELOS terms) while
 * the tool supplies ENFORCEMENT (id assignment, dedup, the Phase-A True gate,
 * per-lane kind purity) at ingest.
 *
 * Always-materialized (design resolution 2, 2026-08-05): each kind is its own
 * LANE — one prompt file, one submission file, authored blind to the other
 * lanes — so independence stops being a merge instruction the host must follow
 * and becomes the shape of the artifacts. The tool merges the per-kind
 * submissions at the ingest chokepoint (`assembleCharters` still receives ONE
 * merged submission). Content rules are the CURRENT ones — channel-pure
 * scope-by-feeding packets and the kind rename ride design resolution 4, never
 * this mechanism change. Lane prompts are ADVANCE-FREE (no continue-command).
 */

/** The extraction kinds a run's ceiling requests, in canonical order. */
export function charterExtractionKindsForCeiling(ceiling: Ceiling): CharterKind[] {
  return ceiling.rung === "deepest"
    ? ["stated", "inferred", "revealed", "true"]
    : ["stated", "inferred", "revealed"];
}

/** Per-kind definition + access-scope text (current content rules, verbatim). */
const KIND_LANE_TEXT: Record<
  CharterKind,
  { definition: string[]; scope: string[] }
> = {
  stated: {
    definition: [
      "- **stated** — what the user/docs SAY it is for (cite the doc/comment).",
    ],
    scope: [
      "Read ONLY docs / specs / READMEs / header comments for the subsystem's",
      "files; cite the doc. Do NOT open the implementation to guess intent.",
    ],
  },
  inferred: {
    definition: [
      "- **inferred** — YOUR model of that intent (where you read between the lines).",
    ],
    scope: [
      "Reason about intent from the subsystem's shape + docs; your model of what",
      "it is FOR, read between the lines.",
    ],
  },
  revealed: {
    definition: [
      "- **revealed** — what the code actually optimizes for (cite the code). This is",
      "  the objective anchor — far more extractable than any intent charter.",
    ],
    scope: [
      "Read ONLY the subsystem's CODE; cite code. Do NOT read the docs/READMEs —",
      "anchor purely on what the implementation optimizes for.",
    ],
  },
  true: {
    definition: [
      "- **true** — the *shining city* ideal the user may be unaware of. NOMINATABLE,",
      "  NEVER ASSERTED. It MUST name a concrete alternative AND a concrete cost the",
      '  user seems to pay unaware ("Quicken exists; you\'re rebuilding a worse one")',
      "  or it is dropped as slop. Framed as a provocation, never a verdict.",
    ],
    scope: [
      "The shining-city provocation: a concrete alternative + the cost paid",
      "unaware. Nominate only if certain — a nomination without a concrete",
      "alternative AND cost is slop and will be dropped.",
    ],
  },
};

/**
 * Render ONE kind's lane prompt. The lane is blind by construction: it carries
 * only its own kind's definition, scope, and submission path.
 */
export function renderCharterKindLanePrompt(
  bundle: ArtifactBundle,
  opts: { kind: CharterKind; submissionPath: string },
): string {
  const consensus = bundle.structure_decomposition?.consensus ?? [];
  const lane = KIND_LANE_TEXT[opts.kind];

  const subsystemLines = consensus.length
    ? consensus.map((node) => {
        const preview = node.members.slice(0, 12).join(", ");
        const more =
          node.members.length > 12 ? ` (+${node.members.length - 12} more)` : "";
        return `- **${node.node_id}** — ${node.members.length} file(s): ${preview}${more}`;
      })
    : ["- (no confident subsystems were found — submit an empty `subsystems` array)"];

  return [
    `# Design review — charter extraction, **${opts.kind}** lane (conceptual, teleological)`,
    "",
    "You are authoring ONE kind of charter in the **charter layer** of the",
    'conceptual design review: not "is this module correct/clean" but *"what is',
    'this subsystem FOR, and does it serve that purpose as well as a better',
    'design could."*',
    "",
    "For each confident subsystem below, state its charter of this ONE kind, a",
    "purpose in **telos terms — never mechanism**. A charter that merely restates",
    'the code ("it manages quota") is useless — the delta against the impl collapses',
    'to zero. State the telos ("exists so N cooperating auditors extract max value',
    'from finite provider budgets"). Your kind:',
    "",
    ...lane.definition,
    "",
    "## Your access scope (this lane is BLIND to the other kinds)",
    "",
    ...lane.scope,
    "",
    "You are one of several independent, blind lanes (one per charter kind); do",
    "NOT read another lane's prompt or output, and do NOT author any kind other",
    "than your own. Tag each charter's `confidence`. You author charters ONLY —",
    "an INDEPENDENT delta-miner reads them in a later pass and mines the gaps",
    "between kinds (no author marks its own homework), so do NOT emit deltas.",
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
    `Write your submission as JSON to \`${opts.submissionPath}\` with this shape`,
    `(every charter's \`kind\` MUST be \`"${opts.kind}"\` — any other kind refuses the lane):`,
    "",
    "```json",
    "{",
    '  "subsystems": [',
    "    {",
    '      "node_id": "<one of the subsystems above>",',
    '      "charters": [',
    `        { "kind": "${opts.kind}", "purpose": "<telos, not mechanism>",`,
    '          "provenance": [{ "kind": "doc|code|comment|inferred|...", "ref": "<path/id>", "quote": "<optional>" }],',
    '          "confidence": "high|medium|low"',
    ...(opts.kind === "true"
      ? ['          , "nominated_alternative": "...", "nominated_cost": "..." }']
      : ["        }"]),
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
    "",
  ].join("\n");
}
