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

- **A tracked generated doc that links to an UNTRACKED file blocks every docs-touching commit
  (2026-08-20).** The commit gate materializes the STAGED tree — untracked files vanish — before
  running `check:doc-links`, so a link from a tracked doc to an untracked target resolves to
  nothing there while the standalone `npm run check:doc-links` passes every time. Deterministic,
  not a flake, and the failure names the link rather than the untracked file, so it reads as a
  broken doc. Hit when the routine's generated inbox linked a freshly-written proposal that had
  never been `git add`ed: two agents each failed five commits and correctly refused to bypass.
  Proposals under the routine's proposals directory are tracked BY CONVENTION — add the new one,
  and the gate clears.

- **`git commit` after `git add <paths>` commits the whole INDEX, not your paths (2026-08-20).**
  A concurrent agent's already-staged files ride your commit and land under your message. Hit at
  closeout: a docs agent's three staged backlog files landed inside a one-file handoff fix, which
  then needed an amend to describe what it actually carried. When any other agent may be staging,
  scope the commit itself — `git commit -- <pathspec>` — rather than trusting the index.

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

- **A broad multi-file review scope kills both peer-CLI lanes, and they fail in OPPOSITE shapes
  (2026-08-09 and 2026-08-10, four deaths in two nights).** `agy -p` dies fast and loud —
  `Error: timeout waiting for response`, ~36 bytes, nothing salvageable. `codex exec` dies slow and
  quiet: it works for ~20-50 minutes, then wedges inside its own collab/agent-spawn subsystem
  (`ERROR codex_core::tools::router:` — `timeout_ms must be at least 10000` one night,
  `Full-history forked agents inherit the parent agent type` then `collab spawn failed: agent thread
  limit reached` the next) and sits at `collab: Wait` until killed. ⚠ **Codex's output is NOT lost —
  read the trace before writing the scope off.** The 2026-08-10 lane had already emitted 24 findings
  into its transcript before wedging; the run that assumed a wedge meant no output would have
  discarded them. Redirect to a file, and on a wedge `awk '/^FINDING:/,0'` the trace. Mitigation is
  the standing one ([[nim-offload-reliable-unit-is-one-entry]]): one bounded scope per dispatch, not
  seven files in one prompt.

- **A PreToolUse block kills the WHOLE chained command — the earlier statements never ran (2026-07-25).**
  A refused `git add <files> && git commit …` is refused at the tool call, before any statement executes, so
  the `add` did not happen either — and the retry fails identically, reading as "the gate ignored my fix".
  Compounded by the constitutional-doc / loop-core attestations, which bind to the EXACT staged tree: the
  natural `add && attest && commit` chain can never work, since staging after attesting invalidates the
  override. Stage in its own call, then attest, then commit. (Converse of
  [[pretooluse-gate-misses-chained-git-add-commit]], where the chain BYPASSES the gate.)

- **An "open item" claim in a MEMORY or spec is a lead, not a work order (2026-07-19).** The memory
  consolidation found a memory listing four open items of which three were long done. Same decay as
  [[backlog-prose-decays-verify-against-head]], but in the memory store, where nothing ever forces a
  re-read. Verify any "open"/"remaining"/"TODO" claim against HEAD before it becomes work.

- **Never delete from a backlog file by LINE NUMBER.** Entries can span two physical lines while being
  one logical bullet, because a hook may embed a literal newline inside a code span. A line-keyed delete
  then removes half an entry and leaves an orphaned fragment that reads as corruption. Bit `open-bugs.md`
  during the 2026-07-19 classification pass. Delete by matching the entry's TEXT, and after any scripted
  edit scan for orphans — lines not starting with `-`, `>`, `#`, a space, `|`, or a backtick.

