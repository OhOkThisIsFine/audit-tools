# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **PH-01 is DECIDED: rejected (owner, 2026-08-27).** *One core, two draws* stands — auditing and
  remediating remain ONE logical core and a difference between them is a policy axis of that core.
  Its central premise was false: mutation is not remediate-exclusive (`auto_fixes_applied` is third
  in audit's own `PRIORITY`). PH-01's objection to the one-core lap falls with it; the structural
  audit's separate *measurement* survives. Do not re-propose without new evidence.
- **The one-core dissolution lap is RE-BASELINED, and two of its defects are fixed** (`4986b201`).
  Both original premises were false when routed: remediate has driven the shared engine since
  2026-06-17, and `hostHandoffCore.ts` already owns three of the four named duplications. Fixed
  here: `PRE_INTAKE_PRIORITY` lost a dangling id the engine had been skipping in silence for two
  months, and both remediate `advance` sites now handle `outcome.stopped` through the new shared
  `describeStoppedFold` rather than reporting a wedged fold as a finished run. Two residues remain,
  both stated in the backlog entry.
- **The seven orphaned `docs/reviews/` records are routed.** Nineteen entries reached
  `docs/backlog/`, each proposed by one agent and refuted by a second against HEAD. The
  shared-helper adoption sweep produced none: all eight of its clusters landed after it was written
  and the class is now enforced by `check:shared-primitives`, so the repo's own rule deletes the
  entry rather than restating the trap. The gap that let it happen is itself an open-bugs entry —
  and the obvious "every review must be cited" gate is the WRONG one, for the reason stated there.
- **CX-02's design record is repaired AND gated, and the gate changed what the item is.** Its four
  refuted claims are corrected in place, and a `/design-check` then found three more things it did
  not carry plus one constraint answer that is simply wrong. The record is the single home for all
  of it. Two results matter most: the two registries are two LAYERS (the outer carries
  per-obligation host-boundary policy, the inner is uniform), and constraint 1's emission-point
  cycle-guard answer cannot work, because `advance` returns on the first emit so the tolerance of 16
  can never accumulate.
- **The separable half of CX-02 is landed.** One fold scan ran the holistic `deriveAuditState` 25
  times instead of once; the outer derive is now memoized exactly as the inner one has been since
  `6145a1a3`. Red-green validated by `tests/audit/one-holistic-derivation-per-scan.test.ts`. It is
  NOT a stage of the collapse — an independent lane established the cache makes that test pass while
  both registries and both drains survive.
- **Repository:** `main` and `origin/main` are synchronized; every commit passed its gates and the
  full suite is green (457 files, 6058 tests). No release is pending — `v0.50.2` is live on npm and
  matches the local version.

## Immediate next

**Implement CX-02's structural collapse.** One atomic loop-core replace; never stage half of it. The
design gate is done and the record carries verified inputs, so the next lap starts by writing the
two answers the gate left open — it does not start by coding.

1. **Re-answer constraint 1.** Its own answer is refuted. Decide where the cycle guards observe and
   in WHAT UNIT: `FINALIZATION_CYCLE_TOLERANCE` is 16 and today counts outer-fold transitions, each
   of which may contain up to 64 dispatches, so carrying the literal into a per-dispatch observer
   tightens the guard silently by up to 64x. Single-source it the way `deriveEngineBound` already
   single-sources the cap pair — derive the threshold, never write a second literal.
2. **Answer constraint 3's open question**, which the record says the spec must settle first: does
   the fold hold ONE lock across the work the outer layer ran outside it, or release and reacquire?
   Bound to it: several transitions RELOAD the bundle from disk, and keeping those reloads while
   deferring the write to a halt-time persist discards the in-memory `artifact_metadata` carry the
   PRIORITY-ordering guarantee depends on.

Then the replace itself: one registry carrying the host-boundary policy, dispatch-local failure
attribution, a FILTERED registry view for the `plan` draw (`runHostDelegationObligation` ingests
results, which a plan must not do), and the nine-plus pinning suites migrated in the same commit.
Note what verification is available: the collapse has NO test that can pass only once it lands, so
the pinning suites staying green is the evidence.

## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- `.audit-tools/nightly/open-items.json` still lists six items while `answer.mjs --list` reports
  none open. The rendered inbox was the half a human reads and it is fixed; the tracked snapshot is
  not, because `render-inbox.mjs` does not own that file and `writeOpenItems` refuses a batch that
  drops a record-path item on its own. The disagreement has its own open-bugs entry.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ CX-02 — one audit obligation registry, one drain. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
