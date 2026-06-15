# Backlog — known friction, deferred fixes & future product directions

A living log of things to fix or build later, so they are not lost between
sessions. This is also the home for deferred product-design specs that are still
too early to encode as implementation contracts.

**Remove an entry once it ships** — this is a to-do list, not a status log. When
an item needs design detail, record durable contracts, gates, and principles
rather than "where the code is today."

> **Last reconciled 2026-06-13** against the shipped rolling-dispatch redesign +
> the self-audit remediation. Removed (verified against current `src`): the whole
> "2026-06-11 dogfood" friction block — lens interactivity, conceptual-review
> depth, `wave_size`→rolling, host-only `next-step`, canary, packet proximity,
> quota pre-check — all resolved by the redesign; the stale "waves" wording item;
> and the shipped-status entries (workflow redesigns, contract-pipeline build,
> agent reflections, scope/intent checkpoint, structured fast-path). A design-doc
> drift check ran the same day — unbuilt design commitments are now tracked under
> *Design commitments not yet built*.
>
> **Re-reconciled 2026-06-13 (second pass)** against `src`: removed the `opentoken
> wrap` friction and the orchestrator opentoken work-item (verified gone from src;
> guard test `no-opentoken-guard.test.mjs`; superseded by the headroom proxy);
> narrowed the `free_form_intent` commitment to its genuinely-unbuilt halves —
> clause escalation (`interpretFreeFormIntentForAudit` still unwired) and
> remediate-code interpretation (audit-code no-verbatim + lens weighting already
> shipped).

## Known friction (agent / dev experience)

- **`quota` command silently drops the capability-handshake flags.** The
  informational `quota` command parses neither the scalar
  `--host-context-tokens`/`--host-output-tokens` pair nor
  `--host-models`/`--host-model-id`, so its capacity estimate reflects only
  cached/learned limits. Low stakes (read-only diagnostics); wiring the flags
  would make it useful for previewing roster capacity. (The other half of this
  entry — `run-to-completion` — was resolved 2026-06-12 by deleting the batch
  loop entirely; `next-step` is the only terminal loop.)

- **Run CLAUDECODE-unset tests via the PowerShell tool, not nested `cmd /c`.**
  `cmd /c "set CLAUDECODE=&& npm test"` from inside the bash tool printed only the
  cmd banner and swallowed all test output. `$env:CLAUDECODE=$null; npm test` in the
  PowerShell tool works cleanly. (Spotted 2026-06-12 during N6.)

- **Implement-worker result `finding_id` placeholder is ambiguous → merge rejects.**
  `prepareImplementDispatch` renders the result template as `"finding_id": "FINDING-ID"`
  with a tempting `Satisfies obligations: FND-*` line just above it, so standard-tier
  workers report the `FND-*` *obligation* id (and split one node into several
  `item_results`) instead of the node/item id shown under `## Items` / `Findings:` —
  the `N-*` key that `state.items` is actually keyed by. `merge-implement-results`
  then throws `Unknown finding_id in implement result: FND-…`. The correct id is just
  `block_id` minus the `CP-BLOCK-` prefix. Fix in the renderer: emit the real node id
  into the template and instruct "one item_result per item id under ## Items; never use
  the FND-* obligation ids." Workaround 2026-06-13: inject the exact node id into each
  worker's dispatch wrapper prompt — eliminated the error for 11/11 wave-2 blocks
  (3/7 wave-1 blocks hit it and needed post-hoc result-file patching).

