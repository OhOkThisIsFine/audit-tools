# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
None this run — no CLAUDE.md/AGENTS.md findings surfaced (an independent adversary re-check of both
files also came back clean).

### Design decisions for you
- [DD-1] `spec/self-scaling-pipeline-design.md` — still open from a prior run (DD-2), now with a second
  instance found: despite the doc's own preamble "Durable conceptual design; no dated status here," it
  still narrates history in changelog-creep style — (a) lines ~19-21: "...it has since been softened...
  shipped (`docs/backlog.md` doc-review D-68)"; (b) NEW, line ~46: "...(`interpretLeanLightReviewVerdict`,
  **now in** `src/remediate/riskSignal.ts`)" — the latter is close to `documentation-philosophy.md`'s own
  cited example of the forbidden pattern ("now in `dispatch.ts`"). Both facts are true; only the framing
  is the issue. Rewrite both timelessly (state the current shape directly, drop the tried/moved/shipped
  narrative), or is this history load-bearing context worth keeping?
- [DD-2] `spec/multi-ide-concurrent-runs-design.md` — still open from a prior run (DD-3), now sharper:
  line ~179-180's "concrete values set in slice 2" paired with `(taskLeaseMs, heartbeatMs)` is stale on
  two fronts. `taskLeaseMs` shipped (`AUDIT_TASK_CLAIM_LEASE_MS`, `src/audit/cli/dispatch.ts:135`), but
  `heartbeatMs` has zero occurrences anywhere in `src/` — `withClaimHeartbeat` is wired only to the
  short-lived mutexes, never to the long-lived task claims — directly contradicted by the doc's own next
  paragraph ("no live heartbeat" for those claims). Correction to the prior run's evidence: "slice 2" is
  not a self-scaling-pipeline-design.md reference (that doc has no "slice" numbering at all) — it traces
  to `docs/backlog.md`/`docs/HANDOFF.md`'s own D-66/67 slice numbering for this same multi-IDE feature,
  whose actual slice-2 content ("verified not worth building a shared reducer") doesn't match "concrete
  values set" either. Drop the "pair"/`heartbeatMs`/"slice 2" framing to match the doc's own settled
  reality (lease-only, no heartbeat, backstopped by merge-time ownership), or is heartbeat extension to
  long-lived claims still intended future work that needs a real tracking home?
- [DD-3] `spec/host-validation.md` — still open from a prior run (DD-4), re-confirmed: only has GUI-host
  live-dispatch checklist rows for `/audit-code`. `verify:remediate-hosts`
  (`scripts/remediate/verify-hosts.mjs`) exists, is wired into `verify:release`, and mirrors
  `verify:hosts` exactly — remediate-code targets the identical GUI-host set (Antigravity/OpenCode/VS
  Code). Add a sibling remediate-code checklist section, or explicitly scope the doc's title/intro to
  audit-code-only?
