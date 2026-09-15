// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import { CharterProvenanceSchema } from "audit-tools/shared";
import type { Ceiling, CharterLaneKind } from "audit-tools/shared";

/** The provenance-kind alternation, DERIVED from the schema at render time. */
const PROVENANCE_KINDS = CharterProvenanceSchema.shape.kind.options.join("|");

/**
 * Per-kind charter-extraction LANE prompts (step 1 of the charter layer; approved
 * host text: docs/reviews/prompt-refinement-2026-09-13.md §8). The host supplies
 * JUDGMENT — one goal DAG per lane, purposes in TELOS terms, edges meaning
 * `from` SERVES `to`, evidence on nodes and edges — while the tool supplies
 * ENFORCEMENT at ingest (packet feeding, universe grounding, cycle refusal, level
 * derivation, citation checking, candidate correspondences).
 *
 * Channel purity is a property of the INPUT: each lane's prompt points at a
 * tool-materialized evidence PACKET holding only that channel's material, so
 * blindness never depends on an agent obeying a "do not read X" instruction.
 * `true` is NOT a lane. Lane prompts are ADVANCE-FREE (no continue-command).
 */

/** The three estimator kinds — every extraction lane; never `true`. */
export type EstimatorCharterKind = CharterLaneKind;

/**
 * The extraction kinds a run's ceiling requests, in canonical order. The three
 * estimator channels extract at every charter-authorizing ceiling; `deepest`
 * changes what may be nominated downstream, never the lane set.
 */
export function charterExtractionKindsForCeiling(
  _ceiling: Ceiling,
): EstimatorCharterKind[] {
  return ["stated", "structural", "revealed"];
}

/** Per-kind perspective line, packet description, and the `files` rule (scope follows the evidence). */
const KIND_LANE_TEXT: Record<
  EstimatorCharterKind,
  { perspective: string; packet: string; filesRule: string }
> = {
  stated: {
    perspective: "- **stated** — TESTIMONY: what docs and comments say the code is for.",
    packet:
      "Your packet holds the repo's doc files plus the comments extracted from each subsystem file — testimony only, no code.",
    filesRule:
      "- `files` — optional; include only the repo-relative files your evidence itself names. Docs name goals and symbols, rarely files; do not guess a scope.",
  },
  structural: {
    perspective:
      "- **structural** — intent FROZEN INTO ORGANIZATION: what the file tree, names, declarations and dependency edges say the code is for.",
    packet:
      "Your packet holds the file tree, the dependency edges among files, and each file's top-level declaration lines — organization only: no bodies, no docs, no comments.",
    filesRule:
      "- `files` — the in-scope files that implement this purpose, as relative paths exactly as your packet names them.",
  },
  revealed: {
    perspective:
      "- **revealed** — BEHAVIOR: what the code actually optimizes for. This is the objective anchor.",
    packet:
      "Your packet holds each subsystem file's comment-stripped source — behavior only, no testimony.",
    filesRule:
      "- `files` — the in-scope files that implement this purpose, as relative paths exactly as your packet names them.",
  },
};

