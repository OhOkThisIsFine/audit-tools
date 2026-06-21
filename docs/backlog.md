# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

_(none open — add the moment you hit one)_

## Forward tracks

- **Nightly autonomous audit→remediate→PR pipeline — the capstone.** Scheduled run (cloud routine or local
  headless) → audit → auto-remediate actionable findings behind green gates → PR + report, escalating only
  ambiguity/low-confidence to Ethan. The next big build now that the architecture is stable and the A-9
  autonomy acceptance test passes.
- **Build the deterministic analyzers.** The INV-1 investigation decided the levers; building them is the
  forward work: AST/structural (tree-sitter, ast-grep), promote `madge` (already shelled in `anchorGrounding`)
  to a real graph-edge extractor, dead-code (knip/ts-prune), complexity/duplication, broader semgrep, CodeQL
  for dataflow. Each must enrich the shared language-neutral graph via the adapter pattern (in-process pure-JS,
  reproducible), never fork planning per ecosystem. Worth mining ralph-architecture-sweep's *heuristics* as
  graph queries: deletion test (low-in-degree nodes), seam detection (repeated call-site signatures).
- **Cross-IDE/provider quota — real-host validation.** The per-provider HTTP `QuotaSource`s are built on
  `BaseHttpQuotaSource` (Claude OAuth source live + wired); the open work is validating each provider's source
  against the *real* endpoint (not just fixtures), folding learned-limit feedback + the capability handshake
  into one trustworthy capacity estimate per provider+IDE+model triple, degrading safely when a source is
  silent. Per-provider recipes: [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md). Red line:
  self-monitoring own-provider only, never IDE-GUI automation.

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
