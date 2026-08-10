# Meta-review — /audit-code run 2026-07-30 (free-lane delegation + wide-view process walk)

**Run:** fresh full audit of audit-tools itself (1,213 files, 2,100 findings — 121 high), driven
conversation-first with the operator directive *delegate every LLM step to free lanes; primary
quota is low*. Prior same-day dogfood run archived (not deleted) at
`.audit-tools/audit-run-archive-2026-07-30/`. Categorized frictions (12 observations, all three
categories) live in the run's friction record — `.audit-tools/audit/friction/run.json` — and are
the per-event authority; this document is the wide-view synthesis the friction schema doesn't hold.

## Delegation outcome (the directive worked)

Every LLM judgment step ran on a non-Anthropic lane; primary quota was spent only on orchestration
(this conversation itself):

| Step | Lane | Notes |
|---|---|---|
| critical-flow enrichment | agy-gemini (flash-high) | 12 verified multi-file flows |
| conceptual design review | agy-gemini | 4 findings |
| contract (adversarial) review | agy-claude (sonnet-4-6) | 13 findings; codex rung was quota-dead until Aug 4 — recorded via `the offload router dispatch -x codex`, ladder walked on |
| wave 1: 58 packets / 527 tasks | tier-mapped subagent offload → offload pools | ~15.1M worker tokens, 58/58 valid results, 885 findings |
| wave 2 + mega-packet (97 tasks) | pool/fast + pool/reasoning | 81 findings; see partitioner defect below |
| lens-steward packets | tool's own rolling engine → agy | after the write-permission repair below |
| synthesis narrative | agy-gemini | 6 themes over 2,100 findings |

Total offloaded worker volume ≈ 16M tokens. The tier-mapped offload path (`the offload router offload on`,
Agent `model` param → `routing.subagents`) held up under a 58-agent concurrent wave with zero
transport failures surfaced to the host.

## What the run itself proved or reproduced (highest-value items)

1. **Deepening re-partitioner lacks the initial planner's budget split** *(root-caused this run)*.
   Initial planning correctly split 528 tasks into 58 budget-sized packets; selective deepening
   packed 97 of its 98 tasks into ONE 655,753-token packet → `no_capable_pool` head-of-line block.
   The advertised recovery "let re-planning shrink the packets" did not fire across two
   consecutive next-steps (same as the prior run's watch item). What worked: re-handshaking the
   roster with the honest 1M-context deep window admitted the packet unchanged. Fix belongs in the
   deepening partitioner.
2. **Headless-lane write permission is a systemic assumption, hit twice.** Manual agy dispatch and
   the tool's OWN rolling-engine agy dispatch both died on headless `write_file` auto-deny — the
   analysis runs, nothing is written, the packet reports only `outcome:error` while the cause sits
   in an unsurfaced stderr file. The sanctioned config channel exists
   (`~/.audit-code/sources-declared.json` → `parameters.dangerously_skip_permissions` on the
   `agy-cli` source) and the session-config validator's refusal correctly redirects — but names
   the spec, not the file. Surface worker stderr in `packet_result`; name the declaration path in
   the refusal; consider defaulting the flag for tool-managed workers whose only write is their
   assigned result path.
3. **An errored rolling packet crashes the advance loop** — `audit_tasks_completed` stays
   actionable, advance re-selects it to the `maxTransitions (100)` ceiling and exits 1, where
   `no_capable_pool` gets a graceful resumable pause. Same class, different (worse) ergonomics.
4. **Reproduced twice: merge-and-ingest exits 2 on full success** (885-finding ingest,
   `progress_made:true`). Known from the prior run; still open.
5. **Reproduced: completion does not promote the report** — `.audit-tools/audit-report.md` (the
   tracked deliverable) still held the previous run's render; operator promoted by hand again.

## Process-shape observations (worth design attention)

- **The pre-dispatch judgment chain is strictly sequential** (~11 fold-breaking gates before
  planning). Upstream-valid ordering is a DAG, not a chain — independent-input gates (the two
  design reviews already run concurrently *within* their step) could be surfaced as a parallel
  frontier across obligations, cutting wall-clock dominated by slow free lanes.
- **Tier routing skewed maximal:** 55 of 58 wave-1 packets rated `deep`. Either the self-audit's
  risk profile genuinely concentrates, or the risk→tier gate defaults upward; a distribution
  that's ~all-deep routes nothing on a paid lane.
- **Lens-combination fragmentation:** one hot flow (workerResult) appeared in ~15 packets with
  slightly different lens subsets — the same file cluster re-read per packet. Merging lens
  variants over an identical file scope into one multi-lens packet would cut repeated context.
- **Prompt proportioning:** the flow-fallback prompt shipped 87 single-file low-confidence stubs
  (truncated at that); the 50KB review prompts spend most of their budget on exhaustive per-unit
  file lists while showing 20 of 1,823 analyzer leads. Summarize inventories, spend the budget on
  leads.
- **Suffix-variant re-confirmation:** each agy reasoning suffix (`-high/-medium/-low`) counts as a
  new model id at Gate-0 → one interactive gate per suffix. Collapse suffix families.
- **What deserves explicit praise:** the fold-aware drain and staleness DAG ran flawlessly through
  ~30 deterministic obligations; per-packet `access` grants + result-path write scoping made a
  58-agent offloaded wave safe to run unattended; the dispatch step's host-agnostic "spawn one
  dedicated dispatcher" phrasing mapped cleanly onto this harness's Workflow affordance; and the
  session-config validator's constitutional refusal of dispatch inventory (naming the spec) is
  exactly the enforce-in-tooling posture working as designed.

## Operator decisions taken autonomously (recorded for review)

- Treated the standing lens preference ("default follows the proposal") as the answer to the
  intent gate: proposal accepted verbatim, shallow conceptual depth.
- Treated the run directive (run it, free lanes, low quota) as the affirmative for the 58-packet
  `confirmation_recommended` gate, after confirming the wave would spend no primary quota.
- Set `parameters.dangerously_skip_permissions` on the `agy-cli` source in
  `~/.audit-code/sources-declared.json` (machine-level, reversible) so the tool's own agy workers
  can write their result files.

## Where the follow-up work lives

- Fixable defects surfaced here → the run's friction record is the authority; fold into
  `docs/backlog/open-bugs.md` on the next triage pass (verify each against HEAD first — leads,
  not verdicts).
- The 2,100-finding audit report → `.audit-tools/audit-report.md` / `audit-findings.json`
  (promoted), ready for `/remediate-code` intake.
