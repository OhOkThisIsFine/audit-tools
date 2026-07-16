# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-1] `CLAUDE.md` ~line 219 — the Own-vs-acquire analyzer engine bullet asserts "the consent token
  is stripped/redacted before any `SessionConfig` is persisted to a shared artifact" as current behavior.
  No such stripping/redaction exists anywhere in `src/` (only the `consent_token` type field and its
  read-through). `src/shared/friction/stepBoundaryCapture.ts:317` states verbatim: "The backlog's noted
  `consent_token` strip-before-persist is a planned, not yet implemented, forward constraint." —
  proposed: replace the trailing clause with "; stripping/redacting the consent token before any
  `SessionConfig` persistence is a planned, not-yet-implemented forward constraint (tracked in
  `docs/backlog.md`, `[[deterministic-analyzers-own-vs-acquire]]`) — do not treat it as current behavior."
- [CLAUDE-2] `CLAUDE.md` ~line 142 — remediate-code's State persistence bullet says StateStore is "guarded
  by the shared `withFileLock`" directly. `src/remediate/state/store.ts` no longer imports `withFileLock`
  at all — it goes through `createLockedJsonStore`/`LockedJsonStore` (`audit-tools/shared/io/lockedJsonStore.ts`,
  also used by the audit session-config mutator), which is what calls `withFileLock` internally. The cited
  backoff/stale-lock numbers (50ms→500ms, 30s) are still correct — proposed: "guarded by the shared
  `LockedJsonStore` (`audit-tools/shared/io/lockedJsonStore.ts`, also used by the audit session-config
  mutator), which wraps `withFileLock` (`audit-tools/shared/quota/fileLock`: exponential 50ms→500ms
  backoff, token-checked 30s stale-lock cleanup)."

