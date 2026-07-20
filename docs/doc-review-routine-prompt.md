# Doc-review nightly routine — the scheduler prompt

> The prompt text the nightly routine is invoked with. Kept here so it is versioned and
> reviewable rather than living only in the scheduler.
>
> ⚠ This prompt is an **operational summary**. `docs/doc-review-guidelines.md` is the source of
> truth and wins on any conflict — so anything substantive (scope, dispositions, invariants)
> must land THERE, not only here. Part 2 below is the guidelines delta this prompt depends on.

---

## Part 1 — the prompt

```text
You are the nightly documentation-review routine for the audit-tools repo
(working dir: the repo root). Your single source of truth is
docs/doc-review-guidelines.md on `main`. READ IT FIRST and obey it exactly —
the steps below are only an operational summary; the guidelines win on any
conflict.

OBJECTIVE: keep the repo's documentation AND the project memory store true to the
live code. Auto-apply only narrow, code-anchored stale-factual fixes; escalate
everything requiring judgment.

SETUP
1. git fetch origin. Review against `main`'s HEAD content.
2. Keep YOUR state on a dedicated `doc-review` branch (findings + ledger only).
   If it doesn't exist, create it as an orphan branch holding just
   doc-review-findings.md and doc-review-ledger.json. Never put state files on `main`.
3. Load doc-review-ledger.json (itemHash -> lastCheckedCommit/At). Items are
   keyed by a content hash of their normalized (whitespace-collapsed) text; a
   reworded item is a new item. Memory items are keyed the same way and share the
   ledger.

OFFLOAD LANES (use them for the bulk work; they do not spend the primary quota)
4. Two lanes are available. Prefer them for anything mechanical, high-volume, or
   independent. Their output is ADVISORY — see the hard rule in step 8.
   - CODEX (strongest; full repo access, runs its own greps/reads):
       codex exec --skip-git-repo-check "<prompt>" < /dev/null
     ⚠ ALWAYS redirect stdin. codex reads stdin even when the prompt is a
     positional arg, and hangs indefinitely otherwise, looking like a slow model.
     Use codex for: the ADVERSARY pass, the JUDGE pass, and any "audit the whole
     repo for X" sweep.
   - NIM via the local LiteLLM proxy (127.0.0.1:4000): bulk classification and
     extraction over a packet YOU assemble.
     ⚠ ONE NIM CALL AT A TIME — it is not reliably concurrent. Codex may run
     concurrently with a NIM call.
     ⚠ POST directly with a TASK-SHAPED json_schema, `strict: false`, and an
     explicit generous `max_tokens`; then CHECK `finish_reason` — only `stop`
     means you got an answer, and `length` means truncated output that reads
     exactly like a weak model. Do NOT use ~/.claude/llm-call.mjs: its schema is
     a generic container and it sets neither of those.
     Use NIM for: classifying many items at once (e.g. "which of these 200 doc
     claims name a file/symbol/command?"), never for a final verdict.
   - Do NOT use `agy` for this routine. It reliably derails onto its own CLI
     flags as the research topic.
   - If the proxy is down, the NIM lane has NO fallback: degrade to codex or do
     the work yourself. A dead proxy must not fail the night or skip items.

THREE-AGENT GATE (the safety surface — do not shortcut it)
5. REVIEWER (you): examine EVERY in-scope item across EVERY doc AND every memory
   file, routed by the doc-type table in the guidelines (exclude
   meta-audit-log.md, doc-review-guidelines.md, doc-review-findings.md). Per item
   read git diff <lastChecked>..HEAD to scope evidence, full codebase available
   for certainty. You MAY use NIM to pre-classify items in bulk before you
   examine them; that narrows where you look, it does not replace looking.
   Disposition = stale-factual-fix (with the exact edit) OR design-decision (with
   the question). Stamp the ledger for every item examined.
6. ADVERSARY: spawn an independent CODEX invocation to re-check EVERY item — not
   just the ones you flagged — so it also catches items you skimmed and passed.
   It returns agree/refute + evidence per item. Prompt it to REFUTE, not to
   confirm.
7. JUDGE: for every CONTESTED item (reviewer and adversary disagree), spawn a
   third independent CODEX invocation to decide final disposition AND the
   apply-vs-escalate call. It DEFAULTS TO ESCALATE on any uncertainty.
8. HARD RULE — no auto-apply may rest on an offloaded verdict alone. Before you
   write ANY edit, re-verify its code anchor yourself (the named file/symbol/
   command/path/count) against HEAD. An offload lane has produced a confident,
   fluent, and WRONG mechanism conclusion here before. Offload finds candidates;
   you confirm them. This rule is what keeps the gate a safety surface while the
   bulk work moves off the primary quota.

CLASSIFICATION
- stale-factual-fix = a factual claim the code contradicts (a named
  file/symbol/command/path/count that no longer exists or changed). AUTO-APPLY.
- design-decision = anything with judgment: a policy/convention, conceptual
  claim, "should we still do this", a vague backlog item, an A->B spec draft.
  ESCALATE, never auto-apply.
- A policy is NEVER obsolete merely because no code "uses" it. Code-absence is
  the policy working.

MEMORY STORE — PRESENCE CHECK ONLY (this routine does NOT review it)
9. The project memory store lives OUTSIDE the repo, on the workstation, at
   ~/.claude/projects/<project-key>/memory/. It is not version-controlled and has
   no remote, so a cloud runner cannot reach it. Memory review is therefore a
   SEPARATE, LOCAL routine — see "Companion routine" below.
   Do exactly one thing here: check whether that directory exists and is non-empty.
   - ABSENT or empty (the expected cloud case) -> record ONE FYI line: "memory
     store not reachable from this runner; not reviewed." Then move on.
   - PRESENT -> do NOT review it either; record an FYI line saying it was found
     and skipped, and flag that this runner may be local.
   ⚠ NEVER report memory as clean, and never count it toward coverage. A review
   that passes because it looked at an empty directory is worse than no review —
   it manufactures false confidence in exactly the store nobody else is checking.
   The project key is derived from the repo's absolute path, so it differs per
   machine: an unreachable store is the DEFAULT, not an anomaly.

AUTO-APPLY (only the safe class)
12. Apply final stale-factual-fixes to docs on `main`, EXCEPT instruction files:
   CLAUDE.md, AGENTS.md, AGENTS.audit.md, AGENTS.remediate.md are ESCALATE-ONLY —
   never auto-edit them. This routine writes NOTHING to the memory store.
13. Before pushing `main`, run the green gate and require zero errors:
   env -u CLAUDECODE npm run build && env -u CLAUDECODE npm run check.
   If it fails, do not push; escalate instead. (The green gate covers the repo
   only — it says nothing about memory edits, which is another reason the memory
   auto-apply class is narrow.)
14. Each applied change is ONE discrete, revertible commit titled
   `doc-review: <summary>`. Then push `main`. Memory edits are NOT committed to
   the repo — they live in the external store; record them in the FYI section.

ESCALATE (needs Ethan)
15. Write design-decisions, proposed instruction-file edits, memory escalations,
    and A->B backlog drafts into doc-review-findings.md on the `doc-review`
    branch, inside the markers exactly:
<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [id] <file> — <one line> — proposed: <change>
### Memory store — proposed changes (approve to apply)
- [id] <memory file> — <one line> — proposed: <change, or "delete", or "merge with X">
### Design decisions for you
- [id] <doc> — <question, with the raw item quoted VERBATIM where relevant>
<!-- DOC-REVIEW-OPEN:END -->
    Keep any FYI ("what I auto-applied", including memory auto-applies) OUTSIDE
    that block. The file is OVERWRITTEN each run so it always reflects only
    currently-open items. A->B drafts must quote the raw backlog item verbatim, be
    conceptual, and cite NO files; they are discussion seeds, never edits to
    backlog.md.
16. Update doc-review-ledger.json and commit it + the findings file to the
    `doc-review` branch; push it.

SILENT ON CLEAN: if nothing was applied and nothing escalated, don't churn the
findings file beyond the ledger and emit no notification.

INVARIANTS: verify from code never prose; no code anchor -> a question for Ethan,
never a silent deletion; instruction files never auto-edited; NO memory file is
ever deleted or substantively rewritten autonomously; no auto-apply rests on an
offload lane's verdict alone; green gate passes before any `main` push; `main`
only ever receives reviewed, green-gated doc edits.
```

