# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate

Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target**, ideally `AUDIT_TOOLS_LIVE_QUOTA=1` (forces the wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. After a run, its findings are the
corpus to hand-label for the A2 oracle (see Deferred / waiting).

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Lap friction walk — smokes/release-poll/runPlanPhase lap (2026-07-09, orchestrator + 2×Sonnet + Haiku
  + free-NIM review lane).** Lean-tier lap, 3 disjoint items via parallel implementers; `llm read` as the
  standing free adversarial-review lane; orchestrator as accountability gate.
  - **(ambiguous-direction) A broken probe fixture produced a confidently-wrong env conclusion — twice —
    before being caught.** Diagnosing the npm-12 postinstall break, the orchestrator's probe package.json
    was malformed (unescaped quotes), so `npm install` failed silently under `>/dev/null` and every probe
    variant "proved" scripts were skipped/flags didn't work. Only a verbose re-run exposed EJSONPARSE, and
    the valid fixture then flipped two earlier conclusions. Probe hygiene: validate the fixture (run the
    probe once verbose) before trusting any negative result. Same family as verify-premises-before-building.
  - **(tool-should-decide) Parallel Agent-tool implementers in ONE shared worktree raced on write.** An
    implementer's finished edits were silently reverted once by a sibling (and `docs/backlog.md` was an
    overlap surface — two agents + orchestrator all editing it); it re-applied and re-verified, no loss, but
    attribution was luck. Known gap (recurrence of the 2026-07-08/09 entries): remediate-code's per-node
    worktrees + claims solve exactly this; for ad-hoc fan-out the fix stays host discipline — disjoint file
    lists must include DOCS, and doc edits are better done centrally by the orchestrator. Also recurred: the
    attest-then-commit chain trap (attest must be its own Bash call AFTER staging — gate checks fire on the
    whole chained call).
  - **(inefficient-feeding) Free-NIM review lane worked; one payload-size miss.** `llm read` reviews caught
    a real dropped-assert defect in the smoke diff for zero quota; the ~700-line deletion diff exceeded what
    the (already-fixed) tool would take and was split (collateral files → NIM; big file reduced to its
    `git diff -U0` added-lines). No file bodies through main context; recon/impl/verify all in subagents.

