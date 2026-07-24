# Durable traps

> Standing environment and tooling reference — NOT work to clear.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

A trap that can be detected at a tool call is enforced by a hook in `.claude/hooks/` and its
entry is DELETED here rather than restated: two copies decay independently, and the guard states
the trap and the fix when it fires.

- **Concurrent agent sessions can share the ONE primary checkout (2026-07-23).** Two live
  sessions worked `C:\Code\audit-tools` simultaneously: files changed under each other mid-turn,
  and one session's staged WIP was committed + pushed by the sibling (correctly). Foreign
  mid-session edits/commits are NOT corruption — `git log --oneline -5` + authorship first, never
  a "recovery"; re-read files before editing; before opening a big item check whether the sibling
  is mid-flight on it. Full protocol: memory [[concurrent-sessions-share-the-checkout]]. No
  tooling fix proposed yet; if a collision ever loses work, the mechanical form is a session
  lease/marker in `.claude/hooks/.state/`.

- **`litellm` crashes at import whenever pydantic-core drifts off pydantic's EXACT pin (2026-07-23,
  re-verified 2026-07-24).** `pydantic` pins `pydantic-core==<exact>` (today: pydantic 2.13.4 →
  `pydantic-core==2.46.4`), so any independent bump of pydantic-core — a manual upgrade, or a
  transitive install pulling a newer core — hard-breaks `import litellm`, and the offload lane has no
  fallback when the proxy won't start. The 2026-07-23 instance was core 2.47.0 against a pin of
  2.46.4; that instance is RESOLVED on this box (2.46.4 installed, `import litellm` clean). Same
  env-rot family as prior site-packages breakage.
  ⚠ **Do not copy a version number out of this entry as the fix.** `pip install pydantic-core==2.46.4`
  is correct only while pydantic pins that core, and becomes the skew-*creating* command after a
  pydantic upgrade. Version-agnostic remedy — read the pin, then satisfy it:
  `python -c "import importlib.metadata as m; print([r for r in m.requires('pydantic') if 'core' in r])"`,
  or `python -m pip install --force-reinstall pydantic` to re-pull the matching pair.
  Candidate (hook-shaped per the durable-trap policy — a `litellm --config …` start IS detectable at a
  Bash tool call): a proxy-start preflight comparing installed pydantic-core against pydantic's
  declared pin. ⚠ It must compare that PAIR specifically — `pip check`'s exit code is useless as the
  gate here: it already exits 1 on this box for 7 unrelated mismatches (databricks-sdk, datasets,
  litellm/importlib-metadata, markitdown, omegaconf, sympy, transformers) and reports no pydantic line.

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
  shipped (`src/shared/providers/openAiCompatibleProvider.ts:61,:84-92`) and hand-rolling a `node:http`
  transport there was deliberately rejected — undici IS Node's fetch implementation, pure JS, and HTTP
  transport is correctness-sensitive enough to acquire rather than own.
  (b) **the offload helper is already fixed** — `~/.claude/llm-call.mjs` POSTs via `node:http` with a
  30-min ceiling (`LLM_TIMEOUT_MS`, request-option `timeout`), so a plain
  `node ~/.claude/llm-call.mjs …` call needs nothing from the caller.
  (c) **a standalone script you hand-roll** (`~/.claude/*.mjs`, scratchpad) — `import("undici")` still
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

- **The LiteLLM/NIM offload lane rate-limits hard above ~2 concurrent requests per model (2026-07-23
  remedy update).** A 10-batch fan-out at concurrency 10 (and again at 3) returned
  `litellm.RateLimitError … Error code: 429` on nearly every batch. **Use for any hand-written bulk
  driver:** concurrency ≤2 *per model*, escalating backoff, and a **resumable** driver (skip
  already-processed items, merge into the output file) — a long fan-out will lose batches, and two
  concurrent writers to one output file will clobber each other's progress. **Do NOT hand-rotate the
  `model` per batch/retry** — that half of the original remedy was superseded on 2026-07-23:
  `~/.audit-code/litellm-config.yaml` now declares `router_settings.num_retries: 2` plus same-tier
  `fallbacks` chains for all 13 aliases, and the config comment fixes the contract — roster-level
  fallback lives in the proxy config, not in each caller's retry loop. Caller-side rotation now also
  crosses capability tiers (the old list mixed rank 1 with rank 10), silently downgrading the call.
  Fallbacks cover single-model burst throttling, not aggregate account throughput, so the ≤2 ceiling
  still applies. Scope is now ad-hoc scripts only: audit-tools' own dispatch is paced by the declared
  `quota.max_concurrent: 2` / `requests_per_minute: 15` on the `nim-*-single-shot` sources in
  `~/.audit-code/sources-declared.json`, and `laneWorkerKindConflict` refuses agentic workers on any
  `burst_limited` lane. Distinct from [[offload-lane-failures-are-usually-the-caller]]: this one
  really is the endpoint, and `finish_reason` is `undefined` (not `length`) because the body is an
  error, not a completion. Record:
  [`worker-kind-pool-class-rule-2026-07-23.md`](reviews/worker-kind-pool-class-rule-2026-07-23.md).

