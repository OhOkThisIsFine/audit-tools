# Durable traps

> Standing environment and tooling reference — NOT work to clear.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

A trap that can be MECHANICALLY enforced is enforced, and its entry is DELETED here rather than
restated: two copies decay independently, and the mechanism states the trap and the fix when it
fires. Enforcement is a hook in `.claude/hooks/` when the trap is detectable at a tool call, and a
contract test when it is a property of the tree instead — a test is equally binding and equally
self-describing, so it earns the same deletion. What may NOT be deleted is a trap enforced only
*partly*: state the uncovered half explicitly rather than letting the covered half read as a close.

- **A vitest CLI file filter resurrects same-suffixed test COPIES under stale worktree dirs
  (2026-08-06).** `npx vitest run tests/remediate/x.test.ts` substring-matched — and RAN — the
  copies at `.claude/worktrees/wf_*/tests/remediate/x.test.ts` and
  `.audit-tools/worktrees/*/tests/...` even though config excludes cover both dirs; 17 copies of
  one lock-based test then raced each other (hermeticity collisions reading as regressions), and
  stale copies failed at LOAD, flipping exit 1 on a green run. A plain `npm test` (no filter) is
  NOT affected. Fix at the source: no leftover worktree dirs (agent worktrees removed after use;
  orphan dirs moved out). Also: the Bash tool's cwd PERSISTS across calls — a `cd` left in a
  worktree/subdir makes the next bare `npx vitest` run against the WRONG root with default
  includes.

- **The Workflow tool's per-agent `model` override may not take (observed 2026-08-06).** Both
  omitting `model` and passing `model:'fable'` ran every workflow subagent as
  `claude-haiku-4-5` in this environment — plan quality accordingly: treat workflow subagent
  output as weak-model advisory, seed correction waves with explicit review findings, and verify
  every patch against source before landing (two waves of this sprint each shipped
  inverted-semantics fixes that read plausibly).

- **A local test RED can be an ambient-PATH artifact, not a regression.** `INV-shared-core-14`
  stubbed only two provider constructors while auto-resolution walks the real `PATH`, so it passed in CI
  (no CLIs on the runner) and failed on any box with `agy`/`codex` installed — reading as a product
  defect. Fixed, but the CLASS recurs: before believing a local red, check whether the fixture depends on
  what happens to be installed. [[lap-green-must-match-ci-evidence]] cuts BOTH ways — CI green over a
  local red is as real a signal as the reverse.

- **agy's headless lane is INERT until `~/.gemini/antigravity-cli/settings.json` grants tool
  permissions — and the grammar is `tool(target)` (verified live 2026-07-25).** Without that file
  `agy -p` exits 0 and prints only `jetski: no output produced — a tool required the "command"
  permission that headless mode cannot prompt for`, which reads as a dead lane. The error message
  itself names the grammar: a `permissions.allow` array of `tool(target)` entries, `*` accepted as the
  target wildcard. `read_file`/`glob`/`list_directory`/`search_file_content` are NOT sufficient on
  their own — agy shells out, so `command(...)` is required for any file work. The CLI's cwd defaults
  to its own `…/antigravity-cli/scratch`, so pass `--add-dir <repo>` AND absolute paths in the prompt
  or it reports the file missing. `--dangerously-skip-permissions` remains refused by
  `shell-trap-guard.mjs` (prompt-derail trap) and is not needed. ⚠ The allow-list is MACHINE-GLOBAL and
  currently grants `command(*)`, i.e. every headless agy session auto-approves any command — narrow it
  if agy is ever pointed at untrusted input.

- **A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).**
  A refused `git add <files> && git commit …` is refused at the tool call, before any statement executes, so
  the `add` did not happen either — and the retry fails identically, reading as "the gate ignored my fix".
  Compounded by the constitutional-doc / loop-core attestations, which bind to the EXACT staged tree: the
  natural `add && attest && commit` chain can never work, since staging after attesting invalidates the
  override. Stage in its own call, then attest, then commit. (Converse of
  [[pretooluse-gate-misses-chained-git-add-commit]], where the chain BYPASSES the gate.)

- **An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).** The memory
  consolidation found a memory listing 4 open items of which 3 were long done (audit's symmetric
  `runRollingDispatch` wiring, INV-QD-14 spill, `rate_limited` handling). Same decay as
  [[backlog-prose-decays-verify-against-head]], but in the memory store, where nothing ever forces a
  re-read. Verify any "open"/"remaining"/"TODO" claim against HEAD before it becomes work.

- **Never delete from a backlog file by LINE NUMBER.** Entries can span two physical lines while being
  one logical bullet, because a hook may embed a literal newline inside a code span. A line-keyed delete
  then removes half an entry and leaves an orphaned fragment that reads as corruption. Bit `open-bugs.md`
  during the 2026-07-19 classification pass. Delete by matching the entry's TEXT, and after any scripted
  edit scan for orphans — lines not starting with `-`, `>`, `#`, a space, `|`, or a backtick.

