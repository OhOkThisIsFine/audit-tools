# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Quota-aware dispatch — SHIPPED; live validation env-bound.** The token-budget dispatch gate is
  code-complete (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees). **Still open:** live validation
  on a real rate-limited multi-worker run — cold-start calibration slope + the resume path especially
  want a live check. Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].

- **Friction detection — M-QUOTA escalation chain WIRED; live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is end-to-end on the remediate
  driver path (generic `recordRateLimit` hook + `rateLimit:{channel,text}` on `RollingDispatchResult` +
  retained `HostSessionQuotaSource` threaded through pool sizing AND dispatch). Unit-tested in
  `tests/shared/rollingDispatch.test.mjs`. **Still open:** (1) live validation on a real rate-limited
  run; (2) audit-side parity (`src/audit/orchestrator/rollingDispatch.ts` + `quotaPool.ts`) — the shared
  primitive supports the hooks, audit just needs to thread a retained source.
  [[meta-audit-friction-must-be-tool-enforced]]

- **Selective-deepening convergence — both known loops FIXED; live validation env-bound.** Loop #1
  (packet-result `task_id` ≠ assigned `deepening:*` id): prompt-side fix in `buildTaskSections`. Loop #2
  (idempotency_key collision across rounds): fixed by folding `task_id` into
  `buildResultContentDiscriminator`'s `deepening`/`steward` branch (`src/shared/contentKey.ts`). Both need
  a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks.
  - **TRAP (still relevant if this class regresses):** host-side unblock attempts do NOT work and actively
    corrupt gitignored run-state. Marking `status:complete` in `audit_tasks.json` is ignored; writing
    `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency
    keys clears the obligation but cascades stale `planning_artifacts`. **There is NO host-side unblock —
    the fix must be a code change, then a clean re-run.** A recovery affordance the tool SHOULD expose:
    `--force-synthesis` / partial-coverage escape that resyncs `artifact_metadata` and drives synthesis
    from the intact ledger without hand-editing artifacts.

## Forward tracks

- **Last-writer-wins seams → default LWW, but compare-on-conflict.** Policy idea: wherever a write is
  last-writer-wins, keep LWW as the cheap default but compare a monotonic marker on conflict and keep
  the newer/better. **Scope today is narrow:** correctness-critical seams are already NOT LWW (mutex-
  serialized with reload + merge-time ownership re-validation). The one true LWW seam is the **cosmetic**
  shared `steps/current-*` latest-pointer (`src/shared/io/stepContractWriter.ts`). Low value but a clean
  general guard for future seams. [[multi-ide-concurrent-runs-design]],
  [[enforce-robustness-in-tooling-not-host-discretion]].

- **Schema-enforced generation — CE-004 residual.** Emit-time constraint seam + `total_lines` gate
  (CE-009) + validator duplicate finding-id hard-reject are shipped. **Open:** the always-on conversation
  host (`claude-code`) advertises no API-level constraint mechanism → on the primary path this reduces to
  the repair floor (no emit-time prevention). Env-bound on a provider gaining a constraint endpoint.
  Further semantic-validity checks beyond `total_lines` / fabricated paths / out-of-range spans are
  unbuilt candidates.

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.

- **Deterministic analyzers: own-vs-acquire engine.** The acquisition engine, registry
  (`EXTERNAL_ANALYZER_CANDIDATES`), adapters (eslint, semgrep, gitleaks, jscpd, osv-scanner, clippy,
  rubocop, hadolint, actionlint, type-coverage), and consent gate (`admitSpawn`) are shipped. **Open:**
  clippy/rubocop landed fixture-only (no Rust/Ruby repo → live spawn unvalidated); mutation testing
  remains a gap. **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]

- **Remaining deterministic-analyzer work (DEFERRED).** Dead-code as a sound signal needs the full file
  universe + entrypoint provenance — knip/ts-prune territory, not a hand-rolled edge query (the shipped
  `deletion_candidate` low-in-degree signal covers the cheap version). Graph-query heuristics and
  extraction-persisted complexity/duplication/seams remain DONE (`deriveGraphSignals` pure reader).

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.

- **Codebase-wide churn/context/enforce pass — remainder.** The 2026-06-27 pass shipped its actionable
  findings. C3/C5/C6/E4/E5 are low-value / need design intent — unscheduled. Re-run the lens broadly
  when worthwhile.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy — final opt-in validation before global flip.** Proxy runs natively on Windows;
  `127.0.0.1:8787` livez/health 200, `/v1/messages` forwards intact. **Pending (user-owned):** one
  opt-in session confirming contract JSON survives compression before flipping the global
  `ANTHROPIC_BASE_URL`. [[headroom-proxy-broken-windows-no-rust-core]]
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
- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
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
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
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
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
