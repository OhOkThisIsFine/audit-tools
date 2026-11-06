# Lens assignment and per-pass token cost — design check (2026-11-06)

<!-- review-routing: no-forward-work -->

Status: design-check done. An independent AGY lane tried to refute the plan; I verified each lead
against source. No product code yet. Three points need the owner before implementation.

## Defect (D10 of `docs/reviews/dogfood-audit-2026-11-06.md`)

The scoped-inspection workload of the 2026-11-06 dogfood run has 931 items, one per file set and
lens, and costs about 13.7M tokens: 12 285 875 content tokens and 1 376 141 prompt-overhead tokens.

## Owner-approved plan (2026-11-06, relayed by the coordinator)

1. Lens assignment from deterministic content signals (graph, analyzers); the path bucket is a weak
   signal only. A floor: every in-scope file gets at least 2 lenses, the two that signals score highest.
2. Required per-reviewer lens votes (worth / not worth / no view for each lens of the chosen set).
   Add a lens on 2 votes, or 1 vote plus a signal. Drop only when every reviewer who saw the file votes
   against and no signal requires it. Record each change with its votes; add a file+lens pair at most
   once per run.
3. One lens per item. Cut tokens per pass: (a) a byte-identical prefix across the lens items of a file
   group, lens standard last; (b) a smaller fixed overhead; (c) combine items only where overhead
   exceeds content; (d) lens regions for very large files, last.

## Measurement (deterministic, this run)

| Quantity | Value |
|---|---|
| Overhead tokens | 1 376 141 (fixed contract text 938 649 ≈ 1 008 per item; assignment block 335 098; lens guidance 103 088) |
| Content tokens | 12 285 875 |
| Median per item | overhead 1 313, content 5 890 |
| Items with overhead > content | 153 (196 165 overhead vs 97 930 content) |
| Unique files / content | 1 327 files, 3 655 038 tokens, each read 3.36 times |
| Lenses per file | today 3.27; floor 2 + analyzer signals 2.00 |

## Verified findings

| # | Finding | Verdict | Consequence |
|---|---|---|---|
| F1 | The work-item prompt does NOT inline file content: the reader opens the files with its own tools (`renderAuditWorkItemPrompt` region of `src/audit/cli/dispatch/hostHandoff.ts`, "Review every listed file"). A shared prompt prefix therefore caches only the ~1 000-token contract text, never the content. | **Holds** (my own recon). | Plan 3(a) saves content tokens only if the tool inlines each file group's content into the prompt. **Owner decision 1.** |
| F2 | Inlining collides with two recorded decisions: prompt review 11a (owner-approved 2026-09-17, `docs/reviews/prompt-refinement-2026-09-13.md`) dropped "place shared context first to make it cache-eligible" because "ordering is a backend concern"; and `host-workload.json` would grow from 6.6 MB to about 50 MB (12.3M content tokens). The lens-steward precedent "grant the file, do not inline it" (`docs/reviews/lens-steward-redesign-2026-09-17.md`) is about path lists, not source, so it does not bind here. | **Holds in part.** | Part of decision 1. |
| F3 | The result path is stated FIRST, on its own line, by an owner prompt-review decision ("the buried destination", lens-steward redesign item 4). A byte-identical prefix needs every per-item value (result path, item id) at the END. | **Holds.** | **Owner decision 2:** keep a one-line "write your result to the path at the end of this prompt" first, and the path itself last. |
| F4 | "The two that signals score highest" needs a score. The only per-file score today is `lensVerification.ts` (`SCORE_CRITICAL_FLOW = 6`, `SCORE_EXTERNAL_ANALYZER_SIGNAL = 6`, `SCORE_LARGE_FILE = 4`, `SCORE_HIGH_RISK_CLEAN = 5`, `SCORE_EXTERNAL_ANALYZER_PATH_MATCH = 8`): weights with no measurement, used only as a steward's HINT. Using them to choose lenses makes the hint a boundary — the class commit `cfaaf7a8` removed. | **Holds.** | Signals become boolean predicates, each mapped to the lenses whose standard covers it. The floor is a MINIMUM: every signalled lens is assigned. **Owner decision 3:** the rule that fills a file with fewer than 2 signalled lenses, with no weights. |
| F5 | `deriveCoverageElementKey` (`coverageElementBaseline.ts`) hashes `required_lenses`. A vote that adds or drops a lens moves the key, so the file's `completed_lenses` reset and in-flight tasks holding it are dropped. | **Holds.** | Preservation must key on (file, lens), not on the whole lens set. |
| F6 | MANDATORY_LENSES (`lensSelection.ts`) are a RUN-level union. Once the bucket is a weak signal, a mandatory lens can reach no file, and `summary.lens_coverage` then says `not_run`. | **Holds.** | Rule: every selected lens is assigned to at least the files whose signals match it; a lens with no matching file is reported, not silently dropped. |
| F7 | A drop below the floor, or to zero lenses, leaves `audit_status` pending forever (`coverage.ts` `applyFileCoverage`). | **Holds** as a missing rule. | A drop never takes a file below the floor. |
| F8 | A drop decided before every reviewer of the file has reported depends on result arrival order. | **Holds.** | Decide a drop only after all reviewers assigned to the file have reported. Votes are keyed to `file_coverage` paths and stored in their own ledger artifact. |
| F9 | Flow requeue (`flowRequeue.ts`) re-adds flow lenses from `completed_lenses` and ignores `required_lenses`, so it can re-add a dropped lens. | **Plausible** — verify at implementation. | Intersect flow lenses with the file's current lenses, or exempt flow lenses from drops. |
| F10 | 3(c) "contradicts one lens per item". | **Refuted.** Same-lens items of different units can merge without a second lens. | Needs a cross-unit same-lens task (today only the tiny-test unit merges); the test is overhead > content, per the plan. |
| F11 | 3(d) lens regions fail the host door: `parseHostResult` requires `reviewed_lines === total_lines`. | **Holds.** | 3(d) needs a region binding in the task binding. It stays last, as planned. |

## Smallest failing tests (red today)

1. Prefix: `tests/audit/host-handoff.test.ts` — two items of one file group, lenses `correctness` and
   `security`; the common prefix of their `prompt.text` holds the file list and the contract, and the
   per-item tail holds only the lens standard, the identity and the result path. Red: the result path
   is line 2.
2. Floor: a runtime file with no other signal gets exactly the floor, not today's 4 bucket lenses; a
   docs file gets 2, not 1.
3. Votes: a host result without lens votes is refused at `parseHostResult`.
4. Preservation: adding a lens to a file keeps its `completed_lenses`.

## Order of work after the decisions

1(b) shrink the fixed overhead (no decision needed, largest overhead share) → signals as predicates
and the floor → votes and their ledger → (a) per decision 1 → (c) → (d).
