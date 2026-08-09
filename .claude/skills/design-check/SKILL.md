---
name: design-check
description: Run the pre-implementation design gate before writing code for a non-trivial change in audit-tools — check the intended approach against the repo's retired decisions and standing invariants, have an independent lane try to refute it, and come back with the minimal failing test that proves the bug. Use before implementing any loop-core, dispatch, quota, contract, or cross-cutting change, and whenever a fix is about to reintroduce a mechanism the repo may already have deliberately removed. Not for trivial mechanical edits.
---

# Design-check — refute the approach before writing it

The dominant defect class here is not a coding mistake, it is a **decision already made and
forgotten**: a fix that reintroduces something the repo deliberately retired, or that lands a new
reachable path through a strand nobody re-checked. Adversarial review catches these — but review runs
*after* the code exists, so every catch costs a full rewrite. This skill moves one cheap pass to the
front, where the same catch costs an edit to a plan.

Bounded and pre-implementation. It ends with a failing test, not with code.

## 1. Size the change — decide if this gate applies

Skip for trivial mechanical edits (a typo, a message string, a test rename); say so in one line and go.
Run it when the change touches loop-core (the paths in
[`src/shared/loopCorePaths.ts`](../../../src/shared/loopCorePaths.ts) — the same set the commit
attestation gate keys on), a shared contract under `src/shared`, dispatch/quota/rolling behaviour, an
artifact shape, or anything whose blast radius you cannot state in one sentence.

Risk-tier it the same way a lap is tiered ([[risk-tier-loop-laps-cheap-vs-heavy]]): one pass for a
contained change, the full three questions below for loop-core.

## 2. Collect the retirement evidence (deterministic, before any LLM)

The question "has this already been decided against?" is answered from the repo, not from memory.
Gather, with the file tools:

- **Standing decisions** — the *Preferences & standing decisions*, *Conventions & invariants* and
  *Commands* sections of [`CLAUDE.md`](../../../CLAUDE.md). These are where retirements live as prose
  (`KNOWN_MODEL_LIMITS`, the hardcoded host-model id, `--production` knip, the node:test split).
- **Durable traps** — [`docs/backlog/durable-traps.md`](../../../docs/backlog/durable-traps.md), and the
  open items in [`docs/backlog/open-bugs.md`](../../../docs/backlog/open-bugs.md) that name the same
  files. An entry that already describes your plan is the answer.
- **The removal itself** — `git log --oneline -S'<symbol>'` for the mechanism you are about to add
  back, and `git log --oneline --grep=retire --grep=revert --grep=delete -i -20`. A symbol that was
  *removed* in a commit is the strongest possible signal, and it is cheap to ask.
- **Project memory** — the index at `~/.claude/projects/C--Code-audit-tools/memory/MEMORY.md`; open
  only the entries whose one-line hook matches the change.

If any source says the mechanism was removed on purpose, **stop and surface it** — that is the whole
value of the gate. Do not argue it back in during the same breath; the owner decides whether the
retirement still holds.

## 3. Have an independent lane try to refute the plan

Delegate — do not self-assess; the point is a reader who did not author the plan. Pick an
independent lane and run it yourself: `codex exec --skip-git-repo-check "<prompt>" < /dev/null`
(closing stdin is load-bearing), `agy -p "<prompt>"`, or a free-provider session via
`powershell -File C:\Users\ethan\freellmapi\claude.ps1 -p "<prompt>"`. Pass the plan plus the
evidence files from step 2 as file PATHS in the prompt; never paste file bodies into it.

**Hand the lane the recon rather than the job of redoing it.** What a round must not do is judge work
it authored — that is independence of *verdict*, and it is the whole point of delegating. Independence
of *input* was never carrying it: a fresh lane that re-greps the same call-site map the last round
already established burns its budget from scratch on rediscovery instead of judgment (four rounds over
one step cost ~135k subagent tokens apiece, nearly all of it identical). So write the verified map once
— the call sites, their current values, who writes what — and pass it as a **read-only, provenanced
input**, labelled as prior verified recon this lane did not author. The lane never writes back to it,
and its verdict stays its own. When it disagrees with the map it must say so and name the file and line
that contradicts it; that disagreement is a fresh recon pass, which is the only thing allowed to update
the map. Otherwise the map quietly absorbs one reviewer's assumption and reaches the next round as
fact. Sharing an agent *session* across rounds is the wrong version of this — it keeps the context by
forfeiting the fresh verdict.

Ask exactly three questions, and POST a schema shaped to *this* job — an array of typed verdicts, not
the generic `{summary, findings, open_questions}` container, which returns placeholder values on
analytical work:

1. Does this reintroduce anything the attached evidence shows was deliberately retired?
2. Which adjacent strand does it make newly reachable, and what breaks there?
3. What is the smallest test that fails today because of the defect, and passes only once it is fixed?

Treat the answers as **advisory leads, not verdicts** — verify each one against the source file before
acting on it. A refutation you cannot reproduce in the code is not a refutation.

## 4. Write the failing test first

Turn answer (3) into a real test and run it. It must be **red before the fix and green after**, and it
must reach the code it names ([[test-must-reach-the-code-it-claims]]) — a test that would pass against
the unfixed tree proves nothing. Restore any temporary mutation by **inverting the edit**, never with
`git checkout --` ([[redgreen-restore-by-inverting-never-checkout]]); the shell-trap guard refuses that
restore anyway.

## 5. Hand back — then implement

Three lines, then start coding: the retirement verdict (clean, or the decision it collides with), the
adjacent strand the change makes reachable, and the failing test now pinned red. If step 2 found a
collision, stop at the surface instead — the plan needs the owner, not an implementation.