- **External shared-logic audit V1–V7 — ALL SHIPPED 2026-07-09** (13-commit subagent-implemented program,
  adversarial review on every loop-core/delicate commit; `git log 5ca5bce2..6145a1a3`). Remaining
  residuals only (each deliberate, low-severity, documented at the code site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.mjs` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.
  - **(from V2) conversation-first mid-run dirt is indistinguishable.** A declared-but-unedited file the
    USER dirties during the run window can still be staged in the `merge-implement-results` flow —
    `run_start_dirty` fences only pre-run dirt; full closure needs per-edit git ground truth that flow
    lacks. Documented at `collectStagingFiles`. ⬇ Live-run watch (conversation-first run on a dirty repo):
    `leftover_files` in the report must list untouched dirt; nothing outside the run's surface committed.
  - **(from C1) drain-scan derivation cost watch.** The engine adoption memoizes `deriveAuditState` per
    bundle identity (once per iteration, as before). The standing profiling ledgers are the regression
    watch — compare step timings against pre-`6145a1a3` if a drain slowdown is ever suspected.

- **Lap friction walk — D-66/67 slice-1 ownership-gate lap (2026-07-09, orchestrator+Haiku/Sonnet+NIM).**
  Full pipeline: 3 parallel recon subagents → design doc → design-level adversarial review (NIM free pass +
  independent Sonnet) → 2 parallel disjoint-boundary implementers → central gates → independent post-impl
  adversarial review → repair rounds via transcript-resume → re-review APPROVE → attested commits.
  - **(ambiguous-direction) Design-LEVEL adversarial review paid for itself before a line was written.**
    The pre-implementation review pass found 2 CONFIRMED-BROKEN design decisions (tokens parked on the
    per-round-rebuilt `active-dispatch.json`; A-8 hybrid never claiming) that post-impl review would have
    surfaced as expensive rework. Post-impl review STILL found 2 more (staleness-blind partition, legacy-
    session bricking) the authors' green suites missed — review depth scaling with delicacy, both layers
    earning keep. Also recurred: the design's own probe choice (heartbeat) was wrong for audit's claim
    lifecycle (absent-claim ≠ reclaim on the self-heal path) — caught by a REAL breaking test mid-impl;
    a design doc is a point-in-time proposal even when adversarially reviewed same-day.
  - **(tool-should-decide) Two tool fixes shipped in-lap instead of host workarounds.** (1) `llm read`'s
    JSON-contract break → fixed upstream in llm-worker-tools (entry below) rather than "avoid diff
    payloads". (2) The PreToolUse commit-gate fires on the whole Bash call BEFORE a chained
    `attest && git commit` executes, so the attestation half hadn't run when the gate checked — minor
    ergonomic trap, workaround = attest as its own call; a gate that could recognize the attest step in
    the same chain would remove the trap (low value, noting only).
  - **(inefficient-feeding) None material.** Recon/design-review/impl/post-review all via subagents
    returning conclusions or delta reports; NIM took the design pass free; diff bodies never entered main
    context (only stats + targeted greps + the follow-up fix's hunk view). One llm-read lane burned ~4
    failed calls before being rerouted to subagents — now fixed at the tool layer.

- **Lap friction walk — shared-logic remediation lap (2026-07-09).** Subagent-implemented 13-commit
  program (V1–V7 + dedup bundle + C1/C2): parallel disjoint-file implementers, central build+test+commit,
  independent adversarial review per loop-core/delicate commit, repair rounds on CONCERNS.
  - **(ambiguous-direction) Adversarial review caught real defects the author pass + green targeted suites
    missed — in BOTH delicate items.** V2 round-1: the declared-surface fallback reopened the exact
    over-inclusion defect being fixed; round-2: force-replan dropped the snapshot (the capture-once test
    coverage sat on a production-dead path) + case-fold sibling admission. C1: a reachable zero-dispatch
    log-event drop the implementer's "byte-identical" claim missed, + an 8-9× per-scan derivation
    regression. Four defects, zero caught by the authors' own passing tests.
    [[delegate-adversarial-phases-to-separate-agent]] keeps earning its keep; review depth should scale
    with delicacy (both got full-vector prompts, and both needed them).
  - **(tool-should-decide) Session-limit terminations mid-edit leave multi-file WIP with no tool-level
    ledger of per-agent intent.** Three concurrent implementers died mid-edit on a quota wall; recovery
    worked via transcript-resume + `git status` triage, but attribution of half-done hunks to owners was
    manual. The remediate-code dispatch machinery already solves this (per-node worktrees + claims) — for
    ad-hoc Agent-tool fan-out it remains host judgment. Also: remote main moved mid-lap → rebase conflict
    on the backlog (the re-fetch-before-first-write guard, hit live again).
  - **(inefficient-feeding) None.** Implementers edited directly and returned compact delta reports;
    reviewers returned verdicts; builds/tests batched centrally; no file bodies through main context.

- **Lap friction walk — shared-logic-audit validation lap (2026-07-09).** Assessment lap (no code
  changes): 4 parallel read-only subagents verified an external agent's shared-extraction catalog +
  7 findings; verdicts above (V1-V7) + the dedup forward track below.
  - **(ambiguous-direction) A third-party audit catalog is leads, not verdicts — half its architectural
    rows were stale or already-adjudicated.** The catalog proposed unifying the rolling lifecycle and
    hybrid spill (shipped/adjudicated: shared `driveRolling`, `HybridSpillCoordinator`, D-66/67 "full
    unification is WRONG") and a `FindingAdmissibilityPolicy` merging two different concerns. Feeding it
    raw to remediate-code would have re-built shipped work and contradicted the design-of-record. Same
    verify-premises-before-building pattern as [[spec-degradation-and-doc-staleness]], now for EXTERNAL
    input: catalog rows need validation against current code + design-of-record before remediation intake.
  - **(tool-should-decide) Claim-staleness grounding has no tool support.** remediate's grounding phase
    catches phantom PATHS but not stale CLAIMS ("X is duplicated" when X was single-sourced last week) —
    the paths all exist, the assertion is what's dead. Inherently judgment; handled here by subagent
    verification. Acceptable as host/subagent work; noting the gap.
  - **(inefficient-feeding) None.** All recon via 4 parallel subagents returning file:line conclusions;
    main context received no file dumps; spot-checks were targeted greps.


- **Lap friction walk — backlog-clearance lap (2026-07-09).** Subagent-driven lap: parallel read-only recon →
  I own loop-core impl + review, delegate mechanical impl to subagents, an independent adversarial subagent per
  loop-core change. Shipped INV-WH fix, the loop-core guard + gate, the D-68 fold; assessed D-69; handed off D-66/67.
  - **(ambiguous-direction) Owner-chosen option premises + backlog framings got falsified by measurement/recon
    mid-build — recurring pattern.** The guard's owner-picked "mechanical exclude-heavy, per-node" premise assumed
    the exclude-heavy complement is FAST; measurement showed 92s → impractical per-node, so I loop-core-gated it
    (surfaced the deviation). D-69's "build tool-enforcement" framing was mostly-already-shipped (friction 3-layer +
    D-68). D-66/67's "unify the lifecycle" framing was OVERTURNED by recon (full unification is the WRONG endpoint —
    genuine divergence). Same lesson as the recurring [[spec-degradation-and-doc-staleness]] entries below: a backlog
    item / a chosen option / a design memory is a point-in-time PROPOSAL; verify its premises against current code AND
    a real measurement BEFORE committing to the literal instruction. Not yet tool-enforceable; a review-before-build
    discipline.
  - **(tool-should-decide) The pre-commit gate silently failed OPEN in every linked worktree.** The staged-snapshot
    materialization put its scratch index under `join(root,'.git',…)`, but in a LINKED worktree `.git` is a FILE, so
    every git-with-scratch-index call failed → the ENTIRE gate (typecheck, doc-contract, and the new loop-core check)
    no-op'd fail-open on any divergent commit. A gate that silently no-ops is worse than no gate (false assurance).
    FIXED this lap (scratch index → os.tmpdir()). Durable lesson: a tool that fail-opens on infra fault must make the
    no-op OBSERVABLE, not silent — consider a one-line stderr when the staged-snapshot path bails.
  - **(inefficient-feeding) None material.** Recon routed through parallel read-only Explore/general subagents
    returning conclusions + file:line refs; main context received specs + diffs to review, not file dumps. One
    deliberate full-region read (the `nextStep.ts` fork) for a delicate hand edit. No god-file re-read loop.

- **Lap friction walk — backlog-orchestration lap (2026-07-08).** Orchestrated lap: parallel read-only recon
  agents → serial implement-agent-per-item with adversarial review before each commit. Shipped six backlog code
  items (wrapper passthrough D-61, vi.spyOn barrel guard INV-12, accept-node stray-worktree guard, convergence
  CE fingerprint, validate-artifact cross-gates, `score-tokens` harness). Three-category walk:
  - **(ambiguous-direction) A backlog item's suggested FIX was weaker than the ideal one.** D-61 proposed "a
    parity test (wrapper-reachable ⊇ cli.ts commands)". The enforce-in-tooling ideal is a passthrough-to-dist
    DEFAULT — dist/cli.js becomes the single source of truth and wrapper/CLI drift is *structurally impossible*,
    no hand-maintained allowlist. A lap that literally implemented the suggested test would have shipped a
    weaker guard needing perpetual maintenance. Reinforces [[backlog-item-states-invariant-not-fix-mechanism]]:
    a backlog item's impl suggestion is a lead, not a verdict — re-derive the ideal fix from the property.
  - **(tool-should-decide) The multi-agent write path is forced serial by a shared worktree.** Parallel
    implement agents can't safely edit the same working tree (collision + green-at-every-commit), so recon
    parallelized but implementation serialized one-item-at-a-time. Agent `isolation:"worktree"` would allow
    parallel writes but carries its own strand traps ([[no-agent-isolation-worktree-for-dispatch-nodes]], the
    very bug fixed this lap). No clean tool fix beyond the existing remediate-code dispatch machinery (which
    already does bounded parallel worktree units + merge) — for ad-hoc dev fan-out, serial-write is correct.
    Attested, not a new defect.
  - **(inefficient-feeding) None.** Recon routed through parallel read-only Explore/general agents that returned
    conclusions + implementation specs (file+line refs), never file dumps; each implement agent read its own
    scope. Main context received specs and diffs to review, not raw file bodies. No large-file re-read loop.

- **Lap friction walk — arbitrage Phase-0 lap (2026-07-08).** Full three-category walk of the doc-review +
  dial-adjudication + arbitrage-increment-1 lap:
  - **(ambiguous-direction) A forward-track design memory carried two falsified technical premises — SECOND
    instance of the pattern below.** [[arbitrage-dispatch-tier-design]] (written 2026-07-07) asserted (a)
    "`deriveCostRank` prices free pools ~0 once registered" — FALSE (a non-models.dev model id falls to the
    *worst* unknown-price band, the opposite of free-first), and (b) opencode-free is `Bearer public` zero-auth —
    which needed live verification (the docs describe a paid API-key tier; the free-model path *does* work with
    `Bearer public`, confirmed by probing). A lap trusting the memory would have shipped a config example that
    ranks *last* + assumed an unverified endpoint. Verifying before building (live probe + seam map) caught both.
    This is the exact recurrence of the entry immediately below — a design memory's technical premises must be
    re-verified against current code AND live endpoints BEFORE building, not assumed. That the same pattern
    recurred within one day is the signal it isn't yet tool-enforced; the durable fix is still
    [[spec-degradation-and-doc-staleness]] (a memory is a point-in-time proposal, not a live spec).
  - **(tool-should-decide) The wrapper dispatch table can silently drift from `cli.ts`'s command set (D-61).**
    `audit-code cleanup` was documented + fully implemented in `src/audit/cli.ts` but had no case in
    `wrapper/audit-code-wrapper-lib.mjs`, so the packaged bin answered `Unknown command: cleanup` for a
    long-standing gap. Fixed + added a reachability test for `cleanup` specifically — but the GENERAL guard is
    missing: nothing asserts the wrapper dispatch table covers `cli.ts`'s command set (or the documented
    commands). A parity test (wrapper-reachable ⊇ cli.ts commands) would enforce it and catch the next drift.
    [[enforce-robustness-in-tooling-not-host-discretion]]
  - **(inefficient-feeding) None this lap** — recon was routed through Explore/`llm`-style subagents (the seam
    map, the adversarial review) so the main context received conclusions, not file dumps; no large-file
    re-read loop. Category attested clean.

- **A forward-track design memory outlived a major closure and sent a build in the wrong initial direction
  (ambiguous-direction, 2026-07-08).** The cost↔speed dial's design (memory
  [[host-provider-misattribution-nim-codex]] forward-track, written 2026-07-07) defined its throughput axis +
  free-pool-max in terms of the **AIMD adaptive concurrency ceiling** — which was CLOSED and reverted the SAME
  window ([[concurrency-is-declared-or-absent-never-learned]]). A lap that trusted the memory built a
  declared-*rate* throughput axis (v1) before the stale-AIMD dependency was caught and the owner re-steered to
  auto-derived concurrency. No lasting damage (caught pre-merge, λ=0 default kept it safe), but the lesson
  generalizes [[spec-degradation-and-doc-staleness]]: **when a forward-track predates a since-landed closure,
  re-reconcile its premises against current invariants BEFORE building, not after.** A design memory is a
  point-in-time proposal, not a live spec — the same "spec is right, the design is wrong" rule that killed
  C3-AIMD applies to a memory that cites a deleted mechanism.

- **A lap reported "merged" before its work was on remote `main` → the next lap re-did it (faithful-reporting /
  pipeline-ownership failure, 2026-07-07).** Two laps both did the A1 rename. Root cause, established from git: the
  first lap's rename commit (`7688febe`) was authored 23:24:56, committed 23:25:17, and did not land on remote `main`
  until **23:25:30** — yet it had been *reported* to the owner as "completed, committed, and merged" before the second
  lap was launched. The second lap's `start-lap` fetched the true remote tip (`db1c0e11`, v0.32.32, **no A1**) before
  23:25:30, so HANDOFF still queued A1 and it correctly built it; its identical commit was then rejected on push
  (behind remote) and discarded — a full rename's worth of wasted work. `start-lap` behaved correctly against the
  remote state that existed; the defect is upstream. Two independent fixes, both belong in tooling not host habit:
  (1) **a lap is not "done" until its work is on remote `main`** — the completion signal an operator trusts must be
  gated on the push having landed (pipeline-ownership; the first lap violated this by reporting merged pre-push).
  (2) **`start-lap` re-fetch-before-first-write guard** — re-fetch + re-read HANDOFF immediately before the first
  commit so a mid-lap merge is caught before the duplicate lands (bounds the blast radius to a rejected push, not
  wasted labor). The labor-saving fix is still the cooperative-runs claim ([[multi-ide-concurrent-runs-design]]
  task-claiming): stake a claim on the item at lap start so a second lap sees it taken. Salvage from this incident:
  the loser's sweep caught a stale `// Local-subprocess` comment the winner's rename missed — landed as a follow-up chore.

- **THREE adversarial reviews in a row found a defect the author's own green suite missed (ambiguous-direction).**
  INV-QD-15's first cut left `tests/remediate/wave-scheduler.test.ts` RED and would have shipped; the bucket
  deletion's first cut promoted a latent `success`-clears-live-cooldown bug (INV-QD-16) to the sole failure mode;
  and the v0.32.31 bug-(4) fix's first cut DROPPED the `pool.quotaStateEntry` snapshot entirely (green suite +
  the new regression all passed), but an independent reviewer showed the snapshot is load-bearing in the
  transient-read window — a prior-run cooldown would be lost to proactive spill on a Windows EBUSY read flake.
  Corrected to `live ?? snapshot` order (keep the fallback). All three caught only by an independent reviewer agent,
  never the author pass. This is [[delegate-adversarial-phases-to-separate-agent]] earning its keep — but it is
  still a *host habit*, not a tool obligation. The remediate contract pipeline already runs adversarial rounds;
  the same gate should exist for hand-authored (non-node) changes to loop-core modules. A related, generalizable
  cause on the bug-(4) case: the backlog item stated the *fix-mechanism* ("prefer live") but not the *invariant*
  (don't lose a prior-run cooldown to a transient IO flake), so the mechanism read as "drop the snapshot" — the
  [[backlog-item-states-invariant-not-fix-mechanism]] failure mode, in the wild.

- **Meta-frictions from the v0.32.27 code-fixable sweep (fix in tooling).** Four tool gaps surfaced driving +
  recovering that run (full detail in its friction record `.audit-tools/remediation/friction/backlog-code-fixable-sweep-2026-07-06.json`):
  - **Cross-file contract/invariant regressions escape node-local verify — CLOSED for loop-core nodes (per-node
    guard shipped).** `acceptNodeWorktree` now runs the cross-cutting invariant/contract guard suite (`verify:guards`
    = full vitest MINUS the heavy subprocess/e2e tests) in the MAIN checkout after a node's cherry-pick lands, gating
    + rolling back that node on RED — but ONLY when the node's edits touch a loop-core path (`isLoopCorePath`,
    single-sourced `src/shared/loopCorePaths.ts`), which bounds cost so the cheap majority of nodes never pay for it.
    Fires only on audit-tools self-remediation (`isAuditToolsMonorepo`, like the merged-base check). This attributes a
    cross-file break to the node that caused it (vs the old late, coarse close-time reblock) for the loop-core class
    where those breaks concentrate. NON-loop-core cross-file breaks still rely on the close-time whole-repo gate
    (acceptable — the observed escapes were loop-core). Extends [[worktree-tests-miss-integration-guards]].
    - **Open follow-up (pre-existing, unconfirmed):** the EXISTING merged-base-check's post-merge scoped-`git clean`
      (`acceptNode.ts`, driven off a post-cherry-pick `gitEditedFilesForBranch` probe) may be inert — a subagent
      observed the post-merge `HEAD...branch` probe reads empty in a test harness, though `removeWorktree` does not
      delete the branch so first-principles says it should be non-empty. The new guard sidesteps this by capturing the
      node's edited files PRE-merge; the merged-base-check was left untouched (couldn't confirm the claim; fixing a
      working rollback path blind is riskier than the latent untracked-file leak). Investigate: does the post-merge
      probe actually return files on the real path? If empty, single-source both scoped-cleans off the pre-merge snapshot.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else is ~12s combined. **→ The highest-leverage gate
    win is the packaged-audit-code smoke.** Internal breakdown (measured): `next-step ×~7 to dispatch_review`
    = 35.9s (53% — the real audit-flow round-trips, inherent coverage), `npm install from tarball` 9.3s,
    `next-step to present_report` 10.1s, `npm pack` 7.2s (incl. a prepack rebuild). The next-step round-trips
    are fresh-process pipeline runs — cutting them cuts coverage, so this needs a real design (e.g. an
    in-process multi-step driver for the smoke, or packing once and sharing the tarball across both smokes
    since they build the identical `audit-tools` package), not a quick trim.
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

