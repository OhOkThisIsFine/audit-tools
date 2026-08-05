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
  **CONCURRENCY:** fan-out at 3, 10 and 12 all degraded (429s, or schema-valid empty documents, or never
  returning). Ceiling **≤2 concurrent per model**, escalating backoff, **resumable** driver (two writers
  to one output file clobber each other). ⚠ The size lap's "pool ~6-wide" PREDATES this — do not use it.
  On this axis the endpoint really is the cause, and `finish_reason` is `undefined`, not `length`.
  Scope is ad-hoc scripts only: audit-tools' own dispatch is paced by declared
  `quota.max_concurrent`/`requests_per_minute` and `laneWorkerKindConflict`. Record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](../reviews/worker-kind-pool-class-rule-2026-07-23.md).
  ⚠ **Never hand-rotate `model` per batch/retry** — the proxy owns retries and same-tier fallbacks
  (`~/.llm-relay/config.json` since the 2026-07-28 LiteLLM retirement); caller-side rotation crosses
  capability tiers and silently downgrades the call.
  ⚠ Rank is not latency: rank-1 `glm-5.2` returned nothing in >15min where `deepseek-v4-flash` answered
  in seconds. Rank-1 is no default for a blocking call. Re-confirmed 2026-07-28: an 836-line analytical
  call to `nim/z-ai/glm-5.2` died `HTTP 504 backend timed out` where small probes answered instantly.
  ⚠ Dead-lane detection is mechanical: `~/.claude/llm-call.mjs` probes `/health` and exits 3 naming
  the restart command. That helper is OUTSIDE the repo — re-add the preflight if it is ever reset.
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
  (`git commit "--no-verify"` works), so stripping quotes would reopen the hole. Reword the message
  (drop the `core.` prefix / the double-dash) rather than weakening the gate.

- **The offload lane must inline source WITH LINE NUMBERS, or any file:line ask is unanswerable
  (2026-07-20, medium).** `~/.claude/llm-call.mjs` inlines each file as raw text. An adversarial
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
  (b) **the offload helper is already fixed** — `~/.claude/llm-call.mjs` POSTs via `node:http` with a
  30-min ceiling (`LLM_TIMEOUT_MS`, request-option `timeout`), so a plain
  `node ~/.claude/llm-call.mjs …` call needs nothing from the caller.
  (c) **a standalone script you hand-roll** (`~/.claude/*.mjs`, scratchpad) — `import("undici")` still
  does NOT resolve (re-verified 2026-07-24: `ERR_MODULE_NOT_FOUND` from `~/.claude` and from the
  scratchpad; resolves only with the repo as cwd). Use `node:http` — or `node:https` for a non-local
  endpoint — with an explicit request `timeout`.

- **`$TMPDIR` is UNSET in the Bash tool, so `"$TMPDIR/x"` writes to the shell's install dir
  (2026-07-25, low).** A heredoc to `"$TMPDIR/plan.md"` became `/plan.md` → `Permission denied`, and the
  reader then resolved it against cwd as `C:\Program Files\Git\plan.md`. The failure is loud but names
  the wrong cause (it reads as a missing file, not an unset var). Write scratch files to the session
  scratchpad path by its absolute value; never assume a POSIX temp var is exported.
  Same class, confirmed 2026-07-28: **`$CLAUDE_PROJECT_DIR` is also unset in the Bash tool** — it is a
  hook-invocation variable (the hook command lines in `.claude/settings.json` resolve it), not a shell
  export, so `"$CLAUDE_PROJECT_DIR/.audit-tools/x.log"` becomes the root path `/.audit-tools/x.log` and
  fails. Any env var seen only in hook command lines is suspect in a tool shell.

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

