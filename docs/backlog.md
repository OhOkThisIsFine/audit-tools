# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Repro
  (run `20260622T023504252Z_audit_tasks_completed_001`): after the base pass, `deepening:finding:*` /
  `deepening:steward:*` tasks are created and counted pending, but the dispatch packager re-emits *base-unit*
  packets whose worker results carry packet-style task_ids (e.g. `flow:...:reliability:packet-3-…`) that don't
  match the assigned `deepening:finding:e0e34e19f3`. merge-and-ingest reports "Missing audit result for
  assigned task", spawns *more* deepening tasks, and loops forever — never reaching synthesis. Two sub-bugs:
  (1) packager dispatches wrong task_ids for deepening follow-ups; (2) workers omit `findings[].lens` (validator
  requires it) — only the top-level `AuditResult.lens` is set, so every deepening result is rejected until the
  per-finding lens is backfilled. Fix in tooling: deepening packet prompts must bind the worker output to the
  exact assigned `deepening:*` task_id, and the renderer/validator must force `findings[].lens` (default from the
  AuditResult lens). Until fixed, recovery = quarantine the orphan pending `deepening:*` tasks to let synthesis
  run (loses only second-pass verification of already-recorded findings). (Ethan, 2026-06-22.)
- **Dispatch is not aware of the host's own session/usage quota — hits the wall instead of adapting.** This run
  hit the Claude Code host session limit twice mid-dispatch (`You've hit your session limit · resets 10:30pm`,
  then `1:30pm`). Each time the in-flight workers returned a limit message instead of results (0 tokens, wasted
  dispatch), and the *only* adaptation was the operator (me) noticing the reset time and manually re-firing after
  it cleared. That is a tool defect, not an environmental fact: the auditor/remediator advertise quota-awareness
  (learned RPM/TPM, sliding window, 429/524 parsing, cross-provider `QuotaSource`), and the host session is the
  host provider's *own* quota — squarely inside the self-monitoring red line (own-provider-only; never IDE GUI
  automation). Expected behavior: (1) track the host session/usage budget (fixed-window reset, not just
  per-minute RPM/TPM) as a first-class `QuotaSource`; (2) pace/throttle concurrency *before* the wall and, when a
  worker returns a session-limit message, parse the reset timestamp, automatically pause, and resume at reset —
  no operator in the loop; (3) treat a limit-message worker result as a re-queue, not a consumed packet. The
  current `merge-and-ingest` "re-derive remaining from disk" path is reactive recovery, not the quota-aware
  adaptation the design promises. Extends the cross-provider quota matrix / quota-dispatch vision to the host's
  own session budget. (Ethan, 2026-06-22.)
- **Final-report promotion path mismatch — ENOENT on synthesis.** At synthesis the orchestrator logs
  `completed audit but could not promote final report to ...\.audit-tools\audit-report.md: ENOENT ... lstat
  '...\.audit-tools\audit\audit-report.md'`. Synthesis writes the promoted deliverables directly to
  `.audit-tools/audit-report.md` + `.audit-tools/audit-findings.json` (the documented final location), but the
  promote step — and the `present_report` step prompt — look for the source at `.audit-tools/audit/audit-report.md`,
  which is never written there. Harmless this run (deliverables exist at the right place) but the warning is noise
  and the `present_report` prompt points the host at a nonexistent path. Fix: single-source the promote source/dest
  and the prompt's report path off one path module. (Ethan, 2026-06-22.)
- **Gitignore generated skills + host assets (always-ignore).** `audit-code ensure` / install-hosts emit
  generated skill files (generated audit-code & remediate-code skills, host renderer outputs, etc.) into the
  working tree; these are build/install artifacts, not source — always add them to `.gitignore` so they don't
  show up as tracked/dirty state. (Ethan, 2026-06-22.)
