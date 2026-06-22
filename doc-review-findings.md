# Doc-review findings — 2026-06-22 (run 3)

Run against main HEAD `9f9727b` → pushed to `96c39a5` after applying 2 commits.

---

## FYI — auto-applied this run

Two commits pushed to main (each discrete and revertible):

| Commit | Summary |
|---|---|
| `a862869` | `docs/HANDOFF.md` — update live version `0.29.3` → `0.30.0`; drop stale 0.29.x history parenthetical |
| `96c39a5` | `docs/NEW-MACHINE-SETUP.md` — update expected CLI version `# expect 0.28.11` → `# expect 0.30.0` |

**Resolved from previous run (committed by Ethan in `e0c479e`, dropped from open list):**
CLAUDE-1 (layout table), CLAUDE-2 (workspace commands), CLAUDE-3 (audit src paths), CLAUDE-5 (phases list),
CLAUDE-6 (dispatch symbols), CLAUDE-7 (waveScheduler), CLAUDE-11 (abbreviated paths), CLAUDE-12 (test paths).

**Reviewer error corrected:** Run 2 incorrectly marked AGENTS-1/AGENTS-2 as resolved. Both files exist at repo root and both broken links are confirmed by adversary + judge — items remain open.

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

- [D-1] `docs/NEW-MACHINE-SETUP.md` L42 — `"git fetch audit-tools slice-2b-wip  # the in-flight branch (see step 5)"` — no step 5 exists (doc has sections 0–4 only); HANDOFF.md says "In flight: nothing"; `slice-2b-wip` branch exists on remote but appears stale. Remove these lines? Or is there active in-flight work that should replace them?

- [D-2] `docs/NEW-MACHINE-SETUP.md` intro box L32 — `"see docs/HANDOFF.md ⚠️ block"` — no ⚠️ block in HANDOFF.md. The box describes a Linux-specific in-flight bug that appears to have shipped in v0.28.11. Should the intro box be updated or removed?

- [D-4] `README.audit.md` Key Docs — `docs/history.md` referenced but file doesn't exist (not at `docs/history.md` or `docs/audit-pkg/history.md`). Remove the reference, or create the file?
<!-- DOC-REVIEW-OPEN:END -->