- **Global install defers `postinstall` under npm's allow-scripts policy.**
  `npm install -g auditor-lambda` installs the bin but prints
  `npm warn allow-scripts … (postinstall: node scripts/postinstall.mjs)` and skips
  it, so the host-integration deploy (OpenCode config + `/audit-code` skill/prompt)
  silently doesn't run. Finish with `npm approve-scripts auditor-lambda` or invoke
  `postinstall.mjs` manually. (This also gates the overbroad-perms deploy flagged
  by `CFG-4996560e`, so it's not purely a regression.)
- **`t.mock.module` is unusable in audit-code tests.** audit-code runs tests via
  `node --import tsx/esm --test`; `t.mock.module` needs
  `--experimental-test-module-mocks` and conflicts with the tsx/esm loader, so it
  throws `t.mock.module is not a function`. Use a dependency-injection point
  instead (e.g. `cmdWorkerRun(argv, deps)` in
  `src/cli/workerRunCommand.ts`) rather than module-graph mocking.
- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`. (The
  orchestrator-rendered command path now routes through the shared
  `renderPromptCommand`/`toPromptPathToken`, so this is mainly a trap for
  hand-typed or inline `node -e` commands.)
- **The `Bash` tool mangles Windows backslash paths.** A plain command like
  `node C:\…\audit-code.mjs merge-and-ingest …` run through `Bash` drops the
  backslashes (`C:\a\b` → `C:ab` → MODULE_NOT_FOUND). Use the `PowerShell` tool for
  Windows-absolute-path commands, or forward slashes (Node accepts `C:/…`). The
  orchestrators now emit POSIX-slash commands for this reason (`renderCommand`), so
  the trap is mainly for hand-typed paths. The `opentoken wrap` step-JSON mangling
  friction graduated to a command-class wrap policy — control-plane commands are
  wrap-exempt, encoded in the dispatch prompts + memory
  `opentoken-wrap-mangles-orchestrator-prompts`.
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.
- **New default-on orchestrator behavior breaks existing fixtures.** Turning a
  dispatch behavior on by default can change first-contact output and break
  end-to-end fixtures that assumed the old shape; the fix at the time was seeding
  the old default in the test helper. Any new default-on behavior needs a sweep of
  existing fixtures, or should ship default-off until they catch up. (The original
  canary example is gone — the canary→graduate phase was removed entirely — but
  the lesson stands.)
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` because the `.mjs` tests import built `.ts` via `.js`
  specifiers. Use the canonical `node --import tsx/esm --test …`, as in the
  package's `test` script, or `npm run test:single -- tests/<file>.test.mjs`. This
  is a trap when running one test file by hand or telling a subagent to "run
  node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a
  later `npm run check -w packages/<pkg>` fails with *No workspaces found* because
  the path doubles. Use a subshell `(cd … && …)` in Bash, or pass absolute paths
  and `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.
- **PowerShell block output cannot be piped inline after a `foreach` statement.**
  A shape like `foreach (...) { ... } | ConvertTo-Json` throws "An empty pipe
  element is not allowed"; assign the loop output first (`$out = foreach (...) {
  ... }`) and pipe `$out`.
- **PowerShell `-Filter` is not a regex.** Patterns like
  `document-FINDING-00[1-6].result.json` can match nothing even when files exist;
  use `Where-Object { $_.Name -match '...' }` for numbered result checks.
- **PowerShell unwraps single-element arrays in `ConvertTo-Json`.** `@(@{...})`
  collapses to a bare object, so a one-result `submit-packet` payload serializes as
  an object instead of a 1-element array and is rejected. Workers had to
  string-concat the surrounding `[`/`]`. The packet and worker prompts now carry
  this guidance (bracket-wrap the output, or `Write-Output -NoEnumerate`).
  (Sibling of the `foreach`/`-Filter` PowerShell traps above.)

- **`--host-can-dispatch-subagents` is documented as a boolean but defined with a value.**
  The `/remediate-code` and `/audit-code` loaders show `--host-can-dispatch-subagents`
  as a bare flag, but commander defines it as `--host-can-dispatch-subagents <value>`,
  so passing it bare swallows the *next* flag as its value
  (`… --host-can-dispatch-subagents --host-max-concurrent 4` made `4` a stray positional
  → "too many arguments for 'next-step'"). Spotted 2026-06-14. Fix: define it as a true
  boolean option (no `<value>`) so the documented usage works, or change the loader docs
  to `--host-can-dispatch-subagents true`. (The `--host-models` JSON roster itself passes
  fine through the PowerShell→.cmd shim when single-quoted.)
- **`conversation-start.md` is not auto-registered as an intake source.** When
  `/remediate-code` receives conversational/memory guidance *alongside* an `--input`
  report, the loader writes the guidance to `intake/conversation-start.md`, but
  `synthesize_intake`'s source-manifest lists only the `--input` document — so the
  guidance reaches planning only if the host folds it in by hand (it did, 2026-06-14).
  Fix: have intake discover `intake/conversation-start.md` (and any `intake/*.md`) and
  add it to the source-manifest as a supplementary `conversation` source, so mixed
  report+guidance runs are first-class.
- **Implement-worker `finding_id` trap recurred — renderer fix still unshipped.** The
  documented renderer fix above (emit the real node id + "one item_result per item id;
  never FND-*/OBL-* obligation ids") is still not in `prepareImplementDispatch`; the
  2026-06-14 run hit it again (an opus worker emitted one item_result per obligation incl.
  `OBL-WS-C` → `merge-implement-results` threw; the result file was patched post-hoc).
  Two-sided fix worth doing together: (1) renderer emits the node id + the one-entry rule;
  (2) make `merge-implement-results` *tolerant* — if an unknown `finding_id` is actually a
  known obligation id, map it back to its owning node instead of throwing (and collapse
  multiple per-obligation `item_results` for one node).

### Auditor-agnostic robustness — enforce-in-tooling fixes (2026-06-14)

Surfaced re-evaluating the 452-finding remediation run under the standing invariant
*"enforce in tooling, never host discretion"* (CLAUDE.md). Each item is a place the run only
succeeded because a capable host intervened — a latent failure mode for a weaker auditor. The
fix is the enforced change, not host care. (The three Known-friction bullets just above —
finding_id trap, `--host-can-dispatch-subagents`, conversation-start intake — belong to this set.)

- **Single bootstrap, not write-then-call.** The loader has the host write
  `conversation-start.md` then separately call `next-step`. Enforce a single entry operation
  (`next-step` accepts `--guidance-file`, or the loader is one command) so no host must
  remember the two-step dance.
- **Upstream evidence must auto-thread to dependent nodes.** The still-real verification node
  produced the import-graph / COR-3410f5f6 / version verdicts; the host relayed them into the
  dependent workers' prompts by hand. Enforce: a node's result is automatically threaded into
  the dispatch prompts of nodes that depend on it (verification edges already exist in the DAG —
  the dispatcher should ingest the upstream result, not the host).
- **Bounded findings digest as an artifact.** Reading scope from the 742 KB
  `audit-findings.json` was hand-rolled PowerShell (overflow-prone). Enforce: intake emits a
  bounded findings digest (counts, by-severity/lens/package, top findings, work-block map) the
  step prompt points to — no host should query raw findings ad-hoc.
- **Worker verification commands declared, not improvised.** Build-race safety (never two
  `npm run build` on one package; verify via `check`+`test`; rebuild shared between dependency
  levels) was host reasoning. Enforce: the dispatch plan/worker prompt states the exact verify
  commands per node (check + package test, never build); the scheduler owns shared rebuilds
  between levels.
- **Rolling per-node dispatch + concurrency owned by the scheduler.** The host hand-grouped and
  hand-paced 6 waves. Enforce dispatch-when-verified-complete with a quota-driven concurrency
  pool + incremental merge (see *Design commitments not yet built → Rolling per-node dispatch*).
  The host executes a steady-state pool; it should not design the waves.
- **Write-scope enforced, not self-reported.** Two workers edited `shared` out of scope
  (converged green, but unenforced). Enforce: the merge validates each worker's actual edits
  against its declared write-scope and rejects out-of-scope writes (ARC-f378135d).
- **Cross-block break propagation.** An OBL-C002 behavior change broke a seam test (SEAM-8c) in
  another block that the host fixed by hand. Enforce: paired positive+negative obligations
  (already tracked) + a cross-block reconciliation pass so a behavior change derives the
  dependent expectations to update — no host mop-up.
- **Result-shape errors impossible by construction.** `finding_id` / one-entry-per-node and
  field-type schema errors should be caught at write-time by a shared validator the worker runs,
  and `merge-implement-results` should be tolerant (map obligation→node, collapse multi-entry)
  rather than throwing. *(Contract-pipeline half shipped 2026-06-15: `validate-artifact` CLI +
  `CONTRACT_PIPELINE_VALIDATORS` give workers a write-time self-check for the contract artifacts,
  referenced in every phase prompt. The implement-worker-result half — `finding_id` mapping +
  tolerant merge — remains, tracked under the `finding_id` Known-friction bullets above.)*
- **Mid-edit typecheck-hook false alarms.** The async PostToolUse hook fired on transient
  mid-edit states during concurrent waves (authoritative `check` was green each time). Enforce:
  debounce the hook / scope it to the final edit, and define the final-green node as the
  authoritative gate, so a weaker host isn't derailed by advisory noise.
- **Model tier set by the planner, not the host.** `model_hint.tier` was flat "standard"; the
  host hand-upgraded architecture-heavy nodes to deep. Enforce: the planner sets tier by node
  complexity.
- **Per-finding coverage ledger.** The run tracked 17 blocks, not 452 finding dispositions.
  Enforce a per-finding ledger so every source finding has an auditable terminal disposition
  (closes CE-007 / OBL-GOAL-COVERAGE).
- **Generator↔fixture drift guard.** `generate-auditor-contract-fixture.mjs` now imports the
  shared constant; add a test asserting regenerated output == committed fixture so the generator
  can never silently re-break the suite.

### Friction from the June 8–9 self-audit (auditor feedback)

- **Whether to allow declared-boundary files as `affected_files` evidence.** The
  `submit-packet` rejection now *lists* the task's allowed files (shipped
  2026-06-09), but auditors still may reference only their assigned files — a
  finding that needs to cite an in-boundary-but-unassigned file (e.g. a
  `schemas/finding.schema.json` to fully describe a duplicate-schema finding) must
  drop that evidence. Open contract decision: allow declared-boundary files as
  evidence, or keep the strict assigned-files-only rule.
