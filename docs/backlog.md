# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **remediate-code: stale unfinished run silently hijacks a fresh `--guidance-file`/`--input` call.**
  2026-07-01: a `next-step --guidance-file <new-scope>` call on a repo with an old unfinished run
  (`remediation/audit-full-sweep-20260630`) picked up and closed THAT run instead of starting fresh
  intake from the guidance file — reconciled 13 stale results and produced a ~1800-line diff unrelated
  to the new scope. It also hit a branch-switch error (blocked by uncommitted host files) and silently
  proceeded past it rather than surfacing the conflict. Host had to notice via `git status` after the
  fact and discard the diff by hand. Fix: when new intake (`--guidance-file`/`--input`) is supplied and
  an unfinished prior run exists, `next-step` should stop and require explicit confirmation
  (resume-old vs discard-and-start-fresh) rather than silently resuming the old one; a branch-switch
  failure during that resume should abort loudly, not continue on a different branch than intended.
- **remediate-code: `--guidance-file` doesn't override the `confirm_auto_discovered_input` offer.**
  Same session: after declining an auto-discovered stale `audit-findings.json` candidate once, the
  *next* `next-step --guidance-file <same file>` call re-offered the identical candidate again instead
  of proceeding to intake synthesis — only switching to `--input <path>` (pointing directly at the
  guidance file) broke the loop. Two wasted round-trips. `--guidance-file` should short-circuit
  default-candidate discovery entirely, matching what the loader's own documented flow implies.
- **remediate-code: intake `source-manifest.json` can point at a session-scoped temp path.** When the
  host supplies `--guidance-file` from a scratchpad/tempdir (the documented pattern for conversational
  input), the resulting `source-manifest.json` records that literal path — which is tied to the
  originating session and may not survive into a later session/new context window, silently breaking
  every downstream step that re-reads "Source Inputs". Host-side mitigation used this session: copy the
  guidance file into `.audit-tools/remediation/intake/` and repoint the manifest before ending the
  session. Tool-side fix: `next-step` should copy/persist a host-supplied guidance file into the
  run's own artifact tree at ingest time (mirroring what already happens for `--input` on an existing
  repo-relative path), not just record the caller-supplied path verbatim.
- **remediate-code: contract-pipeline step prompts sometimes cite `*.input.json` for tool-owned
  canonical artifacts.** `finalized_module_contracts.input.json` was listed as a "Required Input" in
  later contract-pipeline phases, but once merged from host-authored shards the real file is the
  tool-owned `finalized_module_contracts.json` (no `.input`) — the `.input.json` never gets rewritten
  for a tool-merged artifact. Required host-side workaround: telling every dispatched subagent "if that
  exact path doesn't exist, read the `.json` variant instead." Fix: step-prompt generation should name
  the actual canonical path for artifacts the tool owns, not always assume the host-input naming
  convention.

- **Dead-code — production-mode tested-but-unwired sweep (manual, periodic).** `check:deadcode`
  (knip default-mode, in `verify:release`) gates zero-consumer exports. The tested-but-unwired class
  (live but unreached in production) isn't gate-able (`knip --production` has real false positives on
  dispatch-table/alias/dynamic wiring) — worked instead as a periodic manual sweep: `knip --production`
  → filter to grep-zero-caller candidates → delete symbol + orphaned tests. Re-run when worthwhile; no
  fixed cadence. [[deterministic-analyzers-own-vs-acquire]]

- **Consent-gate for proposed analyzers — confirmed no gap; LLM-proposal channel deferred.** 2026-07-01
  verification: (1) `admitSpawn` (`src/audit/extractors/analyzers/acquisitionEngine.ts`) already gates
  EVERY `defaultRun: false` candidate — including `jscpd` (CP-NODE-2, `defaultRun: false` in
  `src/audit/extractors/analyzers/candidates.ts`) — behind a non-empty `consentToken`; confirmed, no gap.
  (2) There is no runtime path for an LLM to propose a brand-new analyzer id beyond the static
  `EXTERNAL_ANALYZER_CANDIDATES` array (`src/audit/extractors/analyzers/registry.ts`) — out of scope
  this round; if a future proposal channel is built, it must route through the same `admitSpawn`
  chokepoint, never bypass it. (3) Latent (not currently exercised) hazard: `SessionConfig`'s persisted
  schema (`ExternalAcquisitionConfig` in `src/shared/types/sessionConfig.ts`) does not structurally
  strip `external_acquisition.consent_token` on write/serialize — harmless today (nothing persists
  `SessionConfig` verbatim to a shared/committed artifact), but if a future proposal-channel writer ever
  round-trips `SessionConfig` through a persisted file, the token would leak. Flag for whoever builds
  that channel: strip or redact `consent_token` before any such persistence.

