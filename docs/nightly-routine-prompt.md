# Nightly maintenance routine — generated scheduler prompt

> **GENERATED from [`docs/nightly-routine.md`](nightly-routine.md) and [`docs/doc-review-guidelines.md`](doc-review-guidelines.md); do not hand-edit.**
> The scheduler consumes this standalone rendering. Every operational fact lives in one of
> those two sources; this file adds no summary or precedence rule.
> Regenerate: `node scripts/check-nightly-routine-prompt.mjs --write`.

The two canonical contracts follow verbatim. Apply them together; the routine document owns
cross-leg execution and the review-guidelines document owns leg 1.

=== BEGIN docs/nightly-routine.md ===
# The nightly maintenance routine

One scheduled run, three legs, one philosophy: **if an item is unambiguous, do it;
if it needs the owner, surface it.** This doc owns the routine's shape — what it
covers, what it may change on its own, and how open items reach the owner.
[`doc-review-guidelines.md`](doc-review-guidelines.md) owns the *rubric* for leg 1
(how to judge a doc claim); this file owns the routine.

## Start inputs and execution lanes

At the start of every run:

1. Read this file, [`doc-review-guidelines.md`](doc-review-guidelines.md), and
   [`../CLAUDE.md`](../CLAUDE.md). Review against **local HEAD**. Fetch configured
   remotes for context, but do not assume one is named `origin` and never replace
   local HEAD with a remote ref — unpushed code can be the evidence a doc describes.
2. Load `.claude/nightly-decisions.json` before deciding what to ask. A recorded
   `subject_key` is settled and never re-raised; when its answer implies work that
   has not landed, execute that now-unambiguous work under the normal gate.
3. Load the prior `.audit-tools/nightly/open-items.json` so `first_seen` and
   `nights_open` carry forward through `writeOpenItems()`.

Use independent lanes wherever they preserve coverage:

- **Codex** has repo access and performs its own source inspection:
  `codex exec --skip-git-repo-check "<prompt>" < /dev/null`. Closing stdin is
  load-bearing; an open stdin makes the process wait indefinitely.
- **The second independent lane** is a separate free-provider session:
  `powershell -File C:\Users\ethan\freellmapi\claude.ps1 -p "<prompt>"`. The
  launcher owns the routing mechanics (endpoint, key, model alias), so this doc
  never restates them and cannot drift from them. Treat every reply as an
  advisory lead and verify it against source; quoted evidence is especially
  fallible.
- If a lane is unavailable, route the work elsewhere. A dead lane may not
  silently shrink coverage; any coverage that still could not run belongs in
  the inbox's `skipped` list.

## The three legs

| Leg | Scope | May act alone | Escalates |
|---|---|---|---|
| **docs** | Every in-scope doc, routed by the type table in `doc-review-guidelines.md` | Stale-factual fixes with a code anchor (never instruction files) | Design decisions, instruction-file edits, condensation proposals |
| **backlog** | `docs/backlog/open-bugs.md`, `docs/backlog/forward-tracks.md`, `docs/backlog/deferred.md` | Mechanical cleanup only: delete an entry whose fix verifiably shipped, strip status-noise from a live entry, correct a stale file/symbol reference | Any genuine disambiguation — turning a vague item into a spec is the owner's call |
| **solutions** | Project + global memory, backlog *Durable traps* and *Open bugs*, friction records | **Nothing.** Proposal-only | Every proposal, with evidence and a ready-to-apply patch |

The asymmetry is deliberate. A doc fix is reversible prose; a backlog rewrite can
silently decide something the owner would have decided differently; and a guard
that misfires blocks *every* tool call until it is found and reverted — which is
a bad thing to discover at 3am. So autonomy narrows as blast radius widens.

### Leg 1 — docs

The rubric is [`doc-review-guidelines.md`](doc-review-guidelines.md). Its scope
ledger is implemented in [`scripts/nightly/scope-ledger.mjs`](../scripts/nightly/scope-ledger.mjs):
`plan` enumerates the in-scope corpus through the doc manifest and reports each
item's evidence window, `stamp <doc>` records a doc as examined at HEAD, and the
run writes `leg1-<date>-coverage.json` beside leg 2's stamp. **Coverage is read
from that file, never eyeballed** — the same rule leg 2 already lives under, and
the reason it exists: until it shipped, leg 1 reported its own coverage from
prose, so the number was whatever the agent believed. Stamp a doc only after an
agent actually examined it; an item with no ledger entry has no window and is
reviewed cold, which is the honest answer rather than a defect.

### Leg 2 — backlog

Reuse the rubric in [`.claude/skills/disambiguate-backlog/SKILL.md`](../.claude/skills/disambiguate-backlog/SKILL.md);
do not fork it. The skill is the conversational form of the same pass, and the
nightly is its unattended half: it finds the under-specified items and asks the
same reviewer+adversary-characterized question, but posts it to the inbox
instead of asking live.

*Verify before deleting.* An entry claiming to be shipped is a LEAD, not a fact —
a 2026-07-19 pass found ~21% of entries stale or already closed, in both
directions. Deletion requires the same code anchor a doc auto-apply requires.

*Coverage is read from the stamp, never eyeballed.* The mechanical sweep
(`scripts/shared/triage-backlog.mjs`) resolves its model target live from the
router's roster, preflights once (a dead lane aborts at entry 0 with the
router's own error), and writes `<out>-coverage.json` — model, attempted, classified,
errored, aborted — beside the JSONL as it runs. Report leg-2 coverage from that
stamp; a missing or aborted stamp means the sweep did NOT cover the backlog,
and saying so is the honest sentence three partial runs had to reconstruct by
hand (P11, sol-4 decision 2026-08-06).

### Leg 3 — recurring-problem solutions

Read the project memory store
(`~/.claude/projects/C--Code-audit-tools/memory/`, including its `MEMORY.md`
index), the global `~/.claude/CLAUDE.md`, backlog *Durable traps* and *Open
bugs*, and the run's friction records. These are separate recurrence surfaces;
do not silently narrow the pass to whichever one is easiest to search.

