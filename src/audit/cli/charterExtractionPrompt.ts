import type { ArtifactBundle } from "../io/artifacts.js";
import { CharterProvenanceSchema } from "audit-tools/shared";
import type { Ceiling, CharterKind } from "audit-tools/shared";

/** The provenance-kind alternation, DERIVED from the schema at render time. */
const PROVENANCE_KINDS = CharterProvenanceSchema.shape.kind.options.join("|");

/**
 * Per-kind charter-extraction LANE prompts (Phase C.1). The host supplies
 * JUDGMENT (a self-organized leveled teleology per lane, in TELOS terms) while
 * the tool supplies ENFORCEMENT (packet feeding, universe grounding, the
 * file-set-overlap join, id assignment, the Phase-A True gate, per-lane kind
 * purity) at ingest.
 *
 * Channel purity is a property of the INPUT (design resolution 4): each lane's
 * prompt points at a tool-materialized evidence PACKET holding only that
 * channel's material (stated → docs + extracted comments; structural → tree /
 * edges / declarations; revealed → comment-stripped bodies), so blindness never
 * depends on an agent obeying a "do not read X" instruction. `true` is NOT a
 * lane — it is nominated by the independent delta miner at the deepest rung,
 * downstream of triangulation. Lane prompts are ADVANCE-FREE (no
 * continue-command).
 */

/** The three estimator kinds — every extraction lane; never `true`. */
export type EstimatorCharterKind = Exclude<CharterKind, "true">;

/**
 * The extraction kinds a run's ceiling requests, in canonical order. The three
 * estimator channels extract at every charter-authorizing ceiling; `deepest`
 * changes what the MINER may do (True nominations), never the lane set.
 */
export function charterExtractionKindsForCeiling(
  _ceiling: Ceiling,
): EstimatorCharterKind[] {
  return ["stated", "structural", "revealed"];
}

/** Per-kind definition + channel description (what the packet holds and means). */
const KIND_LANE_TEXT: Record<
  EstimatorCharterKind,
  { definition: string[]; channel: string[] }
> = {
  stated: {
    definition: [
      "- **stated** — TESTIMONY: what the docs and comments SAY the code is for",
      "  (cite the doc/comment).",
    ],
    channel: [
      "Your packet holds the repo's doc files plus the comments extracted from",
      "each subsystem file — testimony only, no code. Cite the doc/comment you",
      "read each claim from.",
    ],
  },
  structural: {
    definition: [
      "- **structural** — intent FROZEN INTO ORGANIZATION: what the file tree,",
      "  names, declarations and dependency edges say the code is for.",
    ],
    channel: [
      "Your packet holds the file tree, the dependency edges among files, and",
      "each file's top-level declaration lines — organization only: no bodies,",
      "no docs, no comments. Read intent from how the code is ARRANGED.",
    ],
  },
  revealed: {
    definition: [
      "- **revealed** — BEHAVIOR: what the code actually optimizes for (cite the",
      "  code). This is the objective anchor — far more extractable than any",
      "  intent charter.",
    ],
    channel: [
      "Your packet holds each subsystem file's comment-stripped source —",
      "behavior only, no testimony. Anchor purely on what the implementation",
      "does and optimizes for.",
    ],
  },
};

/**
 * Render ONE kind's lane prompt. The lane is blind by construction: it carries
 * only its own kind's definition, its materialized evidence packet, and its
 * submission path.
 */
