# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.31.2** (both global bins reinstalled + verified). v0.31.2 shipped the two
  VERIFIED churn/context follow-ons from the 2026-07-02 lens pass (see *This lap* below). v0.31.1 fixed the
  contract-pipeline repair-revert bug. v0.31.0 shipped the T5 forward-tracks remediation via the full contract pipeline:
  (1) five new external analyzers clippy/rubocop/hadolint/actionlint/type-coverage (candidates + clippy/rubocop
  adapters + HADOLINT/ACTIONLINT BinarySpecs; `BinarySpec.checksumsAsset` generalized to a fn for hadolint's
  per-asset `.sha256`); (2) knip↔graph cross-check as a pure render-time join (normalized in-degree index +
  per-file/per-language fidelity gate + entrypoints from surface_manifest/critical_flows); (3) remediate-code
  SKILL.md no-drift guard test; (4) validator intra-result duplicate finding-id hard-reject; (5) churn/context/
  enforce review pass (`docs/reviews/churn-context-enforce-pass-2026-07-02.md`).
- **This lap (v0.31.2):** shipped the two VERIFIED churn/context follow-ons from the 2026-07-02 lens pass.
  (N1) The per-task/per-file analyzer-signal rendering re-flattened the whole `externalAnalyzerResults` set on
  every call → O(tasks × files × total-results) per dispatch. Now `buildAnalyzerSignalAnchorIndex`
  (`src/audit/orchestrator/fileAnchors.ts`) builds a path-keyed `Map<string, FileAnchor[]>` ONCE per dispatch
  (in `dispatch.ts`, beside `buildKnipGraphIndex`); `analyzerSignalAnchorsForPath` is now an O(1) index read.
  (N4) `renderTaskAnalyzerSignals` (`src/audit/cli/dispatch/packetPrompt.ts`) capped at 24 lines +
  omitted-count footer, mirroring the isolated-large-file anchor preview's `.slice(0, 24)`. Regression tests in
  `tests/audit/dispatch-helpers.test.mjs` (N4 cap) — pre-index tests re-pointed through the index builder.
- **Immediate next:** none pending from this sprint.
- **Open items from this run** (all in `docs/backlog.md`): live validation of the 5 new analyzers (clippy/rubocop
  are fixture-only here — no Rust/Ruby repo). Design-direction items filed: guidance-file discovery should
  contextualize not suppress; parallel dispatch over overlapping files is the target; multi-IDE concurrent runs.
  Two release-gate traps bit this run (both cross-cutting guards the per-node worktrees miss): the new dated
  review doc had to be registered in the doc-manifest, and `INV-K` id tokens in source tripped the glossary-ids
  guard — run `npm run verify:release` before tagging, not just node-level verifies.
- Ethan runs live/rate-limited/deepening-capable runs routinely and reports back — this doc does not
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
  headroom proxy final opt-in flip (Ethan's own decision, proxy already verified healthy); narrow staleness
  on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured); cross-provider quota
  live-endpoint confirmation (Claude/Codex live-confirmed, Copilot/Antigravity gated→degrade).
  *(full detail in `docs/backlog.md` → "Deferred / waiting")*

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