- **The free offload lane is the local `llm-relay` broker — it must be RUNNING, and callers should
  request a named pool.** Requests go to `127.0.0.1:8791`; start it with a bare `llm-relay`.
  Three consequences:
  (a) there is no standalone fallback — `~/.claude/llm-call.mjs` POSTs that one endpoint, preflights
  `/health`, and exits 3 when nothing is listening, so a failing offload means "start the relay", not
  "the backend is broken".
  (b) Use `pool/fast`, `pool/coding`, or `pool/reasoning`. The relay owns concrete candidates and
  failover; putting a provider/model id in audit-tools recreates the duplicate configuration this
  boundary exists to remove. `llm-relay pools --probe` is the concrete-model health check.
  (c) invocation shape differs by consumer: `llm-call.mjs` takes the model as its FIRST POSITIONAL
  argument, while `--model <spec>` is the *worker/provider* form (claude-worker, codex, agy).
  Offloading to *Claude Haiku* is a separate lane (Agent tool `model: haiku`), unrelated to the proxy.
  (d) the ladder's agy lane pins can go stale against the installed agy model roster (2026-08-05:
  `agy-claude-sonnet` pinned `claude-sonnet-5`, agy only offers `Claude Sonnet 4.6 (Thinking)`; also
  `--effort` is rejected for the Claude models). On an "invalid model selection" error, run the same
  command with a roster model name from the error's list — a relay-config fix belongs in
  `~/.llm-relay/config.json`, not here.

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

- **`tests/audit/audit-code-completion.test.ts` is the slowest file in the whole suite, not just in audit.**
  Rank 1 in every profiled run that lists it (`.audit-tools-profile/vitest-history.ndjson`), 285-470s file
  wall. It drives the full multi-phase audit flow in-process — the CLI handlers are imported and called
  directly, not subprocess-spawned — and `HEAVY_AUDIT_TEST_TIMEOUT_MS = 300_000` is a PER-TEST timeout on
  four tests, so a file wall above 300s is expected, not a hang. **Confirmed, do not re-chase:** production
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
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.ts`.)

- **`pre-commit-gate.mjs` fires only on `git commit`, so every OTHER commit-creating git subcommand lands ungated (2026-07-22, corrected 2026-07-24, low, friction: tool-should-decide).** The gate filters shell statements with `isGitSubcommand('commit')` and returns at `commitSubCmds.length === 0` (both in `runGate`, `.claude/hooks/pre-commit-gate.mjs`), so `git merge`, `git rebase --continue`, `git cherry-pick`, `git revert` and `git am` skip *every* leg — `npm run check`, the doc-contract subset, `check:doc-manifest`, and the loop-core attestation. Seen as stray-doc failures on all three merge commits of the v0.34.7 queue (main red until `0c6a5a6d` registered the docs). **The original remedy — "run the doc-manifest check in the `ci` workflow too" — is a no-op and always was:** `ci.yml`'s `gate` job runs `npm run verify:checks`, which already contains `check:doc-manifest`, and `docs/**` has been a trigger path since `214f601e` (2026-07-19). CI is what *reports* the red; the gate that is missing is the LOCAL one. Real fix: widen the gate's detection to the commit-creating subcommand set — then delete this entry per the hook-enforcement policy.

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
  ⚠ **CLOSED to its floor — `check:tests` reaches 563 of 564 test files.** `tsconfig.test.json`
  sets `checkJs: false`, which silently excludes any `.mjs` test. The 1 file still outside the gate
  is deliberate and permanent: `tests/shared/shared-tests-invariants.test.mjs` (a `.ts` guard cannot
  detect its own exclusion). 563 is therefore the honest ceiling — "the test tree is typechecked"
  carries exactly that asterisk, no larger.

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

- **`.gitignore`'s `>>> audit-tools managed ignores >>>` block is GENERATED — a rule added between
  its markers is silently wiped (2026-07-30).** The wrapper's install path rewrites the whole block,
  and the packaged smoke tests run that install, so `npm test` alone is enough to erase the edit.
  It fails quietly: the rules work right up until any install runs, and the loss shows up later as
  files that were tracked mysteriously becoming ignored again. Already-tracked files are unaffected
  (gitignore does not untrack), which is what makes it easy to miss — only NEW matching files go
  missing. Put custom rules **after** the closing marker; later rules win, so a negation there still
  overrides the block's `.audit-tools/*` / `.audit-tools/*/*` patterns.

## Doc-set hygiene (enforced)


