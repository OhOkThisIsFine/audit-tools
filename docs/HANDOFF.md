# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.2** (both global bins reinstalled + verified live). v0.32.2 closed the four
  2026-07-02 contract-pipeline / intake frictions (intake guidance-file hijack, citation-grounding new-file
  infinite loop, polarity identifier-token masking; envelope re-derive confirmed a no-op) — see the "This lap"
  bullet below and `docs/backlog.md` → the now-✅ entries under "Open bugs / frictions — continued". v0.32.1
  fixed the implement-dispatch data-loss modes; v0.32.0 shipped **(A) same-file parallel dispatch** (optimistic
  + git-enforced) and **(B) remediate-code multi-host installer parity** (both ✅ in Forward tracks).
- **This lap (v0.32.0):** two forward tracks via a full `/remediate-code` contract-pipeline run.
  **Track A** pivoted (owner-approved) from the falsified semantic-anchor design to **optimistic same-file
  dispatch enforced at merge by actual git hunks**: `RemediationBlock.cofile_parallel_safe` (mechanical flag,
  set when `mergeBlocksSharingFiles` keeps independent same-file blocks separate + copied through
  `splitBlocksByContextBudget`); `ownershipSubWaves` batches both-flagged same-file nodes; `gitHunksForBranch`
  + relaxed `detectOverlappingEdits` on actual hunks; serialized cherry-pick stays the correctness authority.
  **Track B** = `wrapper/remediate-code-wrapper-install-hosts.mjs` (+ renderers/io/opencode/legacy), committed
  host assets (`.agent` SKILL is a source byte-copy), `scripts/remediate/verify-hosts.mjs` +
  `verify:remediate-hosts` in `verify:release`, body-derived drift guard.
  **Recovery note:** the run's own rolling accept/merge phase hit tool data-loss bugs (nodes silently
  stranded / false-`resolved_no_change`, cross-node verify deadlock — logged in `docs/backlog.md` frictions);
  the deliverable was landed via the **combined-reconciliation escape hatch** (per-node worktree implement →
  hand cherry-pick → full-suite once → merge-to-base), NOT the tool's own close phase. The
  `.audit-tools/remediation` run state is therefore abandoned/incomplete (gitignored, local-only) — safe to
  delete; the merged code on `main` is authoritative and full-suite green.
- **Prior lap (v0.31.4 — `091e403`):** folded `ensureWorktreeNodeModules` into `createWorktree`
  (`src/remediate/steps/{dispatch,rollingSession}.ts`) so a worktree can't be created without the
  node_modules junction. v0.31.3 shipped two remediate-code intake/merge tool-enforce fixes. v0.31.0 shipped
  the T5 forward-tracks remediation (five external analyzers). ecc-evaluation track fully closed.
- **Prior lap (repo-internal, unpublished — `a71f509`):** hardened the `pre-commit-gate.mjs` hook against
  hook-skip commits. The gate detected `git commit` but let `--no-verify`/`-n` and `core.hooksPath` overrides
  through — each disables the hook, making green-at-every-commit a no-op. Now rejects (exit 2) any detected
  commit statement carrying a skip token before running `check`. Test: `shared-core-invariants.test.mjs`
  INV-shared-core-16 (4 bypass payloads → exit 2, 2 benign → exit 0). Also closed 2 of the 3 ecc-evaluation
  spawn-safety leads: CVE-2024-27980 + tree-kill verified already-safe (no change); worktree node_modules sync
  remains open (`docs/backlog.md` → forward tracks). Hook+test not in the published `files` set → commit+push
  only, no npm publish. **Known limitation (fail-safe):** the regex gate also matches skip tokens inside a
  commit-message body, so a message *mentioning* `--no-verify`/`core.hooksPath` is blocked — reword to commit
  (it blocks, never wrongly allows).
