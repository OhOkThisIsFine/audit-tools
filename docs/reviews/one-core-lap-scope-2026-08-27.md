# One-core dissolution lap — scope decision brief, 2026-08-27

> The owner asked for thorough pros and cons on whether to keep the lap at full scope, having
> already decided (2026-08-27) to KEEP the conviction *one core, two draws* and to REJECT PH-01.
>
> Method: five measurement lanes at HEAD `fd047b89`, then two independent adversarial lanes — one
> arguing for full scope, one against the convergence half on grounds independent of the rejected
> metaphor — then a judge. Every load-bearing claim below was re-verified by hand afterwards.

## The short answer

**The two positions differ far less than they appear.** Both lanes independently concluded:

- the entry is **false as written** and cannot be kept verbatim;
- the same **five concrete defects** should be fixed;
- the **granularity redesign** is unjustified by any measured defect;
- **CX-02 should land first** for that redesign quarter.

They disagree on one thing only: whether to keep a *lap* as the container, or to delete the entry
and track five named fixes. That is a bookkeeping choice, not an engineering one.

So the real question is not "full scope or narrow". It is: **the work the entry describes does not
exist, so what should replace it?**

## 1. Why the premise is false — and was false when it was routed

The entry has two halves.

**(b) ARC-908bbca5 — "remediate's ~3,800-line procedural `nextStep.ts` vs audit's priority-array
obligation walk."**

Remediate has not been procedural since 2026-06-17. At HEAD it imports shared `advance` from
`audit-tools/shared` and drives it twice — `PRE_INTAKE_PRIORITY` (8 ids) over
`buildPreIntakeObligations` (7 obligations), and `MAIN_PRIORITY` (10 ids) over
`buildMainObligations` (10 obligations). The whole 4,415-line file holds one `} else if`, zero
`switch`, and zero self-recursion. Selection is 757 lines of it — 17%. The rest is executor bodies,
helpers and prompt markdown that no convergence touches.

The A3 slices landed that conversion on 2026-06-17. The entry was owner-routed on 2026-08-19.
`MAIN_PRIORITY` was already present at the last commit before 2026-08-20. **The premise was false
two months before it was written down.**

Convergence also ran both directions: audit's CLI fold runs on the same shared `advance`, and so
does its drain loop. There are exactly four `advance()` call sites in `src/` — two audit, two
remediate.

**(a) ARC-e96acb7e — "host-handoff subsystem duplicated, zero shared core."**

`src/shared/submission/hostHandoffCore.ts` is 372 lines, imported by both twins, and already owns
three of the four named duplications. Two of the entry's sub-claims are also wrong about audit
specifically: audit derives no dispatch frontier (its tasks arrive as parameters), and it enforces
no write scope, because `allowed_files` is remediate-only.

## 2. The reviewers' reasons — which survive

The owner's instinct that the reviewers had good reasons is half right. Their **stated ground does
not survive**; their **measurement does**.

**Does not survive.** The structural audit rejected full host-handoff unification on the ground of
"per-case acceptance and mutation policy". Mutation is not remediate-exclusive: `auto_fixes_applied`
is the **third entry in audit's own `PRIORITY`**, and the audit draw spawns `prettier --write`,
`black`, `sqlfluff fix --force` and `gofmt -w` over the audited tree. The repo already tracks that
as an open forward track. Both draws enforce one write-scope predicate — returned evidence must be a
subset of declared scope — differing only in the oracle. Phase locks, clarification and recovery are
already shared or already injected. **Under "one core, two draws" these are policy axes, exactly as
the conviction says.**

PH-01's objection to (b) was metaphor-framed, so it falls with PH-01.

**Survives.** The measurement, which never depended on the metaphor:

- `jscpd` at the repo's own gate granularity finds **0 clones / 0 duplicated lines** across the two
  twins' 3,667 lines;
- residual shareable surface is **25–55 lines gross, with net deletion near zero**;
- the two prior extraction laps removed 112 twin lines and added 523 shared plus 362 test lines;
- about **40% of each twin is draw-specific by construction** and no one proposes sharing it.

Also surviving: the explicitly per-draw list encoded in the shared `submissionScan` module — refusal
message text, parser standalone-ness, loop ordering, consume timing. One of those has an incident
behind it: four submissions were lost to a collapsed refusal message. That bounds what unification
may collapse.

## 3. Pros of keeping the full scope

