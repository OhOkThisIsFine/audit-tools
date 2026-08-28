# State of play — 2026-08-27

> A dated snapshot, not a durable concept doc. It answers three questions: where the tree is,
> what the recent complexity analysis produced, and what the backlog and forward tracks now hold.
> Durable facts belong in `CLAUDE.md`, `docs/backlog/` and project memory. This record exists to
> route them there, then to be deleted.
>
> Every claim below was extracted once and refuted once by an independent lane. Corrections that
> the refutation produced are folded in, not appended.

## 1. Where the tree is

Everything mechanical is green.

| Signal | State |
|---|---|
| Branch | `main`, clean tree, `0 0` against `origin/main` |
| HEAD | `fd047b89 release: v0.50.1` |
| `npm run build` | green |
| `npm run check` | green |
| Doc and backlog gates | 11 of 11 green |
| npm registry | `audit-tools@0.50.1` published; local version matches |
| Tags | `v0.50.1` present. `v0.50.0` has no tag — that release burned, as `f7881bc8` records |
| `TODO`/`FIXME` in `src/` | effectively zero; the two hits are the analyzer's own debt-marker regex |

The pipeline is complete. Nothing is parked at the push or publish boundary.

## 2. Seven of ten recent reviews reached no work queue

This is the headline. The complexity work is not one document. Ten reviews are dated 2026-08-20
or later. Three are cited from a tracked doc; seven are cited by nothing.

| Review | Lines | Cited from |
|---|---:|---|
| `complexity-reduction-audit-2026-08-26.md` | 282 | `docs/HANDOFF.md` |
| `cx02-drain-unification-design-2026-08-26.md` | 58 | `HANDOFF` + `forward-tracks.md` |
| `low-tier-phase-cost-2026-08-25.md` | 83 | `spec/self-scaling-pipeline-design.md` — a spec, not a work queue |
| **`audit-tools-simplification-workflow-gap-2026-08-26.md`** | **618** | **nothing** |
| **`philosophy-simplification-audit-2026-08-26.md`** | **548** | **nothing** |
| **`n-r13-and-lean-fast-path-trace-2026-08-25.md`** | **294** | **nothing** |
| **`shared-helper-adoption-2026-08-25.md`** | **238** | **nothing** |
| **`closeout-generation-failure-2026-08-26.md`** | **152** | **nothing** |
| **`memory-cut-list-2026-08-25.md`** | **147** | **nothing** |
| **`wave2-dispositions-2026-08-20.md`** | **111** | **nothing** |

Four of the orphans are simplification analyses carrying identified, prioritized work: the
philosophy audit (PH-01…PH-10, DC-01…DC-07), the workflow-gap analysis (8 gaps and a P0/P1/P2
sequence), the shared-helper adoption sweep (F1…F8), and the closeout-generation failure record.
Together that is over 1,500 lines of analysis that no work queue knows about.

`grep -rn 'PH-0\|DC-0' docs/backlog/ docs/HANDOFF.md` returns nothing.

No mechanism could catch this. No gate reconciles `docs/reviews/` against `docs/backlog/`, and
`docs/documentation-philosophy.md` states no rule for routing a review's recommendations into a
work queue. Every gate is green precisely because none of them looks here.

## 3. CX status — verified by commit, not by claim

| Id | Title | Commit | State |
|---|---|---|---|
| CX-01 | One directed-cycle core with exact SCC membership | `c39a9b88` | landed; a real correctness fix |
| CX-02 | One audit obligation registry, one drain | — | **OPEN, pinned** |
| CX-03 | Delete tested-only production APIs | `d24ae899` | **landed 4 of 5 rows** — see below |
| CX-04 | Cross-gate outcomes becomes the only evaluator | `4f708226` | landed |
| CX-05 | One finding-survivor fold, two matching policies | `f16e312c` | landed |
| CX-06 | One shared host-submission scan | `b7bcfa3a` | landed |
| CX-07 | Table-drive the required-entry field checks | `0feac4f8` | landed |

