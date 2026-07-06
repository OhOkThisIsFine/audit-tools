---
name: disambiguate-backlog
description: >-
  Clarify under-specified backlog and meta-audit items in conversation — collect
  every open backlog item (docs/backlog.md) and meta-audit reflection
  (agent-feedback.jsonl / meta-audit-log.md), decide which are under-specified,
  then pin them down one at a time with reviewer+adversary-characterized
  propositions (pros/cons) for the owner to judge, writing the agreed spec back into
  backlog.md or memory. Use this whenever the owner wants to disambiguate, pin down,
  clarify, spec out, triage, or surface design gaps in backlog / meta-audit /
  reflection items — including phrasings like "tighten up the backlog", "which
  backlog items are vague", "turn these raw items into specs", "run the design-gap
  pass", or "go through the open items with me". Reach for it any time the goal is
  closing ambiguity in tracked work items rather than auditing code.
---

# Disambiguate backlog & meta-audit items

## What this is

A live, conversational pass that turns vague tracked work into clear specs:
collect the open work items, find the ones with real ambiguity, and pin each one
down *in conversation* — propose concrete ways to resolve it, characterize each
with honest pros and cons, and let the owner judge, in the loop, now. On agreement,
the resolved spec is written back so the ambiguity is closed for good.

Scope is two raw-signal sources, nothing else:

- **`docs/backlog.md`** — every entry under *Open bugs / frictions*, *Forward
  tracks*, *Deferred / waiting*. (Skip *Durable traps* — it's reference, not
  work-to-spec; only touch a trap if the owner asks.)
- **meta-audit reflections** — worker feedback: `meta-audit-log.md` if present
  (gitignored, append-only) plus any `agent-feedback.jsonl` under
  `.audit-tools/**`. Shape: `{ instruction_clarity, ambiguities[],
  tool_friction[], suggestions[], severity }` (`src/shared/agentReflections.ts`).
  A recurring `ambiguous`/`unclear` reflection is a design gap the same way a
  vague backlog item is.

## Why it works this way

Disambiguation is **judgment** — there's no mechanical "right answer" to apply,
which is exactly why it needs the owner rather than an autonomous fix. And judgment is
best exercised in a back-and-forth: a one-shot report loses the exchange that
actually closes a gap. Doing it live, one item at a time, with concrete
propositions to react to, is how a vague item becomes a real spec in one sitting.

The reviewer+adversary split exists because **an author marking its own homework
misses gaps** (`docs/project-philosophy.md` → A7 "delegate adversarial phases to a separate agent").
One agent drafts propositions; an independent one tries to refute them and find
the interpretation the first missed. You see both, then judge.

## The loop

### 1. Collect — everything, no filtering yet

Read `docs/backlog.md` in full. Enumerate every item in the three in-scope
sections as a discrete unit (one bullet = one item; a bullet with sub-bullets is
one item). Glob `.audit-tools/**/agent-feedback.jsonl` and read `meta-audit-log.md`
if it exists; parse reflections, group recurring ambiguities/frictions into
candidate items. Hold the full list — don't drop anything yet.

### 2. Classify — which items actually need disambiguation

Not every item has a design gap. For each, decide one of:

- **needs-disambiguation** — under-specified in a way that blocks acting on it:
  a vague goal with no agreed shape, an A→B spec that's still a wish, competing
  interpretations, an unstated decision, a reflection naming a real ambiguity.
  *These go into the dialogue.*
- **ready** — clear enough to act on as written; no judgment owed. Skip.
- **shipped / stale** — code shows it's already done or obsolete. **Don't fix it
  here** — this skill closes *design gaps*, not bookkeeping; flag it as closable
  with the proof and let the owner decide, never silently delete. Distinguish
  **fully-shipped** (no open remainder → delete the whole entry on his ok) from
  **partial** (shipped substrate + still-open work → the open remainder is the real
  item; trim away the "what shipped" tail). A standalone `_SHIPPED …_` / `**FIXED**`
  note is by definition fully-shipped — flag it for deletion.