Find problems that keep happening and propose the mechanism that would end them.
The signal is **recurrence**, and it must be counted, not asserted: how many
separate memories, backlog entries, or friction records describe the same trap,
and on how many distinct dates. A one-off is not a pattern.

A proposal carries: the recurrence evidence, the mechanism (hook, gate, contract
change, or a fix that makes the trap unrepresentable), what it would have caught,
and its false-positive surface. When it is a hook or gate, write the full patch
**and its red-green tests** to `.audit-tools/nightly/proposals/<id>/` and
reference it — the owner approves in one step rather than re-deriving the work.
Tests belong under `tests/`; Vitest excludes `.claude/**`, so a test beside a
hook never runs.

Prefer the fix that removes the trap over the guard that catches it. A guard is
what you build when the trap cannot be designed away.

#### The weekly `/insights` pass

`/insights` analyses the host's own session history — `~/.claude/usage-data/`,
where `session-meta/*.json` carries per-session tool counts and `facets/*.json`
carries a `friction_counts` map and a `friction_detail` line — and emits an HTML
report of suggestions. That is leg 3's signal measured from the outside: friction
counted across sessions rather than inferred from what happened to get written
down. So it belongs to this leg, not to a fourth one.

It runs **weekly, not nightly**, gated on a stamp at
`.audit-tools/nightly/insights-last-run.json`. A stamp, not a cron weekday,
because the cadence must survive a missed or failed night — a weekday test
silently skips a fortnight when the Tuesday run dies. Due means the stamp is
absent or its `ran_at` is seven or more days old.

When due, run `/insights` as a nested non-interactive session from the repo
root:

```bash
AUDIT_TOOLS_CHILD_SESSION=1 MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' claude -p "/insights"
```

All three environment variables are load-bearing. `AUDIT_TOOLS_CHILD_SESSION=1`
marks the nested session as a dispatched child so it does not self-register in
the session registry — the insights child writes report files and needs neither
Stop-gate challenges nor git rights (the child-session entry in
`docs/backlog/durable-traps.md`). The `MSYS*` pair matters under Git Bash:
without them the leading slash is rewritten to `C:/Program Files/Git/insights`,
and the nested session answers "no such slash command", which looks like the
feature does not exist. The PowerShell tool is an alternative because it does
not perform that rewrite (set `AUDIT_TOOLS_CHILD_SESSION` there too). The pass takes minutes while it analyses every session not already
cached in `~/.claude/usage-data/facets/`; run it in the background rather than
raising the Bash tool's 600000 ms timeout clamp. The command prints the path of
the HTML report it wrote.

Two reasons it is not nightly. The analysis pass costs primary quota for every
session not already cached in `facets/`, and — the real one — its suggestions are
drawn from a window that reaches back weeks, so night-over-night they barely
change. A recommendation that reappears nightly is the shape that taught the old
digest to be ignored.