- **Read tool truncates lines over ~2000 chars.** Large `file_coverage` arrays
  inside prior-result JSON exceed the per-line cap, so auditors couldn't
  reconstruct exact arrays and fell back to `Get-Content`/bash. Worth noting for
  any task that must read wide single-line JSON.

## Deferred fixes (product bugs)

### Narrow stale-lock-steal double-hold race in `withFileLock`

`removeStaleLock` (`packages/shared/src/quota/fileLock.ts`) checks the stale token
then unlinks in two non-atomic steps. When multiple acquirers race to steal the
*same* >30s-stale lock, one can unlink a lock another just freshly re-created in the
read→unlink gap, briefly admitting two holders (mutual exclusion violated for a
window). Surfaced 2026-06-13 by a 5-way concurrent-steal test that asserted
`maxConcurrent === 1` and flaked ~1-in-3 (`2 !== 1`); that assertion was relaxed to
the in-scope property (distinct tokens / no token corruption, which the token-check
*does* guarantee — FND-TST-a50db947). Impact is low: it only triggers on concurrent
stealing of a crashed/hung holder's lock, and `state.json` acquisition is ~serial in
the orchestrators. A correct fix needs lease-style ownership verification or a truly
atomic claim (a rename-claim still has its own TOCTOU) — not a quick inline patch.
Re-add the strict mutual-exclusion assertion to `fileLock.test.mjs` once fixed.