- **`codex exec` hangs on an open stdin — inside the product that is guaranteed by the spawn substrate,
  not by each spawn site.** The shell-trap guard refuses the trap only for commands the HOST runs. In
  `src/` there is one spawn substrate, `spawnLoggedCommand` (`src/shared/providers/spawnLoggedCommand.ts`),
  and it closes stdin on both branches: `stdio[0]` is `"ignore"` when no `stdinText` is supplied, and a
  pipe that is `.end()`ed immediately when one is. Every CLI provider — codex, claude-code, claude-worker,
  agy, opencode, worker-command, subprocess-template — routes through it, so no provider carries (or
  needs) stdin handling of its own. The failure mode returns only if new code calls `child_process.spawn`
  directly, because Node's default stdio leaves the child's stdin an open pipe → the silent
  exit-0/empty-output hang. Weak spot: only the `stdinText` pipe branch is asserted in
  `tests/shared/spawnLoggedCommand.test.mjs`; the `"ignore"` default — the branch a `worker_command` of
  `["codex","exec",…]` actually takes — has no test.

- **LiteLLM on Windows dies at startup without `PYTHONIOENCODING=utf-8` (2026-07-18).** The proxy's
  startup banner contains non-cp1252 characters, so `show_banner()` raises
  `UnicodeEncodeError: 'charmap' codec can't encode…` and FastAPI reports only
  `Application startup failed. Exiting.` — the encoding cause is buried far up the traceback. Launch with
  `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 litellm --config … --port 4000`. Two adjacent install traps hit the
  same lap: a bare `pip install litellm` lacks the proxy deps (`ImportError: No module named 'backoff'` →
  needs `pip install 'litellm[proxy]'`), and a mismatched `pydantic-core` (2.47.0 vs the required 2.46.4)
  fails the import with a `SystemError` before any of that. Working config:
  `~/.audit-code/litellm-config.yaml`.

- **A retired or unrecognized key in the machine declaration file fails as a MISSING lane (2026-07-18).**
  `~/.audit-code/sources-declared.json` is operator-authored machine config that no repo test ever reads
  (tests inject `readDeclarationFile`), so a stale key survives a fully green suite. Only `repair_proxy`
  has a *named* rejection (`auditorSources.ts` → a `dropped[]` reason); every other unrecognized top-level
  key and every retired per-source field is ignored in silence — `readSourceDeclaration` reads `sources`
  only, and `validateSessionConfig` has no unknown-key check. There is deliberately **no back-compat
  alias**. The drop reason *is* printed, but on stderr only: `resolveSessionConfig` writes
  `[audit-tools] declared source "<id>" not resolved: <reason>` for every drop (no caller overrides the
  default reporter), while the Gate-0 render carries no drop reasons and the populate half is fully mute
  (`populateDeclaredProxyCatalog` returns `null` for an absent/retired declaration and its call site in
  `nextStepCommand.ts` prints nothing). So the lived symptom is "the lane is gone" plus one easily-missed
  stderr line. After any transport-contract change, re-read the declaration file by hand.

- **The free offload lane is the local LiteLLM proxy — it must be RUNNING, and the model must be one of
  its aliases.** `llm-worker-tools` (`llm read`/`llm write`) is retired; requests go to
  `127.0.0.1:4000` (see `~/.claude/CLAUDE.md` → *Offload lane*). Two consequences: (a) unlike the old
  CLI there is no standalone fallback — `~/.claude/llm-call.mjs` POSTs that one endpoint and exits 1 on
  any non-2xx, so a failing offload means "start the proxy", not "the backend is broken"; (b) the model
  must name a LiteLLM alias — `curl -s 127.0.0.1:4000/v1/models` is the authoritative roster (generated
  into `~/.audit-code/litellm-config.yaml`; `glm-5.2` is rank 1) — never a raw NIM catalog id and never
  `haiku`. A wrong name is loud, not silent: `HTTP 400 … Invalid model name passed in model=…`. Mind the
  invocation shape, which differs by consumer: `llm-call.mjs` takes the alias as its FIRST POSITIONAL
  argument (`--schema` is its only flag), while `--model <alias>` is the *worker/provider* form
  (claude-worker, codex, agy) — so `llm-call.mjs --model glm-5.2 …` sends `model="--model"` and 400s.
  Offloading to *Claude Haiku* is a separate lane (Agent tool `model: haiku`), unrelated to the proxy.