**Its suggestions are LEADS, at the same bar as a backlog entry claiming to be
shipped.** The 2026-07-25 pass
([`insights-triage-2026-07-25.md`](reviews/insights-triage-2026-07-25.md)) triaged
twelve: five were already shipped (the
report's window opens before the fix landed), three were debatable, four were
real. One recommended re-adding a retry policy for a failure mode whose root
cause had been found and fixed two days earlier. Every suggestion is therefore
verified against HEAD before it becomes a proposal, and leg 3's propose-only
bound applies unchanged — the pass lands nothing.

Classify every suggestion as one of: **already shipped** (name the mechanism at
HEAD and drop the suggestion), **debatable** (escalate it as an inbox item), or
**genuinely open** (make it a leg-3 proposal with the report's recurrence
evidence). Check the retirement direction specifically; a stale report can
recommend re-adding a mechanism that was deliberately removed.

Only after a successful pass, write the stamp:

```text
.audit-tools/nightly/insights-last-run.json = {
  "ran_at": "<ISO>", "report_path": "<path>", "suggestions_total": N,
  "already_shipped": N, "debatable": N, "open": N
}
```

The numeric values are that run's real counts. Never write the stamp after a
failed pass; leaving it absent or old makes the pass due again tomorrow instead
of parking the failure for a week.

Being *not due* is not a skipped leg and does not go in the inbox's skipped
list. Being due and failing to run does.

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
inbox's *What the last run could NOT cover* block — reviewing a dirty tree is fine, writing to one
is how you lose the owner's uncommitted work.

## Machine output contract

Write `.audit-tools/nightly/open-items.json` through `writeOpenItems()`; it is
the machine contract behind the inbox and the SessionStart notice. Each candidate item has this
shape:

```text
{ id, leg (docs|backlog|solutions), subject_key, path, title, eli5, question,
  options[], evidence[], premise_probes[], auto_close?, proposal?, patch_path? }
```

- `title` is the front-loaded one-line decision, not a summary of the
  investigation.
- `eli5` explains in full sentences, for a non-expert reader, what the
  doc/backlog claims, what the code does, why they diverge, and what each answer
  means going forward. Every item gets one; do not substitute internal IDs or
  symbol-name shorthand.
- `question` is the specific decision. `evidence[]` records what was verified
  against code and how.
- `options[]` is the routine's proposed answers — `{ label, answer }` pairs, where
  `label` is the button text and `answer` is the exact prose that click records.
  **Every item carries them.** They are the whole point of the answerable surface:
  a click on a named choice IS the decision, so answering costs a press instead of
  an essay. An item without them degrades to a bare text box — which is what
  happened on 2026-07-29, when 18 items shipped with no `options` because this
  contract did not list the field the renderer already supported. Offer the real
  alternatives including the do-nothing one; the free-text box behind
  *Something else…* stays available for an answer the routine did not anticipate.
- `premise_probes[]` pins the fact the item is about, in one of two forms:
  `{ file, contains }` (a literal string quoted from that file's **current**
  content — the stale prose, the code line that contradicts it) or
  `{ file, absent }` (a literal string that must NOT yet be in that file — the
  code side of a doc-vs-code divergence). **Every item carries at least one,
  every probe must pass when the item is written** (`contains` present,
  `absent` genuinely absent) — `writeOpenItems()` refuses the batch otherwise —
  and **every probe target must be a git-TRACKED source file**: a gitignored
  runtime artifact or a record file (docs/backlog, docs/reviews, HANDOFF, the
  inbox, `.audit-tools/nightly`, .claude) carries no evidence and is refused at
  write.
  **One door exists, for a question ABOUT a record.** A leg-2 escalation asks
  what a backlog entry should *become* — its premise is prose in `docs/backlog`
  and there is frequently no code side at all, so the record-path refusal made
  leg 2's whole non-mechanical output unwritable. Such an item declares
  `auto_close: false` and may then carry `{ file, contains }` probes on record
  paths. The fragment is still verified present at write like any other; the
  item simply never auto-closes, and leaves the queue when the owner answers —
  which for that question is the only correct exit. The flag is refused unless
  EVERY probe is a positive record-path probe, so an item that *has* a code side
  must still auto-close off it and cannot opt out. An item whose
  premise is a RELATION between two locations (doc says X, code lacks X)
  carries one probe per side — `contains` on the side that asserts, `absent`
  on the side that lacks — and auto-closes when EITHER side moves; an item
  with only `contains` probes closes when ALL its fragments have verifiably
  gone. At presentation, `partitionBySettled` re-evaluates and auto-closes
  `resolved` items instead of surfacing them — an answered queue is a fact
  about the conversation, and the probe is what makes the queue track the CODE
  (on 2026-07-25, 15 of 21 surfaced items were already fixed at HEAD).
  Accepted trade-offs: a rename mis-closes (`contains`) or mis-holds
  (`absent`); pick probe strings accordingly — quote the exact fragment whose
  movement would mean the item is done, not a symbol name likely to survive
  the fix.
  **Never raise an item whose premise is a hand-typed computed value** (a
  count, a total, a length): a computed fact has no quotable string on the
  code side, so no probe form can track it — and the value itself is
  status-noise the doc philosophy already bans. Remove the stated value as a
  doc fix (or escalate removing it) instead of asking the owner to correct
  the number (nightly sol-3 + sol-5 decisions, 2026-08-06: two count items
  nearly served corrupting corrections after the code moved under them).

Compute `subject_key` with `subjectKey(path, subject)` from
`scripts/nightly/items.mjs`, where `subject` is the prose in question, never the
routine's wording of `question`. Before persisting, load `readDecisions(root)`
and select with `partitionBySettled(items, decisions, root)`; only its `open`
half belongs in the next items file (`settled` subjects are answered, `resolved`
ones have no premise left in the tree). A settled answer may make work
unambiguous, but it never makes the same subject an open question again.

Call `writeOpenItems(root, { items: open, applied, skipped, run })` so
`first_seen` and `nights_open` carry forward. `applied` says exactly what changed;
`skipped` names every leg or scope that could not run and why. Never hand-write
the JSON or discard the previous state before this merge.

## Surfacing — the inbox, not the conversation

Each item carries three layers, so the reader spends only the attention the
decision needs: a **one-line title** (the summary), an expandable **"In plain
terms"** ELI5 the routine writes for a non-expert reader (what the doc claims,
what the code does, why they diverged, what each answer would mean), and a
collapsed **technical evidence** list underneath. The routine populates the
`eli5` field for every escalated item — a decision needs the full picture, and a
plain-language version is what makes it answerable without re-derivation.

The answering surface is **one tracked markdown file**,
[`docs/nightly-inbox.md`](nightly-inbox.md), rendered by
`scripts/nightly/render-inbox.mjs` (`npm run nightly:inbox`). Each open item
becomes a block with its plain-terms explanation, its question, and its options
as **checkboxes**. Answering is: tick exactly one box, save. Every item also
carries **Other**, **Won't fix** and **Ask back**, so an answer the routine did
not anticipate — including "your premise is wrong" — is always expressible.

`scripts/nightly/ingest-answers.mjs` (`npm run nightly:ingest`) reads the ticks
back, records them in the durable ledger, and re-renders so answered items drop
out. It **refuses** rather than guesses: two ticked boxes, or an `Other` /
`Won't fix` / `Ask back` with an empty note, records nothing for that item and
reports why — one malformed answer never blocks the rest.

Why a tracked markdown file and not the HTML digest plus localhost server this
replaced. The old pair was technically sound — a `file://` page genuinely cannot
persist a click, so buttons required a server — but it answered the wrong
question. What answering needs is to be **async, easy, and reachable from
wherever the owner is**, and a tracked file is all three: any editor opens it,
GitHub's web UI edits it from a phone, git syncs it between machines and keeps
the history, and nothing has to be running. Being tracked is the other half —
an escalation that lives only in one machine's untracked scratch is lost the
moment you are not sitting at that machine. Deleting the renderer and the server
removed ~560 lines and the entire "is the server up?" question.

The machine contract (`.audit-tools/nightly/open-items.json`) and the full
proposals (`.audit-tools/nightly/proposals/**/*.md`) are tracked for the same
reason. When nothing was applied, open, or skipped, stay silent rather than
churning the inbox.

A SessionStart hook (`.claude/hooks/nightly-surface.mjs`) prints **one line**, at
most once per subject, and is otherwise silent. It has exactly two things to
say: *there are new propositions waiting* (pointing at the inbox), or *there are
answered items ready to apply* (pointing at the ingest command). **Nothing open
means nothing printed** — not even a count of what was auto-closed. Both
announcements are bounded by the viewed ledger, because many answers imply no
work at all and would otherwise nag forever.

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

Answer by ticking a box in [`docs/nightly-inbox.md`](nightly-inbox.md) and
running `npm run nightly:ingest`, or directly from a shell:

