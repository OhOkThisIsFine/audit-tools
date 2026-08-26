# End-of-sprint report — template

The closeout hand-back at the end of every sprint (see the *End-of-sprint cleanup* step in
[`CLAUDE.md`](../CLAUDE.md)) is **rendered, not hand-written**:

```bash
node scripts/render-closeout.mjs --in closeout.json
```

The `"none"` rule has two halves, and they are opposites. In the **input**, every section
carries a value — real content, or the literal `"none"`. In the **rendered output**, the
`"none"` sections are omitted. That omission is the renderer's job, never the author's.

`--template` prints a blank input. The rendered markdown is the hand-back, pasted into chat; the
durable pieces are simultaneously written to their permanent homes (`docs/HANDOFF.md`,
`docs/backlog/`, project memory).

## Why a renderer and not a template to copy

Two properties of the report pull against each other, and no hand-written version holds both:

- **The report must be short.** A section with nothing to report is omitted — not written out as
  `none`, and never as a `none` followed by a paragraph explaining the `none`. Long closeouts are
  the ones that stop being read.
- **Silence must be intentional.** If empty sections simply vanish, a *skipped* obligation and a
  genuine *nothing to report* look identical, and the closeout stops being evidence of anything.

The renderer separates them by moving the disposition off the page and into an input it refuses to
guess. Every section declared in [`scripts/closeout-sections-data.mjs`](../scripts/closeout-sections-data.mjs)
must carry a value — content, or the literal `"none"` — or the render fails and names what is
missing. Only the sections with content render. So an omission in the report is always a decision
that was stated, and the report is still short.

Two sections are `required: true` and may not be `"none"`: **Verification** and **Landed this
sprint**. There an absence is not "nothing to say", it is "nobody looked".

Section order is the registry's order, and it is bottom-weighted on purpose: chat shows the end of
a long message first, so mechanics come first and what the owner must act on comes last.

The refusal is backed by the `closeout-challenge-gate` Stop hook, which reads the record the renderer
writes. That record binds two ways, and both matter:

- **To the worktree CONTENT** — a tree object id, not HEAD. The closeout commits its own HANDOFF,
  backlog, and memory updates, and a HEAD-bound record was invalidated by the very commit it
  described. Committing exactly what the report described now keeps the record valid; an edit made
  after the render correctly invalidates it.
- **To the SESSION that rendered it** — the record is one file per repo, so an earlier session's
  render is not your closeout. A render that predates this session is reported as another
  session's hand-back.

So hand-writing the report instead is not a quiet way around the check. The behavior is pinned by
[`tests/shared/closeout-render.test.ts`](../tests/shared/closeout-render.test.ts).

## What each section is for

- **Verification** — input key `verification`, always renders — what was run, what it returned, and the clean pushed commit it
  ran on.
- **Cleanup** — input key `cleanup` — dead code, orphaned helpers, and stray debug/TODO removed. Any
  intermediate state that is there on purpose belongs in this same section, worded so it does not
  read as a bug. (There is no separate key for it — the input keys are exactly the ones named in this list.)
- **Friction this sprint** — input key `friction`, an OBJECT keyed by bullet id, not a string — bullets keyed by the single-sourced friction vocabulary
  (`FRICTION_CATEGORIES`, `src/shared/friction/frictionRecord.ts`), one taxonomy for sprint retros
  and the product's mechanical capture. The named categories are seeds, not an exhaustive schema —
  the open-ended bullet is load-bearing whenever it has content.
- **Docs synced** — input key `docs` — HANDOFF / backlog / memory + index, only the ones that actually changed.
- **Landed this sprint** — input key `landed`, always renders — what this sprint did and its outcome, with
  commits/versions. "nothing — investigation/docs only" is a real answer; an empty section is not.
- **Decisions needed from you** — input key `decisions` — every decision only the owner can make, posed as an actual
  answerable question with its options spelled out, via AskUserQuestion where the harness offers it.
  "Your decision: see queue X / run command Y" is a pointer, not a question, and does not satisfy
  this section. Record each answer in its durable home once given.
- **Remaining next steps, and where each lives** — input key `next_steps` — every remaining step WITH the document that will
  hold it after the session ends: immediate-next → `docs/HANDOFF.md`; open bugs →
  `docs/backlog/open-bugs.md`; forward tracks → `docs/backlog/forward-tracks.md`; durable
  design/status → project memory + its index; durable how-to → `CLAUDE.md`. A step living only in
  chat is lost.

## Notes

- **Adding or removing a section is a registry edit**, not a prose edit — the renderer, the refusal
  message, and this document's list all follow from `closeout-sections-data.mjs`.
- **Owner decisions are asked, not referenced.** The recurring failure that section exists to stop:
  hand-backs that say "your decision — item X" while the actual question (which the agent holds,
  options and all) never reaches the owner. If the owner would have to open a file or run a command
  to find out what is being asked, the closeout has not asked it.
- **One home per fact.** The report points at where durable content lives; it does not duplicate it.
- **Never commit a filled, dated copy** of a rendered report into the tree — that is the
  changelog/status-doc creep the [documentation philosophy](documentation-philosophy.md) forbids.
