# Work-item prompt overhead — proposal for D10 item (b) (2026-11-06)

<!-- review-routing: no-forward-work -->

Status: PROPOSED, not applied. The owner decides prompt wording one proposal at a time (memory
`prompt-review-is-interactive-one-at-a-time`). Each cut below is shown with its measured saving.
Each cut is optional.

## Measurement

The run's 931 scoped-inspection prompts (`host-workload.json` of run
`review-audit_tasks_completed-136b12af9169ce6c`) hold 1 376 141 tokens at 4 bytes per token. No
prompt carries file content. The script applies the cuts as text changes to every real prompt and
measures again: 1 059 845 tokens, 316 296 fewer (23%). It also checks that each prompt still holds
its result path.

| Cut | What repeats today | Tokens saved |
|---|---|---|
| C1 | The template sentence repeats the absolute result path from line 2. | 40 033 |
| C2 | The line "Result contract: … with exactly result_id, run_id, …" lists the keys that the JSON template below it already shows. The steward lane keeps its line, because it adds `verification` (REQUIRED). | 39 102 |
| C3 | The assignment's `files` array repeats the keys of `file_line_counts`. | 48 262 |
| C4 | The assignment's `task_id` repeats the template's `work_item_id`; `pass_id` is `pass:<lens>`. The reader uses neither. The steward lane keeps both: its `followup_tasks` entries need them. | 29 039 |
| C5 | The `analyzer_provenance` line goes into every prompt. It applies only to an item that carries an analyzer lead, and no item of this run carries one. | 51 205 |
| C7 | Contract wording: one non-empty line instead of two; the lens vocabulary and the "lens is optional" line go, because the lens rule already says "match the assigned lens, or omit it"; "rejects the whole submission" is stated once, at the end. | about 108 000 |

C6 is not in the 23%. The rationale carries a per-file `Source revision` list of 64-character
hashes (140 180 tokens). The reader does not use the hashes. They make the prompt digest change when
a file changes, and the re-plan rule from commit `adcddeb9` compares re-rendered prompts to keep
unchanged in-flight tasks. To remove the hashes from the prompt text, the binding must carry the
source revision, and the re-plan comparison must read the binding. That is a loop-core design change.
It needs its own design check.

## Current and proposed text (one base-lane item)

Unchanged lines are not repeated here: the preamble, the snapshot line, the lens guidance, the
`file_coverage` line, the required-fields line and the two quote rules.

| Current | Proposed |
|---|---|
| `{"file_line_counts":{…},"files":[…],"lens":…,"pass_id":…,"rationale":…,"task_id":…,"unit_id":…}` | `{"file_line_counts":{…},"lens":…,"rationale":…,"unit_id":…}` |
| Result contract: audit-host-result/v1alpha1 with exactly result_id, run_id, work_item_id, prompt_sha256, file_coverage, and findings in addition to contract_version. | (removed; see the template sentence) |
| Finding contract — affected_files, category, evidence must be non-empty (an empty value rejects the submission). / Finding contract — related_findings, reproduction must be non-empty when supplied (an empty value rejects the submission). | Must be non-empty: affected_files, category, evidence; when supplied: related_findings, reproduction. |
| These fields are JSON arrays whenever present, never a bare string or object: … A finding that fails this contract rejects the whole submission. | JSON arrays when present, never a bare string or object: … |
| Closed vocabularies — severity must be one of …; confidence one of …; lens, when supplied, one of correctness\|…\|observability. | Closed vocabularies — severity must be one of …; confidence one of …. |
| analyzer_provenance is optional: … | (only in an item that carries an analyzer lead) |
| lens is optional: defaults from the enclosing AuditResult lens when omitted. | (removed; the lens rule states it) |
| Do not supply a `grounding` field on any finding — grounding is computed by the tool at ingest by re-reading your cited quoted_text from disk, and a supplied one rejects the whole submission. | Never supply a `grounding` field: the tool computes it at ingest from your quoted_text. / A result that breaks any rule above is rejected whole. |
| When you finish, write this JSON to `<absolute result path>`. Keep the five identity values as they are. Fill in `file_coverage` and `findings`: | When you finish, write this JSON to the path on line 2. Keep exactly these keys, and keep the five identity values as they are. Fill in `file_coverage` and `findings`: |

## Rules the proposal keeps

- The finding contract stays IN the prompt. A pointer to a contract file was the failure that put it
  there (`findingContractPrompt.ts` header: a lap lost four results to a contract the host had to
  remember).
- Each line stays derived from `WorkerFindingSchema` and `AUDIT_RESULT_RULES`. The quote rule stays
  verbatim: both result doors refuse with the same sentence.
- The destination stays first (owner prompt-review decision). Decision 2 of the D10 design record
  may move the path to the end; C1 fits both orders, because one statement of the path remains.

## Tests to write first

1. `tests/audit/host-handoff.test.ts`: a base-lane prompt holds its result path exactly once, holds
   no `files` or `task_id` key in its assignment, and holds no `analyzer_provenance` line when its
   item carries no lead. Red today.
2. The steward-lane prompt still holds `verification` REQUIRED, `task_id` and `pass_id`.
3. `tests/audit/host-result-finding-contract.test.ts`: each schema field and each worker-owned rule
   still reaches the prompt (the existing derivation test, kept green).