- **The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look
  identical to a weak or dead model** ([[offload-lane-failures-are-usually-the-caller]], twice over).
  Separate failures, separate remedies; decide which axis you are on before changing anything.
  **SIZE:** failure is size-correlated (48KB+ single calls: no first byte in 28 min; 105KB:
  `ECONNRESET`; 1–3KB per item: 94/101). Split to the natural per-item unit and size `max_tokens` to the
  per-item output — [[nim-offload-reliable-unit-is-one-entry]].
  **CONCURRENCY — a per-BACKEND limit, NOT a property of the lane.** The fan-outs that degraded at 3, 10
  and 12 (429s, schema-valid empty documents, or never returning) were all NIM-routed. Serialize
  NIM-routed work (≤2 concurrent per model, escalating backoff, **resumable** driver — two writers to one
  output file clobber each other); do NOT serialize the lane, and do not assume another provider inherits
  the limit. ⚠ This has been wrong in BOTH directions (first "pool ~6-wide", then a blanket lane-wide
  ceiling), which is why the fact is stated per-backend. `finish_reason` is `undefined`, not `length`.
  [[nim-offload-reliable-unit-is-one-entry]]
  Scope is ad-hoc scripts only: audit-tools' own dispatch is paced by declared
  `quota.max_concurrent`/`requests_per_minute` and `laneWorkerKindConflict`. Record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](../reviews/worker-kind-pool-class-rule-2026-07-23.md).
  ⚠ **Never hand-rotate `model` per batch/retry** — the proxy owns retries and same-tier fallbacks
  (the router owns them); caller-side rotation crosses
  capability tiers and silently downgrades the call.
  ⚠ Rank is not latency: rank-1 `glm-5.2` returned nothing in >15min where `deepseek-v4-flash` answered
  in seconds. Rank-1 is no default for a blocking call. Re-confirmed 2026-07-28: an 836-line analytical
  call to `nim/z-ai/glm-5.2` died `HTTP 504 backend timed out` where small probes answered instantly.
  ⚠ Dead-lane detection is NOT automatic any more. The helper that preflighted `/health` and exited 3
  naming the restart command was retired 2026-07-28 and nothing replaced it, so probe the router
  yourself before a long dispatch — otherwise a dead lane is indistinguishable from a slow one.
  **OPEN:** the lane states its concurrency nowhere a caller reads it, and a call it cannot serve
  returns an empty document instead of refusing loudly.

- **The Bash tool silently CLAMPS `timeout` to 600000ms (2026-07-24).** A call passed
  `timeout: 1800000` for a long offload run and was killed at exactly 10m00s — the excess is
  clamped, not honoured and not warned about. Any command that can legitimately exceed 10 minutes
  (a big offload call, a full suite, a release wait) must use `run_in_background: true`, not a
  larger timeout. A 10-minute kill on a call the caller believed had 30 minutes reads exactly like
  a hung backend, which is the same misdiagnosis class as
  [[offload-lane-failures-are-usually-the-caller]].

- **Git Bash MANGLES a leading-slash argument into a Windows path (2026-07-25).** `claude -p "/insights"`
  through the Bash tool reached the nested session as `C:/Program Files/Git/insights`, which answered
  "there is no such slash command" — and that reads exactly like the feature not existing. It does exist
  (it is registered in `claude.exe`). Any argument that must survive as a literal `/word` — a slash
  command passed to a nested `claude -p`, a container path, a `curl` URL path — needs
  `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` or the PowerShell tool. The failure is silent: the
  callee reports a sensible-sounding error about the mangled value, so the wrong conclusion is the
  DEFAULT one. Verify a "that command does not exist" answer against the binary before believing it.

- **Concurrent agent sessions can share the ONE primary checkout (2026-07-23).** Two live
  sessions worked `C:\Code\audit-tools` simultaneously: files changed under each other mid-turn,
  and one session's staged WIP was committed + pushed by the sibling (correctly). Foreign
  mid-session edits/commits are NOT corruption — `git log --oneline -5` + authorship first, never
  a "recovery"; re-read files before editing; before opening a big item check whether the sibling
  is mid-flight on it. Full protocol: memory [[concurrent-sessions-share-the-checkout]]. No
  tooling fix proposed yet; if a collision ever loses work, the mechanical form is a session
  lease/marker in `.claude/hooks/.state/`.

- **The pre-commit gate scans the WHOLE command string — including commit-message text — for the
  hooksPath/no-verify bypass tokens (2026-07-21).** A commit whose message names the literal tokens
  (e.g. a fix commit describing the bypass) is rejected as if it were the bypass. This is deliberate:
  quoted text cannot be safely excluded, because a genuinely quoted flag still reaches git
  (`git commit "--no-verify"` works), so stripping quotes would reopen the hole.
  A **heredoc** message has the same problem for the SHORT flag, and one the `-m "..."` form does not:
  `stripQuoted` neutralises a bare `-n` inside a quoted message, but a heredoc body is raw command
  text, so prose merely mentioning the flag trips it. Both were hit landing `56cd944d` — the commit
  that narrowed the short-form check to `git commit`, where `-n` alone means skip-the-hooks (on
  cherry-pick and revert it is `--no-commit`, the safer form this gate wants).
  **Remedy for both: write the message to a file and `git commit -F <path>`** — the command string
  then carries no message text to false-match. Rewording works too; neither is a reason to weaken the
  gate.

- **The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable
  (2026-07-20, medium).** A lane that inlines each file as raw text strips them. An adversarial
  review prompt that asks the worker to verify cited `file:line` then cannot be honoured: `glm-5.2`
  answered "NOT VERIFIABLE — the file numbering isn't displayed" to eight consecutive citation checks,
  refuted nothing, and still returned a `premise_false` verdict — an incoherent result that reads as
  model incapacity and is purely a caller defect. Number every inlined line (`N<TAB>source`) and say so
  in the system prompt; a smoke check ("what is on line 166?") confirms the worker can see them.

- **Global `fetch` cannot outlast a long reasoning call — undici's 300s `headersTimeout` is measured to
  the FIRST byte and `globalThis.fetch` cannot be told otherwise (2026-07-20, low; remedy corrected
  2026-07-24).** A multi-file adversarial dispatch to `deepseek-v4-pro` died at ~5min with
  `[TypeError: fetch failed] / UND_ERR_HEADERS_TIMEOUT`, which reads like a dead proxy and is not
  (the default is `300e3` — `undici/lib/dispatcher/client.js:262`). The remedy is split by WHERE the
  caller lives; the original "always use `node:http`" advice is now wrong for two of the three cases:
  (a) **in-repo** — `undici` is a runtime dep (`^7.28.0`, added v0.34.27), so build an `Agent` whose
  `headersTimeout`/`bodyTimeout` follow the declared deadline and pass it as `dispatcher`. That is what
  shipped (`deadlineBoundFetch` in `src/shared/providers/openAiCompatibleProvider.ts`) and hand-rolling a `node:http`
  transport there was deliberately rejected — undici IS Node's fetch implementation, pure JS, and HTTP
  transport is correctness-sensitive enough to acquire rather than own.
  (b) **a standalone script you hand-roll** (`~/.claude/*.mjs`, scratchpad) — `import("undici")` still
  does NOT resolve (re-verified 2026-07-24: `ERR_MODULE_NOT_FOUND` from `~/.claude` and from the
  scratchpad; resolves only with the repo as cwd). Use `node:http` — or `node:https` for a non-local
  endpoint — with an explicit request `timeout`.

