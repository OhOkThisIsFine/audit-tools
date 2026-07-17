# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-3] `CLAUDE.md` ~line 108 — the Providers paragraph names 9 providers but `PROVIDER_NAMES`
  (`src/shared/types/sessionConfig.ts:4-16`) has 10: it omits `claude-worker`, wired into both
  orchestrators (`src/audit/providers/claudeWorkerProvider.ts`, `src/remediate/providers/claudeWorkerProvider.ts`)
  since the commit-3 lane shipped (2026-07-16). Note it's architecturally distinct from the other 9, not a
  drop-in list append: `providerFactory.ts:152-159` excludes it from auto-resolution ("source-pool-only
  proxied worker class... auto-resolution must never be able to pick it") and `assertHostProviderName`
  (`sessionConfig.ts:27-42`) explicitly rejects it as `--host-provider`/`self.provider` ("it can never be
  the conversation host driving a run"). Proposed: add `claude-worker` to the list with a short caveat
  that it's a proxied dispatch-worker class only, never a driver/host provider — not a bare append.
- [CLAUDE-4] `CLAUDE.md` ~line 108 — same paragraph's claim that `openai-compatible` is "the backend the
  in-process rolling engine drives for headless autonomy" is now incomplete. `spec/unified-dispatch-worker-model.md`'s
  worker-taxonomy table gives kind-3 (`openai-compatible`) "none (no tool loop)" for tools/file access and
  states explicitly that "remediate implement is the case that justifies repair-proxy" (kind-1,
  `claude-worker`) "— those workers Read/Edit/Bash/run tests," while kind-3 is permanently capped to
  "self-contained packets... that is their permanent ceiling, not a bug to fix." Both backends run through
  the same in-process rolling engine, but `claude-worker` is the fuller-capability (full tool access)
  headless-autonomy backend for the case the spec calls out as requiring it. Proposed: reword to name
  both, or clarify which capability class each backend actually provides.

### Design decisions for you
- [DD-A] `spec/unified-dispatch-worker-model.md` — the worker-taxonomy table's kind-1 row ("the host and
  its `claude` subagents; `claude -p` when headless") never names the shipped `claude-worker` provider
  (`CLAUDE_WORKER_PROVIDER_NAME`) that concretely realizes it, unlike the kind-2/kind-3 rows which do name
  concretes (codex/agy; NIM/opencode/vLLM). The doc's last edit (`0a540ca`) predates every commit-3 commit
  that built and shipped the class (`9f4cf8f`, `dd47e8d`, `860920c`, `b6a5f0e`) — it structurally predates
  its own "kind-1 launch transport" section's concrete instance. Does this doc need a pass to reconcile
  against the now-shipped commit-3 lane (name `claude-worker` in the taxonomy row / repair-proxy section,
  and check whether the reconciliation-gate/exclusion-grammar sections need a claude-worker-specific note
  anywhere)?
- [DD-B] `spec/cross-provider-quota-matrix.md` — `claude-worker` sources carry no first-party credential
  of their own; quota/pool identity keys on `backend_provider[#account]/model` per
  `apiPool.ts`'s `dispatchableSourceId` (whose own comment states "the transport NEVER enters the quota
  identity"), i.e. `claude-worker` quota-tracks under whatever real backend it's routed to, never under
  its own name. Should this matrix add a one-line note that `claude-worker` is a *transport*, not an
  independently quota-tracked backend, to preempt someone building a redundant `ClaudeWorkerQuotaSource`?
- [DD-C] `spec/audit/dispatch-admission-control.md` lines ~191, ~379 — two "(formerly the standalone
  `--host-max-active-subagents` flag)" / "(formerly `--host-models`)" lineage parentheticals attached to
  `self.max_active_subagents`/`self.roster`. These are pure retired-CLI-transport history with no
  architectural payload (unlike the doc's legitimate "capability inherited from the run, not the driver"
  founding-bug narrative elsewhere, which motivates *why* the architecture is shaped this way) — structurally
  the same "former X folded into Y" changelog-creep smell `documentation-philosophy.md` names as forbidden.
  Recommend stripping both; approve?
- [DD-D] `spec/audit/executor-catalog.md` — "friction triage actually fires from the `present_report`
  terminal step (`decideAuditFrictionCloseout`, called from `nextStepHelpers.ts`/`nextStepCommand.ts`)
  instead" — `decideAuditFrictionCloseout` is called only from `nextStepHelpers.ts` and `executorRunners.ts`;
  `nextStepCommand.ts` never calls it directly, it only reads the already-computed `result.triage`. Pre-existing
  (confirmed present at the prior checkpoint `7817a11` too, not introduced by this window's rework) — low
  confidence this is worth a fix vs. defensible loose phrasing ("spans these two files"). Tighten the
  wording, or leave as-is?
- [DD-E] `docs/HANDOFF.md` "Live state" — "All major code tracks remain complete" sits one paragraph above
  ▶ IMMEDIATE NEXT's description of 0/119 claude-worker-lane dogfood packets succeeding on a HIGH-priority
  open gap. Genuinely ambiguous whether "code tracks" scopes to the older T1–T6 quota-cluster numbering
  (true) or reads globally (false, given the open dogfood gap). Scope the bullet explicitly, or drop it
  now that ▶ IMMEDIATE NEXT is the authoritative current-state pointer?
- [DD-F] `docs/HANDOFF.md` "Older track — bounded quota-cluster remainder" references a "parked self-audit
  (14/261 packets, resumable)" tied to "the charter-fix dogfood run." This carries a different packet
  count than both the claude-worker-lane dogfood run named in ▶ IMMEDIATE NEXT
  (`20260717T062404401Z_audit_tasks_completed_001`, 0/119) and `docs/backlog.md`'s separately-mentioned
  "313-packet run" that regressed mid-dogfood. Three different numbers across what read as two distinct
  efforts (general dispatch/quota validation vs. claude-worker-lane-specific dogfood) — not enough evidence
  in the docs alone to resolve mechanically. Are these the same run under different descriptions, or truly
  separate — and if the "14/261" pointer is stale/superseded, should it be dropped?
- [DD-G] `docs/backlog.md` "`validateDispatchableSources` shape-checked 2 of 9 fields... (FIXED this lap)"
  — fully shipped per its own text (validator now guards all 9 fields at the one shared site) but carries
  no `[[memory-tag]]`, unlike sibling shipped-lesson entries. Per the shipped-entry-deletion rule's "give
  the durable rule a home in the same edit, then delete" clause: the durable lesson here is "a validator
  that guards a field the caller reads must guard every field the caller reads." Give it a memory tag (or
  fold into CLAUDE.md's validation/two-tier-dependency conventions) then delete, or delete now without a
  new home?
- [DD-H] `docs/backlog.md` "Undisclosed-at-authoring behavior changes from the 2026-07-16 assembly lift"
  (sub-items a–e) — entirely retrospective, zero open action items, framed explicitly as "recorded so they
  are not rediscovered as mysteries," but carries no `[[memory-tag]]` — same shape as DD-G. Sub-item (d)
  notes a real durable property (remediate now resolves machine-dependent `sources[]` from ambient
  environment at 3 config-load sites — a hermeticity exposure shared symmetrically with audit). Give (d)'s
  hermeticity note a durable-trap home before deleting the entry, or delete outright now?
- [DD-I] `docs/backlog.md` "Friction walk (repair-proxy dogfood lap, 2026-07-15)" item (1) — proposed
  "model dispatch pools by `(backend-model, operator-cost-class)`, with transport an attribute, not the
  namespace" closely matches commit `860920c1`'s shipped behavior ("Pool/ledger identity keys on
  `backend_provider[#account]/model`... Transport never enters the key"). Medium-high confidence the
  backend-model axis is now satisfied (the operator-cost-class axis may already be covered by the
  pre-existing `cost_per_mtok`/`declared_cost_drift` arbitrage mechanism — not traced to full certainty).
  Confirm this item is shipped and delete, or is there a genuine open remainder on the cost-class axis?

### Doc-set condensation
- [CX-1] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` + `spec/audit/executor-catalog.md`
  — still open from prior runs, re-verified accurate this run (38 artifacts / 27 executors, independently
  recounted three separate times across reviewer + two adversaries, all converging on the same figures):
  "which executor produces which artifact" is hand-maintained independently in two places
  (executor-catalog.md's Produces column and dependency-map.md's per-artifact rows) over the same registry
  pair. Should this have exactly one home (fold one into the other), or is the duplication an acceptable,
  differently-shaped view (catalog = by-executor, map = by-artifact) worth keeping as-is?
- [CX-2] `docs/HANDOFF.md`'s "Release gate — the durable lesson" section and `docs/backlog.md`'s "Durable:
  CI runs the release gate on every push, but nothing was watching it" entry record the identical root
  fact (main was red for ~a dozen laps because the pre-commit hook only runs `npm run check`, not
  `verify:checks`) and the identical corrective habit, under two different memory tags
  (`[[lap-green-must-match-ci-evidence]]` vs `[[enforce-robustness-in-tooling-not-host-discretion]]`).
  backlog.md's item (c) — "consider adding `check:doc-manifest` to the pre-commit hook" — is still
  genuinely open (confirmed: `.claude/hooks/pre-commit-gate.mjs` still runs only `npm run check`).
  Proposal: fold the durable-rule narrative into HANDOFF's Cadence & standing rules section (a standing
  operating rule is what that section is for) and trim backlog.md's entry to just open remainder (c),
  rather than deleting it outright. Confirm?
- [CX-3] `README.md`'s "Philosophy" bullet section (lines ~22-33) restates `docs/project-philosophy.md`
  A2 ("right tool, not deterministic dogma") and A7 (don't grade your own homework / delegate adversarial
  phases) in different prose — a fact in two homes, drift risk if one is updated without the other. Keep
  as a distinct user-facing summary (different register, marketing-adjacent), or replace with a one-line
  pointer to `project-philosophy.md`?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run (commit `7817a11` → `2d1b74c`, 35 commits since the last checkpoint —
the claude-worker provider lane / proxy-catalog / host-pool rework: the isolated proxied kind-1 launch
transport (`ClaudeWorkerProvider`, commits `9f4cf8f`/`dd47e8d`/`860920c`), proxy registry expansion with
capability ranking + identity dedup (`bebd69f`), reclassifying claude-worker as an in-process pool in both
draws (`b6a5f0e`), and the claude-worker lane dogfood run + its feedback-gap record. The owner had already
manually applied 17 of 18 items from the prior escalation batch (commit `2ba6ae3`) before this run started.
5 reviewer agents (ops/package/provider-surface + meta-tooling; backlog.md + HANDOFF.md; the highest-risk
`spec/audit/*` cluster; the remaining `spec/*` cluster; policy/philosophy including CLAUDE.md/AGENTS.md),
each examining every in-scope item in their cluster against live code, then 5 independent adversary agents
re-checked every item from scratch — several adversaries independently recounted registry sizes and found
new items the reviewers missed (a second `spec/host-validation.md` coverage-gap omission for claude-worker;
two additional shipped-but-untagged backlog.md entries; a refined framing for the unified-dispatch-worker-model.md
escalation). Exactly one item was genuinely contested (reviewer vs. adversary disagreed on whether
`docs/end-of-sprint-report-template.md`'s section ordering violates a CLAUDE.md sequencing rule) and was
resolved by an independent judge agent: DROP — direct inspection of both files showed the alleged
ordering constraint doesn't exist (friction was never part of the 7-numbered cleanup sequence in either
file), so the reviewer's premise was factually wrong and no escalation was warranted.

Applied:
- `docs/audit-pkg/operator-guide.md`: added `claude_worker` to the per-backend dispatch-inventory block
  list (`DISPATCH_INVENTORY_FIELDS` includes it, the doc's list didn't).
- `src/audit/README.md`: added `claude-worker` to the provider wiring-layer list (`src/audit/providers/index.ts`
  now injects `createClaudeWorkerProvider` alongside claude-code/opencode/agy).
- `spec/audit/dispatch-admission-control.md`: `HostDispatchDescriptor` → `AuditorDescriptor` (a stale type
  name — the rename predates even the prior doc-review checkpoint, reintroduced by the owner's manual
  batch-apply commit after the rename had already shipped).
- `spec/host-validation.md`: extended the live-dispatch e2e coverage-gap note to also name `claude-worker`
  alongside `agy` (its only existing test, `tests/shared/claude-worker-provider.test.mjs`, is a
  local-mock-HTTP-server unit test, not a live-dispatch e2e).
- `docs/HANDOFF.md`: fixed two changelog-lag spots left behind when commit 3 shipped after the section
  narrating it as open was last edited — "So the next item is `commit 3`" (inside a section already
  retitled "(closed)") now points to its shipped commits + ▶ IMMEDIATE NEXT; the "Live state" repair-proxy
  bullet's "an open worth-it call" tail now states the kind-1 transport shipped and was dogfooded.
- `docs/backlog.md`: deleted two fully-shipped memory-tagged friction entries with zero open remainder
  (the shared-core-capability-restore-every-draw lesson; the G2.5 spec-intent-vs-sketch lesson — both
  already have durable homes via their existing memory tags); fixed two stale internal citations in the
  G4 entry (`quotaPool.ts:129` → `hostPool.ts:156`, the logic moved during the assembly-unification lift;
  `sessionConfig.ts:681-685` → `src/shared/types/sessionConfig.ts:772-779`, drifted ~90 lines from
  intervening edits).
- `docs/project-philosophy.md`: tightened the B6 "log friction" citation to name its actual CLAUDE.md
  section (`→ Known friction & deferred fixes`), matching every sibling citation's precision — the same
  imprecision pattern the prior run's DD-11 fixed for A2/A4/B2; this was the one citation that pattern
  missed, independently re-scanned and confirmed exhaustive by both reviewer and adversary this run.

Full green gate (`npm run build && npm run check && npm test`) passed before push. One discrete commit
(`doc-review: nightly pass — 8 stale-factual-fixes applied, 12 items escalated`), pushed to `main`.
