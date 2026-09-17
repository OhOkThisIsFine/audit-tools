// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import { CharterProvenanceSchema } from "audit-tools/shared";
import type { CorrespondenceCandidate } from "audit-tools/shared";

/** The provenance-kind alternation, DERIVED from the schema at render time. */
const PROVENANCE_KINDS = CharterProvenanceSchema.shape.kind.options
  .map((k) => `\`${k}\``)
  .join(", ");

/**
 * Render the charter-COMPARISON host prompt (steps 2–3; host text reviewed by the
 * owner on 2026-09-17, recorded in docs/reviews/prompt-refinement-2026-09-13.md §9
 * — the earlier "approved" label was DERIVED from the approved charter design,
 * never given to this text). The host is the comparison reader: it authored none of
 * the three lane DAGs; it confirms, rejects, widens or adds correspondences over the
 * tool's candidates and records the typed differences. Routing, severity and
 * finding-ness are never mentioned — the tool routes by the fixed table and the
 * fidelity lane gates findings.
 *
 * Every rule the ingest validator enforces is STATED here, because obedience has to
 * be sufficient: a reader that follows this prompt must produce a submission the
 * tool accepts. Two rules were previously unstated — the silent-channel omission a
 * `presence` difference needs, and the two-different-sides evidence test an added
 * correspondence must pass. The first was also unsatisfiable on a two-channel
 * correspondence until the account minimum became conditional on the dimension
 * (`DifferenceInputSchema`, owner 2026-09-17).
 */
