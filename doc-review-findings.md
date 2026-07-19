# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-5] `CLAUDE.md` ~line 108 — the `claude-worker` description says it spawns `claude -p`
  "through a repair-proxy overlay onto a free backend" and cites `spec/unified-dispatch-worker-model.md`
  for "requiring repair-proxy when a node needs file access." Verified (2 independent adversary passes):
  "repair-proxy" was genuinely RETIRED 2026-07-18 (commit `4441703`, `docs/reviews/litellm-swap-plan-2026-07-18.md`),
  not renamed — the old repair-proxy validated/repaired malformed tool calls and exposed a `GET /registry`
  discovery shape; the new generic `proxy` block (LiteLLM-backed) is a plain passthrough with none of that.
  `src/shared/providers/auditorSources.ts` now explicitly rejects a declared `repair_proxy` key
  ("repair_proxy is retired — declare a proxy block instead"). CLAUDE.md's providers paragraph was last
  touched the day *before* the retirement commit and never caught up. Proposed: replace "spawns `claude -p`
  through a repair-proxy overlay onto a free backend" → "spawns `claude -p` through the declared `proxy`
  overlay (LiteLLM-backed; the retired `repair_proxy` config key now hard-rejects) onto a free backend", and
  "requiring repair-proxy when a node needs file access" → "requiring the proxy transport when a node needs
  file access."

