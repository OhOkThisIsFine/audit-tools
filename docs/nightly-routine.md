# The nightly maintenance routine

One scheduled run, three legs, one philosophy: **if an item is unambiguous, do it;
if it needs the owner, surface it.** This doc owns the routine's shape — what it
covers, what it may change on its own, and how open items reach the owner.
[`doc-review-guidelines.md`](doc-review-guidelines.md) owns the *rubric* for leg 1
(how to judge a doc claim); this file owns the routine.

## The three legs

| Leg | Scope | May act alone | Escalates |
|---|---|---|---|
| **docs** | Every in-scope doc, routed by the type table in `doc-review-guidelines.md` | Stale-factual fixes with a code anchor (never instruction files) | Design decisions, instruction-file edits, condensation proposals |
| **backlog** | `docs/backlog.md` — *Open bugs*, *Forward tracks*, *Deferred / waiting* | Mechanical cleanup only: delete an entry whose fix verifiably shipped, strip status-noise from a live entry, correct a stale file/symbol reference | Any genuine disambiguation — turning a vague item into a spec is the owner's call |
| **solutions** | Project + global memory, backlog *Durable traps* and *Open bugs*, friction records | **Nothing.** Proposal-only | Every proposal, with evidence and a ready-to-apply patch |

The asymmetry is deliberate. A doc fix is reversible prose; a backlog rewrite can
silently decide something the owner would have decided differently; and a guard
that misfires blocks *every* tool call until it is found and reverted — which is
a bad thing to discover at 3am. So autonomy narrows as blast radius widens.

### Leg 2 — backlog

Reuse the rubric in [`.claude/skills/disambiguate-backlog/SKILL.md`](../.claude/skills/disambiguate-backlog/SKILL.md);
do not fork it. The skill is the conversational form of the same pass, and the
nightly is its unattended half: it finds the under-specified items and asks the
same reviewer+adversary-characterized question, but posts it to the digest
instead of asking live.

*Verify before deleting.* An entry claiming to be shipped is a LEAD, not a fact —
a 2026-07-19 pass found ~21% of entries stale or already closed, in both
directions. Deletion requires the same code anchor a doc auto-apply requires.

### Leg 3 — recurring-problem solutions

Find problems that keep happening and propose the mechanism that would end them.
The signal is **recurrence**, and it must be counted, not asserted: how many
separate memories, backlog entries, or friction records describe the same trap,
and on how many distinct dates. A one-off is not a pattern.

A proposal carries: the recurrence evidence, the mechanism (hook, gate, contract
change, or a fix that makes the trap unrepresentable), what it would have caught,
and its false-positive surface. When it is a hook, write the patch **and its
red-green tests** to `.audit-tools/nightly/proposals/` and reference it — the
owner approves in one step rather than re-deriving the work.

Prefer the fix that removes the trap over the guard that catches it. A guard is
what you build when the trap cannot be designed away.

## Where it runs — locally, not in the cloud

The routine runs as a local scheduled task on the owner's box
(`~/.claude/scheduled-tasks/nightly-maintenance/`). Two reasons, both structural:

- **Legs 2 and 3 need memory, and memory is untracked.** The project and global
  memory stores live under `~/.claude/projects/…/memory/`. A cloud agent working
  from a clone cannot see them at all, so those legs are not merely degraded
  there — they are impossible.
- **A cloud run verifies against remote `main`, and a doc can be AHEAD of it.**
  The 2026-07-21 run rewrote a *correct* present-tense claim into "not yet
  shipped" because the code proving it sat in five unpushed local commits. Local
  HEAD is the tree the docs actually describe.

**Clean-tree rule.** Review against HEAD. If the working tree is dirty, the run
still reviews and still reports, but applies **nothing** and says so in the
digest's *Not covered* section — reviewing a dirty tree is fine, writing to one
is how you lose the owner's uncommitted work.

## Surfacing — the digest, not the conversation

The run writes a self-contained HTML digest to `.audit-tools/nightly/latest.html`
(rendered by `scripts/nightly/render-digest.mjs`) and opens it. That is the
channel. A SessionStart hook (`.claude/hooks/nightly-surface.mjs`) prints **one
line**, and only when a subject has not been announced before, so a session that
starts later still learns something is waiting.

This replaced a hook that printed the full decision table into every
conversation. It failed for reasons worth keeping written down, because they are
easy to re-introduce:

- **Prose in table cells.** Items ran to ~900 characters inside a single markdown
  cell — unreadable in a terminal, and large enough that the hook needed a
  self-imposed clip budget. Over-budget output got persisted to a side file and
  the session saw one unexplained line.
- **It arrived whether or not the owner could act.** Every conversation, the same
  block. A notification that cannot be acted on when it fires becomes wallpaper,
  and then the items that *do* matter are invisible too.

## Why a settled question stays settled

The old routine had **no durable home for an answer.** Its clear-on-apply ledger
was keyed by the findings file's commit SHA and expired as soon as the routine
regenerated that file. So a question the owner answered — but whose answer
produced no doc edit, e.g. "keep the version pin, it is a deliberate anchor" —
came back every night forever. That is what taught the channel to be ignored.

The fix is the **subject key**: `sha1(path :: normalized subject prose)`, computed
in [`scripts/nightly/items.mjs`](../scripts/nightly/items.mjs). Answers are
recorded against the subject in `.claude/nightly-decisions.json` — tracked, so it
outlives runs, branches and machines.

```bash
node scripts/nightly/answer.mjs <ID> "the answer"      # settle it
node scripts/nightly/answer.mjs <ID> --wontfix "why"   # settle as not-doing
node scripts/nightly/answer.mjs --list                 # open ids
```

Rules that make the ledger trustworthy:

- **An answer is mandatory.** An empty settle would suppress a question while
  recording nothing about why — the shape that makes a ledger useless a month
  later.
- **A settled subject is never re-asked** — but if the underlying prose is later
  edited, the key changes and the question legitimately returns. Same rule the
  doc-review ledger already used for rewording, applied to the durable side.
- **The routine reads the ledger before asking.** If an answer implies an edit
  that has not landed, the answer makes it unambiguous — so the routine applies
  it under the normal gate rather than asking again.

`nights_open` is carried across runs and shown per item. An item open five or
more nights is called out at the top of the digest: a question that keeps coming
back is itself a finding — either it is not answerable as posed, or it should not
have been asked. Repetition without a counter is what hides that.

## Safety — unchanged

Everything auto-applied still passes the three-agent gate (reviewer → independent
adversary → judge on contest, default-escalate), the code anchor is re-verified
against HEAD before writing, instruction files (`CLAUDE.md`, `AGENTS*.md`) are
never auto-edited, and the full green gate (`npm run build && npm run check &&
npm test`) passes before any push. No auto-apply rests on one reviewer's verdict,
including the routine's own.

**Silent on clean, never silent on skipped.** Nothing found and nothing applied →
no digest churn and no notification. But a leg that could not run says so in the
digest — a quiet digest must mean "all clear", never "did not look".