## Forward tracks

- **Dead-code / unused-export as an ACQUIRED audit analyzer (knip) — slice 3 (graph cross-check) open.**
  Slices 1+2 shipped: a consent-gated `knip` candidate joins via the existing generic
  `getExternalSignalPaths` seam (same as gitleaks/eslint/semgrep), no new wiring needed. **Open:** the
  priority chain runs `external_analyzers_current` before `graph_enrichment_current`, so `graph_bundle.json`
  doesn't exist yet at knip's dispatch time — a cross-check against in/out-degree + entrypoint provenance
  can't happen inline. Two options, neither built: (a) a new later obligation that re-opens persisted knip
  results once the graph exists and re-annotates confidence/suppression, or (b) give the per-file lens
  subauditor prompt direct graph context for `external_analyzer_signal`-tagged files so the LLM reconciles
  it at review time — cheaper, probably right, not yet validated. Entrypoint provenance for either option
  comes from existing graph edges (`package-entrypoint-link`/`workspace-package-link`/route edges) — no new
  `GraphBundle` schema field needed. [[deterministic-analyzers-own-vs-acquire]] [[graph-signals-thin-substrate-extraction-persist]]

- **Codebase-wide churn / context / enforce-in-tooling pass — remainder unscheduled.** The 2026-06-27 pass
  shipped its actionable findings (full record in
  [`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md)).
  Remaining candidates C3/C5/C6/E4/E5 are low-value or need design intent first — not scheduled. Re-run the
  lens broadly if worthwhile later.

- **Schema-enforced generation — CE-004 residual.** The emit-time constraint seam is shipped
  (`discoverOutputConstraintCapability`/`enforceSchemaAtEmit`, degrade-to-repair floor) and CE-009 (semantic
  `total_lines` divergence gate) is shipped. Open: the always-on conversation host (`claude-code`) advertises
  no API-level output-constraint mechanism, so the primary path still reduces to the repair floor — blocked
  on the provider gaining a constraint endpoint, not on our code. Also open: broader semantic-validity checks
  beyond `total_lines` (candidates, not yet built).

- **Deterministic analyzers: own-vs-acquire — build the agnostic acquisition engine, don't expand a fixed
  bundle.** Git-history mining and secret scanning (gitleaks) are the only two fully acquired/shipped.
  Everything else ecosystem-specific (eslint, rubocop, clippy, mutation testing, hadolint, actionlint,
  type-coverage, jscpd, osv-scanner, …) is still a fixed-bundle gap. Concretely:
  (1) **Own only truly-agnostic extractors** — done (git-history, secret scanning).
  (2) **Acquire everything ecosystem-specific on demand** — detect ecosystem deterministically →
  capability-probe the runner (`npx`/`pipx`/`cargo`/`bundle`/…) → run ephemerally → normalize through the
  existing adapter seam → degrade-to-empty when runtime/tool is absent. Not built: the engine is generic,
  each tool is just a registry entry + one normalizing adapter.
  (3) **Selection/safety gate without a maintained allowlist** — mechanical run-safety (capability-probe,
  pin versions, sandboxed/read-only, degrade-to-empty, report-skipped-never-silently) + a small
  value-curated DEFAULT set running without asking + LLM-proposed additions needing per-run user consent.
  Not built beyond the current curated default set.
  (Ethan, 2026-06-24.)

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; it needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall/hallucination.
- **A7 multi-host validation — release-time manual GUI checklist.** Automated coverage
  (`verify:hosts`, provider-matrix in-process dispatch e2e) is built and green. Remaining is the manual
  release-time GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only hosts
  (Antigravity/OpenCode), including that agent-scoped OpenCode permission allowances propagate to spawned
  subtasks — both user-owned, can't be unit-tested.
- **Gated live e2e flags (reference).** `RUN_PROVIDER_MATRIX_E2E=1` (in-process audit dispatch across all
  discovered providers), `RUN_NIM_E2E=1` (hybrid-spill + remediate rolling), `AUDIT_TOOLS_LIVE_QUOTA=1`,
  `RUN_AUTONOMY_E2E=1` (autonomy capstone a9 — still NIM-hardcoded; candidate for provider-matrix
  generalization). Skip without creds; run opportunistically, not a standing to-do.
- **Provider `queryLimits`** deferred — an absent method and a `null` return are handled identically, so stubs
  change nothing; revisit if a provider gains a real proactive rate-limit endpoint.
- **headroom proxy — final opt-in flip, user-owned.** Proxy runs natively on Windows and is verified healthy
  (`headroom.exe proxy --port 8787` via scheduled task `HeadroomProxy`; traps in memory
  [[headroom-proxy-broken-windows-no-rust-core]]). Pending: Ethan's own opt-in session confirming contract
  JSON survives the proxy's compression before flipping the GLOBAL `ANTHROPIC_BASE_URL`
  (`claude-headroom.cmd` Desktop launcher) — a decision to make, not a build task.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment, not per-field proof.** Prose-heavy
  fields (design_spec narrative, rationales) feed downstream LLM prompts, so a cosmetic edit currently re-fires
  staleness and forces wasteful re-emit even when the meaning is unchanged. Desired: a bounded judgment that
  decides whether the *meaning* relevant to downstream consumers actually changed, fail-safe in one direction
  only — **uncertain ⇒ treat as changed ⇒ re-derive**. Efficiency-only; defer until re-emit churn on these
  fields is measured as a real cost.

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

- **No host-side unblock for a stuck idempotency/discriminator-class convergence loop.** Confirmed
  2026-06-30 on the selective-deepening loop before its code fix: marking `status:complete` in
  `audit_tasks.json` is ignored (next-step regenerates in-memory each call); writing
  `partial_completion_terminal.stranded_ids` is overwritten by the next dispatch emission; appending clean
  results with unique idempotency keys clears the immediate obligation but can cascade downstream staleness
  and truncate artifacts. If this class of bug recurs: the fix is a code change to the idempotency
  discriminator, then a clean re-run — never a hand-edit of run-state. A supported `--force-synthesis`
  escape (resync `artifact_metadata`, drive synthesis from the intact ledger without hand-editing artifacts)
  would still be a useful recovery affordance to build.
- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes
  the tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because
  git cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒
  blanket-ignore. Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent
  against the committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/`
  line OUTSIDE the managed markers — delete it, the managed block owns the tree.
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
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A remediate-code contract run (2026-07-01, knip
  slice-3 graph-context module) needed 6 adversarial repair rounds before converging; every accepted
  counterexample was real, but at least 3 of the 6 rounds (CE-004 wrong adapter shape, CE-005/CE-006
  broken retry composition + an entirely separate already-shipped sibling pipeline the draft never
  referenced, CE-007–CE-010 a quality-field bug plus its own over-narrow justification) trace back to
  one root cause: the single upfront Explore pass before authoring the contract was scoped to "the two
  target files," not to "does equivalent logic already exist somewhere else in this codebase." The
  sibling pipeline (`buildPacketGraphContext`) was the single biggest lever in the whole repair history
  and a wider search would have surfaced it in the first round instead of the third. Lesson: before
  writing goal_spec/context_bundle/module_decomposition for a remediation contract, explicitly search
  for prior art doing something similar ANYWHERE in the repo (not just near the literal target files) —
  the cost of one broader Explore call is far lower than a full adversarial repair round.
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.** A
  delegated "delete N dead symbols + their tests" sweep (2026-06-30) spawned a deletion agent that itself spawned 3
  grandchild agents, all editing overlapping test files concurrently — they raced the parent's verification AND the
  main session's hand-fixes (file-modified-since-read churn, a half-reverted symbol re-applied after a `git checkout`,
  one agent bailed mid-task, one hit a weekly limit). Net: hours of reconciliation (re-reverts, a meta-guard fix,
  cascade-dead cleanup) for what one serial pass would have done cleanly. Rule: for a broad mechanical sweep over a
  shared file set, run it as ONE serial agent (or partition by NON-overlapping files), never an uncoordinated fan-out;
  and never hand-edit the same files while a background agent is live on them — wait for genuine quiescence (poll
  mtimes) or a completion signal first.
