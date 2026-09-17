// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts, tests/audit/charter-emit-order.test.ts
/**
 * Render the charter-FIDELITY host prompt (step 4, judgment half; owner-reviewed
 * 2026-09-17 — the earlier "approved host text §9b" label was DERIVED from the
 * owner's approval of the charter design, never given to this text). A separate
 * lane sees only the packet the tool materialized — per open finding candidate,
 * the accounts, their cited provenance, and the exact source slices at those
 * citations — and returns one verdict per difference. Separation from the
 * comparison reader is enforced by dispatch, so the prompt carries no identity
 * plea (owner amendment 2026-09-15).
 *
 * Every rule the ingest applies is STATED here, because obedience has to be
 * sufficient: a lane that follows this text exactly must produce a submission
 * `CharterFidelitySubmissionSchema` accepts and `applyFidelity` stamps. Three
 * rules were previously unstated or wrong — the example carried `over_read_side`
 * beside a non-`interpretation` verdict, which the schema refuses outright; the
 * text promised "the two accounts" where a block holds one, two or three (a
 * `presence` finding candidate names its silent channel by ABSENCE, so it
 * reaches the packet with a single account); and it promised every quote was
 * checked against disk, which is true of QUOTES only — a ref with no quote is
 * never pre-checked, and `buildCharterFidelityPacket` can emit an unreadable-source
 * marker in place of a slice (owner 2026-09-17).
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
    "code does (**revealed**). Your job is narrower than that pass: for each difference, decide",
    "whether each account's claim is really carried by the source that account cites.",
    "",
    "## Your packet",
    "",
    `Read \`${opts.packetPath}\`. Each block holds one difference — its dimension and relation, the gap`,
    "in one sentence, and then every account the comparison recorded: the claim, its cited refs, and a",
    "source slice at each ref.",
    "",
    "A block holds ONE, TWO or THREE accounts. Three means all three channels spoke; two means the",
    "correspondence had two channels. One means the difference is a `presence` gap: the silent channel",
    "is named by its ABSENCE from the block, so no slice can exist for it.",
    "",
    "Judge from the slices only. Do not open other files, and do not judge the design itself.",
    "",
    "Two markers say the evidence is not there:",
    "- `(source <path> could not be read)` in place of a slice — the cited file is gone or unreadable.",
    "- `(no provenance cited)` under an account — that account cited nothing at all.",
    "",
    "A cited QUOTE was re-read from disk before the block was built, so a quote shown in a block was",
    "present at its ref. A ref with no quote was never checked, and neither marker above was.",
    "",
    "## Verdicts",
    "",
    "Give each difference in the packet exactly one verdict:",
    "- `supported` — every account's claim is carried by that account's own cited slices.",
    "- `interpretation` — one account's claim goes beyond what its own slices say. Name that account's",
    "  channel in `over_read_side`.",
    "- `unverifiable` — the slices cannot settle it: a marker above, a slice that does not contain the",
    "  cited matter, or a claim the slices neither carry nor contradict.",
    "",
    "Judge each claim against its OWN cited source, never against another account's claim. Two",
    "accounts can both be well supported and still contradict each other — the contradiction is the",
    "comparison's finding, and `supported` is how you confirm the evidence under it. A claim can also",
    "be well supported and wrong about the code; that is not your question either.",
    "",
    "On a one-account `presence` block, judge that one account the same way: does its own slice carry",
    "the goal it claims? The silence of the other channel is the tool's own record, not a claim you",
    "check.",
    "",
    "## Output",
    "",
    `Write your submission as JSON to \`${opts.submissionPath}\`:`,
    "",
    "```json",
    "{",
    '  "verdicts": [',
    "    {",
    '      "difference_id": "D-0003",',
    '      "verdict": "supported",',
    '      "rationale": "the stated slice at docs/goals.md:12 promises every driver sees the schedule, and the revealed slice at src/scheduling/roster.ts:40 restricts it to admins."',
    "    },",
    "    {",
    '      "difference_id": "D-0007",',
    '      "verdict": "interpretation",',
    '      "over_read_side": "structural",',
    '      "rationale": "the structural account claims a retry policy, but its slice only declares a RetryOptions type and never applies it."',
    "    },",
    "    {",
    '      "difference_id": "D-0011",',
    '      "verdict": "unverifiable",',
    '      "rationale": "the revealed account cites one ref, and its slice reads (source src/legacy/queue.ts could not be read)."',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "- One entry per difference block in the packet, and no more. A second verdict for the same",
    "  `difference_id` is dropped, and so is a `difference_id` the tool does not recognize or has",
    "  already settled itself.",
    "- A difference you leave out stays unjudged. The tool never assumes `supported` for you.",
    "- `over_read_side` goes with `interpretation` and with nothing else: the tool refuses an",
    "  `interpretation` that omits it, and refuses any other verdict that carries it. Its value is",
    "  `stated`, `structural` or `revealed`, and it names a channel with an account in that block.",
    "- `rationale` is required on every verdict. Write one or two sentences, and cite the slice that",
    "  decides it.",
    "",
  ].join("\n");
}