```bash
node scripts/nightly/answer.mjs <ID> "the answer"      # settle it
node scripts/nightly/answer.mjs <ID> --wontfix "why"   # settle as not-doing
node scripts/nightly/answer.mjs <ID> --question "..."  # an answer that asks BACK — stays open
node scripts/nightly/answer.mjs --done <KEY> "<ref>"   # the answered work LANDED
node scripts/nightly/answer.mjs --list                 # unanswered + answered-but-not-done
```

Rules that make the ledger trustworthy:

- **ANSWERED is not DONE, and `--list` reports both.** Settling records the
  owner's REPLY; it does not claim the work exists. Mark the work landed
  separately with `--done <subject-key> "<commit|note>"`. This is the defect that
  made twelve answers invisible on 2026-07-28 — `--list` said "No open nightly
  items" while none of their work was in the tree, and a settled subject is never
  re-raised, so nothing would ever have surfaced them again.
- **An answer that asks a question BACK is not an answer** — record it with
  `--question` and the item stays open. Two of that night's eighteen were exactly
  this shape, filed as settled, which made them unaskable while carrying nothing
  executable.
- **Subjects answered before 2026-07-28 are grandfathered** — completion tracking
  did not exist, so their landing state is unknown by construction. `--list`
  COUNTS them and does not enumerate them: reporting ~50 unknowable subjects as
  outstanding would be a false RED, which trains the reader to skip the list
  exactly like the false GREEN it replaced.
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
more nights is marked on its own item in the inbox: a question that keeps coming
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
no inbox churn and no notification. But a leg that could not run says so in the
inbox — a quiet inbox must mean "all clear", never "did not look".
=== END docs/nightly-routine.md ===

=== BEGIN docs/doc-review-guidelines.md ===
# Doc-review — reviewer guidelines

The rubric for judging a documentation claim: what counts as a stale-factual fix
the routine may apply alone, and what is a decision only the owner can make. This
is **leg 1** of the nightly maintenance routine — [`nightly-routine.md`](nightly-routine.md)
owns the routine itself (its three legs, where it runs, how items reach the
owner). This file is **excluded from its own review**. Edit it here on `main` —
the routine reads it, never rewrites it.

## Why this exists

Docs drift; an agent that *remembers* to re-check them is a latent failure mode
(see `CLAUDE.md` → "auditor-agnostic robustness"). This routine moves that
re-check into tooling: every night, against the live codebase, with three
independent agents gating every change.

## The rubric sources: two philosophies

Every judgement in this routine measures against **two** canonical rubrics, loaded at the
start of every run:

1. **[`documentation-philosophy.md`](documentation-philosophy.md)** — the *doc-shape* rubric:
   what this repo's docs are for and how they're shaped (durable concepts not current state;
   one home per concept; status-noise forbidden; the condensation bias). Governs whether a doc
   is *well-formed as a doc*. When it and this file's mechanics ever conflict, it wins and this
   file is the thing to fix.
2. **[`project-philosophy.md`](project-philosophy.md)** — the *content-conformance* rubric: the
   project's organizing convictions, split into those that govern the product itself (Part A) and
   those that govern its development (Part B). Governs whether a doc's *claims and guidance align
   with the project's stated philosophy* — e.g. a doc that gives audit-tools a backend/model inventory, forking
   planning per-language, gating LLM review behind an internal provider, or leaning on host discretion where
   the tool should enforce, **contradicts** a conviction. `project-philosophy.md` is itself a map
   that points at each conviction's canonical home (`CLAUDE.md` / `spec/` / memory); where the map
   and a home disagree, the **home** is ground truth (verify against it, not the map).

Doc-shape is a *factual/structural* judgement (can auto-apply narrow fixes). **Content-conformance
is always a judgement call → design-decision → escalate to the owner** (see *Philosophy-conformance
review* below); the routine never rewrites a doc's substance to fit a conviction on its own.

## Two perspectives — review the items AND the doc set

The routine reviews on **two distinct perspectives every run** (the philosophy demands both):

1. **Within a document** — do the items inside it fit the philosophy (durable concept, not
   status-noise) and are they factually true against code? This is the item-level pass below.
2. **Across the document set** — is each *document itself* in line with the philosophy, and
   **can/should the corpus be condensed**? Overlap between docs, a doc that should fold into
   another, a doc whose reason-to-exist has lapsed, a thin doc that belongs as a section
   elsewhere. This is the corpus-level pass ("Doc-set condensation review" below).

Perspective 1 can auto-apply narrow factual fixes; perspective 2 is **always a
design-decision → escalate** (never merge, retire, or split a doc autonomously).

## Trust model — three agents earn the autonomy

A single agent editing docs is itself an untrusted host. Autonomy is earned by a
three-tier gate; nothing reaches `main` without surviving all three:

1. **Reviewer** — examines every in-scope item, proposes a disposition.
2. **Adversary** — independently examines **every** item (not just the
   reviewer's surfaced ones, so it also catches false negatives — items the
   reviewer skimmed and passed). Agrees or refutes, with evidence.
3. **Judge** — runs only on **contested** items (reviewer ↔ adversary disagree).
   Decides the final disposition *and* the apply-vs-escalate call. **Defaults to
   escalate on any uncertainty.**

Every agent verifies from code/disk — never trusts doc prose as ground truth.

## The two dispositions

Every item resolves to exactly one:

- **stale-factual-fix** — a *factual* claim the code contradicts: a named file,
  symbol, command, path, or count that demonstrably no longer exists or has
  changed. Narrow and code-anchored. → **auto-applied** (except instruction
  files, below).
- **design-decision** — anything with judgment in it: a policy/convention, a
  conceptual claim, a "should we still do this", a vague backlog item, an A→B
  spec. → **escalated to the owner, never auto-applied.**

The split is the entire safety surface. The classifying rule:

