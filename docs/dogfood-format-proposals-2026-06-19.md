# Format proposals — dogfood notes 1, 2, 3 (2026-06-19)

> **Status: IMPLEMENTED + SHIPPED (2026-06-19).** Notes 1–3 were built on
> `resume-list-dogfood-fixes` per the "Decided (Ethan)" blocks below and merged to `main`
> (note 2 `0092405b`, note 1 `e88d1afa`, note 3 part A `264b36da` + part B `70d74a8d`). This
> doc is kept as the design record; the durable concepts live in `CLAUDE.md`, the status in
> `docs/backlog.md`. Each "Decided" block records Ethan's direction; the design above it matches.

---

## Note 1 — Lens-proposition markdown schema

### Current state
- `buildLensProposals` (`src/audit/orchestrator/intentCheckpointExecutor.ts:191`) emits
  `LensProposal { lens, action: "include"|"exclude", reason }` from deterministic
  heuristics (no LLM).
- `confirmIntentStep.ts:78` renders them as a loose prose list under "## Lens proposals",
  then a separate "## Lens catalog" (all 11 + one-line descriptions), then tells the host
  to *improvise* an `AskUserQuestion` (`confirmIntentStep.ts:192`).
- 11 lenses (`src/shared/types/lens.ts`); 4 mandatory (security, correctness, reliability,
  data_integrity — `lensSelection.ts`). Mandatory-ness is computed at render time, not
  carried on the proposal. Proposals are ephemeral (not in the checkpoint).

**Problem:** every part of the lens question — table shape, which lenses are locked, how
custom lenses are offered, the exact options — is left to host discretion, so it renders
differently each run (violates *enforce-in-tooling-not-host-discretion*).

### Proposal (finalized)
Two-stage proposition, then ONE canonical table the user sees. The whole proposal process
is invisible to the user — they see only the final table + a single "what to layer on top"
question.

**Stage 1 — deterministic first pass:** `buildLensProposals` produces an initial disposition
per canonical lens (the current heuristics).

**Stage 2 — LLM orchestrator review (invisible):** the host LLM reviews the deterministic
dispositions using its own judgment (with repo access if it wants to research), and may
**confirm or change** any disposition. It may also **add non-canonical lenses** it alone
decides would help this audit. None of this is surfaced as "deterministic said X, LLM said
Y" — the user sees only the final, merged dispositions. (Satisfies *LLM-always-in-the-loop*.)

**Structured row** (canonical + LLM-added lenses, uniform — the table does NOT distinguish
canonical from custom):

```
LensProposition {
  lens: string                  // canonical name OR an LLM-authored custom lens name
  disposition: "mandatory" | "recommend_include" | "recommend_exclude"   // exactly 3, no "available"
  reason: string
}
```

**Canonical render** (ALL lenses — canonical + any LLM-added — one table, glyphs):

```markdown
## Lens proposition

| Lens               | Disposition           | Why |
|--------------------|-----------------------|-----|
| security           | ● mandatory           | always audited |
| correctness        | ● mandatory           | always audited |
| reliability        | ● mandatory           | always audited |
| data_integrity     | ● mandatory           | always audited |
| architecture       | ✓ recommend include   | network-surface units + routes/ dir |
| config_deployment  | ✓ recommend include   | .env / *.yaml config detected |
| tests              | ✓ recommend include   | test units present |
| migration_safety   | ✓ recommend include   | (LLM-added) schema migration files detected |
| performance        | ✗ recommend exclude   | no hot-path / perf-sensitive units detected |
| observability      | ✗ recommend exclude   | no logging/metrics surface in scope |
| maintainability    | ✗ recommend exclude   | — |
| operability        | ✗ recommend exclude   | — |
```

**Host question — IDE-AGNOSTIC** (the tool defines the question CONTENT, never a
Claude-specific tool): the prompt instructs the host to ask the user, *in whatever native
way the host has*, which optional lenses to **layer on top** of the always-on mandatory set
(and whether to flip any recommend-include/exclude). Mandatory lenses are NOT re-confirmed.
The user may **describe or enter any number of additional lenses**. The result is written to
`intent_checkpoint.json` `lens_selection: { include, exclude }` (custom lenses → `include`).

### Decided (Ethan, 2026-06-19)
- Table lists **all** canonical lenses + their dispositions; LLM-added lenses appear in the
  same table, undistinguished. Use a **table with glyphs**.
- Dispositions are exactly **mandatory / recommend_include / recommend_exclude** — **no
  "available"**.
- **Deterministic first pass → LLM confirms/adjusts** (and may add non-canonical lenses);
  that process is **invisible** to the user (final table only).
- The user question asks only **what to layer on top** of mandatory (mandatory not mentioned);
  the user may add **any number** of custom lenses.
- **IDE-agnostic** — do NOT depend on Claude-native AskUserQuestion; the tool specifies the
  question content, the host poses it natively.

---

## Note 2 — Standardized per-finding display

### Current state
`renderAuditReportMarkdown` (`src/audit/reporting/synthesis.ts:436`) renders each finding as:
`### id — title`, then `- Severity / - Confidence / - Lens / - Category / [- Theme] /
- Files (path only) / - Summary / [- Grounding if ungrounded] / [- Evidence if present]`.

A Finding (`src/shared/types/finding.ts:101`) carries ~17 more fields; most are NEVER
rendered (`impact`, `likelihood`, `systemic`, `reproduction`, `related_findings`, the
`affected_files` line ranges/symbols). Unevenness comes from: presence-conditionals,
grounding shown ONLY when `ungrounded`, file lines dropped, and summaries that range
50–1340 chars rendered as one dense paragraph.