- **After an unattended run, `git diff` the tracked docs before committing.** The nightly maintenance
  routine runs as a local scheduled task (`~/.claude/scheduled-tasks/nightly-maintenance/`) and lands
  real edits in the working tree — leg 1 auto-applies stale-factual doc fixes, leg 2 does mechanical
  backlog cleanup. Those are direct file edits, so `git reflog` shows nothing; an unexpected `M` in
  `git status` is the only signal. Instruction files (`CLAUDE.md`, `AGENTS*.md`) are escalate-only and
  the code anchor is re-verified against HEAD before any write (`docs/nightly-routine.md` → *Safety*),
  but that is the routine's own contract, not a gate — no hook compares a tracked doc against its
  committed version, and the only mechanical pin on `CLAUDE.md` is the one file-lock sentence in
  `tests/audit/file-lock-doc-sync.test.mjs`. Bit once (2026-07-10) under the old branch-snapshot-keyed
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

- **A remediate test file must not re-declare `makeState` *standalone* — wrap the shared helper instead.**
  `INV-remediate-tests-03` (`tests/remediate/remediate-tests-invariants.test.ts`) fails any test file that
  declares a top-level `makeState` without also importing `./test-helpers`. A **wrapper** over the shared
  `makeState({ plan: {...}, items: {...} })` (`tests/remediate/test-helpers.ts`) is allowed and is the normal
  pattern — several files add file-specific defaults on top of it. `step-utils.test.ts` is the one hardcoded
  exception (genuinely different signature). Fires at `npm test` / CI, not at the tool call.
  Observed 2026-07-08 (a new `access-memory.test.ts` tripped it; it now wraps the shared helper).

- **`tests/audit/audit-code-completion.test.mjs` is the slowest file in the whole suite, not just in audit.**
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

- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.) Same class:
  `tests/shared/rollingDispatch.test.mjs` "re-dispatches immediately on result arrival" passes in
  isolation but intermittently reads `2` for `3` under full-suite load — it is sensitive to ambient
  scheduler/FS load, not just dispatch-path latency. `tests/shared/nightly-routine.test.mjs` spins up
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
  `npm test | grep …; echo $?`, which reports grep's status — is caught by the shell-trap guard's
  advisory; the redirect form above is not detectable without false positives, so it stays yours.)

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
  (`package.json:49`, which `verify:release` and `prepublishOnly` wrap and CI's `gate` job runs); each
  does `npm pack` then `npm install --no-package-lock <tarball>` into a temp dir, so only
  `dependencies` are present. Two ways to break the tarball that pass every local check: (1) a
  production runtime `import` declared as a `devDependency` — devDeps are present in dev + the vitest
  suite, and knip's issue-type whitelist (`knip.json:12`) excludes the dependency checks, so only the
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
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)

- **`pre-commit-gate.mjs` fires only on `git commit`, so every OTHER commit-creating git subcommand lands ungated (2026-07-22, corrected 2026-07-24, low, friction: tool-should-decide).** The gate filters shell statements with `isGitSubcommand('commit')` and returns at `commitSubCmds.length === 0` (`.claude/hooks/pre-commit-gate.mjs:187,190`), so `git merge`, `git rebase --continue`, `git cherry-pick`, `git revert` and `git am` skip *every* leg — `npm run check`, the doc-contract subset, `check:doc-manifest`, and the loop-core attestation. Seen as stray-doc failures on all three merge commits of the v0.34.7 queue (main red until `0c6a5a6d` registered the docs). **The original remedy — "run the doc-manifest check in the `ci` workflow too" — is a no-op and always was:** `ci.yml` runs `npm run verify:checks` (`.github/workflows/ci.yml:119`), which already contains `check:doc-manifest` (`package.json:49`), and `docs/**` has been a trigger path since `214f601e` (2026-07-19). CI is what *reports* the red; the gate that is missing is the LOCAL one. Real fix: widen the gate's detection to the commit-creating subcommand set — then delete this entry per the hook-enforcement policy.

## Doc-set hygiene (enforced)