export function renderCharterKindLanePrompt(
  bundle: ArtifactBundle,
  opts: {
    kind: EstimatorCharterKind;
    submissionPath: string;
    packetPath: string;
  },
): string {
  const consensus = bundle.structure_decomposition?.consensus ?? [];
  const lane = KIND_LANE_TEXT[opts.kind];

  const hintLines = consensus.length
    ? consensus.map((node) => {
        const preview = node.members.slice(0, 12).join(", ");
        const more =
          node.members.length > 12 ? ` (+${node.members.length - 12} more)` : "";
        return `- ${node.members.length} file(s): ${preview}${more}`;
      })
    : ["- (no confident subsystems were found — organize the teleology yourself)"];

  return [
    `# Design review — charter extraction, **${opts.kind}** lane (conceptual, teleological)`,
    "",
    "You are authoring ONE channel's view in the **charter layer** of the",
    'conceptual design review: not "is this module correct/clean" but *"what is',
    'this code FOR, and does it serve that purpose as well as a better design',
    'could."* Your channel:',
    "",
    ...lane.definition,
    "",
    "## Your evidence packet (this lane is BLIND to the other channels)",
    "",
    `Read \`${opts.packetPath}\` — it is your ONLY input, materialized by the`,
    "tool to hold exactly this channel's evidence. Do NOT read repository files",
    "directly, and do NOT read another lane's prompt, packet, or output.",
    "",
    ...lane.channel,
    "",
    "## Self-organize a leveled teleology",
    "",
    "From your channel's evidence alone, organize the purposes you see into a",
    "LEVELED teleology: a set of nodes, each stating a purpose in **telos terms —",
    'never mechanism** ("exists so N cooperating auditors extract max value from',
    'finite provider budgets", never "it manages quota" — a purpose that merely',
    "restates the code collapses the delta against the impl to zero). Each node",
    "carries:",
    "- `purpose` — the telos statement.",
    "- `premise_height` — YOUR level for it: 0 = the repo-level telos, higher =",
    "  closer to a leaf mechanism. Levels are yours to organize; use as many or",
    "  as few as the evidence supports (never force a fixed depth).",
    "- `files` — the node's FILE SCOPE: the packet files this purpose covers,",
    "  as repo-relative paths exactly as the packet names them. The tool joins",
    "  your teleology to the other channels' mechanically by file-set overlap —",
    "  a scope citing a file the repo does not contain refuses the lane.",
    "",
    "A suggested scaffold from the structure decomposition (a HINT — you may",
    "organize different boundaries where your evidence supports them):",
    ...hintLines,
    "",
    "You are one of several independent, blind lanes (one per channel). Tag each",
    "node's `confidence`. You author teleology ONLY — an INDEPENDENT delta-miner",
    "reads all channels in a later pass and mines the gaps between them (no",
    "author marks its own homework), so do NOT emit deltas or comparisons.",
    "",
    "## Anti-slop discipline (do NOT emit)",
    "- No **restated-mechanism** purposes (the delta collapses to zero).",
    "- No **generic** telos any subsystem could claim; be specific to THIS code.",
    "- No **fabricated profundity** — every node cites provenance from YOUR",
    "  channel (revealed cites code, stated cites a doc/comment, structural cites",
    "  the arrangement it reads intent from).",
    "- No files outside your packet — scopes are grounded against the repo and an",
    "  unknown path refuses the whole lane.",
    "",
    "## Output",
    `Write your submission as JSON to \`${opts.submissionPath}\` with this shape`,
    `(every node's \`kind\` MUST be \`"${opts.kind}"\` — any other kind refuses the lane):`,
    "",
    "```json",
    "{",
    '  "nodes": [',
    "    {",
    `      "kind": "${opts.kind}",`,
    '      "purpose": "<telos, not mechanism>",',
    '      "premise_height": 0,',
    '      "files": ["<repo-relative path>", "..."],',
    // Closed enum, exhaustive, NO trailing ellipsis — DERIVED from
    // CharterProvenanceSchema at render time, so a schema enum change flows into
    // the prompt automatically; the behavioral pin in
    // tests/shared/prompt-renders-its-contract.test.ts holds exhaustiveness and
    // closedness of the RENDERED text instead of teaching a worker a smaller
    // contract (an open list here coined a member and quarantined a 34-minute
    // lane run).
    `      "provenance": [{ "kind": "${PROVENANCE_KINDS}", "ref": "<path/id>", "quote": "<optional>" }],`,
    '      "confidence": "high|medium|low"',
    "    }",
    "  ]",
    "}",
    "```",
    "",
  ].join("\n");
}
