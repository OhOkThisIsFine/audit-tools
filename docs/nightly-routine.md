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
| **backlog** | `docs/backlog/open-bugs.md`, `docs/backlog/minor-bugs.md`, `docs/backlog/forward-tracks.md`, `docs/backlog/deferred.md` | Mechanical cleanup only: delete an entry whose fix verifiably shipped, strip status-noise from a live entry, correct a stale file/symbol reference | Any genuine disambiguation — turning a vague item into a spec is the owner's call |
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

*Review-archive retirement (C-10).* `docs/reviews/` is excluded from the doc
manifest by construction, so no staleness pass can ever mark a dated record
spent — which is how 27 files came to hold zero citations from anywhere. Run
`node scripts/nightly/review-retirement-candidates.mjs` once per pass: each
candidate it names (a dated review older than 14 days that nothing outside the
archive cites) becomes a retirement PROPOSAL in the inbox — an owner decision,
never an auto-delete. Git history keeps every retired record.

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
(`~/.claude/projects/C--Code-audit-tools/memory/`, including its
`…/memory/MEMORY.md` index), the global `~/.claude/CLAUDE.md`, backlog
*Durable traps* and *Open
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

**Run the proposal's test at HEAD before writing the proposal.** Record the
exact command, the HEAD sha, and the verbatim failure in
`.audit-tools/nightly/proposals/<id>/RED-AT.txt`, and quote that real failure
in the proposal — never a predicted one (a stated RED nobody observed is a
false red presented as evidence). A test that genuinely cannot run at HEAD
(the patch creates the file under test) still gets a RED-AT.txt stating, in
one line, why. `npm run check:proposal-red-at` (in verify:checks) refuses a
proposal test with no sibling record.

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
session not already cached in `~/.claude/usage-data/facets/`, and — the real one — its suggestions are
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
