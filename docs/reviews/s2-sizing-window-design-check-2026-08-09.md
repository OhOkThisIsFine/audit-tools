# S2 (routing removal) — the design check that refuted its own plan (2026-08-09)

Design record for **S2** of the routing-removal separation
([`routing-removal-separation-plan-2026-08-09.md`](routing-removal-separation-plan-2026-08-09.md)).
Read that plan's S1–S6 sequence first; this record **corrects its S2** and does not restate it.

Method: five parallel area maps (sizing-site census, rung-order semantics, consumer/test surface,
retirement collisions, gate surface) → one synthesized design → three adversarial refuters
(premise, behaviour, greenness) → a failing-test-first pass. Ten agents. Two refuters returned
**REFUTED**; the third returned SURVIVES-WITH-CORRECTION with six corrections. Every claim kept
below was re-read at `9ea59ffe`.

---

## The correction, in one line

**The plan's S2 is not implementable as written, because its premise is false and its target is
entangled with three undecided policy questions.** What survives the refutation is a small
provably-inert cut plus a data-loss bug that had to be fixed first.

---

## 1. The plan's finding 2 is factually wrong at HEAD

The plan says: *"the audit draw already resolves statics provider-free (`limits.ts:169` calls
`resolveModelStatics(hostModel)` with no provider). Only remediate passes one."*

`src/audit/cli/workPartitionRuntime.ts:19` calls `resolveModelStatics(self.model_id, self.provider)`
— it passes a provider — and `:21-28` builds per-roster-entry budgets folded by
`Math.max(...capacityCandidates)` at `:49`. That is the same shape as `plan.ts:800/:802`.

So S2 is a **three-site** class, not a two-site parity fix:

| # | site | what it sizes | routing inputs |
|---|---|---|---|
| 1 | `src/audit/cli/dispatch/quotaPool.ts:172` → `resolveSizingWindowTokens` | audit packets | (S1 removed the pool fold) |
| 2 | `src/remediate/phases/plan.ts:772` → `resolvePlanContextBudget` | remediation blocks | roster max, `host_provider` |
| 3 | `src/audit/cli/workPartitionRuntime.ts:13` → `resolveCurrentWorkPartitionRuntime` | audit work blocks | roster max, `self.provider` |

## 2. "Resolve the same single declared window as S1" is not a drop-in

The two draws read **different config fields**, with **inverted precedence**:

- `resolveLimits` reads `sessionConfig.quota` only — `quota.models[hostModel]` (`limits.ts:154`) and
  `quota.default_context_tokens` / `quota.reserved_output_tokens` (`:115-118`). It never reads
  `block_quota.context_tokens`; the only `block_quota` field it touches is `host_model`, at `:90`.
- `resolvePlanContextBudget` (`plan.ts:776`) and `resolveCurrentWorkPartitionRuntime`
  (`workPartitionRuntime.ts:17`) read `block_quota` **first** — operator intent outranks discovery.
- In `resolveLimits` operator-wide config is the **lowest** rung (`:217-225`); in the other two it is
  the **highest**.

The repo-root `session-config.json` declares `block_quota` and no `quota` block, so a literal reading
of the plan's S2 would stop remediate honouring the owner's own declared window.

## 3. Three policy questions the refutation surfaced — S2 must not decide these silently

1. **Which field is the single declared window?** `block_quota` is the cut-(d) survivor and the
   persisted spelling, but it is validated **nowhere** (`src/shared/validation/sessionConfig.ts` has
   no `block_quota` reference), while the rung it would delete *is* integer-guarded
   (`limits.ts:117-118`). And `spec/unified-dispatch-worker-model.md:189-190` blesses an operator
   override keyed by **model name** — i.e. `QuotaModelLimits` — as the escape hatch that may outrank
   discovery. Choosing `block_quota` promotes the unblessed field and deletes the blessed one.
   Compounding: `docs/backlog/open-bugs.md:608-617` already settles that `block_quota.host_model`
   should move to `self.model_id`.
2. **What replaces the roster max?** Not monotone. `nextStep.ts:344-354` merges persisted with
   explicit capabilities per field, so persisted scalars + a later `--host-models` is reachable and
   **grows** the budget (worked case: 16 800 → 117 600, 7×), which *un-splits* blocks against the
   small model the operator declared. On site 3 the number is worse than transient: it is persisted
   as `work_blocks` in `audit-findings.json` (`src/shared/types/finding.ts:299`) and read cross-run
   by remediate (`intake.ts:301`, `contractPipeline.ts:681,751`) — a schema contract field.
3. **The 1.43× safety-margin divergence.** Audit packets size at margin 1.0, blocks and work blocks
   at `BLOCK_SAFETY_MARGIN` 0.7. Evidence the raw path over-claims: `dispatch.ts:181-194` subtracts
   `AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` from it, and `rollingDispatch.ts:773-777` spends
   the same reservation again.

## 4. What is provably inert, and therefore shippable without an owner call

- **`providerName` on the audit sizing input.** It reaches exactly one expression,
  `hostClassFor(providerName)`, and **both branches return the same `defaults` object** — only the
  `source` label differs, and `sizingWindow.ts` destructures `{ limits }` and discards `source`.
  Exact identity on every rung.
- **The provider argument to `resolveModelStatics`** at `plan.ts:802` and `workPartitionRuntime.ts:19`.
  `src/shared/data/model-statics.generated.json` has no `__by_provider` key, so `modelStatics.ts:142-149`
  already falls through to the flat table. Byte-identical. ⚠ Removing it now is the point: the next
  `npm run update-models` would silently reintroduce a provider axis into **sizing**.

