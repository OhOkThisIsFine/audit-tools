# docs-22 — five concepts with two or three homes: which home survives

> Nightly item docs-22, verified pair-by-pair against HEAD on 2026-07-25 (offload lane, `gpt-oss-120b`,
> one pair per call; 22a re-judged by hand). One home per fact settles *that* there be one home — not
> *which*, which is authorship. This is the recommendation set for the owner's pick; nothing here is
> applied.

## 22a — graph-evidence tiers · **DISSOLVED, no merge needed**

`docs/audit-pkg/product.md:79-86` lists four evidence **kinds**; `docs/audit-pkg/contracts.md:171-179`
lists three **authority classes** for consumers. The claimed contradiction ("FOUR vs THREE") is a
granularity difference, not a disagreement: product's *deterministic ownership edges* and
*analyzer-supplied ownership roots* both fall under contracts' single *ownership edges* class. They
answer different questions — what the evidence IS vs. how much authority a consumer should give it.

**Recommendation:** no merge. Add a pointer each way so the next reader does not re-litigate it.
Same family as [[most-claimed-doc-conflicts-dissolve]].

## 22b — obligation ordering · **README survives**

`README.md:147-150` carries the ordering WITH the disclaimer that `PRIORITY` in
`src/audit/orchestrator/nextStep.ts` is authoritative and the numbering is conceptual grouping.
`docs/audit-pkg/development.md:41-50` repeats the ordering with **no** disclaimer, so it reads as
authoritative — the more dangerous copy, because a reader who finds it first gets a literal execution
sequence that is not one.

**Recommendation:** README keeps the prose; `development.md` becomes a pointer. Neither should restate
the array — CLAUDE.md already records that copies of `PRIORITY` have drifted before.

## 22c — exclusion grammar · **CLOSED 2026-07-25**

`spec/backend-identity-axes.md` owns it; `spec/unified-dispatch-worker-model.md` and
`docs/audit-pkg/operator-guide.md` now point at it (commit `80b59b7b`). The operator guide keeps the
worked examples an operator needs — audience-appropriate usage, not a second definition.

## 22d — partial completion · **audit-goals survives; orchestration-policy gets the valve**

`spec/audit/audit-goals.md:131-139` documents a sanctioned partial-completion valve, and
`recordPartialCompletionTerminal` is live at `src/audit/cli/dispatch/pausePersist.ts:65`.
`spec/audit/orchestration-policy.md:77-84,:110-111` describes completion as all-or-nothing and never
mentions it. This is the one pair where the gap is a **missing fact**, not a duplicate: a reader of
orchestration-policy concludes a run either completes or does not.

**Recommendation:** audit-goals keeps ownership (it is the normative goals doc); orchestration-policy
gains one sentence naming the valve and pointing at it. ⚠ `audit-goals.md` is CONSTITUTIONAL — an
edit there is escalate-only, but this recommendation does not require one.

## 22e — quota / dispatch canon · **needs the owner; both self-declare**

`docs/quota-dispatch-design.md:1-2` — "The single source of truth for *who tracks which quota and why*".
`spec/audit/dispatch-admission-control.md:3` — "This is the design of record for the dispatch/quota model".
The scopes are adjacent, not identical: quota *tracking* vs dispatch *admission against* a ledger. But
the second sentence claims the whole "dispatch/quota model", which swallows the first.

**Recommendation:** keep both documents and narrow the second's self-declaration to admission control
specifically, so the two claims stop overlapping. The alternative — folding one into the other — is a
larger call, because `dispatch-admission-control.md` sits under `spec/audit/` while the quota design is
a cross-cutting `docs/` concept and would have to move.

## What is left for the owner

22a, 22b, 22d are recommendations that can be applied as written once approved. 22e is a genuine
authorship choice between narrowing a claim and merging two documents.