### Manual real-OpenCode validation of scoped permissions (user-owned)

The project-scope OpenCode deploy was aligned with the shared scoped-permission
helpers by the redesign run (N-D02, shipped 2026-06-11). Still pending: manual
validation against real OpenCode that agent-scoped allowances propagate to
spawned subtasks (can't be unit-tested). Revert path if audits start hitting
ask-prompts: re-add the broad rule or rerun an older postinstall.

### remediate-code host-dispatch gaps

- **Provider `queryLimits` is deferred because it has near-zero value today.** The
  canonical dispatch call site already treats an absent method and a `null` return
  identically (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so
  null-returning stubs change nothing at runtime. Revisit only if a provider gains
  a real proactive rate-limit endpoint. This belongs with heterogeneous,
  quota-aware dispatch.

## Design commitments not yet built

Surfaced by a 2026-06-13 drift check of the design docs against `src`. These are
design decisions the docs record but the code has not implemented — tracked here
so the gap is explicit. Re-run the check (design doc vs code) to refresh; don't
record build status in the design docs themselves.

- **`free_form_intent` clause escalation + remediate-code interpretation.**
  Partially shipped 2026-06-13: audit-code no longer pastes intent verbatim into
  worker prompts (removed + guarded by `296c1b90` /
  `no-verbatim-free-form-intent.test.mjs`), and lens-weight interpretation is wired
  (`planningExecutors.ts` → `interpretFreeFormIntent`). Two halves genuinely remain:
  (a) the clause-aware `interpretFreeFormIntentForAudit` (`intentInterpreter.ts`) —
  which produces `checkpoint_questions` / `has_unencodable` — is built but still
  **unwired** (no caller reads it), so unencodable clauses are silently dropped
  instead of escalated to a blocking checkpoint question; (b) `remediate-code` still
  threads `free_form_intent` into remediation worker prompts (`nextStep.ts`) rather
  than interpreting it for priority / lens weighting. Resolve toward the docs
  (interpret + escalate) in both orchestrators.
- **Rolling per-node dispatch (dispatch-when-verified-complete) — remediate-code.**
  The design wants per-result re-scheduling: as each node result lands,
  verify→merge→re-check newly-unblocked nodes→dispatch into freed quota. The code
  builds one wave per `next-step` and gates `prepareImplementDispatch` on item
  *status*, not verified-complete; the host dispatches the wave, waits for all
  results, merges, then re-enters. Batch-then-merge, not rolling.
- **Provider confirmation Gate-0 (shared, session-level) — remediate-code.** The
  design wants one provider confirmation spanning an audit→remediate run.
  remediate-code has no `provider_confirmation` state; each tool resolves its
  provider independently.
- **Parallel module-contract phases — remediate-code.** `buildParallelModuleWaveStep`
  (`contractPipeline.ts`) dispatches a single sequential agent over all modules, not
  N parallel per-module agents.
- **audit-code mid-run pause + scope annotation + folded ingestion.**
  `waiting_for_provider` / `advancePausedState` is built in
  `shared/src/rolling/pausedState.ts` but `rollingDispatch.ts` doesn't use it (it
  only detects stranded packets post-run). Design-review prompts don't annotate
  units `[in scope]` / `[excluded: …]`. Ingestion is still a separate
  `audit_results_ingested` obligation rather than folded into the dispatch turn.
- **Paired obligations (positive + negative test specs) — remediate-code contract
  pipeline.** A behavior-*change* obligation should derive BOTH a positive test (the
  new invariant holds) and a negative test (the old behavior is absent everywhere)
  at obligation/test-spec derivation time, so a partial implementation cannot satisfy
  it. The no-prose-closure half has shipped — `mergeImplementResults` gates a
  `resolved_no_change` ("verified-already-satisfied") closure on executable evidence
  (`hasExecutableEvidence`), routing prose-only claims to triage. This
  paired-derivation half is the remaining piece.

## Features to add later

### Contract-governed implementation pipeline — durable principles

The pipeline shipped 2026-06 (artifact contracts, schemas, validators, content-hash
staleness DAG, deterministic grounding of LLM findings, and the adversarial
**critic → judge → repair** loop). The build details live in the code + design
docs; the principles to keep honoring are:

- Treat LLM output as untrusted until validated; deterministic validators run
  before LLM critics.
- No implementation task without traceability to a requirement, invariant, or
  accepted counterexample.
- Conceptual critique may propose better designs, but adopted changes must be
  reflected in the contract before implementation.
- "Tests pass" is never sufficient proof of completion.
- Use **contract assessment** (invariants / boundaries / obligations) and
  **conceptual design critique** (philosophy / alternatives) as the two named
  modes — never the bare phrase "design assessment".

### Heterogeneous multi-agent dispatch — *partial*

`computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
sizes dispatch just in time, partitions pending token estimates across
`CapacityPool`s, and sums concurrent slots with per-pool quota summaries.
Remaining (deferred as `FINDING-020` — cross-package): per-packet provider
assignment, host-model detection for additional pools, and building a real second
pool such as an IDE model or another CLI provider.

### Cross-IDE/provider quota detection — needs a concerted effort (+ CLI-agent dispatch)

Quota/limit detection is still unreliable across the different host IDEs and providers
(Claude Code, Codex, OpenCode, antigravity, VS Code tasks, …): per-model+provider limit
discovery, learned-limit feedback, and the capability handshake don't yet produce a
dependable capacity picture everywhere. This is a known deficiency, not a small bug — it
wants a dedicated, end-to-end pass over the quota subsystem + the per-provider wiring,
with real per-IDE/provider validation (not just unit fixtures). Target: a
provider+IDE+model triple yields a *trustworthy* capacity/limit estimate dispatch can
rely on, degrading safely (byte-estimate + 429/TPM learning + safety margin) when a
source is silent — never a confidently-wrong number. (Ethan flagged 2026-06-15.)

Part of the same push: **detect and dispatch to CLI agents as additional pools.** The
heterogeneous-dispatch machinery (`computeDispatchCapacity`, `CapacityPool`) can already
model multiple pools, but there is no real second pool. Detecting an available CLI agent
(another `claude`/`codex`/`opencode` process, or an IDE model) and routing
packets/blocks to it — each under its own provider+quota constraints — is the concrete
next capability. Builds on *Heterogeneous multi-agent dispatch* above + the per-model
+provider quota vision (memory `quota-dispatch-vision`).

### Token savings and model routing — DECIDED 2026-06-11

**Decision: headroom (https://github.com/chopratejas/headroom) replaces
opentoken everywhere.** Host level done; orchestrator opentoken removal DONE
2026-06-13 (deleted from src, guarded by `no-opentoken-guard.test.mjs`). The only
remaining piece is host-side: enable + validate the headroom proxy in an opt-in
session before any global env flip (see below).

- **Host (done 2026-06-11):** `headroom` MCP server registered at user scope
  (`claude mcp add --scope user headroom -- headroom mcp serve`); the
  opentoken entry was removed from the Desktop config in the same pass.
  Windows install trap: PyPI ships no Windows wheels for the Rust extension
  and `[all]` needs MSVC (hnswlib) — working recipe is
  `uv tool install --no-build headroom-ai --with fastapi --with uvicorn --with mcp`
  (pure-python wheel, 0.20.15). Proxy mode (`headroom proxy` +
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`; auto-compresses all tool-output
  traffic with CCR retrieval) is installed but NOT enabled — validate it in a
  single opt-in session before any global env flip.