- **Prior lap (v0.31.3):** two remediate-code fixes, both "move host-remembered correctness into the tool".
  (1) **Intake hijack + discovery-contextualize.** A `--guidance-file` now trips the `input_conflict`
  resume-vs-restart gate against a run past intake (was: silently resumed/executed the old unrelated run) —
  `NextStepOptions.guidanceFileSupplied` threaded into `buildPreIntakeObligations`. The single-candidate
  `confirm_auto_discovered_input` gate is now a discovered-sources MANIFEST (lists EVERY existing candidate via
  `InputResolution.allExisting` with type/mtime/finding-count), SKIPPED when an explicit source is present
  (breaks the old decline→re-offer loop), and a declined ack routes to `collect_starting_point`.
  (`src/remediate/steps/{nextStep,intakeResolver}.ts`, `index.ts`.)
  (2) **accept-node dirty-main-tree collision.** `dirtyMainTreeCollisions` detects a main-tree dirty file
  colliding with the node's touched paths BEFORE the cherry-pick; surfaces the actionable
  "commit or stash `<path>`" directive (was: opaque git error → identical auto-retries → human triage), work
  preserved under quarantine. (`src/remediate/steps/dispatch.ts`.) Tests: `intake-resolver.test.ts`,
  `next-step-resume-gates.test.ts`, `dispatch-worktree.test.ts`. Full remediate suite green (2111/0).
- **Test-runner consolidation — ✅ DONE (2026-07-02, repo-internal, unpublished).** The whole suite now
  runs on ONE runner (vitest) across `tests/audit` + `tests/shared` + `tests/remediate`; the node:test split
  (`test:node`, `node --test`, `tsx/esm` loader) was retired. Audit/shared `.test.mjs` files use vitest
  `test`/`describe`/`it` + `expect`; `node:assert/strict` is kept only for the four control-flow assertions
  (`throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` form (it runs fine under
  vitest). `npm test` = build + `vitest run`; single file = `npx vitest run <path>`. `vitest.config.ts`
  raises `testTimeout` to 120s (audit integration tests spawn real subprocesses; node:test had no per-test
  timeout). Framework-consistency guards updated (`shared-tests-invariants` INV-shared-tests-02,
  `audit-infra-architecture` ARC-843ce274-2). **No npm publish** — tests aren't in the published `files`
  set and dist is unchanged; commit+push to main only.
- **This lap (repo-internal, publishable):** fixed the three implement-dispatch data-loss modes the v0.32.0
  run exposed — merge-failed nodes no longer advance as accepted (hard-failure guard blocks any resolve claim
  when the accept quarantined, regardless of label), triage's already-satisfied reconcile now requires the
  node's declared `touched_files` to exist before `resolved_no_change`, and per-node verify drops a
  `targeted_command` that references a sibling's not-yet-created file (`selfContainedVerifyCommands`). Files:
  `src/remediate/steps/dispatch.ts`, `src/remediate/phases/triage.ts` (+ 3 test files). Full suite green
  (5562/0). Detail: `docs/backlog.md` → the now-✅ "Implement-dispatch silently strands/false-resolves nodes".
- **This lap (repo-internal, publishable):** closed the four 2026-07-02 contract-pipeline / intake frictions.
  (1) **Intake guidance-file hijack** — a present `conversation-start.md` now wins over a stale default
  candidate (`intakeResolver.ts` guards the default-candidate block on `!intake.conversationStart`).
  (2) **Citation-grounding infinite loop on new-file modules** — a path-shaped citation grounds when the path
  exists OR its parent directory is tracked (`buildKnownDirs`/`parentDir` in `contractPipelineGates.ts`), so a
  create-file deliverable no longer re-fires the gate; a fabricated-directory path still fails.
  (3) **Polarity substring classifier** — `assertionPolarity` masks multi-segment identifier tokens before the
  keyword regexes so a cited `-fail-` id can't flip a positive (`changeClassification.ts`).
  (4) **`.input.json` envelope re-derive** — confirmed already satisfied by the existing test-plan diff-carry +
  review-snapshot reuse (no code needed). Files: `intakeResolver.ts`, `contractPipelineGates.ts`,
  `changeClassification.ts` (+ 3 test files). Full suite green (5568/0). Detail: `docs/backlog.md` → the now-✅
  entries under "Open bugs / frictions — continued".
- **Immediate next:** none pending. Remaining candidates: deferred T5 items (clippy/rubocop live spawn; schema
  CE-004; churn C3/C5/C6/E4/E5); env-bound live validations. Delete the abandoned `.audit-tools/remediation`
  run state (gitignored) whenever convenient.
- **Multi-agent COOPERATIVE runs — ✅ COMPLETE (all 6 slices shipped, 2026-07-02).** Audit + remediate now
  let an arbitrary number of agents/IDEs join and contribute to ONE shared run (bundle-mutation mutex +
  disjoint task claims + per-agent step slot + per-run dispatch isolation + remediate phase mutex). The
  durable staleness-cascade-wipe trap is resolved; "one sequential call at a time" is superseded.
  **Remaining (env-bound):** live validation with two real IDEs driving one repo simultaneously.
- **Open items** (all in `docs/backlog.md`): live validation of the 5 new analyzers (clippy/rubocop fixture-only
  here — no Rust/Ruby repo). Design-direction tracks remain: parallel dispatch over overlapping files;
  multi-IDE concurrent runs.
- the owner runs live/rate-limited/deepening-capable runs routinely and reports back — this doc does not
  carry "needs live validation" reminders for code that's otherwise complete; treat anything below as
  code-complete unless it says otherwise.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline makes it the tool's own job.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`; don't
  trust the empty mechanical friction set.
- **Release:** `env -u CLAUDECODE npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run gate/test with `env -u CLAUDECODE`.
  Run `env -u CLAUDECODE npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
- **Branch-strand trap (bit twice already):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code
  implement node** — the tool's dispatch plan already names the correct worktree; a second isolation
  worktree strands the subagent's edits where `accept-node` can't see them. See backlog → durable traps.

---

## Suggested ordering — everything open, sequenced

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). Loop-infra (T1–T3) is COMPLETE end-to-end — nothing open on
those tracks. Remaining sequencing: cheap ergonomics (T4) → product/analysis tracks (T5) → deferred (T6).

