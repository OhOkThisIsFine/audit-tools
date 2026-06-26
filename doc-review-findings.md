# Doc-review findings — 2026-06-26 (run 7)

Run against main HEAD `b91b12e` → pushed to `87768bc` after applying 2 commits.

---

## FYI — auto-applied this run

Two commits pushed to main (discrete and revertible):

| Commit | Summary |
|---|---|
| `196b6a7` | `docs/backlog.md` — two broken relative links to files moved from `docs/` to `spec/`: `cross-provider-quota-matrix.md` and `host-validation.md` |
| `87768bc` | `docs/quota-dispatch-design.md` — broken relative link to `cross-provider-quota-matrix.md` (moved to `spec/`) + removed stale `[[claude-quota-credential-resolution]]` wiki-ref (doc deleted, content folded into cross-provider-quota-matrix.md) |

**All previously-open items resolved this run:**
- CLAUDE-4, CLAUDE-8, CLAUDE-9, CLAUDE-10 — applied in `b91b12e` ✓
- AGENTS-1, AGENTS-2 — applied in `b91b12e` ✓
- D-1, D-2 — `docs/NEW-MACHINE-SETUP.md` deleted → dissolved ✓
- D-4 — `README.audit.md` deleted → dissolved ✓

**Docs reviewed, no new issues beyond open items below:**
- `docs/documentation-philosophy.md` — new, clean (pure philosophy, no code anchors)
- `docs/end-of-sprint-report-template.md` — new, clean (template structure only)
- `docs/backlog-remediation-design.md` — new design spec; seam contracts + verified invariants; no misrepresented current-state claims
- `docs/glossary-ids.md` — INV-SOO added; `ownershipScheduler.ts` + `ownershipRegistry.ts` both verified to exist ✓
- `CLAUDE.md`, `AGENTS.audit.md`, `AGENTS.remediate.md` — all previous fixes confirmed applied; verified clean except AF-1 below
- `README.md` — new audit/remediate product sections; consistent with code ✓
- `docs/HANDOFF.md` — "In flight: nothing" accurate; open items D-5 + D-6 below
- `docs/backlog.md` — broken links fixed; new items are design/aspirational ✓
- `spec/` moved files — org-level move from `docs/`; content clean

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

- [AF-1] `AGENTS.remediate.md` line 14 — "When developing inside the `remediator-lambda` repository itself, prefer `node remediate-code.mjs`..." — `remediator-lambda` is a stale product name; repo/package is `audit-tools`. Proposed: replace `remediator-lambda` with `audit-tools`.

### Design decisions for you

- [D-5] `docs/HANDOFF.md` — version string "Live: `audit-tools@0.30.11`" is stale (package.json = `0.30.12`). Per updated doc-review guidelines, version/status strings in prose docs are status-noise to escalate, not auto-bump. Question: de-status this (derive from package.json or drop the pinned version), or is HANDOFF the one doc that should still carry a manually-maintained current-version string?

- [D-6] `docs/HANDOFF.md` — "Last landed (2026-06-26, shipped in 0.30.11):" (12 lines of implementation detail) and "Previously shipped (in npm history): 0.30.10 … 0.30.9 …" are backward-looking sections in a doc whose philosophy mandates "immediate-next-only; NOT a changelog." Should these be stripped (leaving only Live/In-flight/Next/Release/Trap), moved to project memory, or is "last landed" context acceptable for a new machine picking up?

- [D-7] `docs/documentation-philosophy.md` line 27 — the "design / concept docs" home row reads: `` `docs/*-design.md`, glossary, host-validation, quota/cross-provider `` as illustrative examples. `host-validation.md` and `cross-provider-quota-matrix.md` moved to `spec/`, and `audit-workflow-design.md`/`contract-authoring-determinism-design.md`/`remediation-workflow-design.md` also moved to `spec/`, so the `docs/*-design.md` glob no longer covers those. The philosophy doc does not mention `spec/` as a home. Question: update the examples to reflect the `docs/` (guides + living docs) vs `spec/` (specs + research) split, or remove the file-pattern examples entirely since they drift with moves?
<!-- DOC-REVIEW-OPEN:END -->
