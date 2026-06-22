# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

## Forward tracks

- **Nightly autonomous audit→remediate→PR pipeline — the capstone.** Scheduled run (cloud routine or local
  headless) → audit → auto-remediate actionable findings behind green gates → PR + report, escalating only
  ambiguity/low-confidence to Ethan. The next big build now that the architecture is stable and the A-9
  autonomy acceptance test passes.
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