- **An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right
  (2026-07-20, medium).** A NIM (`glm-5.2`) call to verify an axis claim returned an accurate
  per-call-site breakdown that correctly refuted the claim — but attributed sentences to
  `spec/backend-identity-axes.md` that actually came from the just-written source file passed in the
  same call, and invented a verbatim "host quota pools … still key on transport or host identity"
  quote from the identity module that exists nowhere. The lane's structural analysis was worth the
  call; every citation in it was worthless. Treat quoted evidence from the lane as the LEAST reliable
  part of its output, not the most — the opposite of the intuition that a quote is checkable proof.
  ([[offload-lane-failures-are-usually-the-caller]] is about weak-looking output; this is the inverse
  failure — confident output with fake support.)

- **`codex exec` hangs on an open stdin — inside the product that is guaranteed by the spawn substrate,
  not by each spawn site.** The shell-trap guard refuses the trap only for commands the HOST runs. In
  `src/` there is one spawn substrate, `spawnLoggedCommand` (`src/shared/providers/spawnLoggedCommand.ts`),
  and it closes stdin on both branches: `stdio[0]` is `"ignore"` when no `stdinText` is supplied, and a
  pipe that is `.end()`ed immediately when one is. Every CLI provider — codex, claude-code, claude-worker,
  agy, opencode, worker-command, subprocess-template — routes through it, so no provider carries (or
  needs) stdin handling of its own.
  ⚠ **HALF-CLOSED, and the open half is the likelier one.** Nothing prevents new code from calling
  `child_process.spawn` DIRECTLY, where Node's default stdio leaves the child's stdin an open pipe →
  the silent exit-0/empty-output hang. Routing through the substrate is a convention here, not an
  enforced invariant: no gate refuses a direct spawn in `src/`. And only the `stdinText` pipe branch
  is asserted in `tests/shared/spawnLoggedCommand.test.ts` — the `"ignore"` default, which is the
  branch a `worker_command` of `["codex","exec",…]` actually takes, has no test. So the substrate is
  correct and unproven, and bypassing it is undetected.

- **An unrecognized key in the machine declaration can fail as a missing lane.**
  `~/.audit-code/sources-declared.json` is operator-authored machine config that repo tests do not read
  directly (tests inject `readDeclarationFile`). `readSourceDeclaration` consumes `sources` only, and
  the validator does not reject unknown top-level keys. Per-source reach failures are printed on stderr
  as `[audit-tools] declared source "<id>" not resolved: <reason>`. After a source-contract change,
  validate the live declaration through `resolveAmbientSources`; do not infer health from a green suite.

- **The free offload lane is a local router — it must be RUNNING, and callers should request the
  `auto` alias.** Requests go to `127.0.0.1:3001`; start it with
  `powershell -File C:\Users\ethan\freellmapi\start.ps1`. ⚠ This lane has now outlived THREE
  transports — two earlier local brokers on other ports were each retired within weeks — so treat
  any endpoint, port or model name written down here as stale until probed. Three consequences:
  (a) there is no standalone fallback — every offload call goes to that one endpoint, so a failing
  offload means "start the router", not "the backend is broken".
  (b) Address the `auto` alias, not a concrete model. The router owns candidate selection and
  failover; putting a provider/model id in audit-tools recreates the duplicate configuration this
  boundary exists to remove. Ask the router's own `/v1/models` for the live roster rather than
  trusting any written list, this one included.
  (b2) **A dead model NAME passes the reach probe and fails only at work time.**
  `resolveAmbientSources` proves an `openai-compatible` lane by ENDPOINT liveness (`/v1/models`,
  `/health`), which a running router answers regardless of whether the declared `model` resolves. So
  a `sources-declared.json` naming a retired model resolves green, is admitted as a CapacityPool,
  and 400s on every packet. Bit 2026-08-08. Probe the declared MODEL with a
  real `/v1/chat/completions` round-trip after any router upgrade — endpoint-alive is not lane-alive.
  (c) `--model <spec>` is the *worker/provider* invocation form (claude-worker, codex, agy).
  Offloading to *Claude Haiku* is a separate lane (Agent tool `model: haiku`), unrelated to the proxy.
  (d) a hand-written agy model pin goes stale against the installed agy roster (2026-08-05:
  `claude-sonnet-5` pinned, agy only offers `Claude Sonnet 4.6 (Thinking)`; also `--effort` is
  rejected for the Claude models). On an "invalid model selection" error, re-run with a roster model
  name from the error's own list, and read the roster rather than hand-typing it.

- **After an unattended run, `git diff` the tracked docs before committing.** The nightly maintenance
  routine runs as a local scheduled task (`~/.claude/scheduled-tasks/nightly-maintenance/`) and lands
  real edits in the working tree — leg 1 auto-applies stale-factual doc fixes, leg 2 does mechanical
  backlog cleanup. Those are direct file edits, so `git reflog` shows nothing; an unexpected `M` in
  `git status` is the only signal. Instruction files (`CLAUDE.md`, `AGENTS*.md`) are escalate-only and
  the code anchor is re-verified against HEAD before any write (`docs/nightly-routine.md` → *Safety*),
  but that is the routine's own contract, not a gate — no hook compares a tracked doc against its
  committed version, and the only mechanical pin on `CLAUDE.md` is the one file-lock sentence in
  `tests/audit/file-lock-doc-sync.test.ts`. Bit once (2026-07-10) under the old branch-snapshot-keyed
  doc-review auto-apply, which was replaced 2026-07-23 by the subject-keyed durable decisions ledger
  (`253e3851`); the reconcile-against-HEAD tool fix that used to be tracked under *Open bugs* shipped
  with it.

