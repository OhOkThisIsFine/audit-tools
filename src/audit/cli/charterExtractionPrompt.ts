// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import { CharterProvenanceSchema } from "audit-tools/shared";
import type { Ceiling, CharterLaneKind } from "audit-tools/shared";

/** The provenance-kind alternation, DERIVED from the schema at render time. */
const PROVENANCE_KINDS = CharterProvenanceSchema.shape.kind.options.join("|");

/**
 * Per-kind charter-extraction LANE prompts (step 1 of the charter layer; host text
 * reviewed by the owner on 2026-09-17, recorded in
 * docs/reviews/prompt-refinement-2026-09-13.md §8 — the earlier "approved" label
 * was DERIVED from the approved charter design, never given to this text). The host supplies
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

/**
 * The ONE provenance kind a lane's worked example carries. An example must be a
 * VALID submission: rendering the whole alternation into the example's `kind`
 * value taught the host a value the strict enum rejects. The literal is checked
 * against the schema here rather than trusted, so an enum rename cannot leave a
 * stale example behind.
 */
function exampleProvenanceKind(kind: EstimatorCharterKind): string {
  const literal = kind === "stated" ? "doc" : "code";
  const allowed: readonly string[] = CharterProvenanceSchema.shape.kind.options;
  if (!allowed.includes(literal)) {
    throw new Error(
      `charter prompt example provenance kind "${literal}" is absent from CharterProvenanceSchema (${PROVENANCE_KINDS})`,
    );
  }
  return literal;
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
  const exampleKind = exampleProvenanceKind(opts.kind);

  const hintLines = consensus.length
    ? consensus.map((node) => {
        const preview = node.members.slice(0, 12).join(", ");
        const more =
          node.members.length > 12 ? ` (+${node.members.length - 12} more)` : "";
        return `- ${node.members.length} file(s): ${preview}${more}`;
      })
    : ["- (no confident subsystems were found — organize the goal graph yourself)"];

  return [
    `# Design review — charter extraction, the **${opts.kind}** lane`,
    "",
    "You are authoring a high-level design review. The question is not \"is this module correct or",
    "clean\" but *\"what is this code FOR, and does it serve that purpose as well as a better design",
    "could.\"* You author purpose only. Do not review code correctness.",
    "",
    "Three independent, blind lanes each build their own goal graph from ONE evidence channel:",
    "**stated** (docs and comments), **structural** (file tree, declarations, imports), **revealed**",
    `(comment-stripped code). You are the **${opts.kind}** lane; you see only its packet and never the other two graphs.`,
    "",
    "Your review perspective:",
    lane.perspective,
    "",
    "## Purpose against mechanism",
    "",
    "- **Purpose (the WHY)**: the problem this code exists to solve for its users or for the system.",
    "- **Mechanism (the WHAT and the HOW)**: the technical implementation that solves it.",
    "",
    "Every example in this prompt is drawn from an UNRELATED codebase — a delivery-scheduling",
    "service — so that you do not pattern-match it onto the code you are reviewing.",
    "",
    "- *Purpose (DO emit)*: *\"Lets a dispatcher promise a delivery window the fleet can actually keep.\"*",
    "- *Mechanism (do NOT emit)*: *\"Keeps delivery windows in a sorted set keyed by driver id.\"* A purpose that restates the code cannot show an architectural gap.",
    "",
    "## Your evidence packet",
    "",
    `Read \`${opts.packetPath}\`. It holds all the evidence for this review, and it is the only material you may use. Do not open a file outside it: the limited view is deliberate, and it is what makes your lane independent of the other two.`,
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
    "- `purpose` — the purpose statement (the WHY, not the WHAT).",
    "- `provenance` — evidence citations: `<path>#<symbol>` with a literal quote, or `<path>:<line>` for comments and unnamed blocks.",
    "- `confidence` — `\"high\"` | `\"medium\"` | `\"low\"`.",
    lane.filesRule,
    "",
    "Each edge carries `from`, `to`, and `provenance` for the relationship itself.",
    "",
    "A suggested scaffold from structure analysis (a hint — adjust boundaries where evidence supports it):",
    ...hintLines,
    "",
    "## Do not emit",
    "",
    "- No **restated mechanism**: describe the WHY, not the WHAT.",
    "- No **generic purpose** that any subsystem could claim: be specific to THIS code.",
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
    '      "node_id": "promises-the-customer-can-trust",',
    '      "purpose": "Makes every commitment the service gives a customer one it can honour",',
    ...(opts.kind === "stated"
      ? []
      : ['      "files": ["src/scheduling/promise.ts"],']),
    `      "provenance": [{ "kind": "${exampleKind}", "ref": "src/scheduling/promise.ts#Promise", "quote": "class Promise {" }],`,
    '      "confidence": "medium"',
    "    },",
    "    {",
    '      "node_id": "keepable-delivery-windows",',
    '      "purpose": "Lets a dispatcher promise a delivery window the fleet can actually keep",',
    ...(opts.kind === "stated"
      ? []
      : [
          '      "files": ["src/scheduling/window.ts", "src/scheduling/fleet.ts"],',
        ]),
    `      "provenance": [{ "kind": "${exampleKind}", "ref": "src/scheduling/window.ts#DeliveryWindow", "quote": "class DeliveryWindow {" }],`,
    '      "confidence": "high"',
    "    }",
    "  ],",
    '  "edges": [',
    "    {",
    '      "from": "keepable-delivery-windows",',
    '      "to": "promises-the-customer-can-trust",',
    `      "provenance": [{ "kind": "${exampleKind}", "ref": "src/scheduling/window.ts:12", "quote": "a promised window is never silently missed" }]`,
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
