# P63 — A headless run with an open decision cannot satisfy its own hand-back gates

**Scope: MACHINE-WIDE.** Two of the three mechanisms are global
(`~/.claude/hooks/unasked-decision-gate.mjs`, and the absence of the
`AskUserQuestion` tool in a headless session); the third is this repository's
`scripts/render-closeout.mjs`. The work item belongs in
`C:\Code\docs\backlog.md`.

**No patch attached.** The owner is being asked which of the three mechanisms
should yield, and the candidate forms share no code.

## The defect, in one line

Three rules that are individually correct cannot all be satisfied at once by a
headless run that has an open owner decision, so such a run cannot produce a
clean hand-back at all.

## The three rules

1. **`render-closeout.mjs` REQUIRES a question.** Its `decisions` section refuses
   to render unless the value contains one: *"this section is what the owner must
   still ANSWER, and its value contains no question … If every decision is
   settled, the correct value is the literal `none`."*
2. **`unasked-decision-gate.mjs` REFUSES a question in prose.** It fires on a `?`
   outside quoted spans when no `AskUserQuestion` call was made that turn:
   *"A question posed in PROSE does not count (owner decision 2026-08-30)."*
   Its remedy is *"Use AskUserQuestion, and make it the last action of the turn."*
3. **`AskUserQuestion` does not exist in a headless session.** Measured this run:
   `ToolSearch` for it returned *"No matching deferred tools found"*, and a
   keyword search returned only unrelated tools.

A run with a genuinely open decision must therefore either state it (rule 1
satisfied, rule 2 blocks) or omit it (rule 2 satisfied, rule 1 blocks, and the
decision is silently dropped, which is the worse failure). The gate's own fallback
— *"If no decision is actually open, delete the deferral phrasing"* — does not
apply, because the decision IS open.

## Observed, twice, this session

The 2026-09-09 nightly hit it on both of the unasked-decision gate's two allowed
firings, having already satisfied every other closeout requirement: full-suite
green on the exact tree, commits pushed, the report rendered by the renderer and
pasted verbatim. The only unresolved item was the shape of a question the session
had no tool to ask.

## Why it is not rare

It fires for **every headless run that has an open owner decision**. The nightly
maintenance routine is designed to produce exactly that: its whole leg-3 output is
propositions, and its own loader states the constraint — *"running HEADLESS (no
human available; never ask questions — surface owner decisions through the HTML
digest as the contract specifies)."* So the routine is instructed NOT to ask
live, and then gated for not asking live.

## What this run did instead, and why it is not a fix

Both decisions were turned into tickable items in `docs/nightly-inbox.md`, which
is the routine's contractual answering surface: one tick records the answer, and
`npm run nightly:ingest` reads it back. That is genuinely answerable — the
condition the gate protects — but the gate cannot observe it, because it inspects
the assistant's message and the turn's tool calls, not the repository's answering
page.

## Candidate forms, and the choice

1. **Teach the gate the tick-page channel.** Let a turn satisfy it by having
   written an answerable item to the project's decision queue, the same way an
   `AskUserQuestion` call satisfies it. Most faithful to the gate's intent —
   the question really is posed and really is answerable. Largest change, and it
   needs the gate to learn a per-project convention it currently knows nothing
   about.
2. **Exempt a headless session.** Skip the gate when `AskUserQuestion` is not in
   the toolset, since its stated remedy is then impossible. Small and precise.
   Cost: it removes the guard exactly where the run is least supervised, which is
   arguably where it matters most.
3. **Let the renderer accept a stated answering route.** Allow the `decisions`
   section to satisfy its requirement with an explicit pointer to where the
   question is posed and answerable, instead of requiring the interrogative form.
   Cost: it weakens a check that exists to stop a settled decision being filed as
   an open one.

## False-positive surface

Option 2 has the clearest one: a session could lack the tool for a reason other
than being headless, and would then skip a guard that should have fired. Option 1
has almost none — it widens what counts as asking, and does not narrow what
counts as unasked. Option 3 risks a pointer standing in for a question, which is
the failure the gate's own text calls out (*"a pointer to a queue or a command is
not a question"*), so it is listed last deliberately.