- **npm 12 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).**
  Any child `npm install` of a package with a postinstall (e.g. the audit-tools tarball) still reports
  `added 1 package` but skips the script, warning `install scripts blocked because they are not covered by
  allowScripts`. What decides coverage is the dependency **SPEC, not the package name**: a name allowlist —
  `allow-scripts=<name>` in a user-level *or* project-level `.npmrc`, or `--allow-scripts=<name>` on a `-g`
  install — DOES cover a registry spec, including a fresh temp-dir install; it never matches a local
  `file:…tgz` spec, which is exactly how tarball verification installs. For the tarball case the only
  reliable hatch is env `npm_config_dangerously_allow_all_scripts=true` (older npm silently ignores it) —
  used by `scripts/remediate/smoke-packaged-remediate-code.mjs`; the audit packaged smoke deliberately
  strips all `npm_config_*` (`createIsolatedNpmEnv`) and drives `audit-code install` itself instead. Three
  sharp edges: `--allow-scripts=<name>` in a *project-scoped* install is a hard `EALLOWSCRIPTS` error, not a
  no-op; `npm install-scripts approve <pkg>` only RECORDS approval (spec-keyed, version-pinned, written into
  the consumer's `package.json`) — it does not run the blocked script, so reinstall / `npm rebuild` after,
  and for a `file:` tarball it writes an ABSOLUTE key that won't match the relative spec npm itself recorded,
  so it never takes; and hand-writing `"allowScripts": ["<name>"]` is worse than nothing — the array-of-names
  form matches no spec AND silently disables the working `.npmrc` channel (`npm warn install-scripts .npmrc
  allow-scripts setting is being ignored because package.json declares its own allowScripts field`). Also new
  in npm 12: `npm pack --json` can emit an OBJECT keyed by tarball name instead of an array (both smokes
  tolerate both). Global `-g` reinstall of audit-tools from the registry: `npm i -g
  --allow-scripts=audit-tools` DOES run the postinstall (as `/ship` says); verify `~/.claude/commands/*.md`
  landed either way (extends [[audit-code-global-bin-traps]]).

- **`git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is
  NOT a rejection.** On a fast-forward push straight to `main` the remote emits that branch-protection
  message, but the ref still updates (`04a7338c..8279d0de  HEAD -> main`, no `! [remote rejected]`). Confirm
  by `git fetch audit-tools main && git rev-parse audit-tools/main` == local HEAD — don't assume the push
  failed on seeing the advisory. Observed 2026-07-08.

- **The `audit-code-completion-*.test.ts` family drives the full audit flow in-process, so a long file
  wall is expected, not a hang.** It was ONE file (`audit-code-completion.test.ts`) and the slowest in the
  whole suite — rank 1 in every profiled run that listed it
  (`.audit-tools-profile/vitest-history.ndjson`), 285-470s file wall — until it was split five ways over
  `tests/audit/helpers/completion-harness.ts` (2026-08-07, wall-clock brief T4); the fragments now top out
  around 135s. The CLI handlers are imported and called directly rather than subprocess-spawned, and
  `HEAVY_AUDIT_TEST_TIMEOUT_MS = 300_000` is a PER-TEST timeout, so a long wall is the shape of the
  workload. **Confirmed, do not re-chase:** production
  does NOT redundantly re-extract on an unchanged repo. `repo_manifest` *specifically* is presence-gated
  (`src/audit/orchestrator/state.ts` — `has(bundle.repo_manifest) ? "satisfied" : "missing"`), so its sole
  FS walk (`intakeExecutors.ts` → `buildRepoManifestFromFs`) never re-fires once the artifact exists, and
  the staleness pass hashes already-loaded artifact JSON rather than re-walking the FS
  (`staleness.ts` → `getArtifactValue`). Everything downstream (`file_disposition`, `auto_fixes_applied`,
  `syntax_resolved`, `external_analyzers_current`, …) *is* staleness-checked via `staleOrSatisfied` — the
  presence gate is one artifact, not a suite-wide rule. The wall is legitimate one-time-per-phase
  extraction, not a caching bug. Remaining lever (test-side only): pre-seed artifacts to cut pump
  iterations — each of the 4 tests builds a fresh temp repo and pumps up to `MAX_PRE_DISPATCH_PAUSES` (8) +
  `MAX_FINALIZE_STEPS` (10) next-step calls. Full investigation record: memory
  `audit-no-redundant-reextraction-verified`.

- **Codex CLI can burn a long wall-clock on large read-heavy audit packets.** Observed 2026-07-04: 2
  concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning. The
  *hand-routing* remedy is superseded — packet sizing is mechanical now: `packetFilter.ts` re-partitions
  any packet over its assigned tier's budget (`resolveDispatchTier` escalates on `estimated_tokens ≥ 9000`),
  warns `oversized_packet` on whatever is left, and every worker launch carries a declared wall
  (`sessionConfig.timeout_ms` → `rollingAuditDispatch.ts` → `spawnLoggedCommand`). Do NOT hand-route around
  codex or drop it from the executor pool — it is a standing default worker
  ([[free-nim-pool-first-default-worker]]). If a codex-specific read-heavy weakness bites again, express it
  as a declared per-pool timeout or tier cut point, never as host discretion (CLAUDE.md *Auditor-agnostic
  robustness*).

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktrees; accepted work is cherry-picked onto `remediation/<runId>` (`remediationBranchName`, `src/remediate/steps/dispatch/worktreeLifecycle.ts`) and the MAIN checkout is switched to that branch and left there (`ensureRemediationBranchCheckedOut`). By DEFAULT the branch is never auto-merged — the base branch is left untouched for review — so any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: a review pass that reads main (e.g. the nightly docs leg) still sees the unfixed prose and legitimately re-raises the finding. The nightly decisions ledger *can* silence it permanently (subject-keyed, `scripts/nightly/items.mjs` + `answer.mjs`), but settling is the wrong move here — the fix exists, it just isn't on main. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — close checks out the recorded base and `--no-ff` merges `remediation/<runId>` into it, aborting the merge and restoring the remediation branch on conflict so the base is left exactly as it was (`src/remediate/phases/close.ts`). **Caveat — merge-to-base can silently no-op:** the target is read from the `remediation-base-branch.json` sidecar, which is written ONLY when the branch is FIRST created. A run launched from a detached HEAD, or one that REUSES a `remediation/<runId>` branch left by a prior run, has no recorded base; the action then returns `skipped` ("merge manually") rather than guessing a target. So check the closing result — and after any run that touches docs/code you want on main, `git branch --no-merged main --list 'remediation/*'` and merge the survivors by hand before the next review pass.

- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.) Same class:
  `tests/shared/rollingDispatch.test.ts` "re-dispatches immediately on result arrival" passes in
  isolation but intermittently reads `2` for `3` under full-suite load — it is sensitive to ambient
  scheduler/FS load, not just dispatch-path latency. `tests/shared/nightly-routine.test.ts` spins up
  real HTTP servers (the interactive-review contract), which adds transient load that nudges it over
  its window; the durable fix is to widen that test's delay well past worst-case, not to thin the
  server tests (CI's 4-way shard already lowers the per-shard load).

- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run any subset through the GATE, never vitest directly: `node scripts/shared/run-vitest-gate.mjs <path...>`.
  Every arg is forwarded to `vitest run`, so a single file, several files, a glob, `--shard`, `--retry`
  and `--exclude` all work (see `test:doc-contract`, which passes three explicit paths). A bare
  `npx vitest run <path>` still executes, but its **exit code is not trustworthy** — `vitest run` has
  exited 0 while reporting N failed, once reaching release CI. The gate is the only thing that catches
  it: it reads the structured `outcome` field the timing reporter writes to
  `.audit-tools-profile/vitest*-latest.json` (never console prose) and fails closed when the ledger is
  missing, stale, or carries a mismatched run token. `node:assert/strict` is still permitted as an
  assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.

- **Don't mask the test exit code with a REDIRECT.** `npm test > out; echo done` reports the *trailing*
  command's exit, not the suite's — and piping through `grep`/`rm` in the same Bash call races the output
  file, so a real failure reads as "green." Capture the suite's own status:
  `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`. (The *pipe* form of this trap —
  `npm test | grep …; echo $?`, which reports grep's status — is REFUSED by the shell-trap guard
  (escape hatches: `pipefail`/`PIPESTATUS` in the command, or `AUDIT_TOOLS_ALLOW_MASKED_EXIT=1`); the
  redirect form above is not detectable without false positives, so it stays yours.)

- **Global `-g` install BLOCKS `postinstall`** (npm 12 `allowScripts`) → the host-integration deploy
  (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gemini`) never runs. npm *does* warn on stderr and
  names the blocked script — what is silent is the missing deploy, not the skip. **Durable fix** (npm's own
  global remediation): `npm config set allow-scripts=audit-tools --location=user` — already set in
  `~/.npmrc` on this box, so a bare `npm i -g audit-tools` should now run it; re-apply on any fresh box.
  One-off: `npm i -g --allow-scripts=audit-tools`. ⚠ `--allow-scripts` is legal ONLY in global/npx
  contexts — a *project*-scoped install throws `EALLOWSCRIPTS`; there use `npm install-scripts approve
  <pkg>` or `package.json#allowScripts`. Manual finish either way:
  `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.

- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)

- **PowerShell**: `foreach` is a STATEMENT and cannot be piped (`foreach (…) {…} | ConvertTo-Json` → "An empty
  pipe element is not allowed") — assign it to a var first. But a var holding ONE element then serializes as a
  bare object, because the PIPE unrolls the array: `@($x) | ConvertTo-Json` is still `{…}`, so bracket-wrapping
  does NOT save the piped form. Keep `[…]` with `ConvertTo-Json -InputObject @($x)` or the comma operator
  `,@($x) | ConvertTo-Json` (both verified, PS 7.6.3); for a fixed payload prefer a literal-array here-string and
  skip `ConvertTo-Json` entirely. `-Filter` is wildcard-only, never regex — a regex pattern either errors on path
  syntax or silently matches ZERO (`-Filter 'shared.*mjs'` → 0 files, `-Filter 'profile*mjs'` → 2); filter with
  `Where-Object Name -match '<re>'` (bare `Where-Object -match` is invalid — it demands `-Property`/`-Value`).
  [[submit-packet-json-array-trap]]

- **Packaged/global-install drift is caught ONLY by `smoke:packaged-*`, never by dev, `npm run check`,
  knip or vitest — so it fails the gate loudly, not silently.** Both smokes run inside `verify:checks`
  (the `verify:checks` script in `package.json`, which `verify:release` and `prepublishOnly` wrap and CI's `gate` job runs); each
  does `npm pack` then `npm install --no-package-lock <tarball>` into a temp dir, so only
  `dependencies` are present. Two ways to break the tarball that pass every local check: (1) a
  production runtime `import` declared as a `devDependency` — devDeps are present in dev + the vitest
  suite, and knip's `include` issue-type whitelist in `knip.json` excludes the dependency checks, so only the
  packaged smoke hits `ERR_MODULE_NOT_FOUND` (when you add an `import` to any `src/` module that lands
  in `dist/` on a production path, confirm the package is under `dependencies`; bit once 2026-07-04 by
  `zod-to-json-schema` in `src/audit/contracts/workerSchemas.ts` — now correctly a `dependency`);
  (2) deleting a *shipped* file that the `requiredPackagedPaths` list asserts — that list lives ONLY in
  `scripts/audit/smoke-packaged-audit-code.mjs` (defined `:21`, asserted `:505`); the remediate smoke
  packs+installs but asserts no path list, and `scripts/audit/verify-hosts.mjs` is a *sibling* gate over
  the rendered HOST assets, not a second copy of the list. Diagnostic, not a silent trap: if
  `smoke:packaged` errors on a missing module or path, this is why.

- **A `vi.spyOn` on the `audit-tools/shared` re-export barrel passes VACUOUSLY.** Spying a symbol on the
  barrel namespace does not intercept a consumer that imported that symbol directly — the source holds its
  own bound reference, so the spy records zero calls and every assertion over `spy.mock.calls` is green
  while exercising nothing. Mechanically guarded ONLY under `tests/remediate` (INV-remediate-tests-12,
  `tests/remediate/remediate-tests-invariants.test.ts`, which scans its own dir); `tests/audit` and
  `tests/shared` are unguarded — verify by hand there. Everything else about vitest mocking is normal
  practice at HEAD: `vi.spyOn` on built-ins, prototypes and relative source-module namespaces,
  `vi.mock("node:child_process")` (an explicitly sanctioned exception in INV-WH,
  `tests/shared/shared-tests-invariants.test.mjs`) and `vi.useFakeTimers({ toFake: [...] })` are all in
  live use. Injectable-deps seams remain the right tool where the seam is IO or a step boundary
  (`WorkerRunDeps` in `src/audit/cli/workerRunCommand.ts`; `createWriteStream`/`spawn` options on
  `spawnLoggedCommand`) — but they are no longer a blanket rule: their original rationale, the retired
  `node --import tsx/esm --test` runner that could not mock modules, is gone (the stale justification is
  still in the `WorkerRunDeps` doc comment).

- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]

- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.

- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in
  `tests/audit/audit-code-completion-force-synthesis.test.ts`.)

- **A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).** `dist/`, `.claude/*` and `.audit-tools/*/*` are gitignored, so `rg` and `git grep` — the project's default search tools — provably cannot see a worktree's or a build tree's output. `grep -r` and PowerShell `Select-String -Recurse` honour no ignore file, so they hit `dist/**` and report deleted code as still referenced. Verified twice by probe. When checking whether a symbol is truly dead, use the ignore-aware tool; a `grep -r` hit inside `dist/` is the compiled copy of the very code you deleted, not a caller.

- **A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.**
  Deduping five hand-rolled copies of the guard exposed two live bugs no copy and no entry had
  predicted: the worktree-seeding copy omitted `isAbsolute`, so on win32 a path on a DIFFERENT DRIVE
  read as contained (a cross-drive `relative()` returns an absolute path), and every copy's
  `startsWith("..")` wrongly rejected a legitimate entry named `..cache`. Five copies of a security
  predicate is not a style problem — deduping one is correctness work
  ([[five-copies-of-a-guard-hid-two-bugs]]).

- **The Grep tool's content output can mangle comment markers with a BACKSLASH.** It rendered
  `apiPool.ts`'s JSDoc openers and `//` line comments as `\**` / `\ ` (observed 2026-07-29) — a
  harness display artifact that reads exactly like file corruption. Verify with a Read of the same
  lines before diagnosing corruption or "fixing" the file.

- **A typecheck sweep's error count is not final until you re-run it.** Clearing the test tree for
  `check:tests` (`tsconfig.test.json`, `allowJs`; wired into `verify:checks`) surfaced ~20 errors
  beyond the initial count — TS unmasks a second error on the same object literal only once its
  sibling is fixed, so "N remaining" falls as you fix and then rises again. Budget for the re-run, and
  hold the line that every fix be semantics-preserving: `as any`, `@ts-expect-error` and
  optional-widening are banned constructs here, not shortcuts.
  ([[test-tree-typecheck-gate-and-its-cost]])

- **An untypechecked fixture can sit inert for months while its suite reads green.** The `check:tests`
  sweep found two long-lived fixtures carrying keys that are not fields at all (`deps`, `depends_on` —
  the real one is `dependencies`), and two carrying `while (step.step_kind === "state_transition")`
  loops against a kind RETIRED from `RemediationStepKind`, so those loop bodies never executed at all.
  Nothing had flagged either, because nothing typechecked the tree. A green suite over an inert
  fixture is not evidence.
  ⚠ **CLOSED to its floor — `check:tests` reaches every test file except ONE.** `tsconfig.test.json`
  sets `checkJs: false`, which silently excludes any `.mjs` test. The single file still outside the
  gate is deliberate and permanent: `tests/shared/shared-tests-invariants.test.mjs` (a `.ts` guard
  cannot detect its own exclusion) — "the test tree is typechecked" carries exactly that one-file
  asterisk, no larger. (No absolute file count is pinned here: hand-typed counts drift both ways —
  nightly sol-3 decision 2026-08-06.)
  ⚠ **MEASURED and REJECTED (2026-07-28): flipping `checkJs: true` with an exclude list** — the
  flip yields 8,903 errors across essentially every `.mjs` file, so the exclude list would cover
  the whole tree, buy zero coverage, and leave a 451-entry config to rot (it also dirties 28 `.ts`
  consumers). Do not rebuild this.
  ⚠ Converting a test file named in `scripts/shared/test-flake-baseline.json` must move its
  baseline key in the same commit, or the flake record orphans.
  ⚠ Any future `.mjs`→`.ts` conversion runs `node scripts/shared/conversion-assertion-parity.mjs`
  after `git mv`+edits, before commit — review ONLY the files it flags.

- **Cite a SYMBOL, never a bare line number — and when no good symbol exists, cite the file alone.**
  Line numbers across the backlog drifted repo-wide while the symbol names beside them still resolved,
  so hand-bumping them was a treadmill that bought nothing. 77 suffixes were dropped 2026-07-28.
  ⚠ **Do not "repair" a drifted number by auto-resolving it to the nearest declaration.** Tried and
  rejected the same day: a nearest-enclosing-declaration pass over the 44 open-bugs citations returned
  local variables (`preamble`, `shell`, `state`, `summary`) for most of them and resolved one past the
  end of a file it had matched by basename. Applying it would have swapped an honest stale number for
  a confident wrong symbol — the [[backlog-prose-decays-verify-against-head]] class, where re-anchoring
  silently re-certifies the sentence around the citation. Dropping the number is strictly better than
  false precision.

- **A backlog entry's bold title must not contain `**` — even inside backticks.** The roadmap/seek-index
  title parser terminates the title at the first `**` it meets, so a title mentioning a glob like
  `` `tests/**` `` renders truncated ("Convert `tests/") in BOTH generated docs, silently. Seen
  2026-07-28. Write the glob in prose, or drop it to the entry body.

- **A nested `claude -p` launched with this repo as its cwd is a FULL session in the SHARED
  checkout — it runs this repo's hooks and can mutate git state (2026-08-07).** Observed: a
  trivial one-prompt probe (`ANTHROPIC_BASE_URL` overlay onto the local router)
  hit the closeout-challenge Stop hook, spent its whole reply answering it, and PUSHED the
  checkout's unpushed commits on its way out — an uninstructed `git push` of another session's
  in-flight work (benign that day only because every commit was green). The overlay lane DOES
  work mechanically (the CLI accepts the env override + a router model string), but before
  using it as a worker harness: run workers in an isolated worktree or neutral cwd, set the hook
  bypass envs (`AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE=1`, `AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY=1`),
  and expect unknown-model context-window warnings (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` to silence).

- **An offload recon lane reading a file you are concurrently editing reports the POST-edit tree
  (2026-08-07).** An offload lane dispatched to analyze a duplication and left running while the
  extraction was written came back describing the new shared helper as pre-existing — its "finding"
  was the edit in flight. Nothing warns; the report simply describes a tree that did not exist when
  the task was written. Dispatch recon BEFORE editing the files it covers, or hold the edit until it
  returns. Same reason its output is advisory: verify against source at the moment you act.

- **Long offload recon jobs die mid-response; short ones do not (2026-08-07).** Three multi-file
  analysis dispatches on the DeepSeek lane: two failed with `API Error: Server error mid-response`
  after ~10 min, the third returned only after ~25 min; a one-line probe on the same lane answered
  instantly, and the same work on the agy lane returned complete in minutes. `claude -p` buffers to
  completion, so a dying lane and a working one are both zero bytes until the end — elapsed time is
  not a progress signal. Probe small, keep each dispatch to one bounded item, and prefer a second
  lane over a retry on the one that just failed.
  ⚠ **The variable is job LENGTH, not the lane (2026-08-09).** agy is no longer the escape hatch this
  entry's first paragraph implies: one long refutation died there with `status: "ERROR"`,
  `timeout waiting for response` at 296s, having generated 15,532 output tokens that were discarded —
  while an 8s probe on that same lane passed, and the free offload pool hung past 10 min on the same
  prompt and was marked exhausted. Splitting the one job into three bounded questions returned two of
  three. Shrink the unit before walking the ladder.

- **`.audit-tools/remediation-report.md` and `-outcomes.json` are TRACKED — archiving a finished run
  deletes them (2026-08-09).** `.audit-tools/` reads as scratch, but `.gitignore` negations track the
  promoted deliverables, so `mv`-ing the completed run's outputs aside is a tracked-file deletion of
  ~56k lines — the exact loss `14677902` refused to let a branch merge cause. It surfaces obliquely:
  the next `npm run check:memory-citations` dies with a raw `ENOENT` stack on
  `.audit-tools/remediation-report.md` rather than a message about a missing deliverable. Archive the
  RUN DIRECTORY (`.audit-tools/remediation/`) and leave the promoted files where they are — a fresh
  run overwrites them on completion, which is the intended lifecycle. Check with
  `git ls-files .audit-tools/` before moving anything under that path.
  [[gitignore-deliverable-tracking]]

- **The operator's declared offload sources live in `~/.audit-code/sources-declared.json` — NOT in the
  repo, and not under `~/.audit-tools/` (2026-08-09).** A previous lap searched `src/`, the repo
  `session-config.json`, the environment and `~/.audit-tools/` and concluded the declaration was
  unfindable; the state dir is `.audit-code` (`AUDIT_CODE_STATE_DIR_NAME`,
  `src/shared/io/stateDir.ts`), reached via `resolveAuditCodeStateDir` and read as
  `SOURCE_DECLARATION_FILENAME` in `src/shared/providers/auditorSources.ts`. Grep for
  `SOURCE_DECLARATION_FILENAME` rather than probing ports. Any stale entry there is announced on every
  invocation as `declared source "<id>" not resolved: …failed the liveness probe` and otherwise
  silently costs the run its offload lane while it looks configured — so a dead entry is removed, not
  left to warn. (The four stale entries pointing at the retired proxy port were removed
  2026-08-09; `$env:AUDIT_TOOLS_STATE_DIR` overrides the location.)

- **A background lane piped through `tail`/`head` shows ZERO bytes until it exits (2026-08-09).**
  Running a refutation lane as `codex exec '<prompt>' < /dev/null 2>&1 | tail -120` in the background
  makes the whole run invisible: the filter buffers to EOF, so the task output file stays 0 bytes for
  the entire job and there is no way to tell a working lane from a hung one — the exact ambiguity the
  entry above says elapsed time cannot resolve. One lane sat at 0 bytes for ~30 min and then returned
  a complete, useful verdict. Redirect to a file instead (`… *> run.log`) and read the log separately,
  which is the same shape the shell-trap guard already forces on suite commands for the exit-code
  reason.

- **Right after the free router restarts, its `/v1` Anthropic surface can forward a router-local key
  UPSTREAM — a transient 401 window, not a permanent property (2026-08-09).** When
  `FREELLMAPI_ANTHROPIC_PASSTHROUGH=subagent-offload` is enabled the server delegates auth on the
  whole `/v1` Anthropic surface. In the minutes after the restart that enabled it, `POST /v1/messages`
  with the `freellmapi-…` key returned `invalid x-api-key` carrying an **Anthropic-shaped `request_id`
  (`req_011C…`)** — the request had left the machine. **Re-probed ~15 min later the same call
  succeeded**, so the documented credential table (unified key → everything free) does hold; the
  failure was a startup window, and treating it as a permanent surface property would send every
  later session to the wrong endpoint.
  **How to tell it apart from a dead pool**, which is the mistake this entry exists to stop: an
  Anthropic `request_id` means auth was delegated upstream (wait and re-probe); the router's own
  refusal reads `Invalid API key` with **no** request id; and a pool problem says
  `rate_limit_error` / `All models exhausted` with a reset time. `POST /v1/chat/completions` with
  `Authorization: Bearer <key>` kept working throughout and is the safe fallback surface.
  ⚠ Check `Get-Process` start time on the listener before diagnosing anything — the router restarts on
  config change, so behaviour can flip under a running session with nothing in `server.log`.

- **A trivial `claude.ps1 -p` prompt did not return in 5 min while the router answered in 0.4s
  (2026-08-09).** The cost is nested Claude Code **session startup**, not the lane, so a hung
  `claude.ps1` is not evidence the pool is down — probe the router directly before concluding
  anything about lane health. It compounds with the nested-session trap below: launched from the repo
  cwd it is a full session in the SHARED checkout. For bounded recon, POST to the router and skip the
  nested agent entirely.

- **A free-pool reply that returns nothing usable is usually `finish_reason: max_tokens`, not a weak
  model (2026-08-09).** The router's `auto` alias resolves to a reasoning model that spends its whole
  budget thinking **in the visible channel** — 7 of 7 contract-drafting jobs came back ~10,200 chars
  of prose having never reached the JSON they were asked for. Always record `finish_reason` /
  `stop_reason`; a `max_tokens` stop means raise the cap or pin a non-reasoning model, and reading it
  as "the free model can't do this" is the myth a standing open-bugs entry already warns about.
  ⚠ **Assistant PREFILL is not honoured as continuation here** — the reply restarts with its own `{`,
  producing `{"name":"x",{"name":"x",…`, so salvage must take the largest balanced object rather than
  assuming the prefill opened it. ⚠ **`/v1/models` listing a model is not a reachability claim**:
  `glm-4.7` is listed and 401s upstream on every call.

- **`.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between
  its markers is silently wiped (2026-07-30).** The wrapper's install path rewrites the whole block,
  and the packaged smoke tests run that install, so `npm test` alone is enough to erase the edit.
  It fails quietly: the rules work right up until any install runs, and the loss shows up later as
  files that were tracked mysteriously becoming ignored again. Already-tracked files are unaffected
  (gitignore does not untrack), which is what makes it easy to miss — only NEW matching files go
  missing. Put custom rules **after** the closing marker; later rules win, so a negation there still
  overrides the block's `.audit-tools/*` / `.audit-tools/*/*` patterns.

- **The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09).**
  A critique repair renders `Regenerate \`finalized_module_contracts\` IN FULL`
  (`renderContractRepairPrompt`, reached from `src/remediate/steps/contractPipeline.ts`), while the
  standing requirement — and the reason INV-CO-13 exists — is a TARGETED EDIT, because regeneration is
  what silently collapsed a 7-module set to 4. A host that follows the prompt does the banned thing.
  Until the prompt text is fixed: repair by editing the payload, and assert the module-name list before
  and after.

