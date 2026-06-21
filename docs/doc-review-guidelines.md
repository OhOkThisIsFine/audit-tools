# Doc-review — reviewer guidelines

The contract a nightly **cloud routine** follows to keep this repo's documentation
true to the code. This file is the routine's spec; it is **excluded from its own
review**. Edit it here on `main` — the routine reads it, never rewrites it.

## Why this exists

Docs drift; an agent that *remembers* to re-check them is a latent failure mode
(see `CLAUDE.md` → "auditor-agnostic robustness"). This routine moves that
re-check into tooling: every night, against the live codebase, with three
independent agents gating every change.

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
  spec. → **escalated to Ethan, never auto-applied.**

The split is the entire safety surface. The classifying rule:

> **Factual** = verifiable true/false against code (apply).
> **Policy / conceptual / judgment** = needs Ethan (escalate).
> A policy is **not** stale because no code "uses" it — code-absence is the
> policy *working* ("never hardcode model identities" is load-bearing precisely
> when nothing violates it). Never flag a policy as obsolete by absence.

When in doubt, it is a design-decision. Escalate.

## Scope — every doc, routed by type

All `*.md` under the repo, **recursively**, except the exclusions. Each doc gets
the check for its type:

| Type | Files | Check | Auto-apply? |
|---|---|---|---|
| **design / concept** | `docs/audit-workflow-design.md`, `docs/remediation-workflow-design.md`, `docs/contract-authoring-determinism-design.md`, `docs/cross-provider-quota-matrix.md`, `docs/glossary-ids.md`, `docs/host-validation.md` | Claims vs code (drift); flag current-state / changelog creep (docs are timeless concepts, not status). | factual-stale → yes |
| **instruction / policy** | `CLAUDE.md`, `AGENTS.md`, `AGENTS.audit.md`, `AGENTS.remediate.md` | Factual claims only (file/command/path staleness). Policy & conventions untouchable. | **No — escalate-only.** Highest blast radius: a wrong edit deletes a guardrail governing all agents. |
| **ops / usage** | `README.md`, `README.audit.md`, `README.remediate.md`, `docs/NEW-MACHINE-SETUP.md` | Do the documented commands / paths still resolve and run. | factual-stale → yes |
| **backlog** | `docs/backlog.md` | Shipped-detection (item demonstrably built in code → remove, with proof); dedup near-identical raw items; A→B draft (below). Durable-traps section is **reference** — only flag a trap proven fixed-in-tooling. | shipped-removal & dedup → yes; A→B → escalate |
| **handoff** | `docs/HANDOFF.md` | Immediate-next-only (flag multi-step-out / changelog creep); verify each item vs code; a done item → clear it, with proof. | yes |
| **excluded** | `docs/doc-review-guidelines.md` (this spec), `docs/doc-review-findings.md` (output), `meta-audit-log.md` (append-only log — staleness review is a category error) | — | — |

A doc that exists but matches no row → treat as design/concept and, if it looks
out of place, **escalate** ("should this exist / fold in / retire").

## Item keying & the ledger (incremental scope)

State lives in a **sidecar ledger** on the `doc-review` branch
(`doc-review-ledger.json`) — never inline in the prose docs (timestamps in a
timeless doc are exactly the status-noise we flag).

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

1. On the `doc-review` branch, `git fetch` `main`; check out `main`'s HEAD content
   to review against. Load the ledger.
2. **Reviewer** over every in-scope item: read `diff lastChecked..HEAD` for
   scope, full code on demand. Emit per-item `{ disposition, edit?, question?,
   a2b_draft?, evidence }`. Stamp ledger for examined items.
3. **Adversary** independently over every item: `agree | refute` + evidence.
4. Agree → stands. Contested → **Judge** → final disposition + apply/escalate
   (default-escalate).
5. **Apply** (final = stale-factual-fix, and the file is *not* an instruction
   file): make the edit on `main`. Before pushing, run the green gate
   (`npm run build -w @audit-tools/shared && npm run build && npm run check`) —
   must be zero-error. Commit as **one discrete, revertible commit**
   (`doc-review: <summary>`), push `main`.
   - Self-correcting: an applied edit changes the item's hash → next night it
     re-stales and all three agents re-verify the edit.
6. **Escalate** (design-decisions, A→B drafts, instruction-file fixes, anything
   the judge held back): write `doc-review-findings.md` + the ledger to the
   `doc-review` branch and push. The findings file is **overwritten** each run —
   it always reflects *currently-open* items, so resolved ones drop off on their
   own.
7. **Silent on clean**: applied nothing and escalated nothing → no findings file
   churn beyond the ledger, no notification.

## A→B backlog drafts

When a raw backlog item looks ripe to become a spec:

- **Quote the raw item verbatim** so Ethan sees exactly what is being
  interpreted.
- Draft a **conceptual** spec — make the desired thing clear; **no file
  citations** (files change before implementation).
- This is a **discussion seed in the findings file**, never an edit to
  `backlog.md`. Promotion raw → specced is always Ethan's manual call.

## Output contract (machine-readable for the SessionStart hook)

`doc-review-findings.md` must contain a single delimited block holding **only the
items that need Ethan** — proposed instruction-file edits and design decisions.
A local SessionStart hook reads this block and surfaces it at the start of every
conversation. Keep the FYI ("what I auto-applied") outside the block.

```
<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [id] CLAUDE.md — <one line> — proposed: <diff or change>
### Design decisions for you
- [id] <doc> — <the question, with verbatim quote where relevant>
<!-- DOC-REVIEW-OPEN:END -->
```

If there is nothing open, the block is present but empty (hook stays silent).

## Hard invariants

- Verify from code, never from prose.
- No code anchor → it is a question for Ethan, never a silent deletion.
- Instruction files (`CLAUDE.md`, `AGENTS*.md`) are **never** auto-edited.
- Green gate passes before any `main` push.
- Each auto-applied change is one discrete, revertible commit.
- Findings file & ledger live only on the `doc-review` branch; `main` only ever
  receives reviewed, green-gated doc edits.