- **Orchestrators — opentoken removal DONE (2026-06-13).** The opentoken exec-wrap
  (`wrapForOpenToken` / `quoteForOpenTokenCmd` / `runTracked`'s `opentoken` option,
  the sessionConfig field, provider wiring) was deleted from src — superseded by the
  host-level headroom proxy (`853e8a79`, `1b4d227a`; guarded by
  `no-opentoken-guard.test.mjs`), which also retired the cmd.exe wrap-quoting trap
  class. Optional / unbuilt: a `headroom-ai` TS SDK library step (`compress(messages,
  { model })`) that compresses packet evidence at build time + worker payloads at
  ingestion — now low-priority, since the host proxy already compresses tool-output
  traffic. Minor: a vestigial `DO_NOT_TOKEN_WRAP_NOTE` remains in `prompts.ts`;
  verify it isn't needed for proxy traffic before deleting it.
- **tokencost — rejected entirely (2026-06-11), including the local-tokenizer
  substitute.** `tokencost-js` counts Claude tokens via the Anthropic counting
  API (a network call inside deterministic planning — wrong shape) and the
  Python original can't run in Node. The local-tokenizer alternative was also
  dropped: the shipped redesign standardized byte-based estimation as the
  single primitive (N-S04, `estimateTokensFromBytes`), quota learning
  self-corrects from real 429/TPM signals, `BLOCK_SAFETY_MARGIN` absorbs
  estimator error, and BPE tokenizers aren't Claude's tokenizer anyway. The
  headroom proxy's stats are the measured-usage upgrade path. Optional later:
  per-model price fields for ledger cost lines (pure data, no deps). Revisit a
  tokenizer only on observed systematic mispacking.