/**
 * Render ONE kind's lane prompt. The lane is blind by construction: it carries
 * only its own kind's perspective, its materialized evidence packet, and its
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
    : ["- (no confident subsystems were found — organize the goal graph yourself)"];

  return [
    `# Design review — charter extraction, **${opts.kind}** lane (conceptual, teleological)`,
    "",
    "You are authoring a high-level conceptual design review: not \"is this module correct/clean\" but",
    "*\"what is this code FOR, and does it serve that purpose as well as a better design could.\"*",
    "",
    "Three independent, blind lanes each build their own goal graph from ONE evidence channel:",
    "**stated** (docs and comments), **structural** (file tree, declarations, imports), **revealed**",
    `(comment-stripped code). You are the **${opts.kind}** lane; you see only its packet and never the other two graphs.`,
    "",
    "Your review perspective:",
    lane.perspective,
    "",
    "## Core Concepts: Purpose vs. Mechanism",
    "",
    "- **Purpose (Telos / The WHY)**: The problem this code exists to solve for users or the system.",
    "- **Mechanism (The WHAT / HOW)**: The specific technical implementation.",
    "",
    "- *Telos (DO emit)*: *\"Ensures independent audit workers fairly share provider quotas without starving critical security checks.\"*",
    "- *Mechanism (do NOT emit)*: *\"Manages rate limits using a Redis token bucket.\"* A purpose that restates the code cannot show an architectural gap.",
    "",
    "## Your evidence packet",
    "",
    `Read \`${opts.packetPath}\` — it holds the evidence for this review. Cite claims from this packet by symbol and literal quote, not by line number; you do not need to open files outside it.`,
    "",
    lane.packet,
    "",
    "Its `## Provenance manifest` block names every excerpt with the exact line runs delivered, and every",
    "content line is prefixed with its TRUE line number in its own source file (`  12| …`). COPY a",
    "citation from there; never count lines, never infer them, and never cite a range that spans two runs.",
    "",
    "## Build your goal graph",
    "",
    "Organize the purposes you find into one directed graph with no cycles. An edge `from → to` means the child purpose SERVES the parent purpose. A purpose may serve more than one parent. The tool derives each node's level from your edges.",
    "",
    "Each node carries:",
    "- `node_id` — a short slug you choose; it is local to this submission.",
    "- `purpose` — the telos statement (the WHY, not the WHAT).",
    "- `provenance` — evidence citations: `<path>#<symbol>` with a literal quote, or `<path>:<line>` for comments and unnamed blocks.",
    "- `confidence` — `\"high\"` | `\"medium\"` | `\"low\"`.",
    lane.filesRule,
    "",
    "Each edge carries `from`, `to`, and `provenance` for the relationship itself.",
    "",
    "A suggested scaffold from structure analysis (a hint — adjust boundaries where evidence supports it):",
    ...hintLines,
    "",
    "You author teleology ONLY — do NOT review code correctness.",
    "",
    "## Anti-slop discipline (do NOT emit)",
    "- No **restated-mechanism** purposes; describe the WHY, not the WHAT.",
    "- No **generic** telos any subsystem could claim; be specific to THIS code.",
    "- No **fabricated profundity**; every node and edge cites provenance from your packet.",
    "- No files outside your packet; the limited view is intentional.",
    "",
    "## Output",
    "",
    `Write your submission as JSON to \`${opts.submissionPath}\`:`,
    "",
    "```json",
    "{",
    `  "kind": "${opts.kind}",`,
    '  "nodes": [',
    "    {",
    '      "node_id": "quota-fairness",',
    '      "purpose": "Ensures independent audit workers fairly share provider quotas without starving critical security checks",',
    ...(opts.kind === "stated"
      ? []
      : ['      "files": ["src/dispatch/quota.ts", "src/dispatch/pool.ts"],']),
    `      "provenance": [{ "kind": "${PROVENANCE_KINDS}", "ref": "src/dispatch/quota.ts#QuotaManager", "quote": "class QuotaManager {" }],`,
    '      "confidence": "high"',
    "    }",
    "  ],",
    '  "edges": [',
    "    {",
    '      "from": "quota-fairness",',
    '      "to": "trustworthy-audits",',
    `      "provenance": [{ "kind": "${PROVENANCE_KINDS}", "ref": "src/dispatch/quota.ts:12", "quote": "so no lens is starved" }]`,
    "    }",
    "  ]",
    "}",
    "```",
    "",
    `- \`kind\`: Must be \`"${opts.kind}"\`.`,
    `- \`provenance[].kind\`: one of \`${PROVENANCE_KINDS.split("|").join("`, `")}\`.`,
    "- `provenance[].ref` is COPIED verbatim from ONE line run in your packet's manifest — `<path>:<startLine>-<endLine>` for a run, `<path>:<N>` for a single line, the bare `<path>` when the claim names no lines, or a bare id for a non-path source. The packet is SUFFICIENT: you never leave it to cite correctly.",
    "- Every `from` and `to` names a `node_id` in this submission.",
    "",
  ].join("\n");
}
