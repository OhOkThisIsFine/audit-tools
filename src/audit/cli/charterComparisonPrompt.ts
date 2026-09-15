// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { CorrespondenceCandidate } from "audit-tools/shared";

/**
 * Render the charter-COMPARISON host prompt (steps 2–3; approved host text:
 * docs/reviews/prompt-refinement-2026-09-13.md §9). The host is the comparison
 * reader: it authored none of the three lane DAGs; it confirms, rejects, widens
 * or adds correspondences over the tool's candidates and records the typed
 * differences. Routing, severity and finding-ness are never mentioned — the tool
 * routes by the fixed table and the fidelity lane gates findings.
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
    : ["- (the tool found no candidates — add any correspondence you can evidence, or affirm `no_correspondences`)"];

  return [
    "# Design review — charter comparison (correspondences and differences)",
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
    "## Candidate correspondences (tool-proposed)",
    "",
    "Each candidate pairs regions the tool found related by file overlap or by a provenance",
    "cross-reference. Confirm, reject, or widen each one; add any the tool missed.",
    "",
    ...candidateLines,
    "",
    "Rules:",
    "- A correspondence may join one node to one node, several nodes, or a connected subgraph on the other side.",
    "- A correspondence you add must cite one provenance ref per side; the tool re-checks both.",
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
    "| `presence` | No node at the same level matches in a channel that should cover the goal; a missing child goal counts here, at its level |",
    "| `responsibility` | Goal labels match, owner or location differs |",
    "| `hierarchy` | The node matches, the parents or subgoals differ |",
    "| `scope` | Adding a when / for-whom / to-what-extent qualifier reconciles the claims |",
    "| `standing` | The claims reconcile once versioned in time: planned, active, deprecated, removed |",
    "| `standard` | Both agree on what and where, disagree on how well |",
    "",
    "A difference holds the account of every channel in the correspondence — two or three. Give each",
    "difference one relation judged across all of them: `equivalent` (same claim, other words),",
    "`complementary` (no account contradicts another), or `incompatible` (some two cannot both hold).",
    "For an `incompatible` difference also give the `split`: `two_against_one` with the odd channel",
    "named, or `three_way`. For a `presence` difference, say whether the silent channel should have",
    "covered the goal (`covered_channel_gap: true`).",
    "",
    "## Output",
    "",
    `Write your submission as JSON to \`${opts.submissionPath}\`:`,
    "",
    "```json",
    "{",
    '  "correspondences": [',
    "    {",
    '      "candidate_id": "<tool candidate id, or omit for one you add>",',
    '      "verdict": "confirm | reject | widen",',
    '      "members": [',
    '        { "kind": "stated", "node_ids": ["billing-trust"] },',
    '        { "kind": "revealed", "node_ids": ["charge-capture", "fraud-check"] }',
    "      ],",
    '      "evidence": [{ "kind": "doc", "ref": "docs/billing.md#Goals", "quote": "..." }, { "kind": "code", "ref": "src/billing/stripe.ts#capture", "quote": "..." }]',
    "    }",
    "  ],",
    '  "differences": [',
    "    {",
    '      "correspondence": "<index or candidate_id of the correspondence above>",',
    '      "dimension": "standing",',
    '      "relation": "incompatible",',
    '      "split": { "kind": "two_against_one", "odd": "stated" },',
    '      "accounts": [',
    '        { "kind": "stated", "claim": "SSO is planned", "provenance": [{ "kind": "doc", "ref": "docs/roadmap.md:40", "quote": "SSO planned" }] },',
    '        { "kind": "structural", "claim": "SSO is a shipped auth module", "provenance": [{ "kind": "code", "ref": "src/auth/index.ts#samlLogin", "quote": "export { samlLogin }" }] },',
    '        { "kind": "revealed", "claim": "SSO login is implemented and wired", "provenance": [{ "kind": "code", "ref": "src/auth/saml.ts#samlLogin", "quote": "export function samlLogin" }] }',
    "      ],",
    '      "gap": "The roadmap describes as planned what the code already ships.",',
    '      "covered_channel_gap": false',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "- Every `node_id` must exist in the named graph. Every `kind` is one of `stated`, `structural`, `revealed`.",
    "- `equivalent` differences are welcome: they corroborate the match.",
    '- If no candidate and no addition corresponds anywhere, write `"correspondences": []` and `"differences": []` and set `"no_correspondences": true`.',
    "",
  ].join("\n");
}