| # | Point | Strength |
|---|---|---|
| 1 | **There is a live defect that the fork causes.** `report_warning` sits in `PRE_INTAKE_PRIORITY` with no obligation defining it anywhere. The engine skips an undefined id **in silence**. It has been dead since 2026-06-26. Audit cannot have this bug class: `assertExecutorRegistryCoversPriority()` throws at module load, in both directions. | **strong** |
| 2 | **The fork is why the guard is impossible, not merely absent.** Remediate's priority arrays and builders are module-private, so no contract test can reach them. Audit exports its three symbols precisely so a coverage test can. This is a mechanical violation of *whatever can be enforced in tooling must be*, and the guard registry has no row for the class at all. | **strong** |
| 3 | **Remediate reports a wedged fold as a finished run.** Both audit call sites handle `outcome.stopped`; neither remediate site does — a `stopped: "bound"` or `"cycle"` outcome falls through to the normal terminal. The shared engine's own docstring forbids exactly this. Verified: `stopped` appears in remediate's `nextStep.ts` only inside an unrelated prose comment. | **strong** |
| 4 | **The bounded-step invariant is pinned on one draw only.** Remediate passes no `opts`, so its bound is the engine default of 100 by accident rather than by derivation. Audit derives its bound through the single-sourcing helper, and the single-source test asserts only the audit half. | moderate |
| 5 | **A prior extraction did not prevent the drift its own comment claims to have closed.** The shared callee was extracted while the per-draw adapter stayed forked, and that adapter has diverged: remediate drops the `runDir` the shared core returns and reconstructs it by string-slicing the workload filename. A rename of that file silently mis-derives every remediate result path. Both files carry the identical docstring asserting this could not happen. | **strong** |
| 6 | **A second live behavioural divergence sits in a fail-closed path.** The prompt-binding check runs the same five predicates in different order on the two sides, so a doubly-malformed document is refused for different reasons on each draw. Nothing pins the order, and `jscpd` cannot see a five-line reorder. | moderate |
| 7 | **A fork bigger than any the entry names sits outside every gate.** Remediate carries five private git probes, one duplicating a shared export with byte-identical argv but a **different success predicate**. That is semantic, not cosmetic. | moderate |
| 8 | **Feasibility is settled, not speculative.** The injection shape is shipped three times over on these exact concerns, and the dependency gate forces it. Nothing needs inventing. | **strong** |
| 9 | **Atomic replace is not an obstacle here.** Each A3 slice deleted a whole cascade segment and introduced its obligation replacement in **one** commit. The invariant binds per mechanism, not per file, so the residual can land as several small atomic replaces. | **strong** |
| 10 | **The scoping pass already paid for itself.** Four live divergences surfaced only because someone measured the two draws against each other. | weak but factual |

## 4. Cons of keeping the full scope

| # | Point | Strength |
|---|---|---|
| 1 | **A lap authorized as written would spend its budget on work that does not exist.** The thing it names — a procedural remediate `nextStep.ts` — has not existed since June. | **strong** |
| 2 | **The convergence target is scheduled for deletion.** CX-02 atomically replaces audit's nested double drain. Every structure it deletes is audit-only structure remediate never had. Converging remediate onto audit's *current* shape means doing it twice. | **strong** |
| 3 | **The residue is four small mechanical gaps, three with an exact audit-side template to copy.** Scoping that as a lap against a 4,415-line file mismatches the fix to the defect by orders of magnitude. | **strong** |
| 4 | **The one genuine redesign has zero measured defect behind it.** Remediate sequences sub-gates inside executor bodies where audit registers them as first-class `PRIORITY` ids. Redesigning loop-core selection granularity against no failure evidence is what this repo's design-check and attestation gates exist to slow down. | moderate |
| 5 | **"Converge on the engine's capability surface" is not a safe default.** At least one capability must **not** be adopted. `opts.stateSignature` was tried on this very track, passed all 2,191 local Windows tests and a careful diff review, and was reverted for a Linux-only regression. | moderate |
| 6 | **The cost calibration is bad, and worse now than when measured.** A3/A4 was 44 commits, 46 files, +3,377/−1,108 over ~21 hours, and contained a full revert. The loop-core attestation gate landed three weeks *after* that lap, so A3 paid none of it. Every file this work touches is loop-core, and attestation binds to the exact staged tree and cannot be chained with the commit. | moderate |
| 7 | **The entry cannot be re-derived from its own evidence.** Both `[[…]]` memory citations dangle, and the citation gate structurally cannot see that form. | weak |
| 8 | **Half (a) cannot be defended as deduplication at all.** Zero clones at gate granularity; 25–55 residual lines; near-zero net deletion. If the criterion is lines removed, (a) loses outright. | **strong** |

## 5. Scope or sequencing?

Predominantly **scope**, with sequencing binding on exactly one quarter.

Defects 1, 2, 3 and 4 in the pros table are **CX-02-independent**. CX-02 changes audit's drain
*nesting*; it does not touch the load-time coverage assertion, the `stopped` contract, or bound
derivation. Those fixes can land now.

