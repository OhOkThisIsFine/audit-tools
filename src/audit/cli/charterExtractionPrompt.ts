// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
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
 * The provenance kind(s) a lane's worked example cites, per channel (P2.5):
 * - **stated** (testimony) cites `doc` and `comment` only — README/doc/comment
 *   testimony, never a code symbol or a class body.
 * - **structural** (declarations) cites `code` refs naming declarations — a
 *   `<path>#<symbol>` and a top-level declaration line, no bodies.
 * - **revealed** (behavior) cites `code` refs naming behavior symbols and body
 *   lines — what the code DOES.
 *
 * Every literal is checked against the schema here rather than trusted, so an
 * enum rename cannot leave a stale example behind.
 */
function exampleProvenanceKinds(kind: EstimatorCharterKind): string[] {
  const literals: string[] = kind === "stated" ? ["doc", "comment"] : ["code"];
  const allowed: readonly string[] = CharterProvenanceSchema.shape.kind.options;
  for (const literal of literals) {
    if (!allowed.includes(literal)) {
      throw new Error(
        `charter prompt example provenance kind "${literal}" is absent from CharterProvenanceSchema (${PROVENANCE_KINDS})`,
      );
    }
  }
  return literals;
}

/**
 * The worked JSON example for ONE lane, rendered lane-specifically so the host
 * sees the evidence channel its own kind actually receives (P2.5). The example is
 * a VALID submission: every node/edge/provenance literal is schema-admissible, so
 * a host that copies it verbatim satisfies `CharterSubmissionSchema`.
 */
function exampleSubmission(opts: { kind: EstimatorCharterKind }): string {
  const [docKind, commentKind] = exampleProvenanceKinds(opts.kind);
  const stated = opts.kind === "stated";
  // Stated cites testimony — a doc `ref` (node0 + edge) and a comment `ref`
  // (node1). Structural cites code DECLARATIONS; revealed cites code BEHAVIOR.
  // The difference between those two is WHAT the ref/quote names, not the kind.
  const refs = stated
    ? {
        node0Ref: "docs/scheduling.md#promises",
        node0Quote: "every delivery window we offer the customer, we will keep",
        node1Ref: "src/scheduling/window.ts",
        node1Quote: "DeliveryWindow exists so a dispatcher never over-promises",
        edgeQuote: "the window a dispatcher arms is the promise the platform keeps",
      }
    : opts.kind === "structural"
      ? {
          node0Ref: "src/scheduling/promise.ts#Promise",
          node0Quote: "class Promise {",
          node1Ref: "src/scheduling/window.ts#DeliveryWindow",
          node1Quote: "class DeliveryWindow {",
          edgeQuote: "class DeliveryWindow {",
        }
      : {
          node0Ref: "src/scheduling/rebook.ts#rebookOnMiss",
          node0Quote: "function rebookOnMiss(",
          node1Ref: "src/scheduling/rebook.ts#rebookOnMiss",
          node1Quote: "function rebookOnMiss(",
          edgeQuote: "rebookOnMiss(window)",
        };
  return JSON.stringify(
    {
      nodes: [
        {
          node_id: "promises-the-customer-can-trust",
          purpose:
            "Makes every commitment the service gives a customer one it can honour",
          ...(stated ? {} : { files: ["src/scheduling/promise.ts"] }),
          provenance: [
            { kind: docKind, ref: refs.node0Ref, quote: refs.node0Quote },
          ],
          confidence: "medium",
        },
        {
          node_id: "keepable-delivery-windows",
          purpose:
            "Lets a dispatcher promise a delivery window the fleet can actually keep",
          ...(stated
            ? {}
            : { files: ["src/scheduling/window.ts", "src/scheduling/fleet.ts"] }),
          provenance: [
            {
              kind: stated ? commentKind : docKind,
              ref: refs.node1Ref,
              quote: refs.node1Quote,
            },
          ],
          confidence: "high",
        },
      ],
      edges: [
        {
          from: "keepable-delivery-windows",
          to: "promises-the-customer-can-trust",
          provenance: [{ kind: docKind, ref: refs.node0Ref, quote: refs.edgeQuote }],
        },
      ],
    },
    null,
    2,
  );
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
export function renderCharterKindLanePrompt(opts: {
  kind: EstimatorCharterKind;
  submissionPath: string;
  packetPath: string;
}): string {
  const lane = KIND_LANE_TEXT[opts.kind];

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
    "Its `## Provenance manifest` block names every excerpt the packet delivered, and every content line",
    "carries its source line number as a prefix (`  12| class DeliveryWindow {`). That prefix is the",
    "packet's own formatting, not part of the file: STRIP it before you copy a quote, and never cite a",
    "line number. Cite only material the packet shows you. The packet is SUFFICIENT — you never leave it",
    "to cite correctly.",
    "",
    "## Build your goal graph",
    "",
    "Organize the purposes you find into one directed graph with no cycles. An edge `from → to` means the child purpose SERVES the parent purpose. A purpose may serve more than one parent. The tool derives each node's level from your edges.",
    "",
    "Each node carries:",
    "- `node_id` — a short slug you choose; it is local to this submission.",
    "- `purpose` — the purpose statement (the WHY, not the WHAT).",
    "- `provenance` — evidence citations. Each one names a SYMBOL or a file, and carries the literal text you copied. Never a line number.",
    "- `confidence` — `\"high\"` | `\"medium\"` | `\"low\"`.",
    lane.filesRule,
    "",
    "Each edge carries `from`, `to`, and `provenance` for the relationship itself.",
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
    exampleSubmission({ kind: opts.kind }),
    "```",
    "",
    "- `nodes` and `edges` are the whole submission. Do not add a field the example does not show. The tool knows which lane you are from the path it gave you.",
    `- \`provenance[].kind\`: one of \`${PROVENANCE_KINDS.split("|").join("`, `")}\`.`,
    "- `provenance[].ref` names a SYMBOL — `<path>#<symbol>`, the form to prefer — or, when no symbol names your claim, the bare `<path>`. A non-path source is its own bare id. NEVER a line number: a line number drifts as the file changes, and a drifted number cannot be repaired, only deleted.",
    "- `provenance[].quote` is the literal text you COPIED from your packet, character for character, without the packet's line-number prefix. The tool re-reads that text from the file, so the quote — not the reference — is what makes your citation checkable. Never paraphrase it. Never write a quote you did not copy.",
    "- QUOTE whenever your packet gave you text to quote. Two cases are refused: a `ref` naming a symbol (`<path>#<symbol>`) with no quote, and a citation of any file your `## Provenance manifest` lists as an excerpt with no quote. In both, the packet handed you the text and the claim is unverifiable without it.",
    "- The ONE case that takes no quote: a file your packet names in its file tree and excerpts nowhere. You were shown its path only, so cite the bare `<path>` and write no quote. Do not invent one — an invented quote is the worst thing you can submit here.",
    "- Every `from` and `to` names a `node_id` in this submission.",
    "",
  ].join("\n");
}