- **Dispatch admission-control rework — residual (env-bound / deeper, not blocking).** Shipped in full
  (commits 1/2a/2b-AUDIT/2b-REMEDIATE/driver-unification/commit-3/defect-1 — see `docs/HANDOFF.md` T5-3 /
  `git log` for what landed). Design of record
  [`spec/audit/dispatch-admission-control.md`](spec/audit/dispatch-admission-control.md);
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
  - (a) **live validation** of the real host+codex+NIM concurrent run — a metered multi-pool run confirming
    the demoted backend actually fans out alongside the host (folds into the quota-aware-dispatch live-run
    watch below). (b) **Deeper simultaneity:** the audit hybrid path drives the in-process (codex/NIM)
    partition to completion within a `next-step` turn, THEN hands the complement to the host — so host and
    backend alternate ACROSS turns, not simultaneously WITHIN one. True within-turn simultaneity would need
    a detached background driver spanning host turns (architectural; only pursue if wall-clock on a real
    run shows the alternation is the bottleneck).

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (metered provider + large target; `AUDIT_TOOLS_LIVE_QUOTA=1` to force it): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **Friction detection — M-QUOTA escalation chain: live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is unit-tested end-to-end on both
  drivers (`tests/shared/rollingDispatch.test.mjs`; `tests/audit/rolling-audit-dispatch.test.mjs` §5).
  **Still open:** live validation on a real rate-limited run. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops
  (packet-result `task_id` mismatch; idempotency_key collision across rounds) have shipped fixes and need
  a real deepening-capable run to confirm. Recovery until validated: quarantine orphan pending
  `deepening:*` tasks.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, quarantine the orphan `deepening:*` tasks and note the round count here.

- **`llm read` JSON-contract break on review-framed diff payloads — FIXED upstream 2026-07-09; publish
  pending operator WIP.** Reasoning models (nemotron-550b, deepseek-v4-pro) prefixed chain-of-thought
  prose to the JSON on larger review-framed diffs → strict-parse crash. Fixed in `C:\Code\llm-worker-tools`
  commits `01f703c` (response_format json_object + 4xx fallback; balanced-brace tolerant extraction;
  stern-nudge retry) + `a8d13b3` (nudge retry gets its own fresh timeout window), live-verified against
  real NIM; deployed globally from a clean-HEAD tarball. Open: npm publish of llm-worker-tools blocked
  on the operator's own uncommitted WIP there (`bin/llm-worker-tools.mjs` + 4 more; preflight requires
  clean tree) — operator call. Usage note: framing must map output into `llm read`'s
  `{summary,findings[],open_questions[]}` schema; a shape-diverging framing now fails CLEANLY.
  - **Residual (2026-07-09 lap): very large review-framed payloads (~700-line deletion diff) still fail
    even post-fix** — clean error after the nudge retry, no crash, but no result either. Workaround that
    worked: split the payload (review the small collateral-file diff via `llm read`; reduce the big
    deletion to its ADDED lines via `git diff -U0 | grep '^+'` and review those directly). If it recurs,
    consider a chunked-review mode in llm-worker-tools rather than host-side splitting.

## Forward tracks

- **Shared-logic dedup bundle — SHIPPED 2026-07-09 except one marginal item** (same 13-commit program as
  V1–V7 above). Tier B (all 13 extractions: findingSimilarity, countBy, chunkByBudget, fileIntegrity core,
  rolling-flag resolver, cost-drift friction, host-provider assert, LockedJsonStore, postinstall driver,
  hostAssets fold, deliverable constants, shared prompt-command renderer, OpenCode factory + commands-shim
  deletion) and Tier C (1) obligation-engine adoption + (2) host-gate consolidation are ALL landed with
  per-commit adversarial review where loop-core.
  - **Deliberately NOT built — Tier C (3), intra-remediate retry-cap helper** (5 `attempts >= CAP →
    escalate` sites sharing a shape): marginal — the sites are 2-3 lines each over different state records;
    a generic helper would abstract more than it saves. Revisit only if a 6th cap site appears.
  - **Rejected catalog rows (do NOT feed to remediation):** rolling-lifecycle unification as framed
    (D-66/67 owns the correct bounded slices; full unification adjudicated WRONG), hybrid-spill sharing
    (shipped — both sides call the same `HybridSpillCoordinator`/`planHybridDispatch`), generic
    `DispatchPlanner` (admission math already shared; remainders are divergent read-only-vs-git-mutating
    domains), `FindingAdmissibilityPolicy` (category error: evidence-integrity gate vs auto-apply safety
    tier), `FreshnessGraph` merge (artifact-DAG vs flat-hash are different abstractions — the real dup is
    the file-integrity pair in Tier B), cross-orchestrator `ConvergenceController` (caps are not one
    mechanism), grounding/step-contract/manifesting rows (already unified or remediate-only).

