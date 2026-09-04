# P51 — a guard's recognized FORMS are declared data, like its file reach

**Leg:** 3 (recurring-problem solutions). **Status:** proposal. Nightly 2026-09-04.

## The recurrence, counted

One guard, `scripts/check-memory-citations.mjs`, has shipped **five** separate
reach defects across **four distinct dates**. Every one had the same shape: the
guard's stated purpose was *"every memory citation in a tracked doc resolves"*,
its implementation recognized a different set of citation forms than that purpose
implies, and the shortfall was discovered **by accident** rather than by any gate.

| # | Commit / date | What was structurally invisible |
|---|---|---|
| 1 | `e7a57713` | the gate did not exist; a dangling `memory:` cite restored a refuted design |
| 2 | `b91057c5` | the `[[name]]` wikilink form — memories cite each other this way |
| 3 | `69cbcd99` (2026-08-30) | the whole gate, in every linked worktree (cwd-derived store slug) |
| 4 | **2026-09-04, this run** | the sentence-initial capital-M list form (the regex was case-sensitive) |
| 5 | **2026-09-04, this run** | the *inverse* direction: the `memory:` scan never stripped code spans, though the wikilink scan always did, so a doc that merely DESCRIBED the citation syntax was read as citing notes that do not exist |

Defect 5 is worth its own line because it is the same defect pointing the other
way, and it was found by **this proposal document tripping the gate it proposes
to strengthen**: writing the syntax down inside inline code produced two
false dangling citations. One guard, two forms, and the two forms disagreed about
whether inline code counts — which no registry row could state and no test could
catch.

Defect 4 was found only because an unrelated owner decision
(`f86315b46e7f352e`) happened to name the dangling citation. Nothing would have
surfaced it otherwise — the gate reported `✓ all citations resolve` while a
dangling name sat in `docs/project-philosophy.md`.

This is the repo's own **[[a-script-in-no-gate-is-not-a-gate]]** and
**[[false-red-is-as-corrosive-as-false-green]]** failure mode, one level down: the
script *is* in a gate, and the gate *is* wired — but it recognizes less than it
claims, so it is green-by-narrow-pattern.

## Why the existing mechanism does not catch it

`scripts/guard-reach-data.mjs` is exactly the right instinct and already exists:
guard wiring and reach are **declared data**, reconciled against the tracked tree
by `npm run check:guard-reach`. But what it declares is the **file set** a guard
scans (`files: ['**/*.md']`) and, in prose, its known uncovered halves.

It cannot express, and therefore cannot reconcile, **which FORMS of the thing a
guard recognizes inside those files**. A guard can scan 100% of the declared
corpus and still miss 100% of one syntax. That is the entire defect class above,
and it is invisible to every gate the repo has.

The uncovered half is even *stated* in the registry row's `note` for this
guard — but as prose, which decays independently and cannot go red.

## The mechanism

Add a `forms` field to a guard-reach registry row, for guards whose job is to
recognize a syntax. Each entry is a **positive fixture**: a literal string that
the guard MUST flag, paired with the form's name.

```js
{
  id: 'check:memory-citations',
  kind: 'gate',
  files: ['**/*.md'],
  forms: [
    { name: 'lowercase inline list', sample: 'memory: this-note-does-not-exist' },
    { name: 'sentence-initial list',  sample: 'Memory: this-note-does-not-exist' },
    { name: 'wikilink',               sample: '[[this-note-does-not-exist]]' },
  ],
}
```

A contract test under `tests/` then drives the **real guard implementation** over
each declared sample in a temporary fixture tree and asserts the guard reports it
as dangling. A form the guard stops recognizing goes RED at the next run. Adding
a form to the registry without teaching the guard also goes RED — which is the
direction that matters, because it makes the declaration the source of truth
rather than a comment.

**What it would have caught.** Defects 2 and 4 directly, at the moment the form
was first written into a doc rather than months later by accident. Defect 3 (the
whole guard inert) is already covered by the store-resolution fix. Defect 1
predates the guard.

## False-positive surface

Low, and bounded by construction:

- The samples are **synthetic and self-evidently dangling** (`this-note-does-not-exist`),
  so the test never depends on the real memory store's contents — the thing that
  makes the guard itself skip on a fresh CI clone.
- The test asserts only that a declared form is **detected**. It asserts nothing
  about the guard's message, exit code, or the negative direction, so ordinary
  refactors of the guard do not break it.
- The registry already has a reconciliation gate and a test corpus, so this adds
  a field to an existing mechanism rather than a new gate with a new blast radius.

The real cost is honest and worth stating: `forms` is only as complete as what
someone thought to declare. It does not prove the guard recognizes every form that
exists in the wild — it proves it still recognizes every form we have ever known
about, which is precisely the regression the four-defect history shows we do not
otherwise get.

## Why not the alternative

*Prefer the fix that removes the trap over the guard that catches it.* The trap-removing
alternative would be a single canonical citation syntax, mechanically enforced, so
there are no forms to miss. That was considered and is **not** proposed: the three
forms are not accidental variation, they are three different authors' natural prose
(`memory:` inline, `Memory:` sentence-initial, `[[…]]` between memories), and
banning two of them would need its own guard — the same problem one step back, plus
churn across the whole corpus.

## Files in this proposal

- `guard-form-reach.test.ts` — the contract test (red at HEAD; see `RED-AT.txt`).
- `RED-AT.txt` — the measured failure at HEAD, with command and sha.

Landing it needs the `forms` field added to the `check:memory-citations` row in
`scripts/guard-reach-data.mjs` and the test moved to `tests/shared/`.