### T1 — Self-scaling pipeline — ✅ COMPLETE
Design of record: [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)
([[self-scaling-pipeline-not-forked-paths]]). Nothing open on this track.

### T2 — Make the loop converge & safe — ✅ COMPLETE
Repair-cap/convergence-termination, friction detection wiring, and the quarantine-on-fail-loud data-loss
fix are all shipped. Nothing open on this track.

### T3 — Headline product capability — ✅ COMPLETE
Remediator auto-phasing (derivation + persistence + ordinal threading + scheduler barrier + per-phase
boundary gate) is fully shipped end-to-end. Nothing open on this track.

### T4 — Remaining host-friction inventory
Nothing open. All A/B/C/D items shipped (contract-pipeline host-friction inventory, phase-cut, boundary
gates, merge-to-base). Selective-deepening convergence (both known loops) has a shipped code fix; live
validation on a real deepening-capable run remains env-bound (T6-class).

### T5 — Product / analysis forward tracks
1. **Dead-code analyzer (knip) — slice 3, graph cross-check — ✅ SHIPPED v0.31.0** as a pure render-time
   join (normalized in-degree index + per-file/per-language fidelity gate + entrypoints from
   surface_manifest/critical_flows), sidestepping the obligation-ordering blocker. Nothing open.
2. **Deterministic analyzers — own-vs-acquire acquisition engine.** Git-history mining, gitleaks, jscpd,
   osv-scanner, and now (v0.31.0) clippy (cargo), rubocop (bundle), hadolint + actionlint (binary),
   type-coverage (npx) are all registered — the cargo/bundle runner families are now exercised. **Open:**
   clippy/rubocop landed fixture-only (no Rust/Ruby repo here → live spawn unvalidated); remaining
   ecosystem gaps if any. *([[deterministic-analyzers-own-vs-acquire]])*
3. **Schema-enforced generation — CE-004 residual + broader semantic checks.** Emit-time constraint seam +
   `total_lines` gate (CE-009) shipped; validator intra-result duplicate finding-id hard-reject shipped
   v0.31.0. Open: the always-on conversation host advertises no API-level constraint mechanism (provider-
   blocked); further semantic-validity checks are unbuilt candidates.
4. **Codebase-wide churn/context/enforce pass.** The 2026-07-02 pass ran (v0.31.0); its N1 (per-dispatch
   analyzer-anchor path index) and N4 (cap analyzer-signal lines) follow-ons shipped this lap. C3/C5/C6/E4/E5
   remain low-value/needs-design-intent. Re-run the lens broadly if worthwhile.
5. **remediate-code multi-host installer/generator parity — ✅ SHIPPED (v0.32.0).** Nothing open.

### T6 — Deferred / waiting (user-owned or low priority)
- A2 finding-quality oracle (needs a hand-labeled corpus); A7 release-time manual GUI checklist
  (Antigravity/OpenCode); provider `queryLimits` (revisit if a provider gains a proactive endpoint);
  headroom proxy final opt-in flip (the owner's own decision, proxy already verified healthy); narrow staleness
  on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured); cross-provider quota
  live-endpoint confirmation (Claude/Codex live-confirmed, Copilot/Antigravity gated→degrade).
  *(full detail in `docs/backlog.md` → "Deferred / waiting")*

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