- **A Claude lane whose isolated `CLAUDE_CONFIG_DIR` has not TRUSTED the workspace answers from
  nothing rather than failing (2026-08-15).** The dir is trusted per-project and trust is NOT
  inherited from a parent path, so `C:/Code` being listed does not cover `C:/Code/audit-tools`. The
  run opens with `Ignoring N permissions.allow entries … this workspace has not been trusted`, then
  proceeds with no repo tools and **fabricates a confident, well-formed answer** — a doc-review
  request came back as a sprint closeout claiming zero findings and a green 5111-test run it never
  executed (recorded as the symptom in `23d2a1e8`; cause found two nights later). For a
  corroboration lane this is worse than silence: it manufactures agreement
  ([[lane-agreement-is-not-evidence]]). Check line 1 of the lane's log before believing any reply.
  UNENFORCED — no guard checks lane workspace trust; the session-start lane leg (P36) probes
  per-lane TRANSPORT liveness from the declared registry (`scripts/shared/offload-lane-data.mjs`)
  and cannot see trust. Fix + guard proposed as nightly P33.
  [[pool-lane-fabricates-when-untrusted]]

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
  Scope is ad-hoc development scripts only; audit-tools does not schedule these calls. Record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](../reviews/worker-kind-pool-class-rule-2026-07-23.md).
  ⚠ **Never hand-rotate `model` per batch/retry** — the proxy owns retries and same-tier fallbacks
  (the router owns them); caller-side rotation crosses
  capability tiers and silently downgrades the call.
  ⚠ Rank is not latency: rank-1 `glm-5.2` returned nothing in >15min where `deepseek-v4-flash` answered
  in seconds. Rank-1 is no default for a blocking call. Re-confirmed 2026-07-28: an 836-line analytical
  call to `nim/z-ai/glm-5.2` died `HTTP 504 backend timed out` where small probes answered instantly.
  ⚠ Dead-lane detection at SESSION START is mechanical again (P36): `session-start-guards.mjs`
  iterates the declared lane registry (`scripts/shared/offload-lane-data.mjs`, reconciled by
  `npm run check:offload-lanes`) and names each down lane with its remedy. That is a lap-start
  snapshot only — before a LONG mid-lap dispatch, probe the router yourself (`/v1/models`;
  200-with-JSON or 401 = up), or a lane that died mid-lap is indistinguishable from a slow one.
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

- **An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right
  (2026-07-20, medium).** A NIM (`glm-5.2`) call to verify an axis claim returned an accurate
  per-call-site breakdown that correctly refuted the claim — but attributed sentences to the design
  record that actually came from a just-written source file passed in the same call, and invented a
  verbatim supporting quote that exists nowhere. The lane's structural analysis was worth the
  call; every citation in it was worthless. Treat quoted evidence from the lane as the LEAST reliable
  part of its output, not the most — the opposite of the intuition that a quote is checkable proof.
  ([[offload-lane-failures-are-usually-the-caller]] is about weak-looking output; this is the inverse
  failure — confident output with fake support.)

- **The free offload lane is a local router — it must be RUNNING, and callers should request the
  `auto` alias.** Requests go to `127.0.0.1:3001`; start it with
  `powershell -File C:\Users\ethan\freellmapi\start.ps1`. ⚠ This lane has now outlived THREE
  transports — two earlier local brokers on other ports were each retired within weeks — so treat
  any endpoint, port or model name written down here as stale until probed. Three consequences:
  (a) there is no standalone fallback — every offload call goes to that one endpoint, so a failing
  offload means "start the router", not "the backend is broken".
  (b) Address the `auto` alias, not a concrete model. The router owns candidate selection and
  failover. Ask the router's own `/v1/models` for the live roster rather than trusting any written
  list, this one included.
  A listed model may still fail at work time, so probe it with a real `/v1/chat/completions`
  round-trip after a router upgrade; endpoint-alive is not model-alive.
  ⚠ **`/health` is NOT a health check on this router — it has no such route, and the SPA catch-all
  answers `200` for ANY unmatched path** (verified 2026-08-18: `/health` → 200,
  `/this-path-does-not-exist-xyz` → 200, `/v1/models` → 401). So a status-only probe of `/health`
  passes whenever *a web server is listening*, including when the inference surface is dead. Probe
  `/v1/models` instead and treat `200` or `401` as up — `401` is "router up, key wrong", which is a
  different failure with a different fix. The session-start guard and its reconciler now enforce
  this probe shape mechanically (P36: the hook may not carry `/health` or any hardcoded lane URL);
  this paragraph remains for AD-HOC callers probing by hand.
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
  committed version. Bit once (2026-07-10) under the old branch-snapshot-keyed
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
  wall is expected, not a hang.** It was ONE file (`audit-code-completion.test.ts`) and the slowest in the <!-- doc-citation-exempt: names the pre-split file deliberately -->
  whole suite — rank 1 in every profiled run that listed it
  (`.audit-tools-profile/vitest-history.ndjson`) — until it was split over
  `tests/audit/helpers/completion-harness.ts` (2026-08-07, wall-clock brief T4); the fragments are still
  among the slowest files in the suite. The CLI handlers are imported and called directly rather than subprocess-spawned, and
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
  iterations — each test builds a fresh temp repo and pumps up to `MAX_FINALIZE_STEPS` next-step calls
  (`tests/audit/helpers/completion-harness.ts`). Full investigation record: memory
  `audit-no-redundant-reextraction-verified`.

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
  ⚠ The BACKGROUND variant bit on 2026-08-12 and is one level sneakier: `suite > log; echo "EXIT=$?"`
  run as a background task ends with the echo, so the harness completion notice reads "exit code 0"
  for a RED suite — the real status lives only in the task's unread stdout, and the log held two
  TS2345 errors nobody opened before "green" was claimed (CI caught it). In a background task let
  the suite's exit BE the command's exit (`suite > log 2>&1`, no trailing echo), then read the log
  on a non-zero notice. The BACKGROUND variant is now ENFORCED: the shell-trap guard refuses a
  backgrounded suite command whose exit a trailing `;`/`||`/newline statement would launder
  (escape: `AUDIT_TOOLS_ALLOW_MASKED_EXIT=1`; a terminal `exit $?` / `exit $LASTEXITCODE`
  pass-through and `&&`-chains are allowed; in-statement `&` backgrounding stays undetected). The
  foreground redirect form above is still not detectable without false positives, so it stays yours.

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
  `scripts/audit/smoke-packaged-audit-code.mjs`; the remediate smoke
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
  live use. Injectable-deps seams remain the right tool where the seam is IO or a step boundary,
  but they are no longer a blanket rule: their original rationale was a retired test runner that
  could not mock modules.

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