### Proposal (finalized)
A labelled **badge block** (keep `Severity: high` labels — NOT a terse `**HIGH**` line,
which risks confusion), a one-line lead, then a fixed-order body that shows only what a user
needs to **decide** — noisy data (a 12-file list, deep evidence) is summarized/trimmed, not
dumped. Same block format for refuted/quarantined findings.

**Before** (current):
```markdown
### ARC-f378135d — Module boundary leak between intake and dispatch
- Severity: high
- Confidence: medium
- Lens: architecture
- Category: coupling
- Files: src/remediate/intake.ts, src/remediate/steps/dispatch.ts, …(12 total)
- Summary: <1340 chars of dense prose in one line>
- Evidence:
  - …
```

**After** (finalized):
```markdown
### ARC-f378135d — Module boundary leak between intake and dispatch

Intake reaches into dispatch's worktree internals instead of going through the dispatch
contract.   ← one-line lead

- Severity: high
- Confidence: medium
- Lens: architecture
- Grounding: grounded
- Files: `src/remediate/intake.ts:42–78`, `src/remediate/steps/dispatch.ts:533` +10 more
- Details: <the full summary, wrapped as its own paragraph(s)>
- Evidence: 3 items (top: "…") — see audit-findings.json for the full list
```

Rules that kill the unevenness:
- **Labelled badge block**, fixed order, always the same labels: `Severity → Confidence →
  Lens → Grounding → [Systemic]`. Grounding **always** shown (`grounded` / `ungrounded —
  reason` / `refuted`), not only when ungrounded.
- **Decision-first, trim noise:** show the few files that matter (first N with line ranges)
  + a `+K more` count rather than a 12-path dump; summarize long evidence lists with a count
  + the top item, pointing to `audit-findings.json` for the rest. The JSON stays the full
  source of truth; the markdown is the scannable decision view.
- **One-line lead** (first sentence / title-level gist) before the block, every finding.
- **Fixed body order**, sections omitted only when genuinely absent — never reordered or
  relabelled. Elevate `Systemic` (and `Impact`/`Likelihood` when present) but only if they
  help the decision.
- **Long summary** → lead line + `Details:` paragraph, so the block scans at any length.
- **Refuted/quarantined** findings use the **same** block format (in their existing section).

### Decided (Ethan, 2026-06-19)
- **Badge block with explicit labels** ("Severity: high"), NOT a `**HIGH**` badge line.
- Fixed-order, consistent; **show only decision-necessary info** — don't dump a 12-file list
  or deep evidence unless the user asks (trim with a `+N more` / count, JSON has the full set).
- Keep the **one-line lead**.
- **Same format** for refuted/quarantined findings.

---

## Note 3 — Resolve ambiguity up-front, never defer mid-run

### Current state (this one is more behavioral than format)
- Clarifications are collected only at **intake** (`intakeResolver.ts:405`, mostly
  non-blocking `open_questions`) and **after planning** (`waiting_for_clarification`,
  `nextStep.ts:2316`).
- The 7 clarification categories exist (`scope_of_fix`, `intent_vs_symptom`,
  `issue_appropriateness`, … — `state/types.ts:104`) but **no code emits a clarification
  mid-run**. A worker that hits scoping/judgment ambiguity just reports `blocked` →
  triage (retry / ignore / halt). So a batch of architecture findings with scoping
  ambiguity falls out of scope as blocked-then-deferred, never asked as a question.

**Root cause:** there is no up-front pass that classifies each finding for scoping/judgment
ambiguity *before* planning; the clarification gate sits *after* planning.

### Proposal (finalized)
Two complementary pieces:

**A. Up-front ambiguity pass (deterministic → LLM review), before planning:**
1. **Deterministic heuristics first** scan every intended finding for scoping/judgment
   ambiguity and classify into the existing 7 categories (e.g. design/architecture lens +
   unbounded file scope → `scope_of_fix`; "is this real" → `issue_appropriateness`;
   symptom-vs-root → `intent_vs_symptom`).
2. **LLM reviews the deterministic results** with **repo access** (it can research the code
   to confirm/dismiss/add an ambiguity), producing the final set.
3. **Flag all** detected ambiguities, batch into ONE clarification round, and **hard-gate
   the transition into planning** — EXCEPT the user may **explicitly defer** specific items
   (the deferral is the user's call, never the LLM's unilateral decision). Resolved + the
   user-deferred set are recorded so the plan is built against decided scope.

**B. Mid-run escape hatch — a worker may request clarification (not just block):**
When unexpected ambiguity surfaces during implement, a worker can **explicitly report
`needs_clarification`** (a new worker outcome) instead of `blocked`. That routes the item to
a clarification round (surfaced to the user as a real scoping question) rather than to
`triage`'s retry/ignore/halt. `blocked → triage` is then reserved for genuine execution
failures (infra, verify), not un-asked scoping questions.

Result: the whole set is decided up front in one pass; anything that still slips through gets
asked as a clarification mid-run, never silently dropped to triage.

### Decided (Ethan, 2026-06-19)
- **Flag all + hard-ish gate**, but allow **explicit user deferral** of specific items (the
  user defers, never the LLM unilaterally).
- Detection = **deterministic heuristics first, then LLM review** of those results, with
  **codebase access** for the LLM to research.
- Add a **mid-run `needs_clarification` worker outcome** → clarification round, instead of
  the current `blocked → triage` for un-asked scoping/judgment questions.