Verify every classification **from code/disk, never from the prose** — an item
reading "build X" may already be half-built. Present the classification as a
short manifest first: *N items, M need disambiguation, K look shipped/stale.*
Let the owner confirm or re-scope before you spend agent budget going deep.

### 3. Characterize — reviewer + adversary, per in-scope item

For each needs-disambiguation item, the goal is **propositions with pros and
cons**, not a single recommendation. the owner judges; you supply the option space.

Dispatch two independent subagents (use the `Agent` tool — `Explore` for the
read-heavy verification, `general-purpose` for drafting):

- **Reviewer** — read the item + the relevant code (scope the evidence window
  with `git diff` since the item last moved if cheap). Produce **2–4 candidate
  resolutions** ("propositions"): distinct ways the item could be specced or
  decided. For each: a one-line statement of the spec, plus honest **pros / cons**
  (what it buys, what it costs, what it forecloses). Anchor claims to files.
- **Adversary** — independently, *without* the reviewer's output: examine the
  same item, try to refute each proposition's premises, and surface any
  interpretation or option the reviewer missed. Agree / refute with evidence from
  code.

Run these against the project's durable principles (`CLAUDE.md` Concepts, Conventions &
Preferences — ideal-code-over-compat, language-neutral, everything-agnostic,
enforce-robustness-in-tooling) so propositions are pre-filtered for fit. A
proposition that violates a standing decision is a con worth naming, not a silent
drop.

### 4. Judge — one item at a time, the owner decides

Surface items **one at a time**, highest blast-radius / most-blocking first.

**Translate before you present — this is the make-or-break step.** The reviewer
and adversary speak in the repo's internal vocabulary (artifact names, test ids
like "A-9", terms like "disposition", "blast-radius classifier", "sidecar
branch"). the owner is judging the *decision*, not grading the analysis — and a wall
of jargon makes the choice feel opaque even when the analysis is sound. Before
showing anything, rewrite it so the **choice itself is legible**:

- **Lead with the real axes of choice, in plain words.** Usually 1–2 dials the
  options vary along (e.g. "where it runs" × "how cautious it is"). Name the dials
  first; the propositions are just corners of that space. A small table beats a
  list when there are two axes.
- **State each option as what actually happens and what it costs *the owner*** — in a
  sentence a smart outsider to this repo would follow. Not "reuses the
  default-escalate three-agent gate" but "a cloud bot fixes anything that passes
  an automated check and opens the PR itself."
- **Expand or drop every internal term.** If a name (a test id, an artifact, a
  coined phrase) is load-bearing, say what it *means* and why it matters; if it
  isn't, cut it. A refuted premise is "the thing we assumed is true isn't —
  here's the proof," not a citation dump.
- **Give a recommendation with a one-line reason**, then stop. the owner asked for
  propositions characterized by pros/cons so *he* judges — but an unranked menu is
  its own kind of unclear. Point to the option you'd pick and why; he overrides
  freely.

Suggested shape (adapt freely — legibility over template):

```
## <plain restatement of what this item is trying to do>
> <raw item quoted verbatim — so the owner sees exactly what's being interpreted>

**The real choice:** <the 1–2 axes, in plain words>

<table or short list of options, each = what happens + what it costs the owner,
 jargon expanded or removed>

**The catch:** <only design-shaping constraints — a standing decision the
 design tensions with, an axis the options can't both satisfy>

**My read:** <recommendation that follows from the DESIGN merits + one-line why>
```

**Clarify the end-goal only — never touch sequencing.** This skill answers
*"what is the desired thing?"*, full stop. *When* to build it, *whether* now is
the right time, what has to be fixed first — all of that is decided elsewhere
(e.g. when the owner actually runs remediate-code), never here. Concretely:

- **Don't relate the design to other backlog items or known bugs.** It's
  tempting to note "blocked by bug X" or "do the safe half first because of Y" —
  don't. Those items get fixed, dropped, or reinterpreted, and the moment they do,
  a spec that referenced them is stale. A captured spec must read true regardless
  of what else is on the backlog.
