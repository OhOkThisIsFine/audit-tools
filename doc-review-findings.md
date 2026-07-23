# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
(none open)

### Design decisions for you
- [DD-8] `docs/backlog.md` — "Unify the full rolling-dispatch lifecycle shell across audit + remediate
  (doc-review D-66/D-67/C-7)..." (currently ~46 lines). Re-verified tonight against HEAD `e8d1e9a`
  (byte-identical since the last two nights' checks — confirmed programmatically, not just eyeballed):
  still opens with shipped-status narrative ("Slice-1 SHIPPED... slice-2 VERIFIED not worth building...")
  before reaching the genuinely open slice-3 heartbeat work. Should this be trimmed to just the slice-3
  open work (relocating the architecture recap to a spec doc, e.g. `spec/multi-ide-concurrent-runs-design.md`,
  which already owns OD3), or is the recap load-bearing enough to keep as-is (it explains why full
  unification was rejected, preventing re-litigation)?

### Doc-set condensation
(none open)
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied / resolved this run (checkpoint `eba802c` → `e8d1e9a`, 59 commits)

58 commits landed on `main` since last night's ledger stamp (v0.34.13 through v0.34.16 shipped; the
2026-07-22 high-severity dogfood remediation run completed 8/8 nodes; a dogfood-completion docs commit).
In-scope-adjacent files changed: `CLAUDE.md`, `docs/HANDOFF.md`, `docs/backlog.md`,
`docs/end-of-sprint-report-template.md`, `docs/glossary-ids.md`, `docs/project-philosophy.md`,
`.claude/skills/start-lap/SKILL.md`, `spec/audit-workflow-design.md`,
`spec/audit/dispatch-admission-control.md`, `spec/backend-identity-axes.md`,
`spec/remediate/remediation-goals.md`, `spec/unified-dispatch-worker-model.md`, plus new
`docs/reviews/*.md` artifacts (excluded, dated records, already registered in the manifest's excluded row).

**9 of 10 items open from last night's findings are now resolved** — verified independently by both
the reviewer pass and an adversary subagent (no contested items, no judge pass needed):

- **CLAUDE-5** (proposed proxy-overlay wording fix) — already applied verbatim in current `CLAUDE.md`.
- **DD-2** (`spec/unified-dispatch-worker-model.md` repair-proxy section) — substantially rewritten
  around the proxy-overlay model this window: section renamed, discovery feeder now `/v1/models` +
  `/model/info`, repair function declared gone throughout. `auditorSources.ts` confirmed rejecting a
  declared `repair_proxy` key at parse ("repair_proxy is retired — declare a proxy block instead").
- **DD-6** (`spec/audit-workflow-design.md` "always-on LLM estimate review" clause) — now reads "both
  frozen once derived"; LLM clause dropped.
- **DD-7** (`spec/remediate/remediation-goals.md` missing `quota_paused` mention) — gained a paragraph
  pointing at `spec/remediation-workflow-design.md`; `buildQuotaPausedStep`/`step_kind: "quota_paused"`
  confirmed live in `src/remediate/steps/nextStep.ts`.
- **DD-9** (`docs/backlog-remediation-design.md` overstated `intentCheckpointGate` wiring) — resolved
  via a direct owner decision, not a doc edit: a new `docs/backlog.md` entry ("DECIDED (owner 2026-07-22,
  from doc-review DD-9): wire the semantic-equivalence gate into the intent-checkpoint staleness path…")
  specs the actual wiring as open work. `backlog-remediation-design.md` itself is unchanged and
  self-describes as architecture-of-record prose, not a shipped-status claim, so no further edit needed
  there.
- **DD-10** (`docs/end-of-sprint-report-template.md` friction taxonomy mismatch) — the "Friction this
  sprint" section now uses the single-sourced `FRICTION_CATEGORIES` vocabulary
  (`ambiguous_direction`/`tool_should_decide`/`inefficient_feeding`) verbatim, matching
  `src/shared/friction/frictionRecord.ts`.
- **DD-12 & DD-13** (`spec/audit/dispatch-admission-control.md` dead `resolvePoolBudget()` +
  `resource_key` partiality) — the "Deriving the per-pool token budget" section was rewritten around
  `windowConstraintsFor`/`WindowBudget`/multi-constraint admission (`resolvePoolBudget` confirmed zero
  hits in `src/`), and the Legibility section now explicitly documents the `resource_key` partiality gap
  with a pointer to `docs/backlog.md`'s tracked follow-up.
- **DD-15** (`spec/backend-identity-axes.md` version-pinned status-noise) — both `v0.33.11` pins
  de-statused to version-agnostic phrasing ("since fixed" / dropped).
- **CX-3** (README/project-philosophy duplication) — `docs/project-philosophy.md` gained the proposed
  note pointing at README's condensed public-facing restatement.

**Still open: DD-8** (see block above) — untouched, byte-identical.

**New stale-factual-fix found + applied tonight:** `docs/HANDOFF.md`'s IMMEDIATE NEXT item 3 claimed
"(The doc-review queue is EMPTY as of 2026-07-22.)" — false, since DD-8 was confirmed still open both
last night and tonight. Fixed to name DD-8 and point at the `doc-review` branch.

Full green gate (`npm run build && npm run check && npm test`) passed before push — 518 passed | 5
skipped test files, 7194 passed | 12 skipped tests, exit 0, no failures. One discrete commit
(`doc-review: fix HANDOFF.md's stale "doc-review queue is EMPTY" claim`), pushed to `main`
(`e8d1e9a`).
