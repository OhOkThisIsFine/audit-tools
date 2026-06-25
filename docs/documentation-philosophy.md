# Documentation philosophy (canonical)

The single source of truth for *what this repo's docs are for and how they're shaped*.
Every doc, and every item inside a doc, is measured against this. The doc-review routine
([`doc-review-guidelines.md`](doc-review-guidelines.md)) is the enforcement of this philosophy;
this doc is the philosophy itself.

## The core principle

**Docs capture durable concepts, not current state.** Timeless conceptual docs only — the
*why* and the *contract*, never "where the code is today." If a sentence would be wrong after
the next refactor, or reads like a changelog / status report / dated run-narrative, it does not
belong in a concept doc. The single exception is the one rolling handoff (below).

A corollary: **the absence of a thing is not staleness.** A policy ("never hardcode model
identities") is load-bearing precisely when nothing violates it — code-absence is the policy
working, not the doc rotting.

## One home per concept

Each kind of knowledge has exactly one home. Duplication across homes is drift waiting to happen
— if a fact lives in two docs, they will disagree. The homes:

| Home | Holds | Explicitly NOT |
|---|---|---|
| **`CLAUDE.md`** (+ `AGENTS*.md`) | Durable policy, conventions, standing decisions, durable how-to. The instruction layer. | Current state; file-by-file status. |
| **design / concept docs** (`docs/*-design.md`, glossary, host-validation, quota/cross-provider) | Timeless architecture: invariants, seams, contracts, the *why*. The model the code implements. | Changelogs; "this run"; dated plans; progress. |
| **`docs/backlog.md`** | A living to-do list: open work, durable traps, future directions. | A status log. Remove an entry once it ships — record the durable contract/rationale in a concept doc, `CLAUDE.md`, or memory, never "where the code is today." |
| **`docs/HANDOFF.md`** | The single rolling cross-machine handoff: current published state + anything in flight, immediate-next-only. The *one* sanctioned current-state doc. | A changelog; multi-step-out roadmap; anything more than the immediate next. |
| **project memory** | Cross-session durable facts/preferences/traps and their rationale. | — |

When a fact could live in two places, it belongs in the **most durable** one and is referenced
(not copied) from the others.

## What is forbidden in concept docs (status-noise)

These are the smells the review hunts — each is *escalate / retire / condense*, never a silent
field-bump:

- **Pinned version / date / status strings** — "expected version 0.30.5", "plan of record
  (2026-06-24)", "THIS RUN implements…", "shipped 0.28.10 on line X". Derive the value or drop it.
  A doc whose only diffs across runs are version bumps is a status doc masquerading as a concept doc.
- **Changelog / progress creep** — "now in `dispatch.ts`", "former `document.ts` inlined", "A12
  collapsed…". The current shape is read from code; the doc states the durable concept.
- **Dated run-narratives / plans-of-record** — a design captured as "the plan for this run" is
  current-state. Re-state it timelessly as the architecture, or it's not a concept doc.

## The condensation bias

Fewer, denser, timeless docs beat many thin or overlapping ones. The corpus itself is reviewed,
not just its contents:

- **Merge** docs that cover the same concept from two angles into one home.
- **Fold** a doc whose content is a section of another into that other; leave a pointer, not a copy.
- **Retire** a doc whose reason-to-exist has lapsed (the work shipped, the concept moved into
  code/policy, it was always current-state).
- **Split** only when one doc genuinely carries two unrelated durable concepts.
- A doc must justify its existence by a durable concept that has no better home. "Might be useful"
  is not a reason; one clear home is.

## Enforcement

- **Mechanical (hard):** `scripts/check-doc-manifest.mjs` (in `verify:release`) fails the build if
  any tracked `docs/**/*.md` isn't registered in the routing table — strays/dated docs can't merge.
- **Routine (soft, nightly):** the doc-review routine reviews every doc against this philosophy on
  the two perspectives defined in [`doc-review-guidelines.md`](doc-review-guidelines.md) — items
  *within* a doc (fit + staleness) and the doc *set* (does each doc belong / can it be condensed).
  Anything with judgment escalates to Ethan; nothing condenses or retires a doc autonomously.