- [DD-4] `docs/backlog.md` — still open from a prior run (DD-5), re-confirmed: the "ad-hoc Agent fan-out
  has no per-agent ledger" sliver appears both folded into the "Tool-prescribed host Agent fan-out is
  quota-INVISIBLE" entry and as sub-bullet (b) of an older "Untracked-exclusion scope rule" entry, which
  additionally names "recon/review/compaction" as fan-out sites. "compaction" as a fan-out site is still
  not evidenced anywhere in `src/` (zero grep hits) — plausibly describes host/conversational behavior
  rather than a coded dispatch site, but remains unverifiable against any symbol. Dedup the two entries
  (narrow, don't merge wholesale — the older one has no unique remainder beyond "compaction"), and
  separately judge whether "compaction" is accurate or should be dropped from the parenthetical.
- [DD-5] `docs/backlog.md` — still open from a prior run (DD-6), re-confirmed and now also present in the
  entry that supplanted "top" position: the 2026-07-12 friction-walk entry's items use inline
  `(category, severity)` tags with no `[[memory-tag]]`, while other items in the same section (and this
  entry's own now-item-(1)) carry both an inline tag and a `[[memory-tag]]`. Plausible explanation: a
  `[[memory-tag]]` only appears where a durable memory concept was actually captured for that specific
  item, making the "inconsistency" by-design rather than a bug. Either state that rule explicitly in the
  friction-walk-entry template (the preamble two lines above), or treat as a real formatting gap needing
  a fix?
- [DD-6] `spec/audit-workflow-design.md` — NEW this run: lines ~85-87 (Gate 2 section) claim "Cap is high
  (exact value TBD)... Generalize the aggregation already present in `buildFileDisposition` for
  vcs-ignored files above 200." All three sub-claims are now wrong against the shipped code: the
  aggregation is `buildExcludedSummary()` in `src/audit/orchestrator/intentCheckpointExecutor.ts` — NOT
  in `buildFileDisposition` (whose own code comment explicitly says it deliberately does NOT aggregate,
  since downstream consumers treat a missing entry as included); it aggregates ALL excluded files
  generically, not specifically "vcs-ignored"; and it has NO cap/threshold at all (no "200", no size
  guard). Correcting this requires more than a token swap (deciding whether to describe the no-cap
  reality, name the different file, or trim the aspirational cap language), so it's surfaced rather than
  auto-applied. Restate to name `buildExcludedSummary`/`intentCheckpointExecutor.ts` and drop the stale
  "vcs-ignored... above 200"/"Cap TBD" language, or is a cap still intended future work?
- [DD-7] `.claude/skills/ship/SKILL.md` — NEW this run (philosophy-conformance / doc-shape, both facts
  verified true, only the framing is at issue): two instances of changelog-creep phrasing — line ~17
  "CI **now** runs the full suite sharded across parallel jobs (~2× faster) as the real gate, so the
  local preflight is a quick fast-fail, not the full run" and line ~37 "`scripts/release-and-publish.mjs`
  **now** admits any branch whose HEAD already equals `origin/main` (`evaluateReleaseBranch()`)" — both
  narrate a past→present transition rather than stating current behavior timelessly, matching
  `documentation-philosophy.md`'s named forbidden pattern ("now in `dispatch.ts`"). Two independent
  reviewers called this borderline (a meta-tooling runbook, not a strict "concept doc," and the "now"
  carries load-bearing causal rationale) but concurred it should still surface per "when in doubt,
  escalate." Approve a mechanical word-drop (rephrase both sentences to state the current behavior
  directly), or is the historical framing intentional here?
- [DD-8] `docs/backlog.md` — NEW, low-confidence pattern flag (unverified this run, needs a dedicated
  pass, not an individual finding): several other entries follow the same "heavy shipped-narrative
  preamble + genuine open residual" shape that the shipped-entry-deletion rule targets, beyond the one
  entry trimmed this run. Candidates spotted but NOT verified against commit hashes: the "Abandoned-wave
  leases saturate the cold-start cap" entry (~line 63-74), "A2b unmatched-quota fallback" (~101-117), "A
  doc-review auto-apply / hook re-reverted a COMMITTED owner decision" (~151-161 — note its trap may
  belong in CLAUDE.md's Durable traps rather than backlog.md per the "durable rule worth keeping" clause),
  "Untracked-exclusion scope rule" (~168-192), "External shared-logic audit V1-V7 residuals" (~200-215),
  and the D-66/67 entries (~489-540). Worth a dedicated shipped-narrative trim sweep next run (or now, at
  your discretion) — flagging so it isn't lost, not asking you to adjudicate each one here.

### Doc-set condensation
- [CX-1] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` + `spec/audit/executor-catalog.md`
  — still open from prior runs, unchanged this run (all three docs independently re-verified accurate
  against current code, no new drift instance found): "which executor produces which artifact" is
  hand-maintained independently in two places (`executor-catalog.md`'s Produces column and
  `dependency-map.md`'s per-artifact rows) over the same `EXECUTOR_REGISTRY`/`ARTIFACT_DEPENDS_ON_MAP`
  source pair — a prior run already had to fix one live drift instance between them. Should this have
  exactly one home (fold one into the other), or is the duplication an acceptable, differently-shaped view
  (catalog = by-executor, map = by-artifact) worth keeping as-is?

Canonical-manifest check: `scripts/check-doc-manifest.mjs` re-run clean this pass — 18 tracked docs all
registered, no strays.
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run, scoped to everything changed since the last check (commit
`7a416cf7` → `428aed40`): 6 reviewer agents (remediate architecture; audit architecture; quota/dispatch;
policy/instruction/philosophy; package-docs + meta-tooling + READMEs; backlog.md + HANDOFF.md), each
examining every in-scope item in their cluster against live code, re-verifying every previously-open
escalation (DD-1 through DD-8, CX-1) from the last run, and running the existence/philosophy-conformance/
condensation smells. 6 independent adversary agents then re-checked every item (flagged AND "accurate")
from scratch — including two clusters (quota/dispatch; policy/instruction) whose reviewer found zero
findings, where the adversary independently re-derived 20-25 claims each rather than rubber-stamping a
clean pass.

Two items were contested between independent agents and resolved by convergence rather than a dedicated
Judge call (three of four independent judgments landed the same way in each case, satisfying the
"default to escalate on uncertainty" rule by there being none left):
- **Old DD-1** (`docs/backlog-remediation-design.md`'s "D8" cross-reference to `backlog.md`) — one
  reviewer called it still-open, but that reviewer's own adversary, a second reviewer, and that
  reviewer's adversary all independently concluded it's resolved: `backlog.md` carries the matching
  content in its Deferred/waiting section (just not the literal string "D8"), and forcing a foreign
  doc's internal id-label into `backlog.md` would itself be a drift-prone duplication the doc-shape
  rubric argues against. Closed, not carried forward.
- **Old DD-8** (`.claude/skills/ship/SKILL.md`'s CI-staging split vs. `project-philosophy.md` A6) —
  reviewer and two independent adversaries (across two different clusters) all confirmed it sits outside
  A6's scope (A6 is Part A, about the product's own audit/remediate review-depth dials; the ship skill's
  local-preflight-vs-CI split is a Part B dev-ops release-gate concern, not a forked review path of the
  product). Closed, not carried forward.

7 stale-factual-fixes landed on `main` in 3 discrete commits:

- `spec/remediate/remediation-goals.md` + `spec/audit/audit-goals.md` — fixed two broken/mislabeled
  cross-doc links: a display-text mismatch (`spec/audit-goals.md` label pointing at the real
  `spec/audit/audit-goals.md`) and a missing `../` that resolved to a nonexistent file.
- `spec/multi-ide-concurrent-runs-design.md` — the "Remaining" section's serial-phases bullet still
  described a `phase:<name>` per-phase claim scheme including a "document" phase; both are stale — the
  doc's own later Mechanism section (and the shipped code, `REMEDIATE_PHASE_NODE = "phase:main"`) show a
  single `phase:main` mutex over plan/triage/close, "document" having been dissolved (CLAUDE.md N-R13).
- `docs/HANDOFF.md` — deleted a pinned-date ("EXECUTED 2026-07-12") self-audit narrative block that the
  doc's own header forbids ("Per-lap shipped detail is not narrated here — changelog creep") and whose
  content duplicated `docs/backlog.md`; the one residual it named that wasn't tracked anywhere else (a
  dispatch-boundary "no scope-less dispatch" guard) was folded into `docs/backlog.md`'s matching entry in
  the same commit so it wasn't silently dropped.
- `docs/backlog.md` — trimmed the "Node 'no result file' → cascade" entry to its still-open residual
  (root cause + fix are code-proven shipped in `c60eb73f`/`aee3fc77`); deduped the 2026-07-12
  friction-walk entry's item (1), fully redundant with an existing Forward-tracks entry it already
  pointed to; fixed a dangling "`docs/HANDOFF.md` T5-3" pointer (no such anchor exists — retargeted to
  the actual "T5 forward tracks" bullet).

Green gate: `npm run build && npm run check && npm test` — 490 test files / 6422 tests, all green (12
skipped, expected gated e2es). `check:doc-manifest` also re-verified clean. Each change above landed as
one discrete, revertible commit on `main` (`e82131d`, `ecfa619`, `428aed4`).

## Also found, out of this routine's scope (code, not docs)

`src/shared/quota/coverage.ts`'s `renderUnestablishedQuotaNudge` still tells the host agent to consult
"`docs/cross-provider-quota-matrix.md`" — that path doesn't exist; the file lives at
`spec/cross-provider-quota-matrix.md`. A runtime string literal, not a `.md` doc claim, so out of this
routine's edit surface — re-confirmed still present, noting again for a future code fix.
