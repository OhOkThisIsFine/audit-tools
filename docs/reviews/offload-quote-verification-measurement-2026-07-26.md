# Offload quote-verification measurement — 2026-07-26

## Question

Nightly item `sol-19` rejected the proposed file/line anchor checker because it
caught zero of the three real incidents. The owner asked for the remaining
**quote-verification half** to be measured over 20 live offload replies before
anything shipped:

1. How reliably does whitespace-normalized exact matching detect a known-invalid
   supporting quote?
2. What false-positive surface appears when the check is scoped to only the
   files inlined for that call?

No checker was added to `~/.claude/llm-call.mjs` during this measurement.

## Protocol

- Five representative design/refutation packets were each sent through the live
  local LiteLLM/NIM lane: artifact registration, nightly-prompt generation,
  branch-strand enforcement, orphan-worktree handling, and the proposed generic
  quote verifier itself.
- Four aliases were attempted (`glm-5.2`, `minimax-m3`, `qwen3.5-122b`,
  `gpt-oss-120b`); reliable aliases supplied replacement calls until the cohort
  contained **20 complete replies**.
- Every reply used a task-shaped schema with exactly three verdicts. Each verdict
  had an explicit `quoted_text` field and was instructed to copy one contiguous
  12–240-character span, verbatim and without an ellipsis, from one of the
  inlined files. Cohort admission additionally required all three verdicts to
  carry non-empty quote/evidence fields; two exit-zero, parseable replies failed
  that contract and were replaced.
- Matching reused the product contract's semantics from
  `src/shared/validation/findingGrounding.ts`: remove CR, collapse whitespace,
  trim, then require the quote to be a substring of **any file in that call's
  closed input set**.
- A known-positive was made from every naturally matching quote by changing one
  alphanumeric character to a character absent from the source. This isolates
  detector recall from the model's natural fabrication rate.
- To measure the schema-agnostic transport proposal, the same replies' free-form
  `analysis` fields were scanned for text delimited by backticks, straight or
  curly double quotes, or single quotes. Those spans were not designated
  evidence by the schema; an absent span flagged by a generic scanner is
  therefore false-positive noise.

Raw requests/replies and the aggregate JSON are local run artifacts under
`.audit-tools/measurements/offload-quote-verification-2026-07-26/` (ignored, not
a durable project contract).

## Results

It took **32 attempts** to obtain 20 complete replies: 5 calls timed out at the
10-minute transport ceiling, 5 returned `finish_reason=length` / exit 4, and 2
returned exit-zero, parseable JSON with empty required evidence strings (calls
`4` and `14`). The helper correctly kept the timeout and truncation classes off
the success path; cohort validation, not the helper, excluded the two
contract-incomplete replies.

| Measure | Result |
|---|---:|
| Complete live replies | 20 |
| Explicit supporting quotes | 60 |
| Naturally matched the closed input set | 37 / 60 (61.7%) |
| Naturally absent / correctly flaggable | 23 / 60 (38.3%) |
| Constructed matcher sanity check: seeded-invalid rejected | 37 / 37 |
| Constructed matcher sanity check: source-matching quote retained | 37 / 37 |
| Incidental quote-like spans in free-form analysis | 77 |
| Incidental spans absent from the closed set | 28 / 77 (**36.4%**) |
| Replies a generic scanner would noisily flag | 15 / 20 (**75%**) |

The constructed checks are deterministic implementation sanity checks, not
empirical recall or false-positive estimates: each seed was deliberately given
a character absent from the source, while each retained quote was selected
because it already matched. The live evidence is the natural cohort below and
the generic scanner's incidental-span surface.

The 23 natural misses were genuine violations of the requested verbatim-span
contract: invented pseudo-code, a real passage copied with changed punctuation
or Unicode hyphens, comments synthesized from the plan rather than the source,
and source text attributed to a file outside the call. Exact quote grounding is
right to reject all of them; a semantically plausible paraphrase is not a
verbatim quote.

The 28 generic false positives were ordinary analytical prose: code identifiers
and commands such as `git worktree list --porcelain`, proposed test names,
labels such as “X is forbidden”, and apostrophes that a naive extractor treated
as quote delimiters. They are not supporting-evidence fields. A transport helper
cannot distinguish them from asserted evidence because every caller supplies a
different result schema.

## Disposition

**Do not ship a schema-agnostic quote scanner in `llm-call.mjs`.** Its matching
primitive is strong, but the generic extraction boundary is not: it would emit
noise on 75% of otherwise complete replies in this cohort.

The viable shape already exists in the product contract: a consumer that needs
grounding declares an explicit `quoted_text` field in its task-shaped schema and
checks that field with the shared whitespace-normalized matcher. That shape
passed both constructed matcher sanity checks and correctly rejected all 23
natural non-verbatim quotes in this cohort. It is a consumer contract, not a
transport heuristic. The separately-refuted file/line anchor half remains out
of scope.