**CX-03 is not fully landed as the document describes.** Four of its five symbols are gone
tree-wide: `writeCanonicalAuditDeliverables`, `readContractPipelinePlanningOutputs`, `isBlockId`,
`fromBlockId` and `obligationKindVocabularyDivergence` all return zero hits. The fifth,
`projectDesignReviewInputs`, still exists at `src/audit/orchestrator/designReviewProjection.ts:275`
and was **wired into production** at `src/audit/orchestrator/designReviewSnapshot.ts:120` — the
opposite of the proposed deletion. That is a legitimate alternative resolution, but `HANDOFF`
records CX-03 as landed without saying so.

Five of the six landed items touch `src/remediate/**`, mostly the contract pipeline. The pass
cleaned the remediate side. CX-02 is the only candidate that touches the audit loop core.

## 4. Three problems inside the one pinned item

**PH-03 is CX-02's prerequisite, and it is untracked.** PH-03 evolves the shared `advance()` into
`advanceUntilBlocked`, then states that once the shared result can express every legitimate stop,
the audit-specific outer drain identified by CX-02 can be removed. The backlog pins the deletion,
not the enabling contract change.

**The pinned design record contains verified errors.** Independent refutation of
`cx02-drain-unification-design-2026-08-26.md` found four:

1. Marker-protocol sub-claim (c) is **refuted**. `spec/audit/executor-producers.generated.md` is
   generated structurally from `EXECUTOR_REGISTRY[].produces` and `LIFECYCLE_PRODUCTIONS`; the
   render names no obligation registry.
2. The lock-held read-modify-write is cited at `nextStepHelpers.ts:1822-1823`. Those lines are the
   success-path marker fields. The real site is `:1845-1851`.
3. The claim that `executor-registry-sync` retires with the second registry is **overstated**. Only
   2 of that file's 4 tests consume `buildAuditObligations`; the other two must survive.
4. The composite cap of about 6,400 **mixes units**. 100 is the outer engine's transition budget,
   64 is the inner dispatch-slot cap, and the inner engine transition bound is 66, not 64. The
   product is a dispatch-slot ceiling, not a transition count.

**PH-01 instructs a narrowing that the backlog has not applied** — see the next section.

## 5. The orphaned philosophy audit contradicts live, tracked decisions

> **PH-01 is DECIDED, 2026-08-27: rejected. The conviction stands.** The owner kept *one core, two
> draws*. Auditing and remediating remain ONE logical core, and a difference between them is a
> policy axis of that core, not a reason to fork. Route PH-01 to the decided-against register, not
> to the work queue, and do not re-propose it without new evidence.
>
> Two consequences follow, and they must not be conflated. PH-01's objection to the one-core lap
> was metaphor-framed, so it falls with PH-01. The structural audit's separate rejection of *full
> host-handoff unification* rested on per-case acceptance and mutation policy, not on the metaphor,
> so it survives independently and is still live evidence.

### It names four standing formulations as the source of avoidable complexity

| Formulation named | The standing decision it challenges |
|---|---|
| Implementation identity is treated as proof of conceptual unity | *One core, two draws* |
| Every mechanically detectable rule is presumed worth a hard gate | *whatever can be enforced in tooling must be* |
| Adversarial ceremony is a fixed floor rather than a risk response | the fixed review and host-turn ceremony |
| Endpoint purity discounts transition reversibility and blast radius | *Ideal code over compatibility* |

### PH-01 instructs a narrowing of a track the backlog still carries at full scope

PH-01 cites `docs/backlog/forward-tracks.md:132-141` by line. It says to narrow the one-core
dissolution lap to shared handoff substrate and pure primitives, and not to make remediation
conform to audit's obligation walk merely to satisfy the metaphor.

The structural audit agrees independently. Its *Rejected attractive abstractions* list names full
host-handoff unification.

The tracked entry still says to converge remediate's step derivation on the obligation-walk shape.
Two reviews say that half should not be done. The backlog does not know.

The evidence is not a preference. Remediation owns mutation, phase locks, clarification, triage,
merge, quarantine and recovery semantics that audit does not. Partial audit coverage may be
abandoned; half-applied remediation may not. The proposed replacement metaphor is **one protocol,
two bounded contexts**.