- **Do not hand-edit a wedged audit run — use `audit-code force-synthesis`.** Manual changes to
  gitignored task or planning artifacts are overwritten or create false staleness. The tool-owned
  command in `src/audit/cli/forceSynthesisCommand.ts` runs synthesis from evidence already accepted
  by the ledger; it does not invent completion, and uncovered tasks remain visible as uncovered.

- **A residual-reference check run with an ignore-bypassing search manufactures false positives (2026-07-24, low).** `dist/`, `.claude/*` and `.audit-tools/*/*` are gitignored, so `rg` and `git grep` — the project's default search tools — provably cannot see a worktree's or a build tree's output. `grep -r` and PowerShell `Select-String -Recurse` honour no ignore file, so they hit `dist/**` and report deleted code as still referenced. Verified twice by probe. When checking whether a symbol is truly dead, use the ignore-aware tool; a `grep -r` hit inside `dist/` is the compiled copy of the very code you deleted, not a caller.

- **A root-containment check must survive BOTH a win32 cross-drive path and a real `..`-prefixed name.**
  Deduping five hand-rolled copies of the guard exposed two live bugs no copy and no entry had
  predicted: the worktree-seeding copy omitted `isAbsolute`, so on win32 a path on a DIFFERENT DRIVE
  read as contained (a cross-drive `relative()` returns an absolute path), and every copy's
  `startsWith("..")` wrongly rejected a legitimate entry named `..cache`. Five copies of a security
  predicate is not a style problem — deduping one is correctness work
  ([[five-copies-of-a-guard-hid-two-bugs]]).

- **The Grep tool's content output can mangle comment markers with a BACKSLASH.** It rendered
  JSDoc openers and `//` line comments as `\**` / `\ ` (observed 2026-07-29) — a
  harness display artifact that reads exactly like file corruption. Verify with a Read of the same
  lines before diagnosing corruption or "fixing" the file.

- **After a "string to replace not found" on text you JUST wrote, grep for the anchor instead of
  re-reading the whole file (2026-07-16).** The one recorded case was never explained (the suspected
  hook rewriter was falsified 2026-07-25); the mitigation stands on its own.

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

