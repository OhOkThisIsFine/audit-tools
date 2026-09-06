# P56 — reconcile every tracked GENERATED artifact against a declared freshness authority

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: THIS REPOSITORY.** Nightly 2026-09-06, HEAD `97f3033a`.

## The trap

A script derives a tracked file. Whether anything makes that file's *staleness*
red is decided one generator at a time, by whoever happened to wire a `--check`
into `verify:checks`. Nothing states the set, so the answer to "is this derived
file gated?" is a hand survey — and a generator added without a gate looks
exactly like one added with one.

This is the repo's own **`a-script-in-no-gate-is-not-a-gate`** one level up: that
memory is about a *script* nobody runs; this is about an *artifact* nobody
checks.

## Recurrence — 5 records across 4 distinct dates

| # | Record | Date | What went stale, unnoticed |
|---|---|---|---|
| 1 | memory `a-script-in-no-gate-is-not-a-gate.md` | 2026-07-25 | `smoke:linked-audit-code` was in no gate at all and drifted broken at HEAD; its existence read as coverage |
| 2 | proposal `P6-gate-enumeration-generated` | 2026-07-29 / 07-30 | the `verify:checks` step list, restated in prose in two docs, drifted from `package.json` on two consecutive nights — four omissions, two files |
| 3 | `docs/backlog/open-bugs.md:144` | 2026-08-30 | registering `check:loop-core-closure` took edits in five homes; **two further generated artifacts then went stale** (`ci-trigger-paths`, and the gate list inside `.claude/skills/ship/SKILL.md`) and were found one red at a time |
| 4 | `docs/backlog/open-bugs.md:216` | 2026-08-27 | `docs/nightly-inbox.md` and the tracked `.audit-tools/nightly/open-items.json` outlived the ledger that settled them. `render-inbox.mjs` has no `--check`, nothing reconciles either artifact against the ledger, every doc gate stayed green |
| 5 | `docs/backlog/minor-bugs.md:298` | 2026-08-26 | `a56f274d` deleted `GEMINI.md` and committed clean, leaving `check:doc-manifest` red on HEAD until `2a1faa1f` — the fails-only-in-release-CI class |

Five records, four distinct dates. Verified individually against HEAD; the line
numbers above are as read this run.

## The sharp one — confirmed damage, not predicted damage

Record 4 is the only entry in this cluster whose predicted harm is recorded as
having actually happened, in the entry itself:

> **The predicted damage happened the same day, and it is confirmed.** A lap read
> the six from the snapshot and put four to the owner, though all six had been
> settled and COMPLETED hours earlier.

Four settled propositions re-put to a human, and the entry notes one answer would
have reverted a completed decision. That is the cost of a derived artifact with
no freshness authority, and it is the reason this proposal's form is not open.

## Why the existing mechanisms do not catch it

Two things already exist and are *not* enough, which is worth stating precisely
so this is not read as reinventing them.

- **`scripts/shared/generatedArtifacts.mjs`** — "the ONE generated-artifact
  substrate (F1, ceremony review 2026-08-29)". It single-sources
  `spliceGeneratedBlock` and `runGeneratedArtifactCli`, and fixes the CLI
  convention (bare = write, `--check` = verify). Ten generators import it. It is
  a shared **implementation**, and it says nothing about which generators exist
  or whether any of them is wired into a gate. A generator that never imports it
  is invisible to it — and five of sixteen do not.
- **`scripts/check-guard-reach.mjs`** — the proven bidirectional reconciliation,
  but its subject is *guards* and the files they scan. A generator is not a
  guard, so no row claims it in that capacity, and a derived artifact's freshness
  is outside what `GUARDS`/`REACH` can express.

So the substrate exists, the reconciliation shape exists, and the *declaration*
that would join them does not.

## The survey, re-verified at HEAD

The prior lane's table was checked line by line. **It was wrong in one place and
imprecise in another; both are corrected here.** Sixteen tracked generators
(`scripts/**/generate-*.mjs` plus `scripts/nightly/render-inbox.mjs`):