Measured at `fd047b89`: `src/remediate/steps/nextStep.ts` 4,415 lines; audit `hostHandoff.ts`
1,366; remediate `hostHandoff.ts` 2,301; and `src/shared/submission/hostHandoffCore.ts` **372
lines of substrate the two already share**.

### The lap's premise is stale, and it is stale in the direction nobody expected

The entry describes remediate as a procedural file that must converge on audit's obligation walk.
That was true when it was written on 2026-08-19. It is not true at HEAD.

Remediate already drives the shared engine. `src/remediate/steps/nextStep.ts` calls shared
`advance()` twice — pre-intake at `:4376` and main at `:4406` — against **two priority arrays**
(`PRE_INTAKE_PRIORITY`, `MAIN_PRIORITY`) and **two declarative obligation registries**
(`buildPreIntakeObligations` at `:3746`, `buildMainObligations` at `:4032`). Slices A3-1, A3-2 and
A3-2b landed that conversion.

So half (b) is substantially done. And the side that still nests two drains over one `PRIORITY`
array is **audit**, which is exactly what CX-02 exists to fix. The lap's two halves have swapped
places: remediate converged, audit did not.

## 6. The orphaned helper-adoption sweep claims a home it does not have

> **Corrected 2026-08-27, same day.** This section is wrong about the sweep being unactioned. A
> refutation lane re-counted all eight clusters at HEAD: every one was implemented across five
> commits (`6403e766`, `2fc3f385`, `7d4caef5`, `5fc0a1d5`, `927017fb`), and the whole class is now
> enforced by `check:shared-primitives`, which reports every tracked `src` file clean. The
> implementing lap found MORE debt than the sweep claimed in every cluster it re-counted, so the
> sweep's severity judgments were conservative rather than unrefuted. One residue survived and is
> on the queue: the gate's hash rule is keyed to the spelling `sha256`, so an inline `sha1` chain
> re-rolls the anti-pattern it bans. Read the rest of this section as the history of a routing
> question, not as a live finding.

`shared-helper-adoption-2026-08-25.md` opens by calling itself an evidence record for three
open-bugs entries. No such entries exist. A grep over `open-bugs.md` for its subjects returns
nothing.

It documents eight adoption-debt clusters where a canonical helper already exists, is exported and
carries a comment saying it is the only one:

| Id | Cluster |
|---|---|
| F1 | the root-containment guard, forked four ways |
| F2 | `isRecord`, nine definitions, one of them weaker |
| F3 | `compareCodeUnits`, seven definitions, two exported homes |
| F4 | ICU collation on arrays the same file says must be code-unit ordered |
| F5 | `hashContent` bypassed five times, once by the anti-pattern it names |
| F6 | path normalization, ten definitions, two behaviours |
| F7 | a JSONC comment stripper beside the scanner it imports |
| F8 | exact twins |

**Read its own caveat before acting on it.** Its verification fan-out died: the account hit a
monthly spend limit and all seven agents errored before doing any work, which is the documented
success-shaped-empty-result trap. The site lists were each read at source. The severity judgments
are unrefuted single-pass evidence.

## 7. Backlog composition

184 entries across four files.

| File | Entries | Lines | Role |
|---|---:|---:|---|
| `open-bugs.md` | 100 | 936 | fixable defects and friction — the working queue |
| `durable-traps.md` | 71 | 773 | standing environment reference, not work |
| `forward-tracks.md` | 10 | 151 | design directions |
| `deferred.md` | 3 | 47 | blocked on data, a run, credentials or a toolchain |

Severity across the 100 open-bugs entries, counted over the bold headers: **7 high, 19 medium,
2 low-medium, 51 low, 21 with no stated severity.** One of the seven highs states HIGH only
retrospectively, about its former title, so **6 highs are currently asserted**.

The queue is not rotten. Five high-severity entries were spot-checked against HEAD and every one
is still a live defect. No entry was found fixed-and-left-behind.

### Three hygiene defects

