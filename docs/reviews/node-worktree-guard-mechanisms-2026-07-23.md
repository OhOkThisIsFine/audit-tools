# Node-worktree guard — mechanism record (2026-07-23)

Dated mechanism record for the node-context clobber tier (backlog "shared-state clobber from
node context" HIGH + the dist-dependent verify false-red + the accreted worker-prompt rules).
Durable behavior lives in the shipped code and its test pins; this records the verified
mechanisms and the refuted alternatives so they are not re-derived.

## The clobber mechanism (verified against source)

A dispatched worker's CWD is its isolated worktree, `<repo>/.audit-tools/worktrees/<name>`
(`worktreePath()`, `src/remediate/steps/dispatch/worktreeLifecycle.ts:390`; audit review
snapshots `review-<runId>` share the parent, `src/shared/providers/reviewSnapshot.ts:47`).
A stray driver CLI run from there with defaults hits `resolveRepoRoot` →
`climbOutOfAuditTools` (`src/shared/io/repoRoot.ts:33`), which truncates at the outermost
`.audit-tools` segment — the anti-drift anchoring designed for operator cwd-drift is exactly
what redirects a worker's invocation onto the REAL shared run state. That is how
`rolling-session.json` was rewritten mid-run (2026-07-22 dogfood).

Two complications found in recon, both load-bearing for the fix shape:

- **The packaged audit wrapper pins the backend's cwd to the PACKAGE root**
  (`wrapper/audit-code-wrapper-lib.mjs`, `run()`), so a backend `process.cwd()` check misses
  exactly the global-bin invocation a stray worker would use. The wrapper does, however,
  absolutize `--root` against the CALLER's cwd before forwarding (`runDistCommand`), so the
  raw `--root` carries the evidence. Fix: the wrapper stamps `AUDIT_TOOLS_CALLER_CWD` on the
  backend spawn; the guard probes env-stamp + own cwd + raw `--root`, all BEFORE
  `resolveRepoRoot` erases the evidence.
- **Workers legitimately run some commands from their worktree** — audit packet workers may
  self-validate and submit (`submit-packet` / `validate-result`, explicit
  `--artifacts-dir-b64` targets; `worker-run` takes explicit `--task` payload paths). So the
  axis is NOT mutating-vs-read-only; it is **driver-only vs worker-safe**, enforced deny-by-
  default with a tight worker-safe allowlist per CLI (audit: `worker-run`, `submit-packet`,
  `validate-result`, `validate-results`, `validate`; remediate: the three validators). A
  future command is refused-from-worker-context until consciously classified.

## Shipped mechanism (v0.34.19)

- `src/shared/io/nodeWorktreeGuard.ts` — path-shape predicate (`nodeWorktreeAncestor`), the
  CLI guard (`assertCliCommandAllowedFromCwd`), the writer assert
  (`assertNotNodeWorktreeCwd`), the env-var contract (`AUDIT_TOOLS_CALLER_CWD_ENV`).
- One chokepoint per CLI: remediate commander `preAction` hook (`src/remediate/index.ts`);
  audit `main()` pre-switch (`src/audit/cli.ts`) — covers the implicit `sample-run` default.
- Wrapper stamp + scrub: `wrapper/audit-code-wrapper-lib.mjs` stamps the caller cwd;
  `stripClaudeCodeEnv` (`src/shared/tooling/exec.ts`) scrubs it from every provider spawn so
  a worker never inherits the driver's stamp (one wrapper→backend hop only).
- Writer-side defense-in-depth (remediate, the observed clobber surface): `StateStore.mutate`
  / `saveState` + the single `writeSessionFile` chokepoint in
  `src/remediate/steps/rollingSession.ts`.
- Pins: `tests/shared/node-worktree-guard.test.mjs` (predicate, allowlist, rawRoot, env
  parity with the wrapper literal, scrub, spawned-dist wiring for both CLIs and the
  non-CLI StateStore shape). Red-green validated by guard-inversion mutation (9 red).

## Refuted alternatives (do not re-derive)

- **Owner-token discrimination** (backlog candidate b): driver and worker are processes on
  one filesystem — any token the driver reads from disk the worker can read; a CLI-flag
  token is a manual flag the host must remember (bug signal by house rule). Tokens remain
  coordination leases (Codex recon: `Math.random()`-minted, documented non-secret,
  fail-open by design at merge).
- **Forced state-dir redirection** (candidate c): workers are spawned by the HOST harness,
  not the tool — the tool cannot force their env; and `AUDIT_CODE_STATE_DIR` redirects
  machine-global quota state, not repo artifacts, so it would not prevent the failure.
- **Build-first for dist-dependent verifies** (backlog candidate for the false-red item): a
  per-node worktree has NO `dist/` (gitignored; only `node_modules` is junction-linked) and
  a central build materializes MAIN's dist, not the worktree's — so "build before the gate"
  cannot fix the false-red. Shipped instead: accept-time partition
  (`partitionDistDependentVerifyCommands`, string + named-test-file content detection,
  conservative toward deferral) into the same drop-family as whole-suite / cross-node
  commands, deferred to the central close gate (fresh build on the merged tree). The
  explicit-override path (`targetedCommands` supplied — the lifecycle unit-test escape
  hatch) is deliberately unpartitioned.

## Accepted residuals (also pinned in the backlog entry)

Audit-side writers rely on the CLI-level guard alone (add writer asserts only on evidence);
a worker that both `cd`s out and passes explicit targets can still reach state (containment,
not authority — the standing-rules prompt section is the remaining layer); a degraded review
snapshot runs workers at the real root with no cwd signal (`rollingAuditDispatch.ts:253`);
deferred dist-dependent commands are subsumed by the close gate's full-suite run, not
individually re-run.

## Review

Two independent adversarial reviews (Codex CLI fresh agent over the staged diff;
NIM deepseek-v4-pro schema-constrained secondary), both "concerns" on first pass.
Disposition of every concern:

**Fixed in-lap (4):** case-insensitive segment compare in `nodeWorktreeAncestor` (win32 is
case-preserving/case-insensitive; refusing more is safe — both reviewers); deferred
dist-commands now recorded durably in `AcceptNodeWorktreeResult.deferredVerifyCommands` →
accept-outcome sidecar, not just stderr (Codex C); the worker prompt's per-node verification
section now partitions dist-dependent targeted commands out (content-scanned against the
MAIN tree) and renders a deferral note instead of a runnable directive — the prompt no
longer contradicts standing rule 4 (Codex C/E1); standing rules 1 and 3 reworded to align
with the File access section's referencing-tests duty and to name `amended_files` as the
sanctioned out-of-scope channel (Codex E2/E3).

**Refuted (3):** UNC-path miss (the scan loop probes every index, not `segments[1]`);
partition-vs-verify content race (worker edits complete before accept; the per-node lock
holds through partition + verify); empty-kept auto-pass as a new hole (the derive always
contributes `npm run check` when git ground truth exists; the no-ground-truth skip is
pre-existing degrade semantics).

**Accepted residuals (recorded in the backlog entry):** read-only commands refused from
worktree context (deliberate fail-closed); cd-out + explicit-target evasion (containment,
not authority); realpath/symlink alias — HARDENED for case only, full realpath probing not
added (tool-minted paths are literal; a maliciously aliased cwd is the evasion class already
accepted); audit-side writers CLI-guard-only; dist detection false-keeps (transitive
imports, non-test scripts — leads-class, conservative regexes documented); deferred
commands subsumed by the close gate's full-suite run rather than individually re-run (a
non-test dist command on a scoped-out target loses its signal — now visible in the sidecar
record if it ever matters). Env-scrub coverage: CLEAN — Codex verified all seven provider
spawn paths route through `stripClaudeCodeEnv`.