- **Child sessions in the shared checkout — session-registry split (2026-08-18, mechanized;
  supersedes the 2026-08-07/09 kill-switch advice).** SessionStart registers each session in
  `.claude/hooks/.state/sessions/`; while ≥1 record exists (enforcement armed), an unregistered
  session gets exit-0 from all three Stop gates (closeout-challenge, friction, question-philosophy
  Stop leg) and its `git commit` / `git push` is refused by the pre-commit gate. In-process
  Agent/Workflow subagents never fire SessionStart, so they are covered automatically, though
  they DO get Stop events (two once committed to main mid-fan-out:
  `00d6fbfd`, `c687fed9`). No record at all (fresh clone, wiped
  `.claude/hooks/.state/`) = pre-feature behavior. Uncovered halves, stated outright:
  - A NESTED `claude -p` with this repo as cwd DOES fire SessionStart and self-registers as an
    owner unless the dispatcher sets `AUDIT_TOOLS_CHILD_SESSION=1` on the child env, per
    dispatch. Lanes: the freellmapi pool launcher (`claude.ps1`) pointed at this repo, the
    nightly `/insights` invocation (docs/nightly-routine.md), any ad-hoc `claude -p` worker, and
    the freellmapi MCP offload pool lane (`claude.exe -p`, repo cwd, server-side env; observed
    2026-08-18: child self-registered, Stop closeout-challenge REPLACED the final answer;
    `claude.ps1` fixed same day. FIXED 2026-08-19, config-only, no restart — detail on the
    `mcp-pool` row of `scripts/shared/offload-lane-data.mjs`).
  - Script-mediated commits: `node scripts/release-and-publish.mjs` and `npm version` run git in
    a child process the PreToolUse hook never sees.
  - The refusal is a footgun guard, not an adversary gate: the allow token and recovery CLI are
    repo-readable; the refusal text just must not route a child to them.
  - Registry wipe = silent disarm: `.claude/hooks/.state/` is gitignored, so `git clean -xdf`
    returns every gate to legacy until the next SessionStart — the named cause when the
    closeout challenge "stopped firing".
  - The PowerShell-form inline token (`$env:…='1'; git …`) is NOT recognized — dispatchers use
    the bash-form inline prefix or the hook-env form.
  Per-dispatch git allowance: lead the child's specific git command with
  `AUDIT_TOOLS_AGENT_GIT=1` inline (visible in transcript, never standing config); the hook-env
  form exists for lanes that cannot inline. Owner-session recovery:
  `node scripts/shared/sessionRegistry.mjs --register <session-id>` from the repo root — explicit
  id from a hook payload; deliberately no discovery mode.

- **The `audit-code-completion-*` files can flake together under full-suite load, and the symptom
  reads exactly like a regression (2026-08-09).** Seen: `-present`, `-promote`, and `-ingest-dir`
  failed in one full run with `next-step did not reach present_report within
  10 calls` and `expected only blocked/present_report while finalizing, got design_review_parallel`.
  All passed **alone**, and a second full run on the **identical tree** was green — 597 files,
  0 failed. They are not in `scripts/shared/test-flake-baseline.json`, so nothing tells you this.
  The symptom is a *call-count* limit, not a timeout, which is why it does not look load-related:
  under contention a step can come back `blocked` (or re-enter an obligation after a staleness
  cascade) and burn one of the 10 allowed calls. Before treating this cluster as a regression: run
  the current completion files alone, then re-run the FULL suite on the same tree. Two greens plus a mechanism argument
  is the bar — a single alone-pass is not, because these are the slowest files in the suite
  and spin real audit runs through real subprocesses.

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
  config change, so behaviour can flip under a running session with nothing in its own log output.

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
  finalized-contract interface prose remains prose, though since P38 path-parseable `outputs` /
  `side_effects` entries are unioned into node write scope by `buildNodeWriteScopeResolver` — and the
  only route back to the
  decomposition is the pre-critic citation-grounding gate, which fires on a non-existent cited path,
  never on a critique repair. So the repair step could not do what its own critique asked. Nothing
  validates that a critique's remedy is reachable from the phase it is dispatched to; when one is not,
  the fix is a decomposition re-cut, not another repair round.

- **The per-project memory store has NO locking, and a concurrent session silently reverts your edits
  (2026-08-09).** Two Claude sessions purging `~/.claude/projects/<slug>/memory/` at once: three files
  deleted at 17:29 were re-created byte-identical at 17:30:57, and `~/.claude/…/memory/MEMORY.md` was rewritten three
  times by the other session mid-pass. There is no lock and no conflict signal — the loser's work just
  disappears. Detect it by `stat`-ing mtimes before and after a write; when a second session is live,
  stop and let one own the store rather than interleaving.

- **The `~/.claude/…/memory/MEMORY.md` index has no size gate, and the harness read limit is a hard cliff (2026-08-09).** The index
  is bounded by a ~24.4KB read limit with no check enforcing it; adding one index line plus a note
  pushed it to 24,414 bytes — over — and it was caught only by a manual `wc -c`. Measure after any
  index edit. The prescribed reduction is MERGING closed sagas and cutting obsolete memories, never a
  mechanical line-trim (tried, failed).

