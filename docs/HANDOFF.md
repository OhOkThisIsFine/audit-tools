# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.31.3** (both global bins reinstalled + verified). v0.31.3 shipped two
  remediate-code intake/merge tool-enforce fixes (see *This lap*). v0.31.2 shipped the two churn/context
  follow-ons from the 2026-07-02 lens pass. v0.31.1 fixed the contract-pipeline repair-revert bug. v0.31.0
  shipped the T5 forward-tracks remediation (five external analyzers, knip↔graph cross-check, validator
  duplicate-id reject).
- **This lap (v0.31.3):** two remediate-code fixes, both "move host-remembered correctness into the tool".
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
- **Immediate next:** none pending — the multi-agent cooperative-runs track is complete (see below).
  Next candidates are the other forward tracks in `docs/backlog.md` (parallel dispatch over overlapping
  files; the deferred T5 items). Env-bound follow-up for the shipped track: live two-IDE validation. Slice **3 (per-agent step slot) SHIPPED**: `stepContractWriter` writes each
  `next-step` process's prompt+JSON to a per-process `steps/<agentId>/` slot and returns `prompt_path`
  there (host already uses the returned path → concurrency-safe, no SKILL change) + a shared
  `steps/current-*` latest copy for back-compat; dispatch `runId` already auto-isolates per-run files, so
  the slice-2 boundary is closed. **The audit-side cooperative story is now complete** (bundle mutex +
  disjoint task claims + per-run isolation + per-agent step/prompt + stdout handoff). **Next: slice 4** =
  remediate `phase:<name>` claims for serial phases (plan/document/triage/close) so two joining peers
  don't both plan + make a second next-step join the rolling frontier by default (implement is already
  cooperative; the shared step-writer fix already covers remediate's step slot). Then slice 5 = rewrite
  the [[concurrent-nextstep-staleness-cascade-wipe]] trap as resolved.
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
5. **remediate-code full installer/generator parity** (only the SKILL.md drift-guard test shipped v0.31.0;
   the ~1200-line multi-host installer parity remains a forward track — see `docs/backlog.md`).

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