### Design decisions for you
- [DD-1] `docs/backlog.md` — two Durable-traps entries now describe the identical PowerShell-here-string-
  in-Bash-tool trap: the entry added by the very latest commit (14a998e, "Multi-line git commit messages:
  use a temp file... NOT the PowerShell here-string") and a pre-existing entry ("The Bash tool is POSIX sh,
  NOT PowerShell..."). Neither is a strict subset — the new one has the recovery command
  (`git commit --amend -F <file>`), the old one has the broader generalization ("applies to every native
  exe called from the Bash tool, not just git"). Merge into one entry? If so, which wording survives —
  keep both the recovery-command detail and the generalization?
- [DD-2] `docs/backlog.md` line ~52 — A→B seed candidate (raw item quoted verbatim, not drafted): "the
  dispatch system tries too hard to force specific assignments of nodes/packets to sources... Shift to the
  originally-intended model: decouple the ClaimRegistry so claims are pool-agnostic locks... and move quota
  reservations to a Just-in-Time (JIT) model... allowing the orchestrator to dynamically select and reserve
  quota JIT right before calling the provider. [[relax-dispatch-source-forcing]]". Re-verified still open
  and accurate (ClaimRegistry is still pool-bound, no JIT-reservation rework exists). Is this ready to
  promote to a conceptual spec now that G1/G2 have landed the per-auditor inventory seam it depends on?
- [DD-3] `spec/audit-workflow-design.md` — the "Pipeline order" diagram omits `critical_flow_fallback_current`
  entirely, though it's a real PRIORITY obligation (sitting between `structure_artifacts` and
  `graph_enrichment_current`) with its own `host_delegation` executor and artifact (`critical-flow-fallback.json`).
  Its structural peer `charter_extraction` IS shown, annotated `[host_delegation, gated by the
  intent-checkpoint ceiling]`. Represent it the same way (own diagram line, conditional annotation), fold
  it into the existing `batch_deterministic` bracket with a caveat, or leave it out deliberately?
- [DD-4] `spec/audit/dispatch-admission-control.md` — the `## What changes` / `## Migration` /
  `## Validation criteria` sections are written as a forward-looking plan ("the new admission loop...
  ship as one change", "Tests to update/add"), but the work has already shipped: `computeDispatchAdmission`
  is live and wired, `granted_packet_ids` is threaded through the dispatch stack, all named tests exist,
  and `max_concurrent_agents` survives only as "replaced" comments, never a live field. This is both
  factually stale (describes planned, not current, state) and a changelog-creep smell
  (`documentation-philosophy.md`'s forbidden "now in `dispatch.ts`" pattern). Re-state timelessly as
  current architecture (folding into the doc's earlier present-tense sections), or trim/retire the
  migration-shaped sections now that the migration is complete?
- [DD-5] `spec/unified-dispatch-worker-model.md` — a pinned-status-string smell that's pervasive through
  the whole doc, not one header: `## Greenfield endpoint (owner-approved 2026-07-16, supersedes the
  SEAM-first phasing below)`, plus similar dated/owner-decided framing at (roughly) lines 5, 71, 91, 229.
  De-status these (drop the dates, state the current architecture timelessly), or is the approval-date
  provenance load-bearing history worth keeping in this specific doc?
- [DD-6] `spec/unified-dispatch-worker-model.md` — the Decomposition section carries `[SHIPPED]` /
  commit-hash tags for G1/G2/2a-i/2a-ii that duplicate `docs/HANDOFF.md`'s own G1-G6 sequencing/status
  tracking (HANDOFF already narrates "G1 — ✅ SHIPPED (`e7b593ac`)" etc. in finer detail) — a one-home-
  per-concept violation, and the tagging is already inconsistent (G2 tagged, 2a-i/2a-ii not, though all are
  equally shipped). De-status this section into a timeless list of decomposition steps (drop commit-hash/
  SHIPPED provenance) and point to HANDOFF.md for status, rather than maintaining a second copy that will
  keep drifting?
- [DD-7] `spec/cost-first-routing.md` — the Gate-0 "Where the ordering is confirmed" section doesn't
  describe the source-pool cost fold shipped since baseline (dispatchable NIM/opencode/repair-proxy
  sources folded into the same unified Gate-0 cost ordering as provider/host candidates, via namespaced
  `source::` keys, plus the `00eb133` dedup-against-provider-representative-models fix). (Note: the
  separately-flagged capability_rank tiebreak is already adequately described at concept-doc altitude —
  only the source-pool fold is a genuine gap.) Extend the doc to cover it, or is it below this doc's
  intended abstraction level?
- [DD-8] `spec/self-scaling-pipeline-design.md` line ~44 — "The structured-audit lean path **now** runs one
  bounded light adversarial pass..." is changelog-creep phrasing (matches `documentation-philosophy.md`'s
  own named forbidden pattern, "now in `dispatch.ts`") in a doc whose own header states "Durable
  conceptual design; no dated status here." The underlying fact is correct (`interpretLeanLightReviewVerdict`
  in `src/remediate/riskSignal.ts` is live). Approve dropping "now" ("now runs" → "runs")?
- [DD-9] `spec/remediation-workflow-design.md` line ~172 — "...escalating to the full pipeline on any
  concern — **no longer** a bare skip." Same changelog-creep smell as DD-8, and this doc's own header
  explicitly disclaims narrating "what has or hasn't shipped" — its own body violates its own stated rule.
  Approve rewording to state the invariant timelessly (e.g. "...— never a bare skip")?
- [DD-10] `spec/cross-provider-quota-matrix.md` line ~220 — the `agy`-alias paragraph is factually accurate
  (`ANTIGRAVITY_PROVIDER_NAMES = new Set(["antigravity","agy"])` confirmed live) but opens with "SHIPPED
  (as a same-mechanism alias, not a new source):" — a bare shipped-status marker, the same status-noise
  smell as DD-5/DD-8/DD-9. De-status the marker (state the alias fact timelessly), keeping the durable
  "credential-store sharing is unverified" caveat that follows it?
- [DD-11] `docs/project-philosophy.md` — three of the map's home-citations are imprecise relative to every
  sibling entry's precision:
  - A2 ("Right tool, not deterministic dogma"): cites a blanket `(home: CLAUDE.md → Concepts)` for all
    three of its sub-claims, but only the parent conviction lives in Concepts — "LLM always in the loop"
    is actually under Conventions & invariants, and "Resolve toward the durable contract" is under
    Preferences & standing decisions.
  - A4 ("Everything-agnostic by default") model/provider/IDE-agnostic sub-bullet: cites "(Home: CLAUDE.md's
    fuller statement wins on the nuance.)" with no section named. The matching content is under
    **Conventions & invariants** (line ~184, the "never make us hand-maintain a model/price/limit table"
    bullet) — confirmed directly, not Preferences as an earlier pass guessed.
  - B2 ("Ship-pipeline ownership"): cites `(home: CLAUDE.md; ...)` with no section named, unlike every
    other B-section. Matching content is under **Release & publish**.
  Should all three be split/named precisely to match the rest of the map, or is coarseness intentional for
  these three?
- [DD-12] `docs/glossary-ids.md` — the guard test (`tests/shared/id-glossary.test.mjs`)'s `TOKEN_RE` is
  structurally blind to two real id shapes in `src/`: a mixed-alnum area like `DC1`/`DC2` (a letter run
  with an embedded digit, matching neither of the regex's two alternatives) and a long descriptive area
  with no trailing digit like `BROKER-CLASSIFY-SINGLE-SOURCE`. (The missing glossary rows themselves were
  auto-applied this run — see FYI below — this item is just the guard-regex gap, a code change.) Widen
  `TOKEN_RE` to catch these shapes going forward, or are they a deliberately different id family outside
  the guard's scope?
- [DD-13] `examples/README.md` — all 10 fixtures in `examples/session-config/*.json` now fail
  `validateRepoSessionIntent` (each uses a now-forbidden dispatch-inventory field: `provider`/
  `claude_code`/`opencode`/`subprocess_template`/`vscode_task`/`sources`) since the G2 `RepoSessionIntent`
  split. Zero test/script references any of them, so nothing currently catches this. `docs/HANDOFF.md`
  already calls this a deliberate intermediate pending G2.5 (the deterministic source-emitter), but
  `examples/README.md` carries no such caveat and presents the directory as straightforwardly usable.
  Annotate as pre-G2.5 illustrations (not directly loadable today), rewrite as `--auditor <json>`
  descriptor examples (the shape that actually works), or remove until G2.5 settles the on-disk
  representation?
- [DD-14] `docs/audit-pkg/operator-guide.md` ~lines 138-148 — the session-config callout box pins a "(G2)"
  milestone label and "now FAILS at load" changelog phrasing onto an otherwise-accurate rule (verified
  field-for-field against `DISPATCH_INVENTORY_FIELDS` + `validateRepoSessionIntent`). `docs/HANDOFF.md`
  already plans G3/G4/G5 as further milestones in the same series, so this paragraph will need the same
  manual edit again at each step. Restate the rule timelessly (drop the G-series anchor), given more
  milestones are already planned?
- [DD-15] `README.md` — two numbered pipeline lists don't match the code's actual execution order:
  - audit-code: step 3 "Confirm intent" is listed before step 4 "Map the subsystems", but the PRIORITY
    array actually runs the deterministic subsystem-clustering half of step 4
    (`design_assessment_current`, `structure_decomposition_current`) BEFORE `intent_checkpoint_current`
    (step 3's host pause) — only the LLM charter-extraction sub-step of step 4 genuinely runs after.
  - remediate-code: step 3 "Confirm intent" is listed before steps 4-5 ("Design the change" / "Review the
    findings"), but for structured-audit input `pending_intake` (step 2) already runs the contract-pipeline
    + review-approval-gate work (steps 4-5) before `confirm_intent` (step 3) is next reachable — matching
    CLAUDE.md's own note that there's no separate "document" phase (dissolved, N-R13).
  Reorder/annotate both numbered lists to reflect real execution order, or is the numbering intentionally
  a conceptual grouping that needs an explicit caveat (mirroring CLAUDE.md's own choice not to restate the
  PRIORITY array verbatim, since such restatements drift)?
- [DD-16] **Doc-manifest gate is currently failing on `main`** (`npm run check:doc-manifest`, wired into
  `verify:release`) — three files shipped by the G1/G2 rework aren't registered in
  `docs/doc-review-guidelines.md`'s canonical manifest table: `docs/reviews/dispatch-inventory-greenfield-
  design-2026-07-16.md`, `docs/reviews/g1-auditor-descriptor-plan-2026-07-16.md`,
  `docs/reviews/g2-repo-session-intent-plan-2026-07-16.md`. This is a real release blocker (confirmed by
  running the gate directly against `main` HEAD), not a style nit — `verify:release`/CI's `gate` job is
  red right now. All three are dated design/plan-synthesis artifacts, structurally identical to the
  existing `docs/reviews/*-diagnosis-*.md` entries already listed in the manifest's `excluded` row (durable
  digest lives in `spec/unified-dispatch-worker-model.md`; these are one-off records, not timeless
  concepts). Register them under the `excluded` row with that rationale, fold their content into
  `spec/unified-dispatch-worker-model.md`, or something else?

### Doc-set condensation
- [CX-1] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` + `spec/audit/executor-catalog.md`
  — still open from prior runs, re-verified accurate against current code this run (executor/artifact
  counts recounted independently by two agents, now corrected to 27/38 respectively — see FYI): "which
  executor produces which artifact" is hand-maintained independently in two places (executor-catalog.md's
  Produces column and dependency-map.md's per-artifact rows) over the same registry pair. Should this have
  exactly one home (fold one into the other), or is the duplication an acceptable, differently-shaped view
  (catalog = by-executor, map = by-artifact) worth keeping as-is?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run (commit `03339a4` → `7817a11`, 44 commits — the biggest rework since
this routine started: the `--auditor <json>` descriptor collapse (G1, `e7b593a`), the persisted
session-config type split into `RepoSessionIntent` (G2, `59116fe`), the host-inventory handshake channel,
repair-proxy source-pool retirement then its capability-rank/JIT-dispatch integration, quota/host-fanout
gating (items C/D), the critical-flow LLM fallback pass, and `openai-compatible` content-inlining). 5
reviewer agents (ops/package/provider-surface + meta-tooling; backlog.md + HANDOFF.md; the highest-risk
`spec/audit/*` cluster; the remaining `spec/*` cluster; policy/philosophy including CLAUDE.md/AGENTS.md),
each examining every in-scope item in their cluster against live code, then 5 independent adversary agents
re-checked every item from scratch — several adversaries independently recounted registry sizes rather
than trusting the reviewer's counts (catching a real `artifact-contract.md` miscount: 37 was wrong even by
the reviewer's own math, true count is 38), narrowed an overbroad finding to its real scope
(`cost-first-routing.md`'s capability_rank claim), and reclassified two items from stale-factual-fix to
design-decision on a documentation-philosophy.md changelog-creep technicality. One item was genuinely
contested (reviewer vs. adversary disagreed on which CLAUDE.md section a citation belonged under) and was
resolved by direct verification against the file rather than a third subagent. Several previously-open
items from the prior run's escalation file (DD-1 through DD-11, CX-2, CLAUDE-1) were independently
re-verified this run and found resolved — dropped from this file without further action.

Applied:
- `docs/backlog.md`: deleted the fully-shipped `empty_grant` livelock entry outright (zero remainder);
  trimmed four partially-shipped entries (openai-compatible content-inlining, host fan-out quota gate,
  critical-flow LLM fallback, Phase-0 opencode-free) to just their open residuals; trimmed the 2026-07-15
  repair-proxy dogfood entry from a multi-paragraph forensic writeup to just the one item (the cold-start
  admission wall) still actually open, since the design-of-record already dissolved the other two (B1/B2)
  by retiring the repair-proxy source-pool wiring.
- `docs/HANDOFF.md`: deleted two changelog-creep asides (openai-compatible SHIPPED narrative; Item C/D
  SHIPPED narrative) that duplicated the backlog.md entries above verbatim with zero forward-looking
  content.
- `spec/audit/executor-catalog.md`: `EXECUTOR_REGISTRY` count corrected 26 → 27 (the doc's own per-kind
  tables already summed to 27; only the intro prose was stale).
- `spec/audit/artifact-contract.md`: `ARTIFACT_DEFINITIONS` count corrected 37 → 38 (adversary recount
  caught this — the original reviewer's count was itself arithmetically wrong).
- `spec/audit/dispatch-admission-control.md`: updated two `--host-*` flag references
  (`--host-max-active-subagents`, `--host-models`) that G1 retired as literal CLI flags — both now live
  inside the `--auditor <json>` descriptor (`self.max_active_subagents`, `self.roster`).
- `docs/glossary-ids.md`: split the `CE-001`/`CE-002` table row (the cited site only carries CE-001;
  CE-002 appears at five other files); added the three glossary rows missing for `INV-DC1-6`,
  `INV-DC2-3`, and `INV-BROKER-CLASSIFY-SINGLE-SOURCE` (real, load-bearing invariant ids in `src/` that the
  guard test's regex can't see — see DD-12 for the separate regex-gap escalation).

Full green gate (`npm run build && npm run check && npm test`, 6504 tests) passed before push. One
discrete commit (`doc-review: nightly pass — 14 stale-factual-fixes applied, 12 items escalated`), pushed
to `main`.