### Nightly autonomous audit→remediate pipeline — capstone, UNBLOCKED

Redesigns landed 2026-06-11 (46/46); the dogfood gate is met — a fresh self-audit
ran end-to-end on the new architecture 2026-06-13 (97/97 remediated). Remaining to
build: scheduled run (cloud routine or local headless `claude -p`) → audit →
auto-remediate actionable findings behind green test gates → PR + findings
report, escalating only ambiguity/low-confidence fixes to Ethan.

### Single-package install/publish (`audit-tools`)

Collapse the three published packages (`auditor-lambda` + `remediator-lambda` +
`@audit-tools/shared`) into ONE published+installed package — provisionally **`audit-tools`**
(name is free on npm as of 2026-06-15) — exposing both the `audit-code` and `remediate-code`
bins, with the shared library internal. One install, one publish, one version line; removes
the three-way naming mismatch (dir vs npm name vs bin) and the shared-built-first release
ordering. Points to settle when picked up: whether `shared` stays an internal workspace or is
inlined; collapsing the per-package `release:*` scripts + the GitHub-Release-tag publish
workflow to one; keep the `audit-code`/`remediate-code` bin names; and deprecating/redirecting
the old `auditor-lambda`/`remediator-lambda` package names. Deferred (Ethan, 2026-06-15) — for
another time.