- **The recommendation follows from design merits alone** — which option is the
  better *end-goal*, not which is safer to start with given current conditions.
  A "do the cautious thing first" instinct is sequencing in disguise; leave it out.

The spec you write back should be self-contained and timeless: someone reading it
a year later, with a completely different backlog, should still understand exactly
what was wanted and why.

Then stop and let him judge: pick, blend, redirect, defer, or kill. Don't
batch-dump all items — the value is the per-item exchange. If he says the choice
still isn't clear, that's a signal to translate harder, not to add more options.

### 5. Write back — on agreement only

A disambiguation pass must END an item in exactly one of two states:
**specced** (resolved into a self-contained spec) or **left as-is** (untouched,
still raw). NEVER a third state — never rewrite an item into a tighter version
that still carries "open sub-questions to pin down next", "TBD", or "decide X
later". That just relocates the ambiguity and breeds the exact churn this skill
exists to kill. If parts of an item resolve and parts don't, either keep
resolving the rest in conversation now, or leave the WHOLE item raw — do not
write back a half-specced entry with residual open questions. The whole point is
to complete the disambiguation or leave it; clearing it up partway and parking
the remainder in the backlog is a failure mode, not an outcome.

Closing the gap means capturing the resolution where it belongs. When the owner
settles an item:

- **Specced (raw → A→B):** rewrite that backlog entry in place as the agreed
  conceptual spec — desired thing made clear, **no file citations** (files change
  before implementation). Keep it in the right section.
- **Durable decision/rationale:** if the resolution is a standing contract or
  principle (not a to-do), it belongs in memory + `CLAUDE.md`, not the backlog —
  write a memory file (per the memory protocol) and add the index line; remove the
  raw item from the backlog since it's now captured.
- **Shipped/stale confirmed:** **delete the entry outright** — never rewrite it into
  a `_SHIPPED …_` / `**FIXED**` / `**DONE**` marker and never leave such a marker
  standing (a shipped-status note is itself the status-noise the philosophy forbids;
  `git log` is the history). If the entry is only *partially* shipped, delete the
  shipped tail and keep only the still-open remainder. If a shipped fix carries a
  durable trap/convention worth keeping, move it to its durable home (Durable traps,
  `CLAUDE.md`/memory) in the same edit, then delete the backlog entry — never retain
  the entry just to host the rule. Cite the proof the owner agreed to.
- **Deferred/unchanged:** leave it; optionally tighten wording if the owner asked.

Only the owner's explicit agreement triggers a write — never promote on your own read.
After edits, keep the tree green per `CLAUDE.md` (the doc edits are prose, but if
a touched item names a generated asset, run the gate before considering it done).

### 6. Close out

Summarize: items specced, items written to memory, items flagged shipped/stale,
items left open. If meta-audit reflections drove any new gap, note it so the
signal isn't lost. This is end-of-sprint-adjacent — sync memory + index if any
durable decision landed.

**Then commit and push.** Once the items are disambiguated and the pass is done,
commit the backlog/skill/memory edits and push — don't leave the resolved specs
sitting uncommitted in the working tree. (Per "Pipeline ownership" — work done =
landed, not parked at the commit boundary.)

## Hard rules

- **Verify from code, never from prose.** A backlog item's own wording is the
  thing under question — confirm what's true against the actual code/disk.
- **Propositions, not verdicts.** Your job is the characterized option space;
  the judgment is the owner's.
- **Reviewer and adversary are independent.** Don't let one agent produce both —
  that defeats the gate.
- **Write only on explicit agreement.** No silent promotion or deletion.
- **No half-specced write-backs.** An item ends specced or left-as-is — never
  rewritten into a tighter form that still parks "open sub-questions"/"TBD" for a
  future pass. Complete it or leave it whole.
- **Don't touch instruction-file policy** (`CLAUDE.md`, `AGENTS*.md`) as a
  backlog edit; a resolution that changes policy is escalated as its own
  proposition, applied only on the owner's call.