> **Factual** = verifiable true/false against code (apply).
> **Policy / conceptual / judgment** = needs the owner (escalate).
> A policy is **not** stale because no code "uses" it — code-absence is the
> policy *working* ("never own execution-backend metadata" is load-bearing precisely
> when nothing violates it). Never flag a policy as obsolete by absence.

When in doubt, it is a design-decision. Escalate.

## Existence review — every doc, every run (not just intra-doc staleness)

Keeping a doc *factually true* is not the whole job: a doomed doc that is dutifully
kept accurate never gets retired. So **in addition** to the per-type check below, every
doc is asked, every run: **does this still have a reason to exist, and is this the
right home for its content?** This is always a **design-decision → escalate**, never
auto-applied. Two smells force the question (do not silently "fix" either):

- **A pinned version / date / status string in a prose doc** (e.g. "expected version
  0.30.5", "plan of record (2026-06-24)", "THIS RUN implements…") is **status-noise, not
  a factual claim to bump.** Reclassify it from stale-factual-fix to a design-decision:
  escalate *"de-status this (derive the value or drop it), or retire the doc"* — **never
  auto-bump the number.** A doc whose only diffs across runs are version/status bumps is a
  status doc masquerading as a concept doc → propose generate-or-delete.
- **A doc that is not in the canonical manifest** (below) → escalate *"register with a
  type + reason-to-exist, fold into an existing canonical doc, or delete."* Never leave it
  unrouted and silently maintained.

## Normative goals docs — re-check against the executor/phase registry on any change

A **normative goals doc** (`spec/audit/audit-goals.md`, `spec/remediate/remediation-goals.md`) enumerates
the obligations / phases / executors its area must satisfy. Whenever a new obligation, phase, or executor
ships in that area, the goals doc gets a **"does this still match the current executor/phase registry?"**
check *then* — driven by the code change, not deferred for the next doc-review pass to discover the drift.
A registry entry the doc omits, or a doc entry the registry no longer has, is a **design-decision →
escalate** (goals docs are normative — never silently rewritten to match code).

### The refusal behind that rule — constitutional docs

Saying "never silently rewritten" did not stop it: commit `6fc2e453`, a routine doc-review sweep,
rewrote `spec/remediate/remediation-goals.md` along with eight other files. A label is not a
refusal. The normative set is therefore enumerated in **`src/shared/constitutionalDocPaths.ts`**
(generated for the hooks into `scripts/shared/constitutional-doc-paths.generated.mjs`,
parity-checked by `npm run check:constitutional-doc-paths`), and
`.claude/hooks/pre-commit-gate.mjs` **blocks any commit whose staged set touches one of those
paths** unless a fresh, staged-tree-bound override record exists:

```
node scripts/attest-constitutional-doc-change.mjs --reviewed-by <id> \
  --attester-class agent|human --owner-decision "<the owner's call, and where it was escalated>"
```

The override is modelled on the loop-core review attestation: bound to the exact staged tree (any
restage invalidates it), required to name who issued it, and recorded as an attributable artifact.
It records that an owner decision was taken; it cannot verify one — that is the honest limit, and
it is why the list stays narrow. Which docs are constitutional is **derived from this manifest's
own normative rows**, never guessed; the derivation is written out in the module header.

## Shipped-entry deletion — a "SHIPPED" note is itself status-noise

`backlog.md` says *"Remove an entry once it ships."* Enforce it literally — a recorded
"what shipped" is `git log`'s job, not the backlog's:

- **Fully-shipped entry → delete it outright.** When the code proves an entry's work is
  done (factual, code-anchored), **remove the whole entry**. Do **not** rewrite it into a
  `_SHIPPED …_` / `**FIXED**` / `**DONE**` note, and do **not** leave such a note standing —
  a shipped-status marker is exactly the status-noise the philosophy forbids, and these
  accumulate. A standalone `_SHIPPED_`/`_FIXED_` paragraph or a bullet whose content is only
  "this shipped" has **no open remainder → delete it** (code-proven removal is auto-apply,
  same as any shipped-removal; if the proof is incomplete, escalate rather than guess).
- **Partial entry (shipped substrate + open remainder) → trim to the remainder.** Strip the
  "what we already shipped" prose and keep only the still-open work + enough context to act
  on it. The entry stays; its status-log tail goes.
- **Durable rule worth keeping?** If a shipped fix carries a durable trap/convention (e.g.
  "anchor ignore patterns to `.audit-tools/`"), that belongs in its durable home (Durable
  traps, `CLAUDE.md`) — move it there in the same edit, then delete the backlog entry; never
  retain the entry just to host the rule.

## Philosophy-conformance review — every doc, every run

In addition to doc-shape (well-formed?) and factual accuracy (true vs code?), every doc is asked
each run: **does its content conform to the project's philosophy** ([`project-philosophy.md`](project-philosophy.md),
verified against each conviction's canonical home)? This catches a doc that is well-formed and
factually accurate yet **advocates or documents something that cuts against a stated conviction** —
the class the other two checks miss. Smells that trigger it (non-exhaustive — the convictions in
`project-philosophy.md` are the full rubric):

- Any provider roster, model/window/price table, quota policy, capability tier, launch adapter, or execution
  discovery path presented as audit-tools state (violates the host boundary and *everything-agnostic*, A4/A11).
- Per-language / per-ecosystem forks of planning logic (violates *language-neutral*, A4).
- Correctness resting on the host *remembering / noticing / being careful*, or a manual flag treated as
  the fix (violates *enforce-in-tooling*, A3 — "a needed manual flag is a bug signal").
- LLM review gated behind "if an internal provider exists"; CLI treated as the primary product (violates
  *conversation-first* / *LLM always in the loop*, A2/A5).
- "Deterministic by default / 100% deterministic" framing (violates *right tool, not dogma*, A2).
- A separate lean/fast path proposed instead of one self-scaling pipeline (violates A6).
- Deferring the clean endpoint on effort/complexity grounds (violates *ideal-code-over-compatibility*, B1).

**Every conformance finding is a design-decision → escalate**, never auto-applied: judging "does this
contradict a conviction" is exactly the judgment the owner must make, and the fix is often to change the
*code/policy*, not the doc. Quote the offending item, name the conviction (with its `project-philosophy.md`
section + canonical home), and surface it under the escalation block's **"Design decisions for you"**.
`project-philosophy.md` and the two rubric files (`documentation-philosophy.md`, this spec) are reviewed
for their own conformance like any other doc.

## Doc-set condensation review — the corpus as a whole (perspective 2)

Once per run, after the per-doc work, step back and review the **whole document set** against
the philosophy's *condensation bias* — fewer, denser, timeless docs beat many thin or
overlapping ones. This is a corpus-level pass, not a per-item one, and every outcome is a
**design-decision → escalate** (the routine never merges, folds, retires, or splits a doc on
its own). Hunt for:

- **Overlap / duplication** — two docs stating the same concept (a fact in two homes will
  drift). Propose: pick the most-durable home, fold the other in, leave a pointer not a copy.
- **Fold candidates** — a doc whose content is really a *section* of another (e.g. one artifact's
  validation notes belong in the artifact contract, not a second standalone spec).
- **Lapsed reason-to-exist** — the work shipped, the concept moved into code/policy, or it was
  always current-state. Propose retire.
- **Bloat** — a concept doc grown into a changelog/log; propose trim to the durable core.
- **Split** — rare; only when one doc carries two genuinely-unrelated durable concepts.

Each proposal quotes the docs involved and names the target home; the owner makes the merge/retire
call. Surface these in the findings file under a **"Doc-set condensation"** heading.

## Scope — every doc, routed by type

All `*.md` under the repo, **recursively**, except the exclusions. Each doc gets
the check for its type:

<!-- BEGIN doc-manifest table — generated from scripts/doc-manifest-data.mjs -->

| Type | Files | Check | Auto-apply? |
|---|---|---|---|
| **design / concept** | `docs/documentation-philosophy.md`, `docs/project-philosophy.md`, `docs/glossary-ids.md`, `docs/end-of-sprint-report-template.md` | Claims vs code (drift); flag current-state / changelog creep (docs are timeless concepts, not status). `project-philosophy.md` is an orienting **map** (product-vs-development split) that points at each conviction's canonical home — verify its one-line restatements still match those homes; it deliberately references, never re-owns, so a home change makes its pointer stale, not the home. | factual-stale → yes |
| **instruction / policy** | `CLAUDE.md`, `AGENTS.md` | Factual claims only (file/command/path staleness). Policy & conventions untouchable. | **No — escalate-only.** Highest blast radius: a wrong edit deletes a guardrail governing all agents. |
| **ops / usage** | `README.md` | Do the documented commands / paths still resolve and run. | factual-stale → yes |
| **package docs (audit)** | `docs/audit-pkg/product.md`, `docs/audit-pkg/contracts.md`, `docs/audit-pkg/development.md`, `docs/audit-pkg/operator-guide.md`, `docs/audit-pkg/release.md` | Claims vs code/spec (these page the normative `spec/audit/*`); flag current-state / changelog creep. | factual-stale → yes |
| **backlog** | `docs/backlog.md`, `docs/backlog/open-bugs.md`, `docs/backlog/forward-tracks.md`, `docs/backlog/deferred.md`, `docs/backlog/durable-traps.md` | Shipped-detection (see *Shipped-entry deletion* below — a fully-shipped entry is **deleted outright**, never kept as a `SHIPPED`/`FIXED`/`DONE` marker; a partial entry is **trimmed to its open remainder**); dedup near-identical raw items; A→B draft (below). Durable-traps section is **reference** — only flag a trap proven fixed-in-tooling. | shipped-removal & dedup → yes; A→B → escalate |
| **handoff (sequencing view)** | `docs/HANDOFF.md` | Current published state + immediate next only (sanctioned per the philosophy's HANDOFF row). The roadmap block is generated from `▶`-pinned backlog entries; the live nightly block is generated from the persisted queue + decision ledger and must render no visible nightly text when the queue is empty. Never hand-edit either generated block. Flag **changelog creep** and per-item specs duplicated from their authoritative backlog/queue source; verify hand-written current state against code and clear stale state with proof. | hand-written state → yes; generated blocks → generator only |
| **design / concept (`spec/`)** | `spec/**/*.md` (the normative design corpus — workflow designs, contracts, goals docs; routed by pattern, so a new spec is registered the moment it lands) | Claims vs code (drift); flag current-state / changelog creep (durable design only). A `> **Status:** <type-declaration>` preamble identifying the kind of design artifact is permitted; a dated/versioned status string in it is still status-noise → escalate. The goals docs and the `spec/audit/*` contracts are **normative** — see *Normative goals docs* above and the constitutional-doc refusal in `src/shared/constitutionalDocPaths.ts`: a change to one is a design-decision → escalate. | factual-stale → yes (except the constitutional subset — escalate-only) |
| **excluded** | `docs/doc-review-guidelines.md` (this spec — excluded from its own review), `docs/reviews/*-<date>.md` (dated review / plan / diagnosis / dogfood records — excluded BY CONSTRUCTION. Each is a one-off record of what was decided on a day, never a timeless concept; the durable outcome lives in `spec/`, the backlog, or project memory. This pattern replaced a 21.5k-character exhaustive list that grew every lap), `.audit-tools/nightly/proposals/**/*.md` (nightly leg-3 proposal records — the full analysis behind an escalated item (recurrence evidence, proposed mechanism, false-positive surface). TRACKED so a proposal outlives the machine that produced it, but excluded BY CONSTRUCTION for the same reason as a dated review: each is a one-off record of a proposition as it stood that night, never a timeless concept. They deliberately cite paths that do not exist — a file the proposal proposes CREATING, or one deleted since — so reviewing them for staleness, or citation-checking them, would be checking a historical record against a present tree. Accepted outcomes land in code, `spec/`, the backlog or memory; the record stays as provenance), `.audit-tools/audit-report.md` (runtime run-artifact — an audit-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `.audit-tools/remediation-report.md` (runtime run-artifact — a remediate-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `tests/audit/fixtures/simple-app/README.md` (test-fixture content — a sample-app README, its own concern, not a project doc) | — | — |
| **generated host assets** | `.agent/skills/audit-code/SKILL.md`, `.agent/skills/remediate-code/SKILL.md`, `.github/agents/auditor.agent.md`, `.github/agents/remediator.agent.md`, `.github/copilot-instructions.md`, `.github/prompts/audit-code.prompt.md`, `.github/prompts/remediate-code.prompt.md` | ONE canonical body rendered per-IDE (`CLAUDE.md` B5); **not hand-edited** — governed by renderer drift tests (`tests/audit/host-asset-renderer-drift.test.ts`, `tests/remediate/host-bootstrap-descriptors-remediate.test.ts`, `tests/remediate/install-repo-assets.test.ts`). Review the canonical source, not the generated copy; a diff = a drift-test/renderer gap, not a doc edit. | **No — renderer-owned.** |
| **canonical loader bodies** | `skills/audit-code/SKILL.md`, `skills/audit-code/audit-code.prompt.md`, `skills/remediate-code/SKILL.md`, `skills/remediate-code/remediate-code.prompt.md` | HAND-AUTHORED sources, not generated output — the arrow points OUT of `skills/`: the renderer drift tests read these as the canonical body and assert the `.agent/**` and `.github/**` copies equal a fresh render of them, and `scripts/audit/postinstall.mjs` copies one outward as its literal prompt source. Nothing writes into `skills/`. Review them like any other doc — in particular the CLI invocations and flag literals they carry, which no other reviewer checks. Run `npm test` after editing (the drift tests will fail until the generated copies are re-rendered). | Yes — with the renderer drift tests re-run. |
| **generated scheduler prompt** | `docs/nightly-routine-prompt.md` | WHOLE-FILE GENERATED from `docs/nightly-routine.md` (cross-leg routine) + `docs/doc-review-guidelines.md` (leg-1 rubric) by `scripts/check-nightly-routine-prompt.mjs`. Never hand-edit or resolve a conflict in the target; edit the owning source and regenerate. `check:nightly-routine-prompt` gates byte parity plus its `package.json` check/release wiring in `verify:checks` and at commit. | **No — generator-owned.** |
| **generated decision inbox** | `docs/nightly-inbox.md` | GENERATED by `scripts/nightly/render-inbox.mjs` from `.audit-tools/nightly/open-items.json` — the nightly routine's answering surface, and the ONE tracked doc that is deliberately current-state rather than timeless. The owner answers by ticking a checkbox; `scripts/nightly/ingest-answers.mjs` reads the ticks into `.claude/nightly-decisions.json` and re-renders, so answered items drop out on their own. Everything except the ticked boxes and the `notes` blocks is rewritten on each run — review the item CONTENT at its source (`open-items.json`), never by hand-editing this file. Its status-noise is the point: it is a work queue, the same sanctioned exception as `docs/HANDOFF.md`. | **No — generator-owned** (and the owner's answers are the only hand-written part). |
| **meta-tooling / dev-workflow** | `.claude/skills/design-check/SKILL.md`, `.claude/skills/disambiguate-backlog/SKILL.md`, `.claude/skills/ship/SKILL.md`, `.claude/skills/start-lap/SKILL.md`, `docs/nightly-routine.md` | Standalone dev-workflow how-to and scheduler-prompt SOURCE; do the documented commands/paths still resolve. Changes to `docs/nightly-routine.md` must regenerate the generated scheduler prompt. | factual-stale → yes |
| **package READMEs (non-`docs/`)** | `src/audit/README.md`, `src/audit/adapters/README.md`, `examples/README.md` | Claims vs code; do documented commands, paths, provider-neutral host-workload contracts, and result-ingestion boundaries still resolve. These docs must not reintroduce a provider registry, execution adapter, or quota surface. | factual-stale → yes |

<!-- END doc-manifest table -->

**The table above is generated.** Its source of truth is `scripts/doc-manifest-data.mjs`
— edit the data and re-render (`node scripts/check-doc-manifest.mjs --write`); a
hand-edited table fails the gate. The manifest is held as data so that a path can only be
*registered* by being listed as a path: prose that merely names a doc — including the
rationale text inside a row — can never be mistaken for an entry, which is how
`remediation-report.md` became "registered" by a passing mention and how a row pointing at
a file deleted eight weeks earlier survived.

Every tracked `*.md` **anywhere in the repo** must match exactly one row (the `excluded`
row counts). This is mechanically reconciled by `scripts/check-doc-manifest.mjs` (run in
`verify:checks`, so it gates CI and every release): a doc no row matches **fails the
build**, an entry whose file is gone fails, a pattern that matches nothing fails, and a
hand-edited table fails. The existence check has **no per-row exemption** — the `excluded`
row used to have one, which is how a row pointing at a file deleted eight weeks earlier
survived. So a stray doc can never merge silently and the manifest can never drift from
the filesystem. The reviewer still applies the
existence-review smell above; the gate is the hard backstop. A doc that exists but matches
no row → **escalate** ("register here with a reason / fold in / retire"), never
silently treated as design/concept.

Rows carry **patterns**, not just paths (`*` within a segment, `**/` across segments, `?`
one character, `<date>` an ISO date with an optional lap suffix). That is what lets
`docs/reviews/*-<date>.md` state the rule — *a dated review record is excluded by
construction* — instead of enumerating them; the exhaustive list it replaced had reached
51 entries and 21.5k characters in a single table cell, and grew every lap.

## Item keying & the ledger (incremental scope)

The *scope* ledger tracks when each item was last examined; it is distinct from
the *decisions* ledger (`.claude/nightly-decisions.json`) that records the
owner's answers. State lives in a **sidecar file** the run carries forward with
its items (`.audit-tools/nightly/`), never inline in the prose docs (timestamps
in a timeless doc are exactly the status-noise we flag).

- Key each reviewable item by a **content hash of its normalized text**
  (collapse whitespace before hashing). Rewording an item changes its hash →
  it is treated as new and re-checked from scratch. That is correct: a reword is
  a reason to re-verify.
- Ledger maps `itemHash → { lastCheckedCommit, lastCheckedAt }`.
- **The ledger does not let you skip items.** On an active repo the code has
  moved since almost every item's last check, so every item is re-examined. Its
  value is **scoping the evidence window**: for an item last checked at commit
  `C`, read `git diff C..HEAD` to find what *could* have invalidated it, with the
  full codebase available on demand for certainty. Smaller diff to reason over,
  same rigor.
- Ledger writes are **autonomous** (you will not approve timestamp bumps). Only
  *doc content* changes go through the apply/escalate gate.
- Stamp an item only after an agent **actually examined** it this run. The
  adversary's every-item pass is what keeps a stamp honest.

## Pipeline (one nightly run)

0. Load both rubric sources — [`documentation-philosophy.md`](documentation-philosophy.md)
   (doc-shape) and [`project-philosophy.md`](project-philosophy.md) (content-conformance) —
   every disposition measures against them.
1. Review against **local HEAD** (the routine runs locally — see
   [`nightly-routine.md`](nightly-routine.md) for why). Load the ledger.
2. **Reviewer** over every in-scope item (perspective 1, within-doc): read
   `diff lastChecked..HEAD` for scope, full code on demand. Emit per-item
   `{ disposition, edit?, question?, a2b_draft?, evidence }`. Stamp ledger for
   examined items. Also run the **per-doc existence-review**, the
   **philosophy-conformance review** (content vs `project-philosophy.md`), and the
   **doc-set condensation review** (perspective 2) — emit those as escalations.
3. **Adversary** independently over every item: `agree | refute` + evidence.
4. Agree → stands. Contested → **Judge** → final disposition + apply/escalate
   (default-escalate).
5. **Apply** (final = stale-factual-fix, and the file is *not* an instruction
   file): make the edit on `main`. Before pushing, run the **full green gate**:
   `npm run build && npm run check && npm test` — must be
   zero-error / all-pass. **The `npm test` step is non-negotiable, not just
   `build`+`check`:** several in-scope `*.md` files are the *source of truth* for
   generated host-integration assets (e.g. `skills/audit-code/audit-code.prompt.md`
   is the canonical loader body every IDE asset renders from). A "factual"
   entrypoint/path fix to such a file can leave its derived committed asset
   (`.gemini/commands/audit-code.toml`, `.github/agents/auditor.agent.md`, …)
   stale — and ONLY the test suite (host-asset drift, wrapper, contract) catches
   that drift. If the gate fails because a derived/generated asset needs
   regenerating, regenerate it in the SAME commit; if you cannot, **do not push —
   escalate**. Commit as **one discrete, revertible commit**
   (`doc-review: <summary>`), push `main`.
   - Self-correcting: an applied edit changes the item's hash → next night it
     re-stales and all three agents re-verify the edit.
6. **Escalate** (design-decisions, A→B drafts, instruction-file fixes, anything
   the judge held back): emit each as a leg-1 item into
   `.audit-tools/nightly/open-items.json` (shape + subject-key rules in
   [`nightly-routine.md`](nightly-routine.md)). The items file is regenerated each
   run, so a resolved item drops off on its own; a subject the owner has *settled*
   never returns (the durable decisions ledger, not the run's own output).
7. **Silent on clean**: applied nothing and escalated nothing → no digest churn,
   no notification. Never silent on *skipped* — a leg that could not run says so.

## A→B backlog drafts

When a raw backlog item looks ripe to become a spec:

- **Quote the raw item verbatim** so the owner sees exactly what is being
  interpreted.
- Draft a **conceptual** spec — make the desired thing clear; **no file
  citations** (files change before implementation).
- This is a **discussion seed in the findings file**, never an edit to
  `backlog.md`. Promotion raw → specced is always the owner's manual call.

## Output contract

Escalations from this rubric are **leg-1 items in the nightly routine's shared
output** — `.audit-tools/nightly/open-items.json`, rendered to the HTML digest.
The item shape, the subject key that makes an answer stick, and the digest and
notification contract all live in [`nightly-routine.md`](nightly-routine.md);
they are not restated here.

What this rubric owes each escalated item:

- `path` — the doc the claim lives in.
- `title` — the decision in one line, front-loaded. Not a summary of the
  investigation.
- `question` — what the owner is being asked, with the relevant prose quoted
  verbatim.
- `evidence[]` — what was verified against code, and how. The digest collapses
  this behind a disclosure, so length here is cheap; length in `title` is not.
- The **subject** the key is computed from is the doc prose in question — never
  the wording of the question. An answer must survive the routine rephrasing
  itself next run, or it does not stick.

The three escalation classes this rubric produces (proposed instruction-file
edits, design decisions, doc-set condensation) are all leg-1 items; the digest
groups by leg, not by class, so lead the `title` with the class where it matters
(e.g. "instruction-file edit:").

## Hard invariants

- Verify from code, never from prose.
- No code anchor → it is a question for the owner, never a silent deletion.
- Instruction files (`CLAUDE.md`, `AGENTS*.md`) are **never** auto-edited.
- The **full** green gate — `npm run build && npm run check &&
  npm test` — passes before any `main` push. Never `build`+`check` alone: the
  test suite is what catches a doc edit that desyncs a generated host asset from
  its source-of-truth `.md`.
- Each auto-applied change is one discrete, revertible commit.
- Escalations go to `.audit-tools/nightly/open-items.json` (never to `main`);
  `main` only ever receives reviewed, green-gated doc edits.
=== END docs/doc-review-guidelines.md ===