export function renderCharterComparisonPrompt(
  bundle: ArtifactBundle,
  opts: {
    submissionPath: string;
    laneGraphPaths: Record<"stated" | "structural" | "revealed", string>;
  },
): string {
  const candidates: CorrespondenceCandidate[] = bundle.charter_register?.candidates ?? [];
  const candidateLines = candidates.length
    ? candidates.map((c) => {
        const [a, b] = c.members;
        const basis =
          c.basis === "file_overlap"
            ? `file overlap: ${c.evidence_paths.join(", ")}`
            : `cross-ref: ${c.evidence_paths.join(", ")}`;
        return `- \`${c.candidate_id}\` — ${a!.kind}:\`${a!.node_ids.join(",")}\` ↔ ${b!.kind}:\`${b!.node_ids.join(",")}\` (basis: ${basis})`;
      })
    : ["- (the tool found no candidates — add any correspondence you can evidence, or affirm the empty result described under **Output**)"];

  return [
    "# Design review — charter comparison",
    "",
    "Three readers each built a goal graph of this repository from one evidence channel:",
    "**stated** (docs and comments), **structural** (file tree, declarations, imports), **revealed**",
    "(comment-stripped code). Edges mean `from` SERVES `to`. You authored none of them. Your job is to",
    "say which parts of the three graphs speak about the same thing, and how their accounts differ.",
    "Do not merge the graphs and do not write a unified purpose; the three accounts stay separate.",
    "",
    "## The three goal graphs",
    "",
    "Read them at:",
    `- stated: \`${opts.laneGraphPaths.stated}\``,
    `- structural: \`${opts.laneGraphPaths.structural}\``,
    `- revealed: \`${opts.laneGraphPaths.revealed}\``,
    "",
    "Each node carries a `premise_height` the tool DERIVED from that lane's edges: 0 is the top",
    "purpose, and a higher number is closer to a mechanism. Where a rule below says *the same level*,",
    "it means the same `premise_height`. Never recompute one.",
    "",
    "## Candidate correspondences (tool-proposed)",
    "",
    "Each candidate pairs regions the tool found related by file overlap or by a provenance",
    "cross-reference. Confirm, reject, or widen each one; add any the tool missed.",
    "",
    ...candidateLines,
    "",
    "One verdict per candidate:",
    "- `confirm` — the pairing is right as proposed.",
    "- `reject` — the pairing is wrong. The tool drops it and records nothing.",
    "- `widen` — the pairing is right but incomplete. List the FULL member set you mean, including the",
    "  nodes the candidate already named: the tool builds the correspondence from your `members` and",
    "  never from the candidate, so a member you leave out is a member you drop.",
    "",
    "Rules:",
    "- A correspondence may join one node to one node, several nodes, or a connected subgraph on the other side.",
    "- A correspondence must span at least two channels. Every `node_id` must exist in the graph of the channel you name it under.",
    "- A correspondence you ADD (one with no `candidate_id`) must carry at least two evidence refs that",
    "  reach two DIFFERENT sides. A ref reaches a channel's side when its path appears in the `files`",
    "  scope of one of that channel's named nodes; a ref whose path no named node scopes counts as its",
    "  own side. Two refs inside one node's scope are ONE side. Every ref's path must exist in the",
    "  repository. The tool re-checks all of this and drops a correspondence with fewer than two sides.",
    "- A node that matches nothing stays uncorresponded. Do not force a match.",
    "",
    "## Differences",
    "",
    "For every confirmed correspondence, record each way the accounts differ. File each difference on",
    "exactly one dimension; the rule says when it belongs there and not elsewhere:",
    "",
    "| Dimension | File here when |",
    "|---|---|",
    "| `purpose` | Holding the subsystem fixed, the goal labels still contradict (an explicit non-goal against a pursued goal files here) |",
    "| `presence` | One channel of the correspondence has no node for the goal at that `premise_height`, and it should have |",
    "| `responsibility` | Goal labels match, owner or location differs |",
    "| `hierarchy` | The node matches, the parents or subgoals differ |",
    "| `scope` | Adding a when / for-whom / to-what-extent qualifier reconciles the claims |",
    "| `standing` | The claims reconcile once versioned in time: planned, active, deprecated, removed |",
    "| `standard` | Both agree on what and where, disagree on how well |",
    "",
    "Give each difference one `accounts` entry per channel that HAS an account, and one `relation`",
    "judged across all of them: `equivalent` (same claim, other words), `complementary` (no account",
    "contradicts another), or `incompatible` (some two cannot both hold). An `incompatible` difference",
    "also carries a `split`: `two_against_one` naming the odd channel, or `three_way`. Any other",
    "relation carries no `split` at all. Every dimension except `presence` needs an account from at",
    "least two channels: one account contradicts nothing, so it is not a difference.",
    "",
    "A `presence` difference is the ONE case where a channel of the correspondence gets no account:",
    "leave the silent channel out of `accounts` entirely — its absence is how the tool identifies it,",
    "and the route depends on which channel it is. Leave out exactly ONE channel. An account for every",
    "channel says nothing is absent, and two omissions leave the tool nothing to route on; the tool",
    "refuses both. Then set `covered_channel_gap` to `true` when the silent channel's own evidence",
    "should have covered this goal, and `false` when its silence is expected.",
    "",
    "## Output",
    "",
    `Write your submission as JSON to \`${opts.submissionPath}\`:`,
    "",
    "```json",
    "{",
    '  "correspondences": [',
    "    {",
    '      "verdict": "confirm",',
    '      "members": [',
    '        { "kind": "stated", "node_ids": ["keepable-delivery-windows"] },',
    '        { "kind": "structural", "node_ids": ["window-module"] },',
    '        { "kind": "revealed", "node_ids": ["window-solver", "fleet-capacity"] }',
    "      ],",
    '      "evidence": [',
    '        { "kind": "doc", "ref": "docs/scheduling.md#Goals", "quote": "never promise a window the fleet cannot keep" },',
    '        { "kind": "code", "ref": "src/scheduling/window.ts#DeliveryWindow", "quote": "class DeliveryWindow {" },',
    '        { "kind": "code", "ref": "src/scheduling/fleet.ts#capacityFor", "quote": "export function capacityFor" }',
    "      ]",
    "    }",
    "  ],",
    '  "differences": [',
    "    {",
    '      "correspondence": 0,',
    '      "dimension": "standing",',
    '      "relation": "incompatible",',
    '      "split": { "kind": "two_against_one", "odd": "stated" },',
    '      "accounts": [',
    '        { "kind": "stated", "claim": "Same-day windows are planned", "provenance": [{ "kind": "doc", "ref": "docs/roadmap.md:40", "quote": "same-day windows planned" }] },',
    '        { "kind": "structural", "claim": "Same-day windows are a shipped module", "provenance": [{ "kind": "code", "ref": "src/scheduling/sameDay.ts#sameDayWindow", "quote": "export { sameDayWindow }" }] },',
    '        { "kind": "revealed", "claim": "Same-day windows are computed and served", "provenance": [{ "kind": "code", "ref": "src/scheduling/sameDay.ts#solve", "quote": "export function solve" }] }',
    "      ],",
    '      "gap": "The roadmap describes as planned what the code already ships."',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "The example is drawn from an UNRELATED codebase — a delivery-scheduling service — so that you do",
    "not pattern-match it onto the graphs you are reading. It ADDS a correspondence, so it carries no",
    "`candidate_id`; for a tool candidate, copy the `candidate_id` verbatim from the list above.",
    "",
    "- `correspondence`: the `candidate_id` when the correspondence carries one, otherwise its 0-based position in your `correspondences` array.",
    `- \`kind\` on an evidence or provenance entry: one of ${PROVENANCE_KINDS}.`,
    "- Every `kind` on a member or an account is one of `stated`, `structural`, `revealed`, and an account's channel must belong to its correspondence.",
    "- `equivalent` differences are welcome: they corroborate the match.",
    '- If no candidate and no addition corresponds anywhere, write `"correspondences": []` and `"differences": []` and set `"no_correspondences": true`. Set that flag ONLY then — alongside a confirmed correspondence it contradicts itself and the tool refuses the submission.',
    "",
  ].join("\n");
}