| Generator | `--check`? | npm script | in `verify:checks`? | Authority today |
|---|---|---|---|---|
| `scripts/shared/generate-backlog-index.mjs` | yes | `check:backlog-index` | yes | check |
| `scripts/shared/generate-ci-trigger-paths.mjs` | yes | `check:ci-trigger-paths` | yes | check |
| `scripts/shared/generate-cli-surface.mjs` | yes | `check:cli-surface` | yes | check |
| `scripts/shared/generate-constitutional-doc-paths.mjs` | yes | `check:constitutional-doc-paths` | yes | check |
| `scripts/shared/generate-executor-producers.mjs` | yes | `check:executor-producers` | yes | check |
| `scripts/shared/generate-friction-categories.mjs` | yes | `check:friction-categories` | yes | check |
| `scripts/shared/generate-handoff-roadmap.mjs` | yes | `check:handoff-roadmap` | yes | check |
| `scripts/shared/generate-ingestion-checks.mjs` | yes | `check:ingestion-checks` | yes | check |
| `scripts/shared/generate-loop-core-patterns.mjs` | yes | `check:loop-core-patterns` | yes | check |
| `scripts/shared/generate-runtime-artifact-names.mjs` | yes | `check:runtime-artifact-names` | yes | check |
| `scripts/shared/generate-spec-mirrors.mjs` | yes | `check:spec-mirrors` | yes | check |
| `scripts/shared/generate-filelock-export-surface.mjs` | **NO** | — | — | contractTest (`tests/shared/filelock-export-surface.test.ts`) |
| `scripts/audit/generate-schemas.mjs` | NO | `generate-schemas` (write arm) | no | contractTest (`tests/audit/worker-schema-generation.test.ts`) |
| `scripts/remediate/generate-auditor-contract-fixture.mjs` | NO | `fixtures:auditor-contract` (write arm) | no | contractTest (`tests/remediate/fixture-generator-drift-guard.test.ts`) |
| `scripts/shared/generate-vitest-shard-baseline.mjs` | NO | `generate:shard-baseline` (write arm) | no | **none** |
| `scripts/nightly/render-inbox.mjs` | NO | `nightly:inbox` (write arm) | no | **none** |

**Corrections to the prior lane's survey:**

1. **`generate-filelock-export-surface.mjs` does NOT have a `--check` arm.** The
   prior lane reported it as "`--check` wired to no npm script". Its own header
   at HEAD says the opposite, in as many words: *"There is deliberately NO
   --check arm (an unwired one existed and was deleted — F7, ceremony review
   2026-08-29): enforcement is the drift test alone."* The prior lane's
   *conclusion* — that the contract test is its authority — is right; its
   *premise* was wrong, and the difference matters, because "an unwired `--check`
   exists" would have argued for wiring it, which the tree deliberately refused.
2. **Two more generators the prior lane did not classify** —
   `scripts/audit/generate-schemas.mjs` and
   `scripts/remediate/generate-auditor-contract-fixture.mjs` — have no `--check`
   either, and each is covered by a contract test (an A6 drift guard, and a
   byte-comparing drift guard that runs the real generator into a temp dir).
   Both are correctly gated; neither was in the prior lane's table.

The eleven-wired count is confirmed. The two genuinely ungated generators are
confirmed: `generate-vitest-shard-baseline.mjs` and `render-inbox.mjs`.

## The mechanism — form settled, not open

Extend `scripts/guard-reach-data.mjs` with a `GENERATED` section: one row per
tracked generator, each naming exactly one freshness authority that must exist.

```js
{ generator: 'scripts/shared/generate-backlog-index.mjs',
  authority: 'check', npmScript: 'check:backlog-index' },

{ generator: 'scripts/shared/generate-filelock-export-surface.mjs',
  authority: 'contractTest',
  contractTest: 'tests/shared/filelock-export-surface.test.ts',
  note: 'No --check by design (F7) — the drift test is the enforcement.' },

{ generator: 'scripts/shared/generate-vitest-shard-baseline.mjs',
  onDemand: true,
  reason: 'A measurement of this machine, not a derivation from tracked source.' },
```

Plus `check:generated-artifacts` in `verify:checks`, reconciling in both
directions: a tracked generator no row claims is red; a row whose named npm
script does not exist, does not pass `--check`, or sits outside `verify:checks`
is red; a row whose named contract test is not a tracked file under `tests/` is
red; an `onDemand` row with no stated reason is red.

**Why the form is settled and not offered as options.** The repo already runs
eleven `--check` gates on exactly this pattern, `check:guard-reach` is the proven
bidirectional shape, and `generatedArtifacts.mjs` already single-sources the
implementation. A second mechanism, a second registry file, or a per-generator
convention would be the duplication `check:shared-primitives` and the two-tier
dependency policy both exist to prevent. The three authority kinds are not a
design choice either — they are what the tree *already contains*, and a registry
that could not express `contractTest` would be forced to mis-declare three
correctly-gated generators as gaps.

The `contractTest` authority is not an invention: `CLAUDE.md` already rules that
enforcement is *"a **hook** when the trap is detectable at a tool call, and a
**contract test** when it is instead a property of the tree — a test is equally
binding and equally self-describing."* This applies that sentence to derived
files.

## What it would have caught

