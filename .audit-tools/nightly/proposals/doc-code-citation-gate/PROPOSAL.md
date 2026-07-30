# Proposal — `check:doc-code-citations`: a backticked repo path in a doc must exist

**Leg 3 (solutions). Proposal only — nothing in this directory is applied.**

## The trap

A doc names a real repo file in backticks (`` `tests/audit/next-step.test.mjs` ``). The file is
later renamed or deleted. Nothing notices. The doc now points a reader — human or agent — at a
path that does not exist, and the citation carries the authority of a pointer nobody can follow.

`check:doc-links` catches this for *markdown links*. Nothing catches it for the far more common
form: a path in backticks, which is how this repo's docs cite code almost everywhere.

## Recurrence — counted, not asserted

| Date | Record | Instance |
|---|---|---|
| 2026-07-29 (this run) | leg 1, four independent reviewer lanes | **31 stale `.test.mjs` citations** across 9 tracked docs after the `.mjs`→`.ts` test ratchet (commits `66e88b73`, `573beb23`, `defe7dd1`, `5f2c0191`) renamed 560 test files and no doc sweep followed |
| 2026-07-28 | nightly item `backlog-10`, settled *"Drop bare line numbers. Repair by pointing them at the appropriate symbols."* → commit `c396a99f` | **77 drifting line-number citations** repo-wide |
| 2026-07-2x | `docs/backlog/open-bugs.md:10` | *"A contract change swept `tests/` and missed the PRODUCERS in `scripts/` — caught only by CI"* — same class, code side |
| standing | memory `refactor-must-sweep-memory-not-just-code` | a rename sweeps code and leaves every prose citation behind |
| standing | memory `backlog-prose-decays-verify-against-head` | backlog prose decays against HEAD; verification is manual |

Five records, four distinct dates, both directions (doc→code and code→doc). This is a pattern.

## Already mechanized? Only for two neighbouring shapes

- `scripts/check-doc-links.mjs` — **markdown links only** (`[text](path)`). Green at HEAD; it did
  not see one of tonight's 31.
- `scripts/check-memory-citations.mjs` — the exact same idea for `memory: <slug>` citations, and
  the direct precedent for this proposal's shape (including its "SKIP when the store is absent"
  honesty about what CI can see; this gate needs no such carve-out, since it checks tracked files).
- `scripts/check-doc-manifest.mjs` — reconciles which docs exist, not what they cite.

So the class is half-enforced: the citation forms this repo uses *least* are gated, and the one it
uses most is not.

## Mechanism

A gate over every tracked `*.md` (minus the manifest's `excluded` set): every backticked token that
looks like a repo-relative path — starts with a known top-level source dir, has an extension —
must be a tracked file.

## Measured false-positive surface — the honest part

Run against HEAD (after tonight's fixes): **507 citations checked, 19 unresolved.** Broken down:

| Class | Count | Example | Disposition |
|---|---|---|---|
| Glob / brace / placeholder patterns | 11 | `` `src/**/*.ts` ``, `` `docs/reviews/*-<date>.md` `` | Skip any token containing `*`, `{`, `<` — they are patterns, not citations |
| **True positives still at HEAD** | 2 | `` `tests/audit/*.test.mjs` `` in `CLAUDE.md` (matches zero files), `` `tests/audit/inv2.test.mjs` `` in `spec/audit/dispatch-admission-control.md` | Both are escalated leg-1 items this run — instruction file and constitutional doc, neither auto-editable |
| Third-party repo paths | 2 | `spec/cross-provider-quota-matrix.md:276` cites `src/index.ts` **inside `fgonzalezurriola/opencode-copilot-usage`** | Needs an escape |
| Deliberate "does not exist" narrative | 3 | `docs/backlog/open-bugs.md:428` — *"`src/scheduler/populate.ts` … and others do not exist"* | Needs an escape |
| Proposed/hypothetical future paths | 1 | — | Needs an escape |

After skipping patterns, the residue is **5 sites** needing a one-time annotation. That is a real
cost and it is small; it is stated here rather than discovered by the owner after approval.

**The escape must be explicit and inline**, following the manifest's data-not-prose principle: a
citation is exempt only by carrying the marker, never by the checker inferring intent from
surrounding prose. Proposed marker: an HTML comment `<!-- doc-citation-exempt: <reason> -->` on the
line above, or a trailing `(external)` / `(does not exist)` qualifier the checker recognizes — the
owner's call which.

## What it would have caught

All 31 of tonight's stale test-path citations, at the commit that renamed the files, instead of a
week later in a nightly review. It would also have been RED on `CLAUDE.md`'s
`` `tests/audit/*.test.mjs` `` glob had glob-expansion been checked (a possible second phase — a
glob citation matching zero tracked files is as dead as a missing path).

## Scope note — the same rot is in source comments

`src/` carries at least 12 stale `.test.mjs` comment citations at HEAD (e.g.
`src/shared/io/nodeWorktreeGuard.ts:82`, `src/audit/cli/nextStepCommand.ts:1538`,
`src/audit/reporting/scoreTokens.ts:205`). Widening the gate from `*.md` to source comments is a
strictly larger decision with a larger FP surface and is **not** proposed here — it is named so the
owner knows the doc-only scope is a choice, not the whole problem.

## Files in this proposal

Not yet written — this run stopped at the measurement, because the escape-marker shape is the
owner's call and the checker's regex depends on it. On approval the gate plus its red-green tests
land in one commit: `scripts/check-doc-code-citations.mjs`,
`tests/shared/doc-code-citations-gate.test.ts` (under `tests/`, since Vitest excludes `.claude/**`),
and the `check:doc-code-citations` entry in `verify:checks`.

The measurement harness used to produce the numbers above is reproducible: it is the same tracked-file
set + backtick regex described under *Mechanism*.
