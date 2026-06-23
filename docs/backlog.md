# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

_(empty — the 2026-06-22 batch shipped 2026-06-23 in the `backlog-actionable-2026-06-23`
remediation: selective-deepening convergence, host-session quota awareness, report-promote
ENOENT single-source, always-ignore generated assets, and visibility-conditional deliverable
gitignore. Log new frictions here as you hit them.)_

## Forward tracks

_The 2026-06-22 forward-track batch shipped 2026-06-23 in `backlog-actionable-2026-06-23`:
autonomous audit→remediate→PR capstone (unattended mode + fail-closed non-destructiveness
allowlist gate), the external deterministic analyzers behind the adapter seam (ast-grep /
semgrep-dataflow / CodeQL-SARIF, degrade-to-empty), cross-provider quota real-shape
validation, mandatory independent-critic dispatch, and tool-emitted friction-capture
close-out in both orchestrators. Durable design captured in memory + CLAUDE.md._

- **Remaining deterministic-analyzer work (DEFERRED).** The external analyzers landed as
  fixture-validated **adapters** (parse + normalize + degrade-to-empty behind the seam); actually
  **spawning** a live native engine (ast-grep / semgrep / CodeQL binary) and wiring its real output is
  still out of scope — the adapter is ready for it. **dead-code** stays deferred: a sound signal needs
  the full file universe (pure orphans emit zero edges) + entrypoint provenance — knip/ts-prune
  territory, not a hand-rolled edge query (the shipped `deletion_candidate` low-in-degree signal covers
  the cheap version). The graph-query heuristics (cycles / hub / orphans / deletion-test) and
  extraction-persisted complexity / duplication / seams remain DONE (`deriveGraphSignals` pure reader).
- **Account-keyed quota pools — pool identity is `(provider, account[, model])`, not `provider/model`.**
  Spec'd in [`quota-dispatch-design.md`](quota-dispatch-design.md) §5: same provider + DIFFERENT accounts
  (e.g. Claude Desktop on account A + Claude CLI subagents on account B) are TWO independent pools with
  separate budgets — the intended way to scale aggregate throughput via a second account. Current quota
  keys (`buildProviderModelKey`, `parseProviderModelKey`) carry no account discriminator, so two
  same-provider accounts would alias to one pool and one credential's `/usage` would masquerade as both.
  Build: read account identity from each credential (Claude OAuth account/org; Codex `account_id`; …),
  add an account segment to the quota key, merge same-provider pools iff account ids match, keep separate
  otherwise. Self-gating must hold per `(provider, account)` so account B's source never probes A.
- **Cross-provider quota — LIVE-endpoint confirmation.** The per-provider mappings are validated against
  live-*shaped* fixtures and the capacity fold; confirming each source against its **real** endpoint
  (Claude/Codex live; Copilot/Antigravity gated→degrade) is environment-bound and still a recorded-
  evidence task, not a code gate. Per-provider recipes: [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md).
  Red line: self-monitoring own-provider only, never IDE-GUI automation.

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
