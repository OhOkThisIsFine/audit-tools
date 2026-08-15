# P35 — A rendered step prompt instructs the host to do something the tool cannot deliver

## The problem

The tool renders prompts that tell the executor to read a file it never writes,
diff against an artifact it just archived, write into a repo the executor cannot
write to, or do the thing a standing invariant forbids. Each instance was found
by a host hitting it at run time and was patched individually; the class has
never been gated.

This is the highest-count recurrence in the store that is not already covered by
an existing proposal.

## Recurrence — 7 records across 5 dates

| Date | Record | Instance |
|---|---|---|
| 2026-07-16 | `docs/backlog/open-bugs.md` | a delegated `charter_extraction` prompt embeds the `next-step` advance command; the executor advanced the loop itself. Recurred in a later `systemic_challenge` round. |
| 2026-08-08 | `docs/backlog/open-bugs.md` | diff-based re-review says "diff against your prior verdict" after `conceptual_design_critique.*` was deleted as stale. |
| 2026-08-08 | `docs/backlog/open-bugs.md` | `module_contract_drafting` says "dispatch ONE sub-agent PER MODULE" — a mechanism the host may not have; 2 of 9 dispatches died mid-output. |
| 2026-08-09 | `docs/backlog/open-bugs.md` | `obligation_ledger.input.json` is listed under Required Inputs in every contract-pipeline step prompt and is **never written**; a host following the prompt literally gets ENOENT. |
| 2026-08-09 | `docs/backlog/open-bugs.md` | the implement-node prompt carries the DAG node description but not the text of `finalized_module_contracts` the worker must satisfy. |
| 2026-08-09 | `docs/backlog/durable-traps.md` | `renderContractRepairPrompt` renders "Regenerate `finalized_module_contracts` IN FULL" while INV-CO-13 requires a targeted edit — "a host that follows the prompt does the banned thing." |
| 2026-08-12 | `.audit-tools/audit/friction/20260812T192026635Z_audit_tasks_completed_001.json` (`ambiguous_direction`) | `design_review_parallel` / `critical_flow_fallback` say "Write the JSON object to <results path>" but delegated lanes are frequently read-only. **Every dispatch that run needed a per-lane override.** Still live at HEAD — `src/audit/orchestrator/designReviewPrompt.ts:495` and `:530`. |

## The mechanism — a removal for most of it, a contract test for the residue

**Removal (preferred, covers the largest sub-class).** Render the "Required
Inputs" list FROM the artifact store's actual write map rather than from the
hand-maintained `requiredInputKeys` string arrays in
`src/remediate/steps/contractPipelinePrompts.ts` (`:144, :199, :220, :233, :253,
:275`). A key with no producer then *cannot be named*, and the
`obligation_ledger.input.json` ENOENT becomes unrepresentable rather than caught.
This is the same shape as the "advance command belongs only to the driver-facing
artifact" spec already written into the 2026-07-16 entry.

**Contract test (for what cannot be removed).** A prompt-capability assertion:
every rendered prompt's imperative must be satisfiable by the executor class the
tool is emitting for — no repo-write instruction without a
return-as-final-message alternative, no reference to an artifact the step's own
staleness rules have archived. Belongs under `tests/`.

## False-positive surface

A prompt may legitimately name an artifact the HOST is expected to create in that
same step. The generator already distinguishes declared inputs from outputs via
`outputKey`, so the derivation must key on that. A blanket "no write instruction"
rule would wrongly flag prompts aimed at a host known to have write access —
which is why the rule is **"state the alternative"**, not "forbid the write".

## Already enforced? No

`tests/remediate/contract-pipeline-prompts.test.ts:89` asserts only
`expect(result.prompt).toContain("Required Inputs")` — the literal heading, never
that the listed paths resolve to anything the tool writes. That is a vacuous
assertion over exactly the field that broke, and is itself an instance of the
"green test that pins nothing" class.

P27 covers prompt-text-prescribing-a-trap, but only for one hook's DENY message
(`shell-trap-guard.mjs`), not for orchestrator step prompts. No row in
`scripts/guard-reach-data.mjs` claims prompt-instruction fulfillability;
`check:doc-code-citations` covers backticked paths in *docs*, not in rendered
prompts.