- **An attestation binds to the staged tree, and a later gate-demanded regeneration used to void it
  (2026-08-09; ENFORCED at the attest scripts 2026-08-12, P19).** Loop-core and constitutional
  commits carry an attestation bound to the exact staged tree; a stale derived file (backlog seek
  index, HANDOFF roadmap, doc manifest, guard-reach registry) makes the gate demand a regeneration
  that changes that tree and voids the attestation. Both attest scripts now run the SAME derived leg
  set the gate runs BEFORE binding — since P34 (2026-08-18) both sides derive it from the guard-reach
  registry through one module (`scripts/shared/derived-file-preflight.mjs` `buildPreCommitLegs`), so
  the two cannot diverge as legs are added — and refuse to write an attestation the gate would
  reject. (An earlier remedy here prescribed reordering the gate's legs — falsified: the derived
  checks already ran first; leg order was never the mechanism, because the gate runs at commit time
  and the attestation is written in an earlier tool call.) ⚠ The uncovered half, stated outright:
  the preflight covers only the derived `preCommit` legs. The doc-contract test leg
  (`test:doc-contract`, up to 240s) is deliberately excluded — including it would make attest cost as
  much as the gate — so a doc-contract failure can still void an attestation and force a second attest.

- **`docs/backlog.md` is NOT a record path to `writeOpenItems`, but `docs/backlog/*` is** (hit
  2026-08-13). `isRecordPath` (`scripts/nightly/items.mjs`) matches the `docs/backlog/` prefix, so
  the split item files are record paths and the router file one directory up is not. The two
  refusals are opposite and both fire at write: an item probing `docs/backlog/durable-traps.md`
  MUST declare `auto_close: false`, and an item probing `docs/backlog.md` must NOT — declaring it
  is refused as "not a positive probe on a record path". Nothing about the two filenames signals
  which side a given item falls on, so authoring a queue item against the router file is a
  guess-then-retry. Enforceable half: the refusal message already names the record set, but it
  fires only after the batch is assembled; a `recordPathHint(file)` export would let an author
  check the classification up front.

- **Git-bash `/tmp` and node's `C:	mp` are different directories (hit 2026-08-18).** A Bash-tool
  redirect to `/tmp/x.log` lands in the msys temp root, but a node script reading `/tmp/x.log`
  resolves `C:	mp` and ENOENTs on a file that exists. Redirect to the session scratchpad (or any
  explicit `C:/` path) when node will read the file back.

- **A commit-carries-its-record-update gate has a covered mechanical half and an uncovered
  semantic half (measured 2026-08-18, closed covered-by-neighbors).** The one real incident
  (2026-07-28: execution state lived only in an untracked checkpoint while HANDOFF/backlog/queue
  said otherwise) does not get a dedicated gate — measurement against 180 commits found zero true
  positives at any threshold and zero declarable work↔record path pairs
  (`docs/reviews/record-update-gate-measurement-2026-08-18.md`). Its mechanical halves are each
  independently enforced instead: HANDOFF generated-state parity (`check:handoff-roadmap` at
  commit + CI + the closeout gate at Stop), answered≠done ledger visibility
  (`completed_at`/`completed_ref` split + the SessionStart nudge in `nightly-surface.mjs`), and
  nobody-asked-at-close (closeout-challenge evidence legs). The semantic half — record PROSE says
  the right thing — is the unscriptable sol-5 class: uncovered, and stated here outright per the
  partly-enforced-trap rule, since `check:backlog-status` bans status fields so there is no field
  a gate could even demand.

- **Never amend or rebase a landed wave commit after the remediation workload prepare
  (2026-08-19).** The prepared binding pins `baseline_commit` = HEAD-at-prepare; an amend re-mints
  that commit and orphans the baseline, after which EVERY acceptance fails
  `baseline_not_ancestor` — and no re-prepare can fix it (a fresh baseline is a descendant of the
  landed commits). The sanctioned repair is `remediate-code recover-ingest` (true-orphanhood-gated,
  ledger-marked, spawn-free under the state lock). Cost when it happened: 12 landed items pending
  in state, a full design-check + three review rounds to build the verb.

- **A subagent's Read tool can serve STALE pre-edit content for a file another agent is
  concurrently editing (2026-08-20).** Hit twice in one session: Read returned a file's
  pre-edit content at pre-edit line numbers while ripgrep and direct disk reads showed
  the post-edit tree, so a reviewer using Read alone would have reviewed the wrong
  file. When Read contradicts a grep, trust the disk read and re-verify. Suspect the
  proxy's tool-result interception first (its own documentation says to drop that flag
  when an agent acts on file content that does not match disk).

## Doc-set hygiene (enforced)