Only the **granularity** gap targets what CX-02 deletes. And CX-02's own source audit names
remediate as the demonstration of the shape audit is converging *toward* — so after CX-02, audit
becomes **more** like remediate, not the reverse. Converging remediate onto audit's current
double-drain today would converge onto a shape scheduled for atomic replacement.

CX-02 therefore does not defer this work. It dissolves the redesign quarter and leaves a bug list.

## 6. What the work actually is

Five named, individually attestable fixes:

1. Export remediate's priority arrays and builders; add a **bidirectional** coverage assertion plus
   a contract test; delete the dangling `report_warning`.
2. Handle `outcome.stopped` at both remediate `advance` sites.
3. Derive remediate's bound rather than inheriting the default 100, and extend the
   `bounded-call-single-source` test to cover it.
4. Keep the shared core's `HostHandoffPaths` intact inside remediate's `BoundaryPaths` — stop
   reconstructing `runDir` by string-slicing.
5. Single-source and pin the prompt-binding predicate order.

Plus, from the scoping pass itself: add a **guard-reach row for priority/registry coverage** — there
is none today.

Do **not** authorize the granularity redesign yet. It has no measured defect and its target moves.

### Correction — what the design gate changed about this list

Running the pre-implementation gate over fixes 1–3 revised two and deleted one. Recorded here
because the list above is what a later session would act on:

- **Fix 1 is a contract test, not a load-time throw.** Audit's `assertExecutorRegistryCoversPriority`
  iterates `PRIORITY` only — it is *not* bidirectional. Audit's bidirectional coverage lives in
  `tests/audit/executor-registry-sync.test.ts` as a test pair. The load-time shape cannot port:
  remediate builds its registries per call from a full ctx, and `src/remediate/index.ts` imports the
  module statically, so an import-time throw would preempt the step write that `blocked` exists to
  guarantee.
- **Fix 2 must not supply `opts.stateSignature`.** Commit `670a6148` reverted that for a Linux-only
  cycle regression, and audit deliberately omits it. `stopped: "cycle"` is therefore *unreachable*
  for remediate — the engine allocates its visited set only when a signature is supplied — so the
  handler discriminates `"bound"` and keeps `"cycle"` only as a type-exhaustiveness arm.
- **Fix 3 is deleted. It was never a defect.** `deriveEngineBound(cap)` derives from a consumer's own
  graceful cap. Remediate has none: `countStep` increments persisted `step_count` once per host
  invocation and enforces no limit. The engine documents its default of 100 as far above any
  legitimate chain, "the deepest real remediate-code fold [being] a handful of transitions per call".
  Deriving would mean inventing a cap to derive from.
- **A citation-gate widening listed above is already done.** P45 landed in `b91057c5`;
  `check:memory-citations` now matches the `[[…]]` form as well. The stale `open-bugs.md` entry
  claiming otherwise is deleted.

## 7. Recommendation

**Re-baseline, do not delete.** Rewrite the entry to the measured residual — the five fixes above,
with the granularity quarter parked behind CX-02 — and keep it as one tracked item. Deleting it
outright risks the same stale framing being re-derived by the next audit from the file's raw size,
which is a failure mode nobody has a mechanism against.

That is the disposition both lanes converge on. It gives the owner what "keep the full scope"
was reaching for — the defects get fixed, the vehicle survives — while refusing the two parts that
are genuinely unjustified: a 4,415-line convergence that is already done, and a redesign with no
evidence behind it.

## 8. What would change this

- Evidence that the unhandled `stopped` or the dangling id **fired in a real run** → those land
  before CX-02, not after.
- A measured defect attributable to the **granularity** difference → that quarter becomes real work,
  still post-CX-02.
- Confirmation that remediate locally reimplements `bindingIdentity`, `resultMapIdentity`,
  `idsAreUnique` or `firstDuplicateIdentity` — **unmeasured today** → half (a)'s surface exceeds 55
  lines and regains lap status.
- CX-02 slipping indefinitely → re-ask on the granularity quarter.

Nothing about the metaphor changes any of this.

## 9. Honest limits of this brief

- **Severity of the two headline (b) defects is unmeasured** — only their existence is verified. No
  evidence was found that remediate's unhandled `stopped` has ever fired; its folds are shallow and
  its bound is 100. Whether `report_warning` was an oversight or a deliberately reserved slot is
  unknown.
- **The residual lap cannot be sized.** The nearest calibration is this track's own first half, but
  that was the whole conversion.
- **Two measurements half (a) needs were not taken** — the four identity helpers above, and whether
  generalizing the workload-envelope parser would net a line reduction.
- **Linux-CI-only regression risk is measured and precedented** on this exact track, and it defeats
  local validation.
- The provenance of the ARC-908bbca5 finding text was not traced. If a later audit re-derived the
  stale framing from the file's size, the same framing recurs regardless of what happens to this
  entry.
