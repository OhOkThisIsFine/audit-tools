# 11 verified doc fixes — held because the tree was dirty

Every fix below passed the full three-agent gate (reviewer → independent adversary →
judge) **and** was re-verified against local HEAD `a0deffcc` by the judge personally.
None was applied: the working tree carried an untracked file from a concurrent session
(`scripts/shared/extract-backlog-entries.mjs`), and a dirty tree is report-only.

Apply as **one discrete, revertible commit** (`doc-review: <summary>`) after
`npm run build && npm run check && npm test` is green.

⚠ Re-verify each anchor before applying — HEAD moved once during the run that produced
this list (`2ceb35ea` → `a0deffcc`, a sibling session's backlog commit).

---

## Group 1 — the `backend_provider` → `service` rename left four stale spec references

Ground truth verified: `src/shared/validation/sessionConfig.ts:170,181` *rejects* the old
names ("this source uses the retired field `provider`; rename it to `transport` (and
`backend_provider` to `service`)"). Those two lines are the only `backend_provider`
occurrences left in `src/` and both are the rejection message. Pool identity keys on
`service[#account]/model` (`src/shared/quota/apiPool.ts:59-72`).

⚠ Scoping caveat that prevents over-eager fixes: `sessionConfig.provider` is **still a
live top-level field** (`src/shared/types/sessionConfig.ts:719`). The rename applies to
`DispatchableSource` entries only. Do not sweep `provider` globally.

| File | Line | Change |
|---|---|---|
| `spec/backend-identity-axes.md` | 15 | `` `backend_provider` `` → `` `service` `` |
| `spec/dispatch-jit-claims.md` | 39 | `` `backend_provider[#account]/model` `` → `` `service[#account]/model` `` |
| `spec/cross-provider-quota-matrix.md` | 35 | same token swap |
| `spec/unified-dispatch-worker-model.md` | 64 | same token swap |

**Deliberately EXCLUDED — sequence-blocked, do not apply with the above.** The table cells
at `spec/unified-dispatch-worker-model.md:272` and `:274` carry the same stale token, but
row `:273` ("operator exclusion pattern | `provider:model` (open, 3 tiers)") is stale in a
way no token swap fixes — the shipped grammar is axis-explicit and an unknown axis is a
*parse error*, not an inert rule. Patching 272/274 while leaving 273 produces a table with
two modern rows and one retired row, which is worse than uniformly stale. These wait on
the exclusion-grammar decision (open item `docs-2`).

---

## Group 2 — four narrow factual corrections

**5. `spec/remediate/remediation-goals.md:315`**
`- `remediation-report.md` has been rendered at repo root,`
→ `- `remediation-report.md` has been rendered under `.audit-tools/`,`
Anchor: `src/remediate/phases/close.ts:1713` `const outputDir = dirname(options.artifactsDir);`
and `:1721` `writeTextFile(join(outputDir, "remediation-report.md"), …)`. With
`artifactsDir = .audit-tools/remediation`, `dirname` = `.audit-tools`. Confirmed on disk.
(Checked and cleared: lines 17-18 name the artifact without asserting a location, so this
fix does not leave the doc self-contradictory.)

**6. `spec/multi-ide-concurrent-runs-design.md:38`**
`` (`src/audit/cli/reviewRun.ts`, `ledger.ts`) `` → `` (`src/audit/cli/reviewRun.ts`, `src/audit/orchestrator/ledger.ts`) ``
Anchor: `find src -name ledger.ts` returns exactly one file, `src/audit/orchestrator/ledger.ts`.
There is no `src/audit/cli/ledger.ts`; the bare filename beside a full sibling path reads
as same-directory.

**7. `spec/host-validation.md:17`** — `table above` → `table below`.
Anchor: the sole table in the file starts at `:52`; lines 1-15 are prose only.

**8. `docs/audit-pkg/development.md:115`** — delete the stray `</content>` last line.
Verified: file is 115 lines, the only fenced block is 22-28, so line 115 is not inside a
fence, and nothing references it.

---

## Group 3 — two HANDOFF corrections

**9. `docs/HANDOFF.md:184`** — `149 → 135 files` → `149 → 136 files`.
Anchor: `docs/reviews/memory-consolidation-2026-07-19.md:10` — "**Result:** 149 → 136
files." `docs/doc-review-guidelines.md:198` independently says 149→136. HANDOFF is the
lone outlier.
⚠ This is a *historical* result. The store holds **164** files today; do not "refresh" it.

**10. `docs/HANDOFF.md:232`** — `rollingAuditDispatch.ts:675` → `:691`, and `:485` → `:490`.
Anchor (grep at HEAD): `src/audit/cli/rollingAuditDispatch.ts:490` (empty-plan round) and
`:691` (drive end); definition at `src/audit/cli/dispatch.ts:150`.
⚠ **Scope strictly to HANDOFF.** `docs/backlog.md:202` and `:203` carry the same two stale
numbers, but that is a different doc under a different manifest row — fix it as part of
the backlog leg, not smuggled into a HANDOFF commit.
✅ Verified still open, so the item itself stands: neither `prepareDispatchCommand.ts:36`
nor `semanticReviewStep.ts:119` calls `releaseOwnedTaskClaims`; grep returns only
`dispatch.ts:150` and the two `rollingAuditDispatch.ts` sites.

**11. `docs/audit-pkg/development.md:17`** — delete the two words `the repo-root `.
Anchor: there is no `HANDOFF.md` at repo root (`ls` confirms); every other doc spells it
`docs/HANDOFF.md`. The *link* itself resolves correctly (`../HANDOFF.md` from
`docs/audit-pkg/` → `docs/HANDOFF.md`) and must not be touched.
⚠ Apply the **narrowed** form only. The reviewer's version also rewrote the `backlog.md`
link text, which was never false — that half is a cosmetic choice, not a fix.

---

## Explicitly deferred, needing an owner decision first

- **Stray `</content>` in two more tracked docs** —
  `docs/reviews/g3-dispatch-policy-plan-2026-07-16.md:347` and
  `docs/reviews/quota-prewall-pacing-diagnosis-2026-06-30.md:83`. Same artifact as fix 8,
  but both files sit in the *excluded* row of `docs/doc-review-guidelines.md`, so editing
  them is outside the routine's remit. Fixing one of three silently is worse than fixing
  none — see open item `docs-20`.