Both were attacked by two independent refuters and neither could be moved.

⚠ **`providerName` could not simply be deleted from `SizingWindowInput`** — `ResolveLimitsOptions.providerName`
was required, so the parameter became optional and `hostClassFor` gained a nullish guard returning
`"unknown"`. Still inert for every existing caller: `resolveLimits` has four call sites
(`src/audit/cli/quotaCommand.ts`, `src/audit/cli/dispatch/sizingWindow.ts`,
`src/shared/quota/capacity.ts`, `src/shared/quota/scheduler.ts`), two of which read `source` — and
the three routing-flavoured ones keep passing a provider, so only sizing takes the new path, where
`source` is discarded.

**How the equality is now enforced rather than asserted:** `tests/audit/dispatch-sizing-window.test.ts`
folds every case through **both** host classes (`claude-code` = hosted, `opencode` = local — the two
branches `hostClassFor` can take) and requires the single provider-free resolution to equal both. If a
provider could ever move the window, one fold disagrees. Validated by inversion: making the
`provider_default` rung return a different pair turns it red, naming the case and the provider.

## 5. What had to be fixed FIRST — a data-loss bug, not an S2 artifact

`resolvePlanContextBudget`'s refusal is documented as a resumable pause. It is not.
`handlePendingExtractedPlan` (`nextStep.ts`) wrapped the **whole** join — sizing, dirty snapshot,
coverage ledger, persistence — in one `catch` that deletes `extracted-plan.json` and reports
*"Corrupted extracted-plan.json removed"*. So an undeclared window **destroyed the extracted plan,
misreported the cause, and looped**: re-extraction cannot change the host's declared window, so the
next step reproduced it exactly, eating the plan on every lap.

It had **zero** coverage — `grep "Cannot size remediation blocks"` returned only the source line.
S2 as designed *widens* the input set reaching that throw (roster rung deleted, statics rung
narrowed, integer validation added), so the plan's "the resumable refusal at `:809-815` stays" was
resting on a refusal that was neither resumable nor reported.

**Fixed:** the recovery region now ends at the plan-validity boundary (normalization + grounding);
everything after it propagates. Pinned by `tests/remediate/plan-sizing-refusal.test.ts`, red-green
validated by inverting the edit.

⚠ The fix exposed two tests that were **green while testing nothing**:
`next-step-resume-gates.test.ts`'s two entry-gate-freeze cases assert only `not.toBe(...)`, and their
own fixture comment says the join must *succeed* — it never did. Their fixture now declares a window
and they assert the precondition positively.

---

## Decision

**S2 is split into two safe commits plus an owner gate.**

1. the recovery-boundary fix (§5) — landed with this record (`d7146254`);
2. the provably-inert provider removal (§4) — LANDED. The three sites lose `host_provider` /
   `self.provider` / `providerName` as sizing inputs; equality is enforced by the strengthened
   both-host-classes fold check, not asserted in prose;
3. **held for the owner: the three questions in §3.** Each moves a number for a real configuration,
   and one of them changes a persisted schema contract field. Until they are answered, the roster max
   and the choice of declared-window field stay exactly as they are.

**Do not re-derive §1 or §2.** The plan's finding 2 stays in that record as written; this file is the
correction, and both were verified at HEAD.

## Refuted claims — recorded so they are not re-proposed

- *"S2 is the draw-parity half of S1."* The two draws read different fields with inverted precedence
  (§2), and S1's three fold cases all run against `SessionConfig = {}` and populate only
  `discoveredLimits` (`tests/audit/dispatch-sizing-window.test.ts:100,117-136`), so they exercise no
  rung a ladder swap touches — they cannot witness the equivalence they would be cited for.
- *"`quotaPool.ts:202`'s roster max is the same defect as the other two."* It is not: each rank's
  window is resolved individually and packets are re-split per tier
  (`packetFilter.ts:170-196`). The other two maxes have no corrective pass — the max IS the final
  budget. But note the converse trap: feeding a single declared intent into the **per-pool** call
  flattens `tier_budgets` (`{small:6000, standard:6000, deep:168000}` → all `168000`), routing an
  oversized packet to the small model. Any shared-core adoption must keep that call per-pool.
- *"The plan's `--host-context-tokens` / `--host-output-tokens` survive as the declared window."*
  Half stale: those flags exist only on the remediate CLI (`src/remediate/index.ts:167,171`). Audit
  retired them into the descriptor (`src/shared/types/auditorDescriptor.ts:37,39`;
  `nextStepCommand.ts:301-302`). The surviving *concept* is the host-declared window; its carrier
  differs per draw, so a shared core must take the window as an argument rather than re-read config.
- *"`resolvePlanContextBudget`'s behaviour can be red-green tested directly."* It is module-private
  and its `caps` lookup runs only when `artifactsDir` is passed, which no existing test did. It is
  reachable only by driving `applyPlanPipeline` through a persisted `host_capabilities`, which is
  what `plan-sizing-refusal.test.ts` does.
- *"`workPartitionRuntime` sizes with the host's declared window."* It reads the **auditor's**
  window and subagent cap (`:19,33,37,43`) to size blocks the **remediator** executes and
  re-partitions (`plan.ts:749,759`). Wrong input, preserved deliberately — naming it
  "the declared window" without saying so would launder it.
