// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
/**
 * Render the charter-FIDELITY host prompt (step 4, judgment half; approved host
 * text: docs/reviews/prompt-refinement-2026-09-13.md §9b). A separate lane sees
 * only the packet the tool materialized — per open finding candidate, the
 * accounts, their cited provenance, and the exact source slices at those
 * citations — and returns one verdict per difference. Separation from the
 * comparison reader is enforced by dispatch, so the prompt carries no identity
 * plea (owner amendment 2026-09-15).
 */
export function renderCharterFidelityPrompt(opts: {
  submissionPath: string;
  packetPath: string;
}): string {
  return [
    "# Design review — charter fidelity check",
    "",
    "A comparison pass recorded differences between three accounts of this repository's goals: what",
    "the docs say (**stated**), what the code's organization promises (**structural**), and what the",
    "code does (**revealed**). For each difference, decide whether the two sources genuinely say",
    "different things, or whether a reader read more into a source than it says.",
    "",
    "## Your packet",
    "",
    `Read \`${opts.packetPath}\`. It holds, per difference: the two accounts, their cited provenance, and the`,
    "exact source slices at those citations. Judge from the slices only; every quote in them has",
    "already been checked against disk.",
    "",
    "## Verdicts",
    "",
    "Give each difference exactly one verdict:",
    "- `supported` — the cited sources genuinely make the two claims; the difference is in the sources.",
    "- `interpretation` — one side's claim goes beyond what its cited source says. Name that side.",
    "- `unverifiable` — the cited slices do not settle whether the claims differ.",
    "",
    "Judge the claim against its own source, not against the other source. A claim can be",
    "well-supported and still wrong about the code; that is not your question.",
    "",
    "## Output",
    "",
    `Write your submission as JSON to \`${opts.submissionPath}\`:`,
    "",
    "```json",
    "{",
    '  "verdicts": [',
    "    {",
    '      "difference_id": "<id from the packet>",',
    '      "verdict": "supported | interpretation | unverifiable",',
    '      "over_read_side": "stated | structural | revealed",',
    '      "rationale": "<one or two sentences citing the slice that decides it>"',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "- One entry per difference in the packet; `over_read_side` only with `interpretation`.",
    "- Every `difference_id` must come from the packet.",
    "",
  ].join("\n");
}