- **Free/cheap multi-account "quota-arbitrage" dispatch tier (9router-inspired) — exploration → build.**
  Fan dispatch across genuinely-free backends + (later) N captured subscription-OAuth accounts, rotating on
  429/cooldown to exceed any single subscription's limit. Key finding: this is **extra SOURCE POOLS on our
  existing machinery, not a new provider engine** — pool identity is already `(provider, account[, model])`,
  the admission loop (`admitBatch` cost-first + spill) already IS the rotation engine, the `ReservationLedger`
  already does per-key backoff, and Claude/Codex/Copilot arbitrage accounts get live per-account quota for free
  via `BaseHttpQuotaSource`. Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass)
  except Kiro (AWS EventStream) + Cursor (protobuf). **Reuse (vendor+sync, MIT):** 9router's provider OAuth
  catalogue (`PROVIDER_OAUTH` + token-refresh endpoints/client_ids) — the someone-else-maintained table the
  corrected sourcing rule prefers; `ERROR_RULES` text classes. **Novel build:** a multi-account credential store
  + refresh-under-lock (encrypted, rotation-loss-safe) generalizing `ClaudeOAuthQuotaSource`. **Risks:**
  ToS/paid-account-ban (impersonating official CLIs — Claude/Codex/Cursor highest; opt-in, never default-on);
  token-security surface (multi-account refresh tokens; encrypted/never-logged/atomic — recall the Antigravity
  leak). **Phase 0 first slice (recommended, ~zero ban/security risk):** `opencode-free` (`Bearer public`) +
  `vertex-trial` (operator's own GCP $300 SA) as free source pools reusing `OpenAiCompatibleProvider` → priced
  ~0 by `deriveCostRank`, routed first, spill already handled. Then Phase 1 multi-account OAuth store
  (Claude/Codex/Copilot). Design of record + full phased plan in memory [[arbitrage-dispatch-tier-design]];
  a coverage diff (2026-07-07) confirmed 9router's price table adds nothing over models.dev, so skip it.
  Relates [[quota-dispatch-vision]] / [[dispatch-admission-control-design]] / [[cross-provider-quota-matrix]] /
  [[openai-compatible-provider]] / [[model-provider-ide-agnostic]].
  - **Phase-0 opencode-free — CODE-COMPLETE (A2 = declared seed + reactive verification, shipped 2026-07-08).**
    opencode-free is live-verified: base `https://opencode.ai/zen/v1`, public `/models`, free models via
    `Bearer public` returning `cost:"0"` (design premise held; docs' "API key" is the PAID tier). opencode-free
    is a pure-config `sources[]` entry (`api_key:"public"` + `cost_per_mtok:0`) — no provider code.
    - **Increment 1 — declared per-source cost seam → SHIPPED, commit `6349bdc5`.**
      `DispatchableSource.cost_per_mtok` → `deriveCostRank` rung 2a (declared 0 = free-first). The design memory's
      "deriveCostRank prices free ~0 automatically" was FALSE (non-models.dev ids → worst band); this is the real fix.
    - **Increment 2 — reactive cost verification → SHIPPED, commit `65ace2c1` (loop-core, full pipeline).**
      Provider extracts the endpoint-reported cost (opencode's `cost`) → `LaunchFreshSessionResult.observedCostUsd`;
      dispatcher closures relay it to `RollingDispatchResult`; the rolling engine's `handleResult` demotes a
      declared-free pool that reports cost>0 (folded into `selectProvider`'s degraded partition, once per pool) +
      fires a `declared_cost_drift` friction event. `driveRolling` shares ONE demotion set across sub-waves/levels so
      the demotion + single friction emit span the whole drive (adversarial-review catch — a per-dispatcher set
      leaked free-first back at each level boundary). Ships `examples/session-config/opencode-free.json` + README.
      Adversarially reviewed (1 MEDIUM found + fixed) + green (6063 tests). A2 (1+2) complete → arbitrage-tier
      release unblocked.
    - **vertex-trial → deferred** (needs operator's GCP $300-trial SA JSON).
    - **Remaining Phase-0 = env-bound live validations only** (no more code): a real opencode-free run confirming
      declared-free routing + a live lapsed-free demotion + the `declared_cost_drift` friction event end-to-end.
- **Cost↔speed dispatch dial + free-pool maximization (owner, 2026-07-07).** Generalizes the cost-first router
  — the minimum-cost corner of a cost-vs-throughput Pareto frontier — into a tunable operating point ON TOP of
  the kept router (does not replace it). Design of record now [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md);
  extends [[cost-first-routing-design]].
  - **✅ SHIPPED v0.32.34 (2026-07-08).** 1D dial, λ ∈ [0,1], capability a hard floor. Seven commits
    (substrate → Gate-0 capture → review hardening → concurrency pivot → R-1 fix + builder unification):
    - **Ordinal-blend admission ordering** (`admissionLoop.ts orderCandidates`): λ=0 = **byte-identical** to the
      pre-dial cost-first sort (adversarially confirmed); λ>0 blends per-axis ORDINALS within the capable set
      (total order, no scale-mixing). The dial reorders only — declaredCap/budget/ledger/claim gates untouched.
    - **Throughput axis = auto-derived declared CONCURRENCY** (`throughputOf` = `declaredCap`, null ⇒ +Infinity).
      **Superseded** the earlier "effective Mtok/s [rate∧concurrency∧speed]" sketch: that leaned on the deleted
      AIMD ceiling AND (v1 of this build) on declared TPM/RPM, which muted the dial on the percent-metered host
      and would have needed a manual rate declaration (owner: *a needed manual flag is a bug signal*, 2026-07-08).
      Concurrency is already on the pool, auto, honors "concurrency is declared or absent, never learned", and
      doesn't crown the sequential host (finite subagent limit < an uncapped parallel source).
    - **Gate-0 capture** = `provider_confirmation` durable policy: `provider-confirmation-input/v1` gains optional
      `dispatch_bias`; persisted on the shared confirmation (`readConfirmedDispatchBias`); both orchestrators
      thread it to `computeDispatchAdmission`. Headless auto-completes λ=0. Default 0 everywhere ⇒ zero behavior
      change until an operator sets it.
  - **✅ Adversarial pass on the concurrency axis DONE (2026-07-08) — found + fixed R-1.** The pass caught that
    `throughputOf = declaredCap (null⇒+Inf)` had RELOCATED R-1, not fixed it: the default zero-declaration
    claude-code host resolves `declaredCap=null` → crowned fastest AND monopolized the wave at λ=1 (null
    budget/cap). Root: `declaredCap==null` means opposite speeds on the host vs a source. Fixed (`a1bcc6a0`) by
    deriving throughput **pool-class-aware** (`deriveThroughputConcurrency`: source uncapped⇒+Inf, host
    unspecified⇒1-sequential) via an auto `is_conversation_host` discriminator — no manual declaration. **Also
    unified (owner steer):** the two near-duplicate AdmissionPool build maps DELETED → one shared
    `admissionPoolsFromSummaries`, so audit/remediate can't drift. Regression + non-vacuous ordering tests added.
  - **RESIDUAL / next — ALL CLOSED (owner, 2026-07-08):**
    - **`/models` concurrency probe — DROPPED (not deferred).** Owner ruled concurrency an almost-irrelevant
      primitive and banned *hunting* for a concurrency value: use a handed signal if one arrives, otherwise stop
      looking. No probe/discovery mechanism is to be built. The already-built consumer plumbing
      (`positiveIntCapOrNull` `src/shared/quota/apiPool.ts` → `concurrency_cap` → `deriveThroughputConcurrency`
      `src/shared/dispatch/admissionLoop.ts`) stays harmlessly ready for a *handed* signal.
      [[concurrency-is-declared-or-absent-never-learned]]
    - **B2 host-reorder seed — CLOSED.** The shipped provider-level `exclude`/`include` + `cost_order` on the
      versioned `provider_confirmation` contract (`src/shared/types/providerConfirmation.ts`) IS the host-reorder
      capability. No pool-keyed reorder field wanted.
  - **Free-pool maximization (dial-independent).** Price-0 pools are first-fill at every operating point → free
    is saturated before any paid pool automatically (`costRank` already delivers it once a source is registered).
    "Maxed" = saturated to the pool's declared sustainable ceiling (`declaredCap` + rate limits + reactive 429
    floor), NOT flooded. **Correction:** the old note said this "depends on C3-AIMD" — C3-AIMD is CLOSED; the
    ceiling is now `declaredCap` + reactive backoff, no learned ceiling. Real work = **register every free source
    as a pool** = the arbitrage-tier track [[arbitrage-dispatch-tier-design]] (Phase 0 zero-ban-risk first).
  - **OPEN (owner call):** whether QUALITY also becomes tradeable vs cost (a true 2D dial, needs a per-task
    quality-worth weighting) — default recorded = 1D cost↔speed + capability floor.

- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.
- **Minor provider/dispatch cleanups (low-pri, bundle opportunistically).**
  ~~providerFactory Rule 6 (`hasClaudeCodeConfig && claudeAvailable`) is a provable strict subset of Rule 9
  (`claudeAvailable`) — delete the redundant rung~~ — **FALSIFIED 2026-07-05 (verify-before-implementing).**
  Not a no-op: the opencode/codex *config-gated* rungs sit BETWEEN Rule 6 (claude config-gated) and Rule 9
  (claude bare-availability tie-break) and resolve to *different* providers. For a dual-configured operator
  (`hasClaudeCodeConfig && claudeAvailable && hasOpenCodeConfig && opencodeAvailable`), Rule 6 makes explicit
  claude config win; deleting it lets the opencode config-gated rung fire first → resolution flips
  claude-code→opencode. Rule 6 is a predicate-subset of Rule 9 but NOT redundant in the ordered table. Leave it.
  Remaining (still valid): inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic
  with its own dedicated test `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion,
  marginal — low value).
  Do NOT delete working proactive quota sources (`BaseHttpQuotaSource` + one-array register is already clean);
  `copilot` is correctly broker-only.

- **Schema-enforced generation — CE-004 residual (provider-blocked only).** The openai-compatible / NIM
  guided-decoding path is **SHIPPED** — the AuditResult `outputSchema` is plumbed through and the dispatch site
  sets it, so those endpoints get emit-time constraint (`guided_json` / `response_format: json_schema`). The
  sole residual is the always-on conversation host (`claude-code`), which advertises no API-level constraint
  mechanism → on that path CE-004 reduces to the repair floor (no emit-time prevention). Genuinely
  host-blocked, not a defect; unblocks only if that host gains a constraint endpoint.
  - **⬇ Live-run watch** on an openai-compatible run: results conform on first emit (repair rounds for
    schema-shape errors drop to ~0).

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.
  - **⬇ Live-run watch** (Codex backend, which nests agents): the driver-selection step must pick the
    **Y-dispatcher** path (thin dispatcher agent, no judgment) rather than slot-pull — confirm from the
    run's driver-selection log. Separately, on a metered run, pacing should slow *before* the wall (proactive)
    rather than only reacting after a 429. FAIL = slot-pull chosen on a nesting-capable host, or pacing that
    only ever reacts post-wall.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.
  - **⬇ Live-run watch** (run under each provider whose IDE/CLI you have — Codex CLI is available now):
    the provider's `QuotaSource` must return **live numbers off its real endpoint**, not the fixture/degrade
    fallback — confirm the quota reads are non-empty and move as the run consumes budget. Codex + Claude are
    reachable now; Copilot/Antigravity need those IDEs running. FAIL = a source stuck on degrade when its
    real endpoint is reachable.

- **D-66/67 SLICE-1 — merge-time ownership-gate on the long-lived claims (OD3 layer 2) — SHIPPED
  2026-07-09.** Commits `86e47077` (remediate: heartbeat probe before the cherry-pick in
  `acceptNodeWorktree` inside both locks; token threaded from all claiming call sites; contested-only
  fail-closed guard with ungated legacy fallback; quarantine-ref no-clobber; sidecar merged-regression
  guard) + `f2a4f91d` (audit: run-scoped `runs/<runId>/owner-tokens.json` token persistence; uniform
  claiming incl. the A-8 hybrid override path; `partitionByOwnership` on new `listLiveClaims` with the
  exported 20-min lease; owned-only claim clearing; merge-gate files added to `LOOP_CORE_PATTERNS`).
  Full-pipeline lap: design-level adversarial review caught 2 CONFIRMED design defects pre-impl
  (active-dispatch token clobber; hybrid tasks never claimed), post-impl review caught 2 CONFIRMED impl
  defects (staleness-blind partition + wrong merge-side lease window; legacy claims-less sessions
  bricked) — all fixed in repair rounds, re-review APPROVE.
  - **Accepted residual:** the probe window is staleMs-wide, not instantaneous — worst case is a stale
    LAND a beat before an imminent reclaim, never a double-land (base mutations stay serialized by the
    per-node + base-branch locks). Slice-3 heartbeat machinery shrinks it if a real cooperative run
    shows it matters.
  - **Discovered asymmetry (slice-2 input):** remediate's `phase:main` mutex has OD3 layer-1 only
    (`withClaimHeartbeat` wraps `advance()`, `nextStep.ts` ~4948), NO layer-2 re-check before persist —
    unlike audit's `auditStep.ts:216-239` template. Not mechanically mirrorable (remediate's persists
    are distributed inside `advance()`) → fold into the slice-2 pause/persist-shape design.

- **Unify the full rolling-dispatch lifecycle shell across audit + remediate (doc-review D-66/D-67/C-7,
  2026-07-08). Slice-1 SHIPPED (entry above); open = slice-2 shared pause reducer + slice-3 heartbeat.**
  Today the genuinely-shared surface is the *admission decision* only
  (`computeDispatchAdmission`, single-sourced in `audit-tools/shared`). Two lifecycle shells around it are
  NOT shared: (a) the pause lifecycle — audit owns `waiting_for_provider`/`pausedState.ts`/`filterNewProviders`;
  remediate has its own separately-implemented `quota_paused` analogue; (b) OD3's heartbeat + merge-time
  ownership-gate revocation protocol — wired only to the short-lived coordination mutexes
  (`withClaimHeartbeat` on bundle-mutation / `phase:main`), NOT the long-lived per-task/per-node execution
  claims (`task-claims.json`, remediate node-claims), which hold a long lease with no live heartbeat and
  rest on dedup-by-id at ingest; `mergeAndIngestCommand.ts` has no ownership gate. Owner decision
  (2026-07-08): the full lifecycle-shell sharing + OD3-on-long-claims is still-intended future work, not
  abandoned — this tracks it. Design-of-record specs
  ([`spec/multi-ide-concurrent-runs-design.md`](../spec/multi-ide-concurrent-runs-design.md) OD3;
  [`spec/audit-workflow-design.md`](../spec/audit-workflow-design.md);
  [`spec/remediation-workflow-design.md`](../spec/remediation-workflow-design.md)) now scope the shared
  claim to admission-math and point here for the unification. [[multi-ide-concurrent-runs-design]] /
  [[dispatch-admission-control-design]]
  - **Design-of-record from the 2026-07-09 recon (READ before building — it changes the target).**
    The driver + packet engine are ALREADY unified (both orchestrators run `driveRolling` over
    `createRollingDispatcher`); only the pause/resume TERMINAL adapter + OD3-on-long-claims are forked.
    Precise map: audit pause = `RollingEngineLifecycleState` (`src/shared/rolling/pausedState.ts`:
    `running|waiting_for_provider|terminal`; `advancePausedState` reducer; `LIVELOCK_PAUSE_LIMIT=3`; wired in
    `rollingAuditDispatch.ts advanceRollingPause`) — INTERNAL, self-advancing, livelock-bounded, partial-coverage-OK.
    Remediate pause = a `PartialCompletionTerminal{reason:"quota_paused", earliest_reset_at}` variant
    (`src/shared/quota/capacity.ts`; `nextStep.ts` ~4636; stranded nodes stay pending) — EXTERNAL, unbounded,
    host-retries-at-reset. **CRITICAL FINDING: full unification is the WRONG endpoint.** The resume SEMANTICS
    genuinely diverge — audit may bound-and-give-up to partial-coverage synthesis (read-only, safe); remediate must
    NOT abandon half-applied edit-nodes to "partial coverage" (a correctness hazard). So the livelock-terminal-vs-
    wait-forever branch MUST stay a per-orchestrator policy injection; `earliest_reset_at`-driven external resume has
    no audit counterpart. **Shareable core (the actual work, bounded):** (1) a shared pause-state reducer that
    REPRESENTS both, with the terminal-policy branch injected; (2) a shared `withExecutionClaim` = `withClaimHeartbeat`
    + the merge-time `registry.heartbeat(token)` ownership-gate (which today exists ONLY inline on the short
    bundle-mutation mutex, `auditStep.ts`:219), applied to the LONG-lived claims (`task-claims.json` 20-min lease,
    remediate node-claims 30s) that currently hold a lease with NO heartbeat + NO merge gate. **Architectural gotcha
    for (2):** the long claims are held across OUT-OF-PROCESS worker runs where the parent isn't looping, so there is
    no natural beater — adding a heartbeat needs a beating owner during the out-of-process span (non-trivial;
    likely the merge-time ownership-gate CHECK alone — refuse a merge whose lease a peer reclaimed — is the bounded,
    high-value first slice, deliverable WITHOUT the heartbeat machinery). **Recommended staging:** slice-1 =
    merge-time ownership-gate on `acceptNodeWorktree` + audit `mergeAndIngestCommand` (bounded, additive); slice-2 =
    shared pause reducer w/ policy injection; slice-3 = full heartbeat on long claims (only if a real cooperative
    run shows the stale-window is insufficient). This is a FOCUSED-LAP track — the most delicate machinery in the
    repo (pause/claim/quota), a genuine divergence to respect, and the owner's own "redesign before scheduled
    autonomy" caution applies; do NOT rush it as a tail-end change.

- **Collapse `leanFastPath` into the Dial A/B continuum as its lowest-risk tier (doc-review D-68) — SHIPPED
  2026-07-09.** The standalone `evaluateFastPath` boolean gate — a SECOND classifier that could DISAGREE with
  the intake risk tier (a grounded ≤5-finding batch touching `src/shared/quota` was "fast-path eligible" AND
  risk-tier `high`, and bypassed the pipeline anyway) — is deleted. Its finding-level simplicity signals now
  fold INTO the tier as escalate-on-evidence (`findingRiskEvidence` in `src/remediate/riskSignal.ts`: systemic /
  architecture-lens → high; ungrounded / below-high-confidence / coupled / >5 findings / >5 files → medium),
  and the lean path is taken IFF the effective tier is `low`. One classifier; the lean path is the `low` tier's
  realization (its light-review floor = `adversarialDepthForTier("low") === "light"`). New-lean ⊆ old-eligible
  (adversarially confirmed strictly safer — the unsafe direction is closed; a risk-subsystem grounded set now
  routes to the full pipeline). **Two intended consequences (accepted, both fail-safe):** (1) finding-evidence
  now persists into the tier, so a finding-quality-ineligible set gets `full`/`fine` downstream dials, not just
  full-pipeline routing (correct — more findings = more coordination risk); (2) the lean gate reads the intake
  tier computed over ALL original findings (escalate-only, never lowered), so a declined risky finding can deny
  the lean path to a clean approved handful — over-restrictive but fail-safe, and fixing it would violate
  escalate-only or re-diverge routing from the run tier. Design of record
  [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md). [[self-scaling-pipeline-not-forked-paths]]

- **Move the per-lap cadence rules (risk-tier + friction-walk) from host-habit to tool-enforcement
  (doc-review D-69) — LARGELY SHIPPED; residue is host-inherent / owner-deferred (assessed 2026-07-09).**
  Both halves were investigated this lap and are substantially tool-enforced already; no new mechanism was
  built because the missing pieces are either host-judgment-inherent or the owner-deferred autonomy redesign,
  and inventing a fragile gate would itself be the "add a step the host must remember" anti-pattern.
  - **Friction-walk half — SHIPPED (three enforcement layers, pre-existing).** (1) mechanical auto-capture at
    10 step boundaries (`src/shared/friction/stepBoundaryCapture.ts`); (2) an in-run BLOCKING per-category
    close-out — a run cannot present complete until every `FRICTION_CATEGORIES` entry is covered by an
    observation or an explicit "none" attestation (`src/shared/friction/triage.ts` `decideFrictionTriage`);
    (3) a session-end Stop-hook backstop (`.claude/hooks/friction-stop-gate.mjs`). The friction walk is NOT a
    host-remembered habit inside an orchestrator run.
  - **Risk-tier half — the in-run classifier is now SHIPPED via D-68.** The lap-level "trivial vs loop-core"
    routing the HANDOFF cadence describes is, WITHIN a run, the self-scaling risk dial — and D-68 (this lap)
    single-sourced that classification (the lean path is now the `low` tier, no parallel gate). So "the tool
    risk-tiers itself" is real for any work routed through the orchestrator.
  - **Genuine residue (accepted, not built):** (a) the LAP-level decision to route an item through the
    orchestrator vs hand-fix it is still host judgment — its tool-enforced end-state is "route substantive work
    through the self-scaling orchestrator" (the [[self-scaling-pipeline-not-forked-paths]] north star), not a new
    gate; (b) a hand-fix lap that never invokes an orchestrator produces no friction artifact, so it is covered
    only by the Stop-hook backstop (and only if a recent run artifact exists in its 12h window). Closing (b)
    mechanically (e.g. block session end on any commit-bearing lap lacking a friction walk) would be fragile and
    over-fire; deferred with `CLAUDE.md`'s "Redesign before scheduled autonomy" rather than force it.
  [[enforce-robustness-in-tooling-not-host-discretion]] / [[self-scaling-pipeline-not-forked-paths]]

- **Context-efficiency track (3 items, GrapeRoot-derived).** Investigated the `codex-cli-compact` /
  GrapeRoot context engine (2026-07-06); its open techniques map to three adaptable builds. GrapeRoot's
  core engine is closed and its benchmarks are vendor-reported — we take the *ideas*, not the code.
  **CROSS-CUTTING GUARD for all three: never break provider prefix caching.** Every change below MUST
  preserve the stable-prefix invariant already stated in
  [`spec/audit-workflow-design.md`](../spec/audit-workflow-design.md) §Prompt caching — *shared context
  (schema / instructions / repo metadata) at the FRONT = cache-eligible fixed prefix; agent-specific,
  turn-varying payload at the BACK*. GrapeRoot re-ranks `recommended_files` every turn, which is exactly
  the prefix-churning move that busts prompt caching — the anti-pattern to avoid. Any dynamic/session
  signal we add lives in the per-packet back payload and must never mutate or reorder the fixed prefix.
  A change that saves selection tokens but busts cache-hit can cost more than it saves; item (3) is the
  regression guard that makes that measurable.
  **Increment 1 SHIPPED (v0.32.38, 2026-07-08) — the piggybacked prefix-ordering fix (#4):** `buildPacketPrompt`
  (`src/audit/cli/dispatch/packetPrompt.ts`) now leads with the de-interpolated static `## Output` schema block as
  the cache-eligible fixed prefix and trails ALL per-packet volatile content; a tool-enforced test pins the ordering
  + prefix-purity invariant. This makes the cross-cutting guard real for the rest of the track.
  **Increment 2a SHIPPED (v0.32.39, 2026-07-08) — item (1) persistence spine:** `access_memory.json`, a first-class
  per-run audit artifact deterministically harvested from the ingested result ledger (frequency + step-ordinal recency
  + lenses) in `runResultIngestionExecutor`. Shared type `src/shared/types/accessMemory.ts`; pure `deriveAccessMemory`
  (`src/audit/orchestrator/accessMemory.ts`); DAG edge `access_memory.json → audit_results.jsonl`.
  **Increment 2b SHIPPED (v0.32.40, 2026-07-08) — item (1) scoring + bias:** `computeContinuityScores`
  (`src/audit/orchestrator/continuityScore.ts`) = deterministic personalized PageRank (α=0.85, fixed 20 iters,
  recency×frequency seed, `edited`>`covered`) over `graph_bundle` edges → biases packet ORDERING via single-sourced
  `orderReviewPackets` (strictly below priority) at the load-bearing sorts (`buildReviewPacketsFromPartition` +
  `fitPacketsToTierBudgets`). Cache-safe. Adversarially reviewed; folded fixes (tier-refit re-sort closing a
  pre-existing priority-monotonicity break, inert-thread removal, NaN guard).
  **Increment 2c SHIPPED (v0.32.41, 2026-07-08) — item (1) remediate parity:** deterministic harvest core
  single-sourced in `audit-tools/shared` (`deriveAccessMemoryFromEvents` over a normalized `AccessTouchEvent` stream);
  audit is a thin adapter (byte-identical). Remediate `deriveRemediationAccessMemory`
  (`src/remediate/state/accessMemory.ts`) populates `edited_count` from the declared edit surface of RESOLVED items
  (per-item `item_spec.touched_files`, block fallback) → `.audit-tools/remediation/access_memory.json`, written from
  the merge under the state lock. Adversarially reviewed (resolved-only not `resolved_no_change`, per-item attribution,
  crash guard). **Item (1) now complete on BOTH orchestrators.**
  **Increment 2d (item (2) `path::symbol` slicing) — CODE-COMPLETE, UNRELEASED (owner ran /start-lap "don't /ship"):**
  the mechanical anchor scanner (`src/audit/orchestrator/fileAnchors.ts`) assigns each TOP-LEVEL (zero-indent) symbol an
  approximate body span (`FileAnchor.end_line` = up to the next top-level decl, clamped to the file line count);
  `renderAnchorPreview` (`src/audit/cli/dispatch/packetPrompt.ts`) renders it as a `path:START-END` slice in the
  isolated-large-file back-payload with advisory "read the span for your lens, expand if evidence crosses" guidance.
  Design realization: packets hand PATHS + workers self-read, so the token lever is cutting god-file re-reads, not packet
  bytes — the guidance is the sub-file dispatch. Fail-safe (nested/indented bindings get no span → never fragment an
  enclosing span nor become spurious slices), cache-safe (back-payload only; fixed prefix untouched), zero schema/validator
  change (`total_lines` stays whole-file, citations stay real-file coords → no `coversAffectedSpan` false-fail).
  Adversarially reviewed (6 vectors REFUTED). Green build/check/audit+shared suite.
  **Remediate continuity CONSUMER + scorer single-sourced — CODE-COMPLETE, UNRELEASED (same "don't /ship" lap):**
  owner principle — auditor/remediator mirroring is common logic; the consumer should have been shared from the start
  (like the 2c harvest core), not audit-only. Scorer EXTRACTED to `audit-tools/shared` (`computeContinuityScores` +
  new single-sourced `continuityMassForPaths` reducer in `src/shared/continuityScore.ts`; graph primitives
  `normalizeGraphPath`/`collectGraphEdges` → `src/shared/graph/graphPaths.ts`); audit re-exports all four → 28+6 import
  sites + 2b behaviour byte-identical. Remediate consumer (`readRemediationAccessMemory` + `computeBlockContinuityScores`,
  `src/remediate/state/accessMemory.ts`) reduces harvested `access_memory.json` to a per-block mass (seed-only — remediate
  has NO graph), threaded via `DriveRollingDispatchOptions.continuityScores` → `toNode` → shared `ownershipSubWaves`
  (`OwnershipSchedulerNode.continuity?` = secondary sort key, strictly below file-disjointness, above `block_id`;
  no-op by default). Adversarially reviewed (6 vectors A–F REFUTED). Green (build/check/deadcode/full suite; 1 known
  hermeticity flake passes alone).
  **Item (3) token-efficiency eval harness — SHIPPED (this lap): `score-tokens` CLI + pure `scoreTokens` reducer +
  per-run `token-usage.jsonl` recording (`extractObservedUsage` on the openai-compatible path,
  `LaunchFreshSessionResult.observedUsage`, off-admission-path append) + provider-independent prefix-stability
  (hash of each recorded packet prompt's cache-eligible prefix from `dispatch-plan.json`). Track-don't-gate: exit
  wired only to a cache-hit-ratio regression vs `--baseline`. "Unmeasured" kept distinct from "measured zero";
  reader tolerates malformed ledger lines. Design-of-record [[access-memory-layer-design]].
  **The context-efficiency access-memory track is now COMPLETE — items (1), (2), AND (3) all shipped.**
  Follow-ups (non-blocking): remediate-side ledger writer (score-audit/score-tokens are audit-first; `observedUsage`
  already on the shared type); packet `task_ids`/`lens` attribution in the ledger (`DispatchPlanEntry` carries neither).

  - **(1) Session/run access-memory layer — bias packet composition toward already-touched code.**
    *Highest value.* We build the STATIC graph (`graph_bundle.json`) but keep no persisted cross-step
    record of what earlier steps actually read/edited/covered, so later packets re-include (and workers
    re-read) the same god-files cold every step — our known waste hotspot ([[worktree-large-files-reread-loop]]:
    large files re-read 15–21×/session). Build a persisted per-run access-memory that biases later
    packet selection + staleness prioritization toward continuity (files/symbols earlier steps touched
    are likelier relevant and cheaper to re-include). Invariants:
    - **Derive from existing result artifacts, not a new hook.** The signal is already latent —
      `AuditResult.file_coverage[]` records what each task covered; remediate node results record touched
      files. Harvest deterministically from what the tool already sees; do not add a host-side capture step
      (enforce-in-tooling, not host discretion).
    - **Cache-safe placement (the guard above).** The access-memory influence changes only *which*
      files/symbols the per-packet back payload includes — it MUST NOT reorder or re-weight anything in the
      fixed shared prefix. Confine all volatility to the back.
    - **Deterministic, content-derived order (no temporal churn).** Access is inherently temporal, but the
      persisted record MUST serialize path-sorted with per-path counters/flags as *values* — never an
      access-ordered array — or it churns the artifact content hash every step and cascades phantom
      staleness down the DAG (the standing "extractors emit stable, content-derived array order" invariant;
      cf. [[staleness-churn-repo-manifest-file-order]]).
    - **DAG-tracked artifact, not ad-hoc freshness.** The access-memory record is a first-class
      `.audit-tools` artifact on the explicit dependency map (`spec/audit/dependency-map.md`), so staleness
      propagates deterministically — never an ad-hoc per-step freshness check.

  - **(2) Symbol-addressable reads (`path::symbol`) — sub-file packet granularity.** *Smaller optimization.*
    When a lens needs one function from a god-file, dispatch a symbol slice, not the whole file, shrinking
    packet bytes. Symbol boundaries already exist deterministically in the extractors
    (`unit_manifest.json` / `surface_manifest.json`), so this enriches shared artifacts, not per-language
    forks. Invariants:
    - **Fail-safe to whole-file** when a symbol boundary is unavailable or ambiguous — never drop context to
      chase a slice.
    - **Coverage/citation semantics must stay valid.** `AuditResult.file_coverage[].total_lines` must match
      actual line counts (schema gate); define partial-read coverage as the symbol's line span (not the
      whole file) so the gate doesn't false-fail, and carry symbol-slice citations back to real file line
      ranges so the source-grounded citation gate (M-B3) still resolves.
    - **Cache-safe by construction** — slices are back-payload; the prefix is untouched.

  - **(3) Token-efficiency eval harness — measure, don't assert, context savings.** *Real gap.* We assert
    "budget context before LLM dispatch" but never measure per-step token cost, so a regression (or a
    caching-buster from items 1/2) is invisible. Build the COST counterpart to the A2 quality oracle
    (`score-audit`): a repeatable benchmark over a fixed prompt corpus × complexity levels reporting real
    input/output tokens **and prefix cache-hit ratio** per step, so cost and quality are the two measured
    axes (GrapeRoot benchmarks both). Invariants:
    - **Must surface cache-hit ratio / prefix stability explicitly** — this is what makes the cross-cutting
      caching guard enforceable: a change that cuts selection tokens but busts the cached prefix shows up as
      a cache-hit regression, not a phantom win.
    - **Measure from recorded run ledgers / headroom telemetry, not metered API calls.** Reading *actual*
      provider-reported usage of a completed run is post-hoc measurement (allowed); it does NOT violate
      "token estimates stay local and deterministic — never API-call token counting in planning/dispatch"
      (that rule governs planning, not after-the-fact benchmarking). Keep the boundary clean:
      `estimateTokensFromBytes` for planning; ledger/telemetry reads for the benchmark.
    - **Reuse the A2 corpus infrastructure** where possible so cost+quality run off one labeled corpus.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
  - **⬇ To close (after any live audit):** take that run's findings, hand-label each true-positive /
    false-positive into `corpus/<run-id>.labels.json`, then run `score-audit` → precision/recall. The
    labeling is ground-truth human judgment (can't be automated); one solid labeled run unblocks the oracle.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **`/remediate-code` GUI-host manual checklist (parity with `/audit-code`).** `spec/host-validation.md` is
  a manual GUI-host live-dispatch checklist for `/audit-code` only; `/remediate-code` has the automated
  no-drift gate (`verify:remediate-hosts`) but no equivalent manual GUI-host checklist, which the
  "keep orchestrators in parity" convention says it should have. Add a sibling `/remediate-code` checklist
  (or extend `host-validation.md`). Folds into the A7 release-time GUI checklist work.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **Doc-manifest scope for non-`docs/` host assets (doc-review D-45(a), owner call).** `.github/prompts/audit-code.prompt.md`, `.agent/skills/audit-code/SKILL.md`, and ~15 other un-manifested `*.md` outside `docs/` are not covered by `check-doc-manifest.mjs` (it scopes to `docs/**`). Now that a renderer drift guard pins the two audit host assets, the only residual is whether these should be *formally* listed in `doc-review-guidelines.md`'s routing table — a low-value owner judgment call, not code work.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment.** Prose-heavy fields feed
  downstream LLM prompts; a cosmetic edit forces wasteful re-emit. The narrowing = bounded judgment on
  meaning change, fail-safe to re-derive. Efficiency-only; defer until re-emit churn is measured.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **npm 12.0.0 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).**
  Any child `npm install` of a package with a postinstall (e.g. the audit-tools tarball) silently skips the
  script and warns `install scripts blocked because they are not covered by allowScripts`. The allowlist is
  SPEC-keyed per-project (`npm install-scripts approve <pkg>` writes `allowScripts` into the consumer's
  package.json); the global `.npmrc` `allow-scripts=["audit-tools"]` does NOT cover fresh temp-dir installs,
  and `--allow-scripts=<name>` on the CLI doesn't either. Working escape hatches: env
  `npm_config_dangerously_allow_all_scripts=true` (older npm silently ignores it — used by the packaged
  smokes' hermetic installs) or `npm install-scripts approve <pkg>` post-declare. Also new in npm 12:
  `npm pack --json` can emit an OBJECT keyed by tarball name instead of an array (smokes now tolerate both).
  Global `-g` reinstall of audit-tools bins: postinstall may be blocked → run `npm install-scripts approve
  audit-tools` / re-run postinstall manually and verify `~/.claude/commands/*.md` landed
  (extends [[audit-code-global-bin-traps]]).

- **Before starting ANY lap in a worktree, sync with remote main — landed work may be missing.** A worktree
  can be branched from a *stale* local main and miss commits that already landed on `audit-tools/main`. This
  session branched 4 commits behind and **re-implemented a full commit (admission-control 2a) already on
  main**, plus built 2b blind to a pinned design section it lacked — then had to `git reset --hard
  audit-tools/main` + cherry-pick + reconcile. First action of every lap:
  `rtk git fetch audit-tools main && git log --oneline HEAD..audit-tools/main` — if that lists commits,
  rebase/reset onto main BEFORE writing code. (Strengthens [[audit-tools-worktree-traps]].)

- **Background long-running command piped through `tail` hides interim progress.** Running a long command
  in the background as `cmd 2>&1 | tail -N` (e.g. `npm run release:patch:publish 2>&1 | tail -40`) makes the
  output file stay EMPTY until the command exits — `tail` buffers and only flushes its last N lines at EOF.
  To watch progress on a background job, do NOT pipe through `tail`; let the harness capture full output (it
  tails the file for you) or redirect to a file and `tail -f` that file separately. Observed 2026-07-08 during
  a release ship — polled an empty file for minutes before realizing the pipe was the cause.

- **`git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is
  NOT a rejection.** On a fast-forward push straight to `main` the remote emits that branch-protection
  message, but the ref still updates (`04a7338c..8279d0de  HEAD -> main`, no `! [remote rejected]`). Confirm
  by `git fetch audit-tools main && git rev-parse audit-tools/main` == local HEAD — don't assume the push
  failed on seeing the advisory. Observed 2026-07-08.

- **New remediate test files must import `makeState` from `tests/remediate/test-helpers.ts`, never re-declare it.**
  `INV-remediate-tests-03` (`tests/remediate/remediate-tests-invariants.test.ts`) fails loudly if any test file
  declares a standalone `makeState`. Wrap the shared helper (`makeState({ plan: {...}, items: {...} })`) instead.
  Observed 2026-07-08 (a new `access-memory.test.ts` tripped it).

- **`tests/audit/audit-code-completion.test.mjs` is the heaviest audit integration test (still-slow follow-up).**
  It drives the full multi-phase audit flow; as of 2026-07-08 it runs the next-step pump loops IN-PROCESS (calls the
  `cmdNextStep`/`cmdIngestResults`/`cmdForceSynthesis` handlers directly — they take argv and never `process.exit` —
  instead of spawning ~10 fresh `node` processes), which removed the subprocess overhead (~185-226s → ~105-121s
  isolated) AND the timeout-flake that forced wasteful isolation reruns. The 4 tests carry an explicit 300s timeout
  (`HEAVY_AUDIT_TEST_TIMEOUT_MS`) because the residual per-step work still balloons under max full-suite CPU
  contention and the global 120s default was too tight for THIS test (a false-negative, not a bug). **Open follow-up
  (make it genuinely fast):** the residual wall is repeated per-step repo extraction/staleness computation — investigate
  whether extraction needlessly re-runs on every next-step even when the temp repo is unchanged (if so that is a
  staleness-caching win that helps PRODUCTION too, not just the test); if inherent, consider pre-seeding artifacts to
  cut pump iterations. The CLI/wrapper subprocess path stays covered by `audit-code-wrapper.test.mjs` + the packaged
  smokes, so the in-process move lost no coverage.

- **Codex CLI is a poor executor for large read-heavy audit packets under a wall-clock budget.** Observed
  2026-07-04: 2 concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning.
  Route only small / low-line packets to the codex pool, or drop it from the audit executor pool for
  read-heavy work. (Durable routing lesson from the admission-control rework.)

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **The Bash tool is POSIX sh, NOT PowerShell — a PowerShell here-string (`@'…'@`) in a `git commit -m`
  becomes literal `@` characters** top-and-bottom of the message (`@\n<body>\n@`), silently corrupting the
  subject line. Seen twice in one lap (both caught pre-push, amended). For any MULTI-LINE commit/PR body,
  write the message to a temp file and use `git commit -F <file>` (single-line messages via `-m "…"` are
  fine). Applies to every native exe called from the Bash tool, not just git.
- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.)
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **A NEW `.claude/hooks/*.mjs` needs an explicit `!.claude/hooks/<name>` re-include in `.gitignore`.**
  `.gitignore` ignores `.claude/hooks/*` then allowlists each tracked hook by name (deliberate — never ship
  arbitrary `.claude` files). Adding a hook and committing WITHOUT the `!` exception silently drops the file
  from the commit; if `.claude/settings.json` (committed) references it, main now points at an untracked hook
  = broken state. Add the `!.claude/hooks/<name>` line in the same commit as the hook + its settings.json
  registration. (Bit once 2026-07-05: `friction-stop-gate.mjs`.)

- **A `\0` in a Write-tool template literal lands as a RAW NUL byte → binary-flags the source file.** Writing
  `` `${a}\0${b}` `` (a NUL pair-key separator) via the Write tool put a literal 0x00 in the `.ts` source, so git
  treated it as **binary** (`git diff` shows `Bin`/`- -`, grep-hostile) even though tsc/vitest read it fine. Same
  for an in-comment control char. Detect with `python -c "print(open(p,'rb').read().count(0))"`; fix by using a
  text-safe escape that stays a source escape (`U+001F` unit separator) or a printable delimiter. Never embed a
  raw control byte in source — prefer a `\uXXXX` escape the compiler resolves at runtime. (Bit once 2026-07-05:
  `src/shared/decompose/consensus.ts` pairKey.)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **Packaged/global-install drift is caught ONLY by `smoke:packaged-*` (`verify:release`), never by dev or
  vitest — so it fails the release gate loudly, not silently.** Two ways to break the tarball that pass every
  local check: (1) a production runtime `import` declared as a `devDependency` — devDeps are present in dev +
  the vitest suite, so only the packaged smoke hits `ERR_MODULE_NOT_FOUND` (when you add an `import` to any
  `src/` module that lands in `dist/` on a production path, confirm the package is under `dependencies`; bit
  once 2026-07-04 by `zod-to-json-schema` in `src/audit/contracts/workerSchemas.ts`); (2) deleting a *shipped*
  file that the smoke's `requiredPackagedPaths` list asserts (`scripts/audit/smoke-packaged-audit-code.mjs`,
  `verify-hosts.mjs`) → the gate fails on the missing tarball path. Diagnostic, not a silent trap: if
  `smoke:packaged` errors on a missing/absent module or path, this is why.
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.
- **`rtk` compresses files you need verbatim.** When reading the `audit-code` skill body or `docs/backlog.md`
  through `rtk read`, content gets partially summarized with retrieval hashes → not exact. For any file you must
  act on verbatim, use raw `Get-Content -Raw` (or the Read tool), not `rtk read`.
- **`rtk proxy` runs executables, not PowerShell cmdlets.** `rtk proxy Get-Content` / `rtk proxy Get-ChildItem`
  fail (cmdlets aren't standalone exes). Working form: `rtk proxy powershell -NoProfile -Command "..."`.
- **`rtk proxy rg` fails with `Access is denied`** (Codex/win32). Fallback: PowerShell `Select-String` (or the
  Grep tool).
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)
