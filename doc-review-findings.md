# Doc-review findings — 2026-06-25 (run 6)

Run against main HEAD `19fb3c7` → pushed to `3bd1aa3` after applying 2 commits.

---

## FYI — auto-applied this run

Two commits pushed to main (discrete and revertible):

| Commit | Summary |
|---|---|
| `b094059` | `docs/HANDOFF.md` — version `0.30.3` → `0.30.5` (two releases since last HANDOFF update: v0.30.4 + v0.30.5) |
| `3bd1aa3` | `docs/NEW-MACHINE-SETUP.md` L119 — expected version `0.30.3` → `0.30.5` |

**New files added to ledger this run:** `docs/backlog-remediation-plan-of-record.md`, `spec/audit/audit-goals.md`, `spec/audit/dependency-map.md` — all clean (factual claims verified against code).

**Changed docs reviewed, no new issues found:**
- `CLAUDE.md` — conceptual rewording ("Right tool, not deterministic dogma" replacing "Deterministic by default"); no new stale factual claims.
- `docs/backlog.md` — large new content (open bugs + forward tracks); all design/aspirational, no stale facts.
- `docs/contract-authoring-determinism-design.md` — updated to match CLAUDE.md "Right tool" language; consistent.
- `docs/glossary-ids.md` — new INV-CK/INV-O1/INV-O2/INV-O3 entries; all four file paths verified to exist.
- `spec/audit/dependency-map.md` — `git_history.json` added as downstream; verified against `dependencyMap.ts:71`.

**Carried from previous runs (Ethan-approved, not yet applied — instruction files):**
CLAUDE-4, CLAUDE-8, CLAUDE-9, CLAUDE-10, AGENTS-1, AGENTS-2 remain open pending Ethan's approval.

**Carried design decisions:** D-1, D-2, D-4 remain open.

---

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)

- [CLAUDE-4] `CLAUDE.md` remediate-code state machine diagram — includes `documenting` state (`pending → planning → documenting → implementing → closing → complete`) but that phase was dissolved. Current states from `src/remediate/state/store.ts` KNOWN_STATUSES: `pending, planning, waiting_for_clarification, implementing, triage, waiting_for_triage, closing, complete`. Proposed: remove `documenting` from the diagram and update the arrow flow accordingly.

- [CLAUDE-8] `CLAUDE.md` Release & publish — "Triggered by GitHub Release tag `audit-code-v*`, `remediate-code-v*`, or `shared-v*`" is wrong. `.github/workflows/publish-package.yml` (lines 38–41) checks `startsWith(github.ref_name, 'v')` — plain `vX.Y.Z` tags only; no per-package tag patterns. Proposed: replace with "plain `vX.Y.Z` tags".

- [CLAUDE-9] `CLAUDE.md` Release & publish — "CI: `npm ci` → build shared → `verify:release` → publish" has no "build shared" step (single-package repo). Proposed: remove "build shared →" from the CI description.

- [CLAUDE-10] `CLAUDE.md` Conventions — end-of-sprint cleanup step (1) says `npm run build -w @audit-tools/shared && npm run build && npm run check`; no `@audit-tools/shared` workspace exists in this single-package repo. Proposed: replace with `npm run build && npm run check`.

- [AGENTS-1] `AGENTS.audit.md` line 1 — `[CLAUDE.md](../../CLAUDE.md)` is a broken relative link. File lives at repo root; `../../CLAUDE.md` resolves two directories above the repo root (does not find `CLAUDE.md`). `AGENTS.md` (also at root) correctly uses `[CLAUDE.md](CLAUDE.md)`. Proposed: `../../CLAUDE.md` → `CLAUDE.md`.

- [AGENTS-2] `AGENTS.remediate.md` line 1 — same broken `../../CLAUDE.md` link as AGENTS-1. Proposed: `../../CLAUDE.md` → `CLAUDE.md`.

### Design decisions for you

- [D-1] `docs/NEW-MACHINE-SETUP.md` L42 — `"git fetch audit-tools slice-2b-wip  # the in-flight branch (see step 5)"` — no step 5 exists (doc has sections 0–4 only); HANDOFF.md says "In flight: nothing"; `slice-2b-wip` branch exists on remote but is 479 commits behind main (diverged v0.27.x era). Remove these lines? Or is there active in-flight work that should replace them?

- [D-2] `docs/NEW-MACHINE-SETUP.md` intro box — `"A Linux new machine is the ideal place to fix the in-flight slice-2b bug — see docs/HANDOFF.md ⚠️ block"` — no ⚠️ block in HANDOFF.md (says "In flight: nothing"). The box describes a Linux-specific in-flight bug; if slice-2b shipped, should this OS note be updated or removed?

- [D-4] `README.audit.md` Key Docs — `docs/history.md` referenced but file doesn't exist (not at `docs/history.md` or `docs/audit-pkg/history.md`). Remove the reference, or create the file?
<!-- DOC-REVIEW-OPEN:END -->
