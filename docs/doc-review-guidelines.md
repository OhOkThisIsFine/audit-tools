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

## What a pass covers (owner, 2026-08-27 — PH-08 accepted for review, refused for the closeout)

A pass is **not** the whole corpus. It covers the documents that CHANGED since their last ledger
stamp, their DECLARED DEPENDENTS, and a PERIODIC SWEEP that reaches everything else on a stated
cadence so nothing goes permanently unexamined. This is the project's own *scale the process to the
work* conviction applied to its own docs, and it is the shape the scope ledger already supports —
`scripts/nightly/scope-ledger.mjs` records a per-document evidence window, so an item with no entry
is reviewed cold rather than silently counted as covered. What must not happen is a pass that quietly
narrows and reports full coverage; coverage is read from the ledger file, never from prose.

The other half of PH-08 was REFUSED. The end-of-sprint closeout does not scale and has no
lightweight variant: it runs whole, every sprint. The steps a lightweight checkpoint would drop —
rewalking the transcript for friction, reading the whole stretch diff, routing every durable fact —
are precisely the ones that catch things, and they caught a masked push failure and a stale decision
queue on the lap this was decided.

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
   status-noise), are they factually true against code, and does each one still **earn its
   length**? This is the item-level pass below. Its condensation half runs **every pass**, never
   only when a file is near its size budget (*Entry-level condensation*, below).
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

## Entry-level condensation — every run, and NOT gated on file size

The size budget (`check:backlog-budget`) is a **backstop, not a trigger**. Waiting for a file to
approach its ceiling before condensing gets the incentive exactly backwards: at the ceiling every
new entry must be paid for by shrinking another *right then*, so the pressure falls on whichever
entry is easiest to shorten rather than on whichever has least value — which is how mechanism gets
trimmed out of entries that still need it. So condensation is part of the **normal** per-doc pass,
run against every in-scope doc regardless of how much room its file has left.

Hunt for, on every run:

- **Obsolete entries** — the work shipped, the question was answered, the tool was retired, the
  premise was refuted. This is *Shipped-entry deletion* above, applied beyond the backlog: any
  entry whose reason to exist has lapsed. Code-proven → auto-apply; anything else → escalate.
- **Accreted post-mortem narrative** — the growth driver named in the budget gate's own rationale.
  An entry that retells *how a defect was found* where it needs only the mechanism and the open
  property. The story belongs in `git log` or a `docs/reviews/` record; propose the trim and quote
  what would be cut.
- **Repetition inside one doc** — the same constraint restated in two entries, or an entry
  re-explaining a rule the doc already states once. Keep the clearest statement, point at it from
  the other.
- **Superseded halves** — an entry carrying both a decided answer and the deliberation it
  replaced. The deliberation goes; a REJECTED option stays only when naming it prevents the
  proposal being raised again.
- **Shipped-status preambles** — "X SHIPPED (with A, B, C …)" ahead of the still-open remainder.
  Reduce to a pointer at the mechanism record and keep the remainder.

**Dispositions are unchanged, and that is the safety surface.** Deleting a code-proven shipped
entry is factual → auto-apply. **Every judgment about whether prose is redundant or over-long is a
design-decision → escalate**, quoting the entry and the proposed shorter form, so the owner
compares them directly. The routine never silently rewrites an entry it merely finds wordy —
brevity is not a licence to drop the load-bearing half, and *pruning aggressively is the wrong
failure mode*: a condensed entry that has lost its mechanism is worse than a long one.