1. **The nightly queue disagrees with its own ledger.** `docs/nightly-inbox.md` and the tracked
   `.audit-tools/nightly/open-items.json` both list six open propositions and a banner reading
   "11 answered items not yet marked done". `node scripts/nightly/answer.mjs --list` returns "No
   open nightly items, and every tracked answer is recorded as done". `109d101a` rendered the
   queue; `b91057c5` and `f41d2442` landed the answers and neither re-rendered.
   `render-inbox.mjs` has no `--check` and no gate reconciles it. The `SessionStart` hook reads the
   ledger, so it correctly surfaced nothing — the damage falls on whoever opens the inbox.
2. **The size baseline holds dead amnesties.** `.size-baseline.json` grandfathers two
   `forward-tracks.md` entries that were deleted with the retired execution substrate. A stale
   amnesty never matches, so the dead data is invisible.
3. **The ceiling does not ratchet down.** It caps `open-bugs.md` at 129,162 bytes against an
   87,087-byte file — about 48% growth headroom, set when the file was larger.

## 8. Forward tracks — current holdings

| Entry | Note |
|---|---|
| CX-02 — one audit obligation registry, one drain | the one pinned item; PH-03 untracked; design record has four verified errors |
| One-core dissolution lap | **its premise is stale** — see below; scope decision open with the owner |
| The audit draw WRITES to the audited tree | phase-1 auto-fix runs `prettier --write`, `black`, `sqlfluff fix --force`, `gofmt -w`; refusable but ON by default |
| Metric-pool empirical program | interim grouping awaiting the five-repo lab experiment |
| A2 finding-quality oracle | spec settled: pinned public repos, never labeled self-audit runs |
| Deterministic analyzers: own-vs-acquire | open half is clippy/rubocop live spawn, blocked on toolchain |
| End-to-end remediate-run smoke for the tool-owned gate | unbuilt; the existing smoke drives `next-step` but no gate execution path |
| Obligation-id slugs vs decomposed-module names | open question, not a planned change |
| Wave-friendly host dispatch | needs a `/design-check` before any build |
| Isolated-branch landing gap | no closing action lands an isolated remediation branch |
| CI wall-clock shard balance | pointer only; assigned outside this repo's agent loop |
| Track 2.5 — production-orphan detection beside knip | the omission is declared, not remembered: `.dependency-cruiser.cjs` states it and gives the reason |

## 9. What I recommend

Ordered by leverage, not by effort.

1. **Route the seven orphaned reviews into `docs/backlog/`.** This is purely mechanical and it
   unblocks judgment on everything else. PH, DC and F items become entries; the workflow-gap P0
   becomes one entry pointing at its own document, in the style the CI wall-clock track already
   uses.
2. **Settle PH-01 before starting CX-02.** It is the highest-leverage decision in the analysis and
   it changes what *One core, two draws* means. CX-02 and the one-core lap both inherit their scope
   from the answer.
3. **Repair the CX-02 design record before implementing it.** Four errors are verified. The item is
   a multi-session atomic loop-core replace that must never be staged half-done, so a wrong cap or
   a wrong lock site is expensive.
4. **Refute the helper-adoption sweep before opening a lap on it.** Its own verification pass never
   ran.
5. **Close the review-to-backlog gap mechanically.** Without a gate, the next analysis lap orphans
   the same way, and every gate stays green while it happens.
6. **Fix the three hygiene defects** in section 7.

## 10. Owner decisions this raises

1. **PH-01** — does *one core, two draws* become *one protocol, two bounded contexts*?
2. **The one-core dissolution lap** — narrow it to shared substrate and pure primitives, as both
   reviews recommend, or keep the obligation-walk convergence?
3. **PH-05 and the hard-gate presumption** — does every mechanically enforceable rule still earn a
   hard gate, or does each gate need an authority and lifecycle-cost test?
4. **The workflow-gap P0** — implement the eight-step rewiring and run its blinded benchmark, or
   leave `/audit-code` as it is?

---

*This is a routing instrument, not a durable concept doc. Once every finding above has reached
`docs/backlog/`, delete it.*