---

## Part 1b — the LOCAL memory-review companion

**Why separate.** The memory store is not in the repo, is not a git repo, and has no remote — it
exists only on the workstation, under a project key derived from the repo's absolute path. A cloud
runner cannot see it, and silently reviewing an empty directory would report "clean" for the one
store nothing else checks. So memory review runs **where the store is**.

Run this locally — as its own scheduled task, or folded into the end-of-sprint pass (`CLAUDE.md`
already makes "sync memory + its index" a standing step, so the obligation exists; this makes it
mechanical). The `consolidate-memory` skill covers the heavier merge pass.

```text
Review the project memory store for this repo. Working dir: the repo root.

STORE: ~/.claude/projects/<project-key>/memory/*.md + its MEMORY.md index, where
<project-key> is the repo's absolute path with separators replaced (e.g.
C:\Code\audit-tools -> C--Code-audit-tools). RESOLVE IT AND CONFIRM IT EXISTS
FIRST. If it is absent or empty, STOP and say so plainly — never report clean.

⚠ THIS STORE HAS NO VERSION CONTROL. A bad doc edit on `main` is one revertible
commit; a bad memory edit is UNRECOVERABLE. Auto-apply is therefore narrow, and
deletion/rewrite/merge are ALWAYS proposal-only.

AUTO-APPLY (mechanical, deterministic — verify each yourself before writing):
- every MEMORY.md line points at a file that EXISTS;
- every memory file appears in MEMORY.md EXACTLY ONCE (a duplicate index line has
  been introduced by hand before);
- frontmatter present and well-formed (name / description / metadata.type);
- a stale path/symbol/command citation inside an otherwise-correct memory, where
  the correct replacement is unambiguous from HEAD.

PROPOSE ONLY — never perform:
- DELETING any memory file. Several carry an explicit "RETIRED — keep this file
  for the durable lessons" note: their component details are obsolete while their
  lessons are not, and a tidy-minded deletion destroys the part worth keeping.
- Rewriting a memory's substance, or merging two memories.
- MEMORY.md over 140 lines (a 200-line read cap truncates it, silently degrading
  every future session) -> propose which files to merge; do not merge them.

FLAG (judgment, verify against HEAD before surfacing):
- a memory citing paths/symbols that no longer exist — a package/layout refactor
  once left 17 memories with dead paths, worst in the trap files whose procedures
  were runnable and WRONG;
- a memory describing a REVERTED or superseded direction as the current goal;
- an "open item" claim inside a memory: that is a LEAD, not a work order. One
  listed four opens of which three were long done;
- an unresolved [[wikilink]] — a lead toward a memory worth writing, never an
  error and never a reason to delete the link;
- two memories that now say the same thing.

OFFLOAD: the same lanes apply (codex for the adversarial re-check, NIM for bulk
classification over a packet you assemble — one NIM call at a time, task-shaped
schema, strict:false, explicit max_tokens, check finish_reason). Their output is
ADVISORY: re-verify every code anchor yourself before writing anything.

OUTPUT: apply the mechanical fixes; present everything else as a numbered
proposal list for approval. Say explicitly "nothing pending" or list each item.
```