Report these under a **"Entry-level condensation"** heading in the findings file, with the file's
current size and its ceiling stated beside them — as CONTEXT for the owner, never as the reason
the proposal was raised.

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
| **backlog** | `docs/backlog.md`, `docs/backlog/open-bugs.md`, `docs/backlog/minor-bugs.md`, `docs/backlog/forward-tracks.md`, `docs/backlog/deferred.md`, `docs/backlog/durable-traps.md` | Shipped-detection (see *Shipped-entry deletion* below — a fully-shipped entry is **deleted outright**, never kept as a `SHIPPED`/`FIXED`/`DONE` marker; a partial entry is **trimmed to its open remainder**); dedup near-identical raw items; A→B draft (below). Durable-traps section is **reference** — only flag a trap proven fixed-in-tooling. | shipped-removal & dedup → yes; A→B → escalate |
| **handoff (sequencing view)** | `docs/HANDOFF.md` | Current published state + immediate next only (sanctioned per the philosophy's HANDOFF row). The roadmap block is generated from `▶`-pinned backlog entries; the live nightly block is generated from the persisted queue + decision ledger and must render no visible nightly text when the queue is empty. Never hand-edit either generated block. Flag **changelog creep** and per-item specs duplicated from their authoritative backlog/queue source; verify hand-written current state against code and clear stale state with proof. | hand-written state → yes; generated blocks → generator only |
| **design / concept (`spec/`)** | `spec/**/*.md` (the normative design corpus — workflow designs, contracts, goals docs; routed by pattern, so a new spec is registered the moment it lands. A `*.generated.md` sibling is NOT part of that corpus — see the check column) | Claims vs code (drift); flag current-state / changelog creep (durable design only). A `> **Status:** <type-declaration>` preamble identifying the kind of design artifact is permitted; a dated/versioned status string in it is still status-noise → escalate. The goals docs and the `spec/audit/*` contracts are **normative** — see *Normative goals docs* above and the constitutional-doc refusal in `src/shared/constitutionalDocPaths.ts`: a change to one is a design-decision → escalate. A `spec/**/*.generated.md` file is a whole-file generator render (its banner names the generator) — never hand-edit it; a stale claim there is a stale SOURCE, fixed by editing the source and re-running the generator, and its `check:` gate refuses the commit otherwise. | factual-stale → yes (except the constitutional subset — escalate-only; `*.generated.md` — generator only) |
| **excluded** | `docs/doc-review-guidelines.md` (this spec — excluded from its own review), `docs/reviews/*-<date>.md` (dated review / plan / diagnosis / dogfood records — excluded BY CONSTRUCTION. Each is a one-off record of what was decided on a day, never a timeless concept; the durable outcome lives in `spec/`, the backlog, or project memory. This pattern replaced a 21.5k-character exhaustive list that grew every lap), `.audit-tools/nightly/proposals/**/*.md` (nightly leg-3 proposal records — the full analysis behind an escalated item (recurrence evidence, proposed mechanism, false-positive surface). TRACKED so a proposal outlives the machine that produced it, but excluded BY CONSTRUCTION for the same reason as a dated review: each is a one-off record of a proposition as it stood that night, never a timeless concept. They deliberately cite paths that do not exist — a file the proposal proposes CREATING, or one deleted since — so reviewing them for staleness, or citation-checking them, would be checking a historical record against a present tree. Accepted outcomes land in code, `spec/`, the backlog or memory; the record stays as provenance), `.audit-tools/audit-report.md` (runtime run-artifact — an audit-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `.audit-tools/remediation-report.md` (runtime run-artifact — a remediate-code run output per `CLAUDE.md`'s Artifact layout; tracked but never reviewed), `tests/audit/fixtures/simple-app/README.md` (test-fixture content — a sample-app README, its own concern, not a project doc) | — | — |
| **generated host assets** | `.agent/skills/audit-code/SKILL.md`, `.agent/skills/remediate-code/SKILL.md`, `.github/agents/auditor.agent.md`, `.github/agents/remediator.agent.md`, `.github/copilot-instructions.md`, `.github/prompts/audit-code.prompt.md`, `.github/prompts/remediate-code.prompt.md` | ONE canonical body rendered per-IDE (`CLAUDE.md` B5); **not hand-edited** — governed by renderer drift tests (`tests/audit/host-asset-renderer-drift.test.ts`, `tests/remediate/host-bootstrap-descriptors-remediate.test.ts`, `tests/remediate/install-repo-assets.test.ts`). Review the canonical source, not the generated copy; a diff = a drift-test/renderer gap, not a doc edit. | **No — renderer-owned.** |
| **canonical loader bodies** | `skills/audit-code/SKILL.md`, `skills/audit-code/audit-code.prompt.md`, `skills/remediate-code/SKILL.md`, `skills/remediate-code/remediate-code.prompt.md` | HAND-AUTHORED sources, not generated output — the arrow points OUT of `skills/`: the renderer drift tests read these as the canonical body and assert the `.agent/**` and `.github/**` copies equal a fresh render of them, and `scripts/audit/postinstall.mjs` copies one outward as its literal prompt source. Nothing writes into `skills/`. Review them like any other doc — in particular the CLI invocations and flag literals they carry, which no other reviewer checks. Run `npm test` after editing (the drift tests will fail until the generated copies are re-rendered). | Yes — with the renderer drift tests re-run. |
| **generated scheduler prompt** | `docs/nightly-routine-prompt.md` | WHOLE-FILE GENERATED from `docs/nightly-routine.md` (cross-leg routine) + `docs/doc-review-guidelines.md` (leg-1 rubric) by `scripts/check-nightly-routine-prompt.mjs`. Never hand-edit or resolve a conflict in the target; edit the owning source and regenerate. `check:nightly-routine-prompt` gates byte parity plus its `package.json` check/release wiring in `verify:checks` and at commit. | **No — generator-owned.** |
| **generated decision inbox** | `docs/nightly-inbox.md` | GENERATED by `scripts/nightly/render-inbox.mjs` from `.audit-tools/nightly/open-items.json` — the nightly routine's answering surface, and the ONE tracked doc that is deliberately current-state rather than timeless. The owner answers by ticking a checkbox; `scripts/nightly/ingest-answers.mjs` reads the ticks into `.claude/nightly-decisions.json` and re-renders, so answered items drop out on their own. Everything except the ticked boxes and the `notes` blocks is rewritten on each run — review the item CONTENT at its source (`.audit-tools/nightly/open-items.json`), never by hand-editing this file. Its status-noise is the point: it is a work queue, the same sanctioned exception as `docs/HANDOFF.md`. | **No — generator-owned** (and the owner's answers are the only hand-written part). |
| **meta-tooling / dev-workflow** | `.claude/skills/design-check/SKILL.md`, `.claude/skills/disambiguate-backlog/SKILL.md`, `.claude/skills/ship/SKILL.md`, `.claude/skills/start-lap/SKILL.md`, `docs/nightly-routine.md` | Standalone dev-workflow how-to and scheduler-prompt SOURCE; do the documented commands/paths still resolve. Changes to `docs/nightly-routine.md` must regenerate the generated scheduler prompt. | factual-stale → yes |
| **package READMEs (non-`docs/`)** | `src/audit/README.md`, `examples/README.md` | Claims vs code; do documented commands, paths, provider-neutral host-workload contracts, and result-ingestion boundaries still resolve. These docs must not reintroduce a provider registry, execution adapter, or quota surface. | factual-stale → yes |

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