- **Conditionally gitignore the canonical audit/remediation deliverables + meta-audit reflections — by repo
  visibility.** The process-conclusion documents — `audit-report.md`, `audit-findings.json`,
  `remediation-report.md`, `remediation-outcomes.json`, and the **meta-audit reflections** file — are NOT
  build artifacts; whether they belong in VCS depends on the repo's visibility:
  - **Private repo → do NOT gitignore** (keep them tracked; they're a useful in-repo record).
  - **Public repo → gitignore by default** (don't publish internal audit findings/reflections unless opted in).
  Detect visibility at install/ensure time (e.g. `gh repo view --json isPrivate`, fall back to a config flag /
  prompt when `gh` or remote is absent) and write the `.gitignore` rule accordingly — never hardcode either way,
  and make it overridable. This is distinct from the always-ignore build artifacts above. (Ethan, 2026-06-22.)

## Forward tracks

- **Autonomous audit→remediate→PR pipeline — the capstone.** The normal audit→remediate flow run
  unattended, with the human's selection step automated. Settled design (Ethan, 2026-06-22):
  - **Host-agnostic — same logic local or cloud.** The host is only a thin trigger/credential
    difference, never a fork of the decision logic.
  - **Selection = act as if the user picked the unambiguously-good items.** remediate-code already
    categorizes findings along a scale from unambiguously-good to ambiguous-design-choice-with-no-
    right-answer; the nightly run auto-remediates the unambiguously-good tier and leaves the rest.
    The ambiguity tier is the *only* selection axis — no token/cost gate, no run budget (deliberately
    dropped as unnecessary dev overhead).
  - **No durable rejection.** Items not auto-remediated are never marked rejected, declined, or
    pending in any persistent state — nothing suppresses them. They stay ordinary live findings, so a
    later run surfaces them normally.
  - **The leftovers are emitted as a standard audit deliverable.** The remaining actionable items —
    the audit minus {deduped, deemed-inappropriate, already-remediated, auto-fixed this run} — are
    written as a normal audit pair: a human-readable report plus its machine-readable findings JSON,
    identical in shape to any audit's output. So the human deals with them by simply running
    remediate-code against that audit like any other audit; acting on them is outside the nightly
    process's scope.
  - **Severity is presentation/ordering only**, never a gate or override — a critical-but-ambiguous
    item just lands in the leftover audit like everything else, for the human to act on later.
  - **Delivery.** Auto-applied fixes land on a branch; a PR is emitted when a remote exists (showing
    what was done and what remains), but the PR is not the primary artifact — the leftover audit
    deliverable pair is. The deliverables are always written to disk so an unattended cloud run with
    nobody watching still produces a consumable result.
- **Build the deterministic analyzers.** The INV-1 investigation decided the levers; building them is the
  forward work: AST/structural (tree-sitter, ast-grep), dead-code (knip/ts-prune), complexity/duplication,
  broader semgrep, CodeQL for dataflow. Each must enrich the shared language-neutral graph via the adapter
  pattern (in-process pure-JS, reproducible), never fork planning per ecosystem.
  - DONE (graph-query heuristics): cycles, hub fan-in/out, orphans, and the **deletion test (low-in-degree
    nodes)** are single-sourced in `src/audit/extractors/graphSignals.ts` (`deriveGraphSignals`), consumed by
    BOTH the design assessment and the risk register (new signals `member_of_cycle` / `is_hub` /
    `deletion_candidate`). `madge` was evaluated and **deliberately not added** — it would re-resolve imports
    the TS compiler analyzer already produces at higher fidelity, JS/TS-only; mining the heuristics as
    language-neutral graph queries over the merged edge set is the durable form.
  - DONE (extraction-persisted + edge-native signals): **complexity** + **duplication** are computed at
    extraction in `buildGraphBundle` (where per-file source is available) and persisted as the optional,
    additive `GraphBundle.node_metrics` contract (`js-ts-effective` reach, absent — not zero — for non-js/ts);
    **seam detection** ships as **bridges/cut-edges** over the undirected projection of the merged edge set
    (NOT the originally-imagined "repeated call-site signatures"). All three are exposed on `deriveGraphSignals`
    (a pure reader — complexity/duplication read `node_metrics`, seams derived from edges) and consumed by BOTH
    the risk register (bounded structural family) and design assessment. Durable lesson: the edge graph is a
    thin substrate — any signal richer than edge-topology must be computed at extraction (source/file-universe/
    entrypoints available there) and persisted as node metadata; `deriveGraphSignals` stays a pure reader.
  - OPEN: the remaining external analyzers (ast-grep, broader semgrep, CodeQL dataflow) — each needs an
    external/native engine, so per the two-tier dependency policy import a vetted tool behind the adapter
    seam rather than hand-rolling. **dead-code** is deferred here too: a sound dead-code signal needs the full
    file universe (pure orphans emit zero edges) + entrypoint provenance — i.e. knip/ts-prune territory, not a
    hand-rolled edge query (the shipped `deletion_candidate` low-in-degree signal covers the cheap version).
- **Cross-IDE/provider quota — real-host validation.** The per-provider HTTP `QuotaSource`s are built on
  `BaseHttpQuotaSource` (Claude OAuth source live + wired); the open work is validating each provider's source
  against the *real* endpoint (not just fixtures), folding learned-limit feedback + the capability handshake
  into one trustworthy capacity estimate per provider+IDE+model triple, degrading safely when a source is
  silent. Per-provider recipes: [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md). Red line:
  self-monitoring own-provider only, never IDE-GUI automation.

- **Enforce the independent-critic / counterexample dispatch in tooling — not host discretion.** The contract pipeline emits a conceptual-critique and a counterexample (adversarial critic) step, but today relies on the host *choosing* to dispatch them to an INDEPENDENT sub-agent (an author marking its own homework misses gaps). When the host advertises subagent-dispatch capability via the capability handshake, both orchestrators (audit-code + remediate-code) must MANDATE independent dispatch of those phases so the property holds for any host in any project — degrading to inline only when the host genuinely cannot dispatch. Instance of "enforce robustness in tooling, not host discretion."
- **End-of-run friction capture, tool-enforced for every project.** At the close of every audit and every remediation run, the orchestrator should emit an obligation for the host to record the friction it hit (non-obvious traps, tooling misbehavior, gate quirks, shell/env gotchas) into a per-project artifact. Today this only happens by dogfooding habit (notes land in *this* repo's `docs/backlog.md`); a host running audit-tools in another project gets nothing. Make friction capture a tool-emitted close-out step, everywhere.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built; remaining is
  the release-time manual GUI checklist run ([`host-validation.md`](host-validation.md)) + a gated Codex
  live-dispatch e2e.
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_CODEX_E2E=1`,
  `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy** — enable + validate the `headroom proxy` (auto-compresses tool-output traffic) in one
  opt-in session before any global env flip; delete the vestigial `DO_NOT_TOKEN_WRAP_NOTE` in `prompts.ts` if
  proxy traffic doesn't need it.
- **Staleness projection of prose-heavy artifacts** (design_spec narrative, rationales) deliberately NOT
  narrowed — those fields feed downstream LLM prompts, so stripping them under-fires staleness. Only safe per
  field if its downstream PROMPT input (not just the deriver) is proven not to read it. Efficiency-only; defer
  unless re-emit churn is measured as a real cost.

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Don't mask the test exit code.** `node --test … ; echo "exit=$?"` and `npm test > out; echo done` report
  the *trailing* command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races
  the output file, so a real failure reads as "green." Capture the suite's own status: `npm test > out 2>&1 &&
  echo PASS || echo "FAIL=$?"`. (Mis-reading a masked exit shipped a release whose CI then failed.)
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