- **A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09).**
  CDC-T1 said to widen a module's `file_scope`, but `file_scope` lives in the module decomposition —
  *"the finalized contracts carry interface fields, not paths"*
  (`src/remediate/steps/contractPipeline.ts:2951-2953, 2978`) — and the only route back to the
  decomposition is the pre-critic citation-grounding gate, which fires on a non-existent cited path,
  never on a critique repair. So the repair step could not do what its own critique asked. Nothing
  validates that a critique's remedy is reachable from the phase it is dispatched to; when one is not,
  the fix is a decomposition re-cut, not another repair round.

- **The per-project memory store has NO locking, and a concurrent session silently reverts your edits
  (2026-08-09).** Two Claude sessions purging `~/.claude/projects/<slug>/memory/` at once: three files
  deleted at 17:29 were re-created byte-identical at 17:30:57, and `MEMORY.md` was rewritten three
  times by the other session mid-pass. There is no lock and no conflict signal — the loser's work just
  disappears. Detect it by `stat`-ing mtimes before and after a write; when a second session is live,
  stop and let one own the store rather than interleaving.

- **`MEMORY.md` has no size gate, and the harness read limit is a hard cliff (2026-08-09).** The index
  is bounded by a ~24.4KB read limit with no check enforcing it; adding one index line plus a note
  pushed it to 24,414 bytes — over — and it was caught only by a manual `wc -c`. Measure after any
  index edit. The prescribed reduction is MERGING closed sagas and cutting obsolete memories, never a
  mechanical line-trim (tried, failed).

- **The pre-commit gate can tell you to regenerate a file AFTER you have already attested, which
  silently invalidates the attestation (2026-08-09).** Loop-core commits carry an attestation bound to
  the exact staged tree. Attest, then commit, and the gate refuses on a stale `docs/backlog.md` seek
  index — the fix regenerates a tracked file, which changes the staged tree, which voids the
  attestation you just wrote. You then attest a second time for the same review. Ordering that works
  today: run the derived-file regenerators (`generate-backlog-index.mjs`,
  `generate-handoff-roadmap.mjs`, `check:philosophy-brief -- --write`) FIRST, stage everything, and
  attest last. ⚠ Enforceable and NOT yet enforced: the gate evaluates the attestation before the
  derived-index check, so it fails in the order that maximises rework. Reordering those legs — index
  regeneration checks before attestation binding — removes the trap entirely, at which point this
  entry goes.

## Doc-set hygiene (enforced)