- **Record 4, the confirmed-damage one.** A `GENERATED` row for
  `render-inbox.mjs` cannot be written without answering "what makes this fresh?"
  — and the only honest answers are a new `--check` or an `onDemand` declaration
  that puts the known gap in the reader's face. Either way the 2026-08-27 drift
  stops being invisible. It would not, by itself, have re-rendered the inbox;
  the recommendation below is what does that.
- **Record 3.** `check:loop-core-closure`'s registration left `ci-trigger-paths`
  stale. `ci-trigger-paths` is authority `check` and already had its gate, so the
  reconciliation does not add coverage there — what it adds is the *statement of
  the set*, which is the missing affordance that entry names ("nothing states the
  SET, so each home is discovered by failing the next check").
- **A future generator landed with no gate.** This is the direction that matters
  most and has no past incident yet, because the tree is currently in good shape:
  the sixteenth generator added tomorrow reds the build until someone declares
  its authority, instead of silently joining the ungated two.

Stated honestly: this gate would **not** have caught record 1 (a smoke script, not
a generator) or record 5 (a doc deletion tripping an existing manifest gate that
the committing session's hooks did not run). Those two are in the recurrence
count as members of the *class* — a derived-or-checked thing whose gate nobody
ran — not as defects this mechanism intercepts. Counting them as catches would be
the inflated-coverage claim the guard-reach registry itself bans.

## False-positive surface

Low, and structurally bounded:

- The gate never runs a generator and never compares content. It answers only
  "does a declared authority exist", so it cannot go red on timing, environment,
  machine, or a legitimately-changed artifact. It reads `git ls-files`,
  `package.json`, and the registry.
- Measured: the candidate script run against the tree at HEAD exits **0** with
  16 generators, so the registry as drafted is already satisfiable — the gate is
  not asking for work the tree cannot supply. See `RED-AT.txt`.
- The one real cost is a **new-file tax**: adding a generator now requires a row.
  That is the intended cost, and it is the same tax `check:guard-reach` already
  charges for a new file. It is also the tax record 3 complains about ("five
  separate homes") — so this proposal makes that entry's count *six* while
  removing the thing it actually complains about, which is discovering the homes
  one red at a time. The `fix` string in the refusal names the file and the
  section, so the discovery is one message rather than a serial hunt.
- A subtler risk, stated: a row can be written `onDemand` to silence the gate.
  The mitigation is the same as `guardedBy: 'declared-gap'` — the reason is
  required, it is a tracked diff, and it is read by the next reviewer. The gate
  makes an ungated artifact *visible*; it cannot make it *gated*.

## The residual decision inside the settled form

**Does the `render-inbox.mjs` row demand a NEW `--check`, or land as `onDemand`?**

- **(i) Add `--check` to `render-inbox.mjs`** — it re-renders the inbox and the
  `open-items.json` snapshot from the answer ledger and compares. The row becomes
  `authority: 'check'`. **Recommended.** It is the artifact whose staleness
  caused the one confirmed damage in this cluster, the ledger is already the
  single source (`node scripts/nightly/answer.mjs --list` reports from it), and
  the entry at `open-bugs.md:216` already states this as its Property. Cost: one
  more `verify:checks` leg, and a nightly render becomes a thing that must be
  committed rather than left dirty.
- **(ii) Land it `onDemand` with the damage recorded as the reason.** Cheaper,
  and honest — the gap becomes declared rather than silent. But it *declares* the
  known-damaging gap instead of closing it, which reads as a close to the next
  reader, and this repo has been burned specifically by a record that reads as a
  closure while the residue is live (P53's sharp half).

The candidate registry ships (ii) as an explicit `PLACEHOLDER` whose `reason`
says it must not stay that way, so the owner's choice is visible in the diff
either way.

## Files in this proposal

- `generated-artifact-registry.test.ts` — the contract test (red at HEAD).
- `generated-artifacts-data.candidate.mjs` — the `GENERATED` section, all 16 rows.
- `check-generated-artifacts.candidate.mjs` — the reconciliation gate.
- `RED-AT.txt` — the measured red at HEAD **and** the measured green of the
  candidate gate against the real tree, with commands and exit codes.

Landing it needs: the `GENERATED` block appended to `scripts/guard-reach-data.mjs`;
`scripts/check-generated-artifacts.mjs` with its import repointed there; the npm
script; its insertion into `verify:checks` after `check:guard-reach`; a gate row
for itself in the `GUARDS` registry (`preCommit: 'always'`, same argument as
`check:guard-reach`); a gloss in `scripts/gate-enumeration-data.mjs`; the test
moved to `tests/shared/`. That list is six homes, which is record 3's complaint
— it is reproduced here deliberately rather than elided.