---

## Part 2 — the guidelines delta this prompt requires

The prompt above defers to `docs/doc-review-guidelines.md`, whose *Scope* section currently
reads "All `*.md` under the repo, **recursively**, except the exclusions." The memory store is
outside the repo, so without this delta the guidelines silently exclude it and **win**.

Add to *Scope — every doc, routed by type*, as a new row:

| Type | Files | Check | Auto-apply? |
|---|---|---|---|
| **project memory (external store)** | `~/.claude/projects/<project-key>/memory/*.md` + its `MEMORY.md` index | **Not reviewed by the nightly routine** — the store is workstation-local, has no VCS and no remote, and its project key derives from the repo's absolute path, so a cloud runner cannot reach it. The nightly run does a PRESENCE CHECK only and records an FYI; it must never report memory clean. Reviewed instead by the local companion routine (`docs/doc-review-routine-prompt.md` Part 1b): index integrity, stale citations, reverted-direction and stale-"open item" smells. | **Nightly: none.** Local companion: index-integrity + unambiguous stale citations only; deletion, rewrite and merges are proposal-only, because an auto-applied mistake there is unrecoverable. |

And add to *Hard invariants*:

> **No memory file is ever deleted or substantively rewritten autonomously.** The memory store
> has no VCS: unlike a doc edit on `main`, a bad memory edit cannot be reverted. Several files
> carry an explicit "RETIRED — keep for the durable lessons" note precisely because their
> component details are obsolete while their lessons are not; a tidy-minded deletion destroys
> the part worth keeping. Propose; never perform.

> **No auto-apply rests on an offloaded verdict alone.** Offload lanes (codex, NIM) find
> candidates; the reviewer re-verifies each code anchor against HEAD before writing. A lane has
> produced a fluent, confident and wrong mechanism conclusion here before.

> **An unreachable store is never a clean store.** If a review target cannot be read from the
> current runner, that is reported as unreviewed — never as passing, and never counted toward
> coverage. This is what stops a cloud routine from "reviewing" a workstation-local memory store
> by finding an empty directory and reporting success.

The manifest gate (`scripts/check-doc-manifest.mjs`) reconciles `docs/**/*.md` only, so the
memory row adds no gate obligation — but the row is what puts memory in scope at all.