### Design decisions for you
- [DD-1] `docs/backlog.md` (the "Capability-evidence obligation..." entry, ~lines 51-69; the
  "`resolveUnevidencedCapabilityPools` is untestable..." bullet, ~lines 71-76; the "UNBLOCKED 2026-07-18 —
  implement it." tail of "Unranked + free compose badly", ~lines 118-127) and `docs/HANDOFF.md`'s
  "IN FLIGHT, REVIEW-BLOCKED... round 2 refused sign-off with six open issues" paragraph (~lines 60-72) —
  all describe the capability-evidence obligation's review status as of round 2. A reviewer proposed
  updating these to round 3 (5/6 defects closed, 3 new named blockers) by reading `origin/wip/capability-evidence`.
  An adversary + judge REFUTED auto-applying this: `git merge-base origin/main origin/wip/capability-evidence`
  = `a8bee5d` — the branches are siblings, main's HEAD never merged the branch, and on main's own tree
  `resolveUnevidencedCapabilityPools` doesn't exist at all (only referenced in docs). Per this routine's own
  scoping rule ("check out main's HEAD content to review against"), an unmerged branch's state is not a
  legitimate ground for a stale-factual-fix against main. Separately, "round N of M closed" is itself a
  status-noise pattern that will just go stale again (round 4 is already in motion per the branch's own
  latest commit) — auto-bumping the number recreates the problem the guidelines forbid. Questions: (1)
  should these docs ever cite unmerged branch state as fact — if so, how (e.g. "may cite the tracked
  branch's latest commit by name" instead of a review-round count)? Or should they stay untouched until the
  branch lands, at which point the routine's ordinary passes pick it up automatically? (2) should the
  "Capability-evidence obligation" bullet and the "Unranked + free compose badly" tail be merged into one
  entry — both track the same in-flight work and currently risk drifting independently? (3) should the
  round-count itself be de-status-noised now (e.g. "REVIEW-BLOCKED, see wip/capability-evidence for current
  round" instead of a number this doc will keep needing to re-bump)?
- [DD-2] `spec/unified-dispatch-worker-model.md` — same "repair-proxy" retirement as CLAUDE-5 above, but
  this file has ~15 live references including a whole section header ("## repair-proxy — the kind-1 launch
  transport"), a worker-taxonomy table column, and a "discovery feeder" registry claim (~line 118) that no
  longer has an equivalent (the plan doc: "no leaderboard fetching, syncing, or scoring logic inside
  audit-tools" post-swap). `docs/reviews/litellm-swap-plan-2026-07-18.md`'s own touch-list planned this
  exact rework ("18 refs... reworded to the neutral proxy contract") but never executed it. This is a
  functional redescription (what replaces the deleted discovery/repair behavior, if anything — does the
  "kind-1 launch transport" section still make sense at all?), not a narrow substitution, so it needs your
  judgment on the replacement prose before it lands rather than a blind auto-apply. Should this section be
  rewritten to describe the new brand-neutral `proxy` contract, and should the file's organizing concept
  move away from "repair-proxy"?
- [DD-3] `docs/HANDOFF.md` ~line 167 — "**commit 5** decide kind-3's fate" has no `docs/backlog.md` entry
  to point to (`grep -n "kind-3\|kind 3\|commit 5" docs/backlog.md` → no hits), violating HANDOFF's own
  contract that every open item points to a backlog.md detail. The "commit 5" numbering itself references a
  per-commit Decomposition that HANDOFF's own "Release gate" section says was RETIRED. Should this get a
  backlog.md entry (what specifically is undecided about kind-3 — single-shot/openai-compatible workers —
  per `spec/unified-dispatch-worker-model.md`), or has it actually been resolved/dropped and the pointer
  should just be deleted?
- [DD-4] `docs/HANDOFF.md` — the "## Prior track — the G-series (closed)" section (~lines 133-211, ~80
  lines) narrates already-shipped commit-by-commit history (engine-sharing, G4/G5/G6 closure mechanics, a
  v0.33.0 release recap, a dated "as of the G3 session" offload-lane snapshot) that duplicates content
  already in `docs/backlog.md` (e.g. its own G4/G5 entries) — the changelog-creep smell this doc type is
  meant to avoid, and contrary to the doc's own frontmatter ("Per-lap shipped detail is not narrated
  here... this doc is the open-work roadmap only"). The genuinely-open pointers are already condensed into
  one paragraph (~lines 164-166). Trim the section to that pointer paragraph + the still-load-bearing
  warnings (the "reinstall before dogfooding" note, the "Release gate — the durable lesson" sub-section),
  dropping the shipped-commit narration — or is the history load-bearing enough to keep (it explains *why*
  full unification was rejected, preventing re-litigation)?
- [DD-5] `docs/HANDOFF.md` ~line 283 — "Residuals from earlier shipped fixes (M-B3/`judge_report` self-check,
  audit worker scratch pollution) live under `docs/backlog.md` → Open bugs." `grep -n "judge_report"
  docs/backlog.md` → zero hits, and `git log --all -S "judge_report" -- docs/backlog.md` shows backlog.md
  has never contained this string — this pointer has been dangling since the section was introduced ("audit
  worker scratch pollution" does resolve fine, to the untracked-exclusion residuals). Does "M-B3/`judge_report`
  self-check" need a real backlog.md entry, or should the reference just be dropped from this line?
- [DD-6] `spec/audit-workflow-design.md` — "...both frozen after one always-on LLM estimate review." Verified
  (2 independent passes): `token_estimate`/`risk_estimate` are populated purely deterministically
  (`computeRiskEstimate` is pure arithmetic; frozen and copied verbatim downstream). A repo-wide grep
  (including full `git log -S` history) for "estimate review"/"estimateReview"/"estimate_review" across
  every `*.ts` file, ever, returns zero hits as an identifier/executor/obligation — only four hedged
  ("may later refine") prose comments use similar wording, none tied to a real `N3` obligation. Was this
  always-on LLM review step ever built, or is this vestigial/aspirational design text that should drop the
  "after one always-on LLM estimate review" clause?
- [DD-7] `spec/remediate/remediation-goals.md` — this normative goals doc's Phases/Resume-semantics/
  Completion sections never mention the `quota_paused` retryable-pause mechanism, even though it's a real,
  wired, host-facing halt/resume state (`partial_terminal` obligation, `buildQuotaPausedStep`,
  `step_kind: "quota_paused"` in `src/remediate/steps/nextStep.ts`) and `spec/remediation-workflow-design.md`
  already documents it explicitly. Per the normative-goals-doc rule, a registry entry the doc omits is an
  escalation. Should `remediation-goals.md` gain a mention (either inline or a pointer to
  `remediation-workflow-design.md`'s existing section), or is this intentionally left out of the normative
  product doc as an implementation-level pause distinct from the phase/completion contract?
- [DD-8] `docs/backlog.md` — "Unify the full rolling-dispatch lifecycle shell across audit + remediate
  (doc-review D-66/D-67/C-7)..." (~lines 617-657, ~522 words). Roughly 350-390 words are shipped-status/
  architecture narrative (what's already unified, already verified, already rejected) vs. ~130-170 words of
  genuinely open content (the slice-3 heartbeat scope + its architectural gotcha) — the "living to-do list,
  not a status log" smell the backlog's own header and the doc-shape philosophy both name. Should this be
  trimmed to just the slice-3 open work (relocating the architecture recap to a spec doc, e.g.
  `spec/multi-ide-concurrent-runs-design.md`, which already owns OD3), or is the recap load-bearing enough
  here (it explains why full unification was rejected, preventing re-litigation) to keep as-is?
- [DD-9] `docs/backlog-remediation-design.md` — "**semantic-equivalence gate (O2↔F1↔D8):** O2 exports ONE
  reusable gate; F1/D8 consume." Verified: the gate (`intentCheckpointGate.ts`, `runIntentCheckpointGate`)
  has zero production importers anywhere in `src/audit`/`src/remediate` (`grep -rln 'intentCheckpointGate'
  src tests` finds only its own file + its own test). F1's actual mechanism
  (`src/audit/orchestrator/resultBaseline.ts`) uses a plain deterministic content-key comparison instead,
  and the same doc's own "Still-gated" section says D8 "needs a manual proxy session... never present as
  landable now." Is the LLM-judge gate dead/unwired code F1 was meant to wire in and never did, or does the
  doc overstate current wiring and should read "F1/D8 will consume" (or scope to D8 only, once landed)?
- [DD-10] `docs/end-of-sprint-report-template.md` — the "Friction this sprint" section uses four named
  dimensions (Gate/tool re-loops; Integration-guard failures; Re-scopes/surprises; Open-ended) that don't
  map onto the single-sourced `FRICTION_CATEGORIES` vocabulary (`ambiguous_direction`/`tool_should_decide`/
  `inefficient_feeding`, `src/shared/friction/frictionRecord.ts`) that `docs/project-philosophy.md` B6 ties
  dev-workflow friction logging to ("log all three categories... durably to backlog"), and CLAUDE.md's own
  "Log friction" bullet uses yet a third framing (bugs vs. durable traps — a filing destination, not a
  category set). Is the sprint-closeout template's taxonomy deliberately a separate axis (dev-sprint retro
  vs. product mechanical-capture are different domains), or should it be recast in the single-sourced
  vocabulary for consistency with "ONE category vocabulary... can never drift"?
- [DD-11] **`docs/reviews/capability-evidence-implementation-review-2026-07-18.md` is not in the canonical
  manifest — this currently BREAKS `npm run verify:release`.** `node scripts/check-doc-manifest.mjs` fails
  right now on `main`'s HEAD:
  ```
  ✗ doc-manifest check failed:
  Stray doc(s) not in the canonical manifest (docs/doc-review-guidelines.md routing table):
    - docs/reviews/capability-evidence-implementation-review-2026-07-18.md
  ```
  This file was added in the same commit that added its sibling `docs/reviews/capability-evidence-obligation-plan-2026-07-18.md`
  (which *is* registered, as a "dated plan artifact... one-off record, not a timeless concept") — the
  implementation-review file was simply missed. Register it in `docs/doc-review-guidelines.md`'s routing
  table with the same pattern as its sibling (this is an edit to the guidelines file itself, which is
  excluded from this routine's own self-review, so it needs your hand)?

### Doc-set condensation
- [CX-3] `README.md`'s "## Philosophy" section (~lines 22-33) restates `docs/project-philosophy.md`'s A2
  ("right tool, not deterministic dogma"), A4 ("everything-agnostic by default"), and A7 ("delegate
  adversarial phases to a separate agent" / "tool owns structure, LLM authors only irreducible judgment in
  small pre-scaffolded slots") in different prose — a fact living in two homes, drift risk if one is updated
  without the other. Still open from a prior run (re-verified this run; the prior run's citation additionally
  named a "North-Star" claim that a fresh read does not support — scope corrected to A2/A4/A7 only). Keep as
  a distinct user-facing summary (different register: terse, no jargon like "A2"/"A7"/canonical-home
  citations), or replace with a one-line pointer to `project-philosophy.md`? If kept, should
  `project-philosophy.md` note that README carries a condensed public-facing version, so a future edit to
  the convictions knows to check both?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-tier gate ran this run (checkpoint `2c321cd` → `4e9eb43`, 43 commits since the last checkpoint —
the H1+H3+H5 dispatch-quota unification, the H2+H4 branch-pair collapse, the repair-proxy retirement /
LiteLLM proxy-contract swap and its live validation, the model-capability-ranking survey, and the
capability-evidence obligation plan/implementation-review work). 7 reviewer agents each examined every
in-scope item in their doc cluster against live code (backlog.md; HANDOFF.md; the `spec/audit/*` cluster;
the remaining `spec/*` cluster; `docs/audit-pkg/*` + README.md; the 6 design/concept docs; instruction files
+ meta-tooling + package READMEs), then 4 independent adversary agents re-checked every candidate finding
from scratch plus swept their clusters for anything missed — several adversaries found additional items the
reviewers missed (a stale self-contradictory "repair-proxy" line in HANDOFF.md itself; a stale
`spec/cost-first-routing.md` reference; the unregistered-doc manifest failure, independently found by two
different agents plus direct inspection). One cluster was genuinely contested (docs/backlog.md's
capability-evidence bullets — reviewer proposed rewriting them against the unmerged `wip/capability-evidence`
branch's state, adversary refuted) and one needed an apply-vs-escalate scope call
(`spec/unified-dispatch-worker-model.md`'s repair-proxy terminology — broad functional redescription vs. a
narrow single-line sibling fix); both resolved by an independent judge agent (both ESCALATE; see DD-1/DD-2
above).

Applied:
- `docs/backlog.md`: deleted a stale `SHIPPED` status-marker bracket (repair-proxy dogfood lap entry);
  rewrote the "cost ordering doesn't consult quota" claim — the quota-demotion primitive
  (`CostCandidate.saturated`) now exists in `costRank.ts` but no caller ever sets it, so the doc now says
  "unwired" not "doesn't exist"; folded two duplicate test-hermeticity bullets (`quota-command.test.mjs`,
  `linux-cycle-regression.test.mjs`) into their richer siblings; consolidated 5 near-identical vitest
  false-green "Recurrence #N" bullets into one summary bullet; deleted two `CLOSED`-status-marker bullets
  (H3/H5 residuals) with independently-verified zero open remainder; fixed 3 stale citations
  (`HYBRID_NODE_TOKEN_ESTIMATE` line number, the pre-commit-gate.mjs scope description, the session-config
  three-filenames citations + a dead wrapper-seeding claim).
- `docs/HANDOFF.md`: removed a stale "two quota contracts" open-item (unified into one contract by commit
  `4008f46`); fixed a self-contradictory repair-proxy reference (the doc's own line 108 already says
  repair-proxy was retired).
- `docs/audit-pkg/operator-guide.md`: corrected the "Shared install files" list — `session-config.json` is
  created lazily by `next-step`/`advance-audit`, not by `install`/`ensure` bootstrap (confirmed via
  `wrapper/audit-code-wrapper-install-hosts.mjs`'s own "No session-config seeding" comment).
- `spec/conceptual-design-review-design.md`: `charter_clarification` → `charter_clarification_current`
  (matches the actual `PRIORITY` array entry in `src/audit/orchestrator/nextStep.ts`).
- `spec/cost-first-routing.md`: "the repair-proxy registry" → "the declared proxy lane" (the `/registry`
  discovery shape was deleted, not renamed, per commit `4441703`).

Full green gate (`npm run build && npm run check && npm test`) passed before push — 510 passed | 5 skipped
test files, 6816 passed | 12 skipped tests, exit 0, no failures. One discrete commit (`doc-review: nightly
pass — 11 stale-factual-fixes applied, ~14 items escalated`), pushed to `main`.
