# Backlog — open work, durable traps & future directions

A living **to-do list, not a status log**. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today." Design-level
specs for open items live in [`docs/remaining-specs.md`](remaining-specs.md) (collapse a spec section
to a shipped-pointer when its item lands). Shipped programs are one-line pointers under *Shipped* —
their rationale is in project memory + git history.

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Ambiguity-step `deemed_inappropriate` silently DECLINES the finding.** At `collect_clarifications`,
  `"action":"deemed_inappropriate"` reads naturally as "this candidate *ambiguity* isn't genuine — proceed
  with the finding," but the engine maps it onto the FINDING and drops it from implementation (lands in
  "Deemed Inappropriate", never coded). Silently dropped 5/7 approved findings in a real run (recovered by
  hand). Fix: an ambiguity marked not-genuinely-ambiguous must CLEAR the ambiguity and PROCEED with the
  finding (today's correct host action is `"action":"clarified"`), or rename the dispositions so "no
  ambiguity here" can't be confused with "drop this finding." A host that approved a finding at the review
  gate must not be able to lose it at the ambiguity gate by a natural word choice.
- **Dispatch node-test `targeted_commands` omit the tsx loader.** The implementation-DAG renders a `.mjs`
  test's verify command as `node --test tests/audit/x.test.mjs`, but every audit/shared `.mjs` test imports
  `audit-tools/shared` (tsconfig `paths`, honored only by tsx) with no built `dist/` in a per-node worktree
  → bare `node --test` can't resolve the import. Render node-test `targeted_commands` as
  `node --import tsx/esm --test <file>` so the in-process verify + the host command match. (Sibling of the
  now-closed `task_7d35176d` — the in-process per-node verify already runs `targeted_commands`, but it
  faithfully runs whatever was rendered, so a `node --test` without tsx still fails.)
- **Stale `remediation-report.md` short-circuits a fresh confirmed run to `complete`** (`task_2092be69`).
  `complete_redelivery` (`nextStep.ts`, `buildPreIntakeObligations`) emits `present_report:complete` when
  `state==null` + no `--input` + a prior-run report exists + no `conversation-start.md`/`extracted-plan.json`.
  Its `freshIntent` check ignores a ready `intake-summary.json` + host-confirmed `intent_checkpoint.json` —
  exactly the signal a NEW run carries right after `confirm_intent` — so a bare `next-step` re-delivers the OLD
  report instead of extracting. Fix: `freshIntent` must treat a ready intake-summary + `confirmed_by:"host"`
  checkpoint with no `state.json` as an active run, not a finished one. (Workaround: re-pass `--input`.)

## Design commitments not yet built

> Re-verify against `src` before picking one up — some may have been closed by the A-8 rolling/hybrid work;
> don't record build status in the design docs, re-run the design-doc-vs-code check.

- **`free_form_intent` clause escalation + remediate interpretation.** `interpretFreeFormIntentForAudit`
  (`intentInterpreter.ts`) produces `checkpoint_questions`/`has_unencodable` but is **unwired** (unencodable
  clauses silently dropped instead of escalated to a blocking checkpoint); and `remediate-code` still threads
  raw `free_form_intent` into worker prompts rather than interpreting it for priority/lens weighting.
- **Rolling per-node dispatch (remediate host path).** The design wants per-result re-scheduling
  (verify→merge→re-check newly-unblocked→dispatch into freed quota); the host path builds one wave per
  `next-step` gated on item *status*. (Largely a verify-vs-A8 question now.)
- **Provider confirmation Gate-0 (shared, session-level).** One provider confirmation spanning an
  audit→remediate run; today each tool resolves its provider independently.
- **Parallel module-contract phases (remediate).** `buildParallelModuleWaveStep` dispatches a single
  sequential agent over all modules, not N parallel per-module agents.
- **audit-code mid-run pause + scope annotation + folded ingestion.** `advancePausedState`
  (`shared/rolling/pausedState.ts`) is built but `rollingDispatch.ts` only detects stranded packets post-run;
  design-review prompts don't annotate units `[in scope]`/`[excluded]`; ingestion is a separate obligation,
  not folded into the dispatch turn.
- **Paired obligations (positive + negative test specs).** A behavior-*change* obligation should derive BOTH
  a positive test (new invariant holds) and a negative test (old behavior absent) so a partial implementation
  can't satisfy it. The no-prose-closure half shipped (`hasExecutableEvidence`); the paired-derivation half remains.

## Larger tracks

- **A2 — falsifiable finding-quality oracle.** Golden corpus, precision/recall + hallucination rate gated in
  CI. High value, own track. (Scorer + fixture corpus built; real scoring needs operator-authored
  `corpus/<run-id>.labels.json`.)
- **A7 — validate the host machinery EVERYWHERE.** Real install/verify/integration across Codex, OpenCode,
  Antigravity, VS Code — Claude Code is the only fully-validated route today. The automated half is
  `npm run verify:hosts` (in `verify:release`); the manual checklist is [`host-validation.md`](host-validation.md).
- **More deterministic analysis — investigate.** Push the deterministic frontier: AST/structural (tree-sitter,
  ast-grep), `madge`→a real graph-edge extractor, dead-code (knip/ts-prune), complexity/duplication, broader
  semgrep, CodeQL for dataflow. Each must enrich the shared language-neutral graph via the adapter pattern,
  never fork planning per ecosystem. (INV-1 decided per-lever; rationale in git history. Worth mining
  ralph-architecture-sweep's *heuristics* re-expressed as graph queries: deletion test, seam detection.)
- **Cross-IDE/provider quota detection — dependable capacity everywhere.** Proactive `QuotaSource`s SHIPPED
  for Claude/Codex/Copilot/Antigravity/OpenCode + the INV-QD-14 utilization spill; the open residual is a
  *trustworthy* per-provider+IDE+model capacity estimate validated against each real host (not just fixtures),
  degrading safely when a source is silent. Per-provider recipes: [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md).
- **Nightly autonomous audit→remediate→PR pipeline — the capstone.** Scheduled run (cloud routine or local
  headless) → audit → auto-remediate actionable findings behind green gates → PR + report, escalating only
  ambiguity/low-confidence to Ethan. Architecture is now stable + the A-9 capstone ran live, so this is the
  next big build (redesign-before-scheduled-autonomy is satisfied).

## Deferred / waiting

- **Staleness projection of prose-heavy artifacts** (design_spec narrative, rationales) deliberately NOT
  narrowed — those fields feed downstream LLM prompts, so stripping them under-fires staleness. Only safe if a
  downstream's PROMPT input (not just its deriver) is proven not to read the field. Efficiency-only.
- **DC-4** injectable `discoverProviders` stub (hermetic default; live roster supplies net-new).
- **Gated live e2es** skip without creds: `RUN_NIM_E2E=1`, INV-2 `AUDIT_TOOLS_LIVE_QUOTA=1`, A-7
  `RUN_CODEX_E2E=1`, A-9 `RUN_AUTONOMY_E2E=1`.
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned).
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy** — enable + validate the `headroom proxy` (auto-compresses tool-output traffic) in one
  opt-in session before any global env flip; delete the vestigial `DO_NOT_TOKEN_WRAP_NOTE` in `prompts.ts` if
  proxy traffic doesn't need it.

## Durable traps (environment / tooling reference)

Still-live gotchas worth keeping for any agent (strong or weak):

- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **`t.mock.module` is unusable** under the tsx/esm loader → use a dependency-injection seam instead.

## Shipped (pointers — durable rationale in project memory + git)

Collapsed once-landed; see the named memory for design rationale:

- **A1** lean fast path · **A3/A4** one shared `advance` engine + canonical `RemediationItem`/status hub ·
  **A5/A11** vetted manifest parsers (`smol-toml`/`yaml`) · **A6** zod single-source contracts · **A8** hybrid
  spill topology, both tools, DC-4, live crit-3 both sides (`0.28.10`) · **A12** single-package collapse ·
  **B1** magic-numbers audit · **B2/B3** semantic-projection staleness + diff-based re-review (both tools) ·
  **B4** refuted-finding quarantine · **B8** finding-merge identity discriminator · cross-package **drift
  consolidation** · **review-necessity approval gate** · **cross-provider proactive quota sources**
  (Claude/Codex/Copilot/Antigravity/OpenCode) + INV-QD-14 utilization spill · **headroom** replaces opentoken
  (host proxy) · the **dogfood bug fixes** (rolling-implement Windows shim, write-scope-enforced-at-accept,
  accept-outcome diagnostics, `--input` resume, lens proposition table, standardized per-finding block,
  up-front ambiguity gate) · **heterogeneous dispatch** (2nd NIM pool + per-slot provider resolution, via A8).
