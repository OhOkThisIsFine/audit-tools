# P30 — HANDOFF changelog creep recurs against a written rule, in the file the rule is written in

Nightly leg 3, 2026-08-13. Queue item `sol-5`. Propose-only. **The trim itself was APPLIED this run**;
what remains open is whether the rule should stop depending on someone remembering it.

## The defect

`docs/HANDOFF.md` is contracted to hold the current published state and the immediate next step,
and nothing else. Shipped-work narration keeps growing back into it.

## Recurrence — counted, 2 dates

| Date | Event |
|---|---|
| 2026-07-25 | Live state cut from 150 lines / 20 bullets to 59 / 8 — "changelog creep re-accreted in HANDOFF Live state, 27 fresh lines narrating what the last lap shipped". |
| 2026-07-26 | Owner sets THE RULE and it is written at the foot of the section: a Live-state bullet must be the immediate next step, or a currently-live gate/trap that will bite the next lap; anything else has another home. |
| 2026-08-13 | Creep found again: a seven-line landing narrative, a landed-items bullet, and an entire `## Verification state` section. Trimmed by this run under the 2026-07-26 rule. |

The rule is stated in three independent places — the section footer, `CLAUDE.md`'s end-of-sprint
step (4) ("immediate-next-only, never a changelog"), and `docs/documentation-philosophy.md`'s
doc-homes table — and was violated anyway. Three written statements did not hold the property.
That is precisely the shape `CLAUDE.md`'s *auditor-agnostic robustness* rule names as a latent
failure mode.

## Mechanism

The enforcement point already exists and is already wired. `scripts/shared/generate-handoff-roadmap.mjs`
owns two marker-delimited generated blocks and has a `--check` mode gated by `check:handoff-roadmap`
in `verify:checks` **and** at the pre-commit gate. It simply never inspects the hand-written region
between the markers.

Two shapes, and they differ sharply in how mechanizable they are:

**(a) Semantic check.** Refuse a hand-written Live-state bullet that is neither the immediate next
step nor a currently-live gate/trap. This is the rule verbatim — and a script cannot reliably make
that judgment. To be sound it would require the bullet set to be GENERATED rather than checked,
which is a much larger change to how HANDOFF is authored.

**(b) Heuristic check.** Refuse the shapes creep actually takes, which are narrow and detectable:
a dated bullet (`2026-08-12:` …), a past-tense landing narrative (`is LANDED`, `shipped in`,
`Built …-first`), and a `## Verification state` heading. Catches both observed instances; catches
the common shapes rather than all of them.

**(c) Do nothing.** The nightly doc-review found and trimmed the creep both times, so the routine
is arguably already the enforcement — at the cost of the creep being live in the tree between runs.

## What it would have caught

(b) would have caught both 2026-07-25 and 2026-08-13, at commit, before either reached a nightly.

## False-positive surface — stated honestly

(a) has a large one: any legitimately-phrased bullet a classifier misreads blocks a commit, and a
gate that misfires blocks every tool call until it is found. (b) has a small, concrete one: a
genuinely-live gate whose description happens to contain a date, or a Verification-state heading
someone wants deliberately. Both are addressable by naming the offending line in the refusal so the
fix is obvious.

Recommendation: (b). It is the mechanizable half, and the honest framing is that it is a partial
enforcement — the uncovered half (creep that avoids all three shapes) should be stated as data in
`scripts/guard-reach-data.mjs` rather than left implied, per the repo's half-close rule.

## Not authored this run

No patch, no red-green tests. Tests would belong under `tests/`.
