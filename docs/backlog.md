# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Friction detection — M-QUOTA escalation chain WIRED (remediate); live validation still env-bound.**
  The `recordLimit → escalate → strand → quota_escalation friction` chain is now fed end-to-end on the named
  remediate driver path. `createRollingDispatcher` gained a generic `recordRateLimit` write hook (fired at the
  `rate_limited` observation point BEFORE the `isPacketEscalated` read) plus a `rateLimit:{channel,text}` field on
  `RollingDispatchResult` carrying the worker ERROR/STATUS evidence (populated by `providerNodeDispatch`).
  `driveRollingImplementDispatch` constructs ONE retained `HostSessionQuotaSource` (onEscalation →
  `captureStepBoundaryFriction(quota_escalation)` with the driver's artifactsDir/runId) and threads the SAME
  instance through `buildConfirmedPools` (pool sizing) AND `driveRollingDispatch → createRollingDispatcher`
  (recordRateLimit + isPacketEscalated). Deterministic wiring unit-tested in `tests/shared/rollingDispatch.test.mjs`
  (same-packet account wall escalates past the bound → early strand before pools exhaust → onEscalation fires).
  **Still open (env-bound):** (1) live validation on a real rate-limited multi-worker run; (2) the A-8 hybrid path
  (`HybridSpillCoordinator`, ~nextStep.ts:1881) drives via the coordinator not `driveRollingDispatch`, so its
  anonymous host-session source is unfed — wire the same escalation route there once the live run validates the
  primary path; (3) audit-side parity (`src/audit/orchestrator/rollingDispatch.ts` `runRollingDispatch` +
  `quotaPool.ts`) — the shared primitive now supports the hooks, audit just needs to thread a retained source.
  Fits the dispatch capability-tiered driver track. [[meta-audit-friction-must-be-tool-enforced]]
- **Selective-deepening tasks never converge — packet result task_id ≠ assigned `deepening:*` id.** Workers returned packet-style task_ids instead of the assigned `deepening:finding:*`, so merge-and-ingest never matched results to tasks and looped. The prompt-side fix (explicit task_id binding in `buildTaskSections`) is in place but **needs live validation** — can't be verified without a real deepening-capable run. Recovery until validated: quarantine orphan pending `deepening:*` tasks to let synthesis run.

- **Dead-code gate — SHIPPED (knip default-mode); production-mode tested-but-unwired sweep is a manual track.**
  `npm run check:deadcode` (`knip --include exports,types,nsExports,nsTypes`, in `verify:release`) fails the build on
  any exported symbol with **zero consumers anywhere — including tests** (`knip.json`, `ignoreExportsUsedInFile:true`,
  entries = the real TS roots `src/audit/index.ts` + `src/remediate/index.ts` since the `.mjs` bins shell out to
  `dist/`). Wiring a new export into its production path is now part of "done". First run deleted 35 truly-dead symbols.
  **Why default-mode, not the literal "zero non-test consumers":** knip `--production` (which would catch the
  tested-but-unwired class directly) has REAL false positives — it can't trace dispatch-table / re-export-alias / dynamic
  wiring, so live functions like `runPlanPhase` / `resolveFreshSessionProviderName` flag as unused. It is therefore NOT
  gate-able. The tested-but-unwired class (the original git-history-extractor failure) is instead worked as a periodic
  **manual audit**: `knip --production` → filter to symbols with zero *grep-detectable* production callers (grep DOES
  find the dispatch/alias cases knip misses, so a grep-zero is a reliable dead signal) → delete symbol + orphaned tests.
  One such sweep ran this sprint (candidates manifested, ~26 confirmed dead + deleted). Re-run when worthwhile.
  [[deterministic-analyzers-own-vs-acquire]]

## Forward tracks

- **Dead-code / unused-export as an ACQUIRED audit analyzer (knip), graph-cross-checked, advisory-lead to the
  subauditor — resolves the deferred dead-code track.** Layer the tested-but-unwired / unused-export signal onto the
  audit engine's *other* mechanical resources so the orchestrator + subauditors consume it for TARGET repos (not just
  our own CI gate). Design of record:
  (1) **Acquire, don't bundle.** knip is an ecosystem-native JS/TS tool → a registry entry + normalizing adapter in the
  acquisition engine (`src/audit/extractors/analyzers/`), run ephemerally for JS/TS targets, degrade-to-empty
  elsewhere. Findings rejoin at the SAME seam as semgrep/eslint/gitleaks (`buildExternalAnalyzerFollowupTasks →
  mergeFindings`). Fits own-vs-acquire; enriches the shared finding contract, never forks planning.
  (2) **Cross-check against the engine's own graph — this is the whole point.** Production-mode knip has REAL false
  positives: it can't trace dispatch-table / re-export-alias / dynamic wiring (proven this sprint —
  `runPlanPhase`/`resolveFreshSessionProviderName` flag as unused but are live). The engine's language-neutral
  `graph_bundle` (calls/import edges) is exactly the substrate that closes that blind spot, and knip brings the
  full-file-universe + entrypoint provenance the bare graph-edge query lacked (the original deferral reason in
  [[graph-signals-thin-substrate-extraction-persist]]). knip ∪ engine-graph is the complete picture neither has alone:
  reconcile knip's "unused export" against the graph's in/out-degree + entrypoint set before surfacing.
  (3) **Advisory lead, LLM adjudicates — never a confirmed finding dumped in.** Because of (2)'s false positives, a
  reconciled candidate goes to the maintainability/dead-code lens subauditor as a *verification lead* ("knip says
  unused; graph shows N callers via <edge kind> — confirm truly-dead or refute as dynamic/entrypoint"), same adapter
  discipline as the other acquired tools. This is the LLM-in-the-loop seam, not a mechanical verdict. The same
  reconcile-then-adjudicate shape applies to ts-prune / other ecosystems' equivalents.
  Subsumes the deferred general dead-code track. (Ethan, 2026-06-30.)
  [[deterministic-analyzers-own-vs-acquire]] [[graph-signals-thin-substrate-extraction-persist]]
- **Precise `calls`/import edges via pure-JS `web-tree-sitter` (WASM) — candidate, deferred.** Our graph extraction
  (`src/audit/extractors/graph.ts`) resolves imports/calls by **regex**, which is approximate. A real AST pass would
  give precise `calls` edges. The OS-agnostic, no-native-build way (fits our two-tier dep policy + everything-agnostic
  principle) is **`web-tree-sitter` (WASM grammars)** as a new extractor behind the existing `GraphEdge` contract —
  borrow the *idea*, not a native toolchain. Surfaced by the 2026-06-28 evaluation of `safishamsi/graphify` (a Python
  tree-sitter knowledge-graph tool — not adoptable wholesale: native grammar wheels, Python stack, violates
  no-native-build). Secondary borrows from that eval: god-node/betweenness "surprise" signals, an
  EXTRACTED/INFERRED/AMBIGUOUS confidence ladder. Eval report: `graphify-evaluation.md` (saved to user Desktop).
  Efficiency/precision-only; defer until regex edge imprecision is a measured cost.
  ([[graph-signals-thin-substrate-extraction-persist]])
- **Three borrow-level leads from the `affaan-m/ecc` evaluation (2026-06-28).** ecc itself is not adoptable/applicable
  (agent-config distribution OS, wrong domain/stack — see `ecc-evaluation.md` on user Desktop), but a deeper pass
  surfaced three idea/reference-level leads worth acting on, none requiring vendoring:
  1. **Windows spawn-safety hardening** (highest value). ecc's `scripts/hooks/mcp-health-check.js` handles the same
     Windows shim class as our `resolveWindowsShimSpawnCommand` (`src/shared/providers/opencodeLaunch.ts`) +
     `spawnLoggedCommand.ts`, and additionally guards **CVE-2024-27980** (Windows `.cmd`/`.bat` arg shell-metachar
     injection — only shell-wrap `.cmd`/`.bat`, with a metachar-safety check) and does `taskkill /T` **tree-kill** so
     shell-wrapped children don't orphan on cancel. Action: (a) borrow the bare-command extension-probe fallback;
     (b) confirm our provider cancel/timeout path **tree-kills** on Windows (cmd.exe-wrapped children); (c) security-
     review our spawn path for CVE-2024-27980 (we just added `windowsVerbatimArguments` to the cmd.exe shim — verify
     arg-injection safety). Relates to the just-shipped headless-codex Windows spawn fixes.
  2. **Worktree shared-dep sync** — ecc2's `sync_shared_dependency_dirs` (`ecc2/src/worktree/mod.rs`) mechanizes
     node_modules sync into fresh worktrees; directly addresses [[worktree-tests-miss-integration-guards]] /
     fresh-worktree-no-node_modules. Borrow-idea for our per-node remediation worktree setup.
  3. **Hook bypass coverage** — ecc's `block-no-verify.js` also blocks the `git -c core.hooksPath=` bypass; confirm
     our `.claude/hooks/` commit gate (`pre-commit-gate.mjs`) blocks that vector too, not just `--no-verify`.
- **Codebase-wide churn / context / enforce-in-tooling pass — remainder.** Run one perspective over the whole
  codebase: hunt (a) **unnecessary churn** — anywhere we recompute / re-derive / re-dispatch more than the actual
  delta demands; (b) **unnecessary context** — anywhere we ship more than needed into a prompt or step; (c)
  **enforce-via-tooling prevention** — anywhere a correctness property held by host/maintainer discretion could be made
  impossible-to-get-wrong at the abstraction. The 2026-06-27 pass shipped its actionable findings (auth-session
  O(auth×files)→O(files), E1/E3/E2 write-scope + executor-registry + incomplete-coverage gates, C2 incremental
  graph-build, X1 prompt-render trim) and closed X-cluster state-projection as not-worth-it; full record in
  [`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md).
  **Remaining:** C3/C5/C6/E4/E5 are low-value / need design intent — unscheduled. Re-run the lens broadly when
  worthwhile. (Ethan, 2026-06-24.)

- **Schema-enforced generation everywhere possible — make malformed output impossible, not merely repairable.**
  Every structured-contract emission in the project — every dispatch path, every emitting agent, both orchestrators —
  should use the provider's strongest available output-constraint mechanism (forced tool-call / JSON-schema-constrained
  generation / structured output) so the schema is enforced at emit time and the malformed-output class is prevented at
  the source; where a provider cannot enforce a schema, that path degrades to the layered repair seam as fallback —
  prevention first, repair as backstop. Provider-agnostic: discover the capability per backend, never hardcode. The
  emit-time seam is present (`discoverOutputConstraintCapability`, `enforceSchemaAtEmit`, degrade-to-`runEmitValidateRepair`,
  one-validator re-validate floor); the semantic-validity gate (CE-009) hard-rejects a `total_lines` that diverges from
  disk past both an absolute floor and a ratio. **Open: CE-004** — the always-on conversation host (`claude-code`)
  advertises *no* API-level constraint mechanism, so on the primary path this reduces to the repair floor (no emit-time
  prevention) — env-bound on a provider gaining a constraint endpoint; plus broader semantic-validity checks beyond
  `total_lines` (fabricated paths / out-of-range spans already gated; more are candidates). (Ethan, 2026-06-24.)

- **Tool-enforced dispatch broker with a capability-tiered driver — rolling dispatch the host can't get wrong.**
  Desired end-state:
  (1) **A tool-enforced dispatch broker as the single chokepoint.** One gated primitive set — read quota, estimate
  per-task tokens (deterministic + local, per standing policy — never API token-counting), dispatch-an-auditor
  (refuses if it would exceed slots / rate / token budget), await-next-completion. No dispatcher can over-dispatch
  because the broker is the only door and it counts. Enforcement layer, independent of who drives.
  (2) **A capability-tiered driver, Y-primary.** Where the host supports agent nesting, the orchestrator dispatches a
  single thin *dispatcher agent* (Y) that runs the rolling loop through the broker tools and spawns auditors up to the
  gated limit — Y performs **no judgment**, only picks the next task and refills slots. Spin Y only above a task-count
  threshold. Where the host can't nest, the top host drives directly through the *same* broker, which releases the next
  slot only on a completion callback (slot-pull). The broker is the constant; the driver tiers by host capability.
  (3) **Classify capable agent hosts off the cold-start floor.** A host that runs parallel subagents (Claude Desktop /
  `claude-code` / `vscode-task`) must get agent-host concurrency, never the hosted-API first-contact cap.
  Enforcement (broker), driving (Y / slot-pull), and judgment (repair + staleness seams) are separate layers; when a
  judgment call costs a dispatch it flows through the same broker. The single-source classifier (`classifyProvider`),
  broker primitive (`computeDispatchCapacity` never-over-dispatch caps), `HostSessionQuotaSource` channel-isolated
  recordLimit + bounded escalation, and driver SELECTION + prompt rendering (`selectDispatchDriver`,
  `renderDispatchDriverInstruction`, single-sourced across both orchestrators) are **shipped**. **Open (env-bound):**
  live Y-dispatcher validation (needs a nested-agent host + a live run) + proactive pre-wall quota-aware pacing.
  (Ethan, 2026-06-24.) See the enforcement/driving/judgment separation principle in memory.

- **Deterministic analyzers: own-vs-acquire — build the agnostic acquisition engine, don't expand a fixed bundle.**
  A fixed bundle of analyzers fails the everything-agnostic test (it privileges whatever ecosystems we bundled
  for). The ideal end-state is a mechanism that **acquires and runs the right ecosystem-native mature tool on the
  fly** — also cheaper to own than a pile of per-language integrations (generalizes the two-tier dependency policy:
  don't hand-roll a Ruby analyzer, shell out to the mature one). Concretely:
  (1) **Own only truly-agnostic extractors** — signals with no ecosystem tool: git-history mining (shipped) and
  text/git-based secret scanning (acquired via gitleaks, shipped).
  (2) **Acquire everything ecosystem-specific on demand** (eslint, rubocop, clippy, mutation testing, hadolint,
  actionlint, type-coverage, jscpd, osv-scanner, …): detect ecosystem deterministically → capability-probe the
  runner (`npx`/`pipx`/`cargo`/`bundle`/…) → run ephemerally → normalize through the existing adapter seam →
  degrade-to-empty when runtime/tool is absent. The build is the *engine*; each tool is a registry entry + one
  normalizing adapter.
  (3) **Selection/safety gate without a maintained allowlist** — enforcement is mechanical run-safety written once
  (capability-probe, pin versions, sandboxed/read-only, degrade-to-empty, report-skipped-never-silently); a small
  value-curated DEFAULT set (high-likelihood × high-leverage × low-overhead — eslint/semgrep/gitleaks/git-mining/…)
  runs without asking; the LLM proposes ecosystem-appropriate tools for the repo; anything beyond the defaults needs
  per-run user consent (ephemeral, nothing persisted). No exhaustive allowlist to curate.
  (Ethan, 2026-06-24.)

- **Remaining deterministic-analyzer work (DEFERRED).** The external analyzers landed as
  fixture-validated **adapters** (parse + normalize + degrade-to-empty behind the seam); actually
  **spawning** a live native engine and wiring its real output is the acquisition engine specced under
  Forward tracks (own-vs-acquire) — the adapters are ready for it. **dead-code** stays deferred: a sound signal needs
  the full file universe (pure orphans emit zero edges) + entrypoint provenance — knip/ts-prune
  territory, not a hand-rolled edge query (the shipped `deletion_candidate` low-in-degree signal covers
  the cheap version). The graph-query heuristics (cycles / hub / orphans / deletion-test) and
  extraction-persisted complexity / duplication / seams remain DONE (`deriveGraphSignals` pure reader).
- **Cross-provider quota — LIVE-endpoint confirmation.** The per-provider mappings are validated against
  live-*shaped* fixtures and the capacity fold; confirming each source against its **real** endpoint
  (Claude/Codex live; Copilot/Antigravity gated→degrade) is environment-bound and still a recorded-
  evidence task, not a code gate. Per-provider recipes: [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md).
  Red line: self-monitoring own-provider only, never IDE-GUI automation.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and green (4 hosts);
  the provider-matrix in-process dispatch e2e (`tests/audit/provider-matrix-dispatch-e2e.test.mjs`, gate
  `RUN_PROVIDER_MATRIX_E2E=1`) runs the same bounded round-trip through every discovered provider (codex +
  openai-compatible/NIM live-verified 2026-06-28; opencode skipped when not installed) — adding a backend needs no new
  test. **Remaining:** the release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for
  the GUI-only hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned subtasks
  (can't be unit-tested; user-owned). Folds into the A7 checklist.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1` (in-process audit dispatch across all
  available providers — codex + openai-compatible/NIM live-verified 2026-06-28), `RUN_NIM_E2E=1` (hybrid-spill +
  remediate rolling), `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1` (autonomy capstone a9 — still
  NIM-hardcoded; candidate for the same provider-matrix generalization).
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy — final opt-in validation before global flip.** Proxy runs natively on Windows (optimize mode
  enabled; `headroom.exe proxy --port 8787` via scheduled task `HeadroomProxy`, hidden restart-loop VBS; `127.0.0.1:8787`
  livez/health 200, `/v1/messages` forwards intact). Traps captured in project memory
  ([[headroom-proxy-broken-windows-no-rust-core]]): MCP-server-locks-install on reinstall, `vcvars` env required for the
  source build, every upgrade rebuilds from source. **Still pending (user-owned):** the one opt-in session confirming
  contract JSON survives the proxy's compression before flipping the GLOBAL `ANTHROPIC_BASE_URL` (use the
  `claude-headroom.cmd` Desktop launcher).
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment, not per-field proof.** Prose-heavy
  fields (design_spec narrative, rationales) feed downstream LLM prompts, so a cosmetic edit currently re-fires
  staleness and forces wasteful re-emit even when the meaning is unchanged. The desired narrowing is NOT a
  hand-maintained per-field rule that a maintainer must prove and re-prove safe every time a prompt changes — that
  is brittle and incomplete by construction. Instead: a bounded judgment that decides whether the *meaning* relevant
  to downstream consumers actually changed, fail-safe in one direction only — **uncertain ⇒ treat as changed ⇒
  re-derive** — so a wrong call can only cost churn, never silently retain stale state. Efficiency-only; defer until
  re-emit churn on these fields is measured as a real cost.

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
- **`node --test` needs the tsx loader**: `node --import tsx/esm --test <file>` (bare `node --test` can't
  resolve `audit-tools/shared` via tsconfig `paths`). Same for `npm run test:single`.
- **Don't mask the test exit code.** `node --test … ; echo "exit=$?"` and `npm test > out; echo done` report
  the *trailing* command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races
  the output file, so a real failure reads as "green." Capture the suite's own status: `npm test > out 2>&1 &&
  echo PASS || echo "FAIL=$?"`. (Mis-reading a masked exit shipped a release whose CI then failed.)
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts (seen: `remediate-code --version` silent via junction, correct when the
  same dist ran direct). Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **`t.mock.module` is unusable** under the tsx/esm loader → use a dependency-injection seam instead.
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.** A
  delegated "delete N dead symbols + their tests" sweep (2026-06-30) spawned a deletion agent that itself spawned 3
  grandchild agents, all editing overlapping test files concurrently — they raced the parent's verification AND the
  main session's hand-fixes (file-modified-since-read churn, a half-reverted symbol re-applied after a `git checkout`,
  one agent bailed mid-task, one hit a weekly limit). Net: hours of reconciliation (re-reverts, a meta-guard fix,
  cascade-dead cleanup) for what one serial pass would have done cleanly. Rule: for a broad mechanical sweep over a
  shared file set, run it as ONE serial agent (or partition by NON-overlapping files), never an uncoordinated fan-out;
  and never hand-edit the same files while a background agent is live on them — wait for genuine quiescence (poll
  mtimes) or a completion signal first.
