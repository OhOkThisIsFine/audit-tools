# P58 — The offload-lane probe cannot launch an npm shim, so a live lane reports DOWN

**Scope: MACHINE-WIDE.** The defect is in `~/.agent-config/offload-lane-data.mjs`,
which every repository's session-start guard imports. Fixing it in audit-tools
alone would leave every other repository reporting the same false RED.
The work item belongs in `C:\Code\docs\backlog.md`, not in this repo's backlog.

## What happened

This session opened with:

> OFFLOAD LANE DOWN — Codex peer CLI (`codex exec`) direct to OpenAI is not
> answering (OpenAI Responses API). Plan this lap without it, or bring it up:
> repair or reinstall the Codex CLI and verify `codex --version`

The lane was not down. Measured minutes later, same machine, same session:

- `codex --version` → exit 0 in 262 ms, 260 ms, 320 ms across three runs.
- `codex exec --skip-git-repo-check "Reply with exactly: CODEX_LANE_OK"` → exit 0
  and the correct answer.

## The mechanism

`probeCommand` in `offload-lane-data.mjs` launches the lane's probe as a bare
argv[0] with no shell and no shim resolution:

```js
const child = spawn(commandOverride || probe.command, probe.args, {
  stdio: 'ignore',
  windowsHide: true,
});
```

On Windows `codex` exists only as the npm shim trio `codex`, `codex.cmd`,
`codex.ps1`. Node cannot execute a `.cmd` directly, so the spawn raises ENOENT:

```
ERROR event: ENOENT spawn codex ENOENT
close code: -4058
```

`probeCommand` then maps the child's `error` event to `done(false)`:

```js
child.on('error', () => {
  clearTimeout(timer);
  done(false);
});
```

`false` is the registry's word for DOWN. So a LAUNCH defect in the probe is
indistinguishable from a lane that is genuinely dead, and the row's `note`
("the probe proves the CLI is installed and launchable") states a guarantee the
probe does not deliver. The `codex-cli` row is the only current row with a bare
npm-shim command, so today it is the only one that fires — but the defect is in
the shared probe path, so any future `peer-cli` row installed by npm inherits it.

## Why this is not a new trap

The machine's own instruction file already names this exact failure family and
already ships the fix. `~/.claude/CLAUDE.md`, *Enforcement tooling*:

> **Child processes**: `spawn-safe.mjs` + `lane-dispatch.mjs` (`~/.agent-config/`)
> — use these instead of `spawnSync`/`spawn` in any machine-wide script.
> `runSafe(argv)` resolves `.cmd` shims, REFUSES a shell …
> Built 2026-09-06 after one script hit this family five times in an afternoon,
> every trap already documented.

`spawn-safe.mjs` itself opens by naming the same case:

> A BARE COMMAND NAME MAY BE A .cmd SHIM. `spawnSync("llm-relay", [...])` returns
> ENOENT, because npm installs it as `llm-relay.cmd` and Node cannot execute a
> `.cmd` directly. Same for npm, npx, tsc, eslint, and everything else npm installs.

So the recurrence is: the trap is documented, the resolver exists, and this call
site — a probe whose whole job is to tell the truth about a lane — never adopted
it. The proposed fix is adoption, not new machinery.

## Proposed fix

Route the probe's argv through the machine's ONE shim resolver, `buildSpawnArgs`
(`~/.agent-config/capture-run.mjs`, the same function `runSafe` uses):

```js
const { buildSpawnArgs } = await import('./capture-run.mjs');
const built = buildSpawnArgs([commandOverride || probe.command, ...probe.args]);
const child = spawn(built.file, built.args, {
  ...built.options,
  stdio: 'ignore',
  windowsHide: true,
});
```

The full candidate file is `candidate-offload-lane-data.mjs` in this directory.
`buildSpawnArgs` is a no-op off win32, so the change costs nothing on other
platforms.

**A second, separable question for the owner.** Should an ENOENT — a probe that
could not LAUNCH — stay mapped to `false` (DOWN) at all? The registry already
has a third state: `null` means *unprobeable*, and is silent by design. Mapping a
launch failure to `null` instead of `false` would mean the guard never again
reports a lane dead on the strength of its own inability to start the probe. It
would also silence a genuine "the CLI is gone" case, which is what the row's
remedy text addresses. The shim fix alone closes today's defect; this is the
deeper choice behind it.

## What it would have caught

This session. The guard told the routine to plan without its Codex lane. The
nightly routine's contract makes that consequential:

> If a lane is unavailable, route the work elsewhere. A dead lane may not
> silently shrink coverage; any coverage that still could not run belongs in the
> inbox's `skipped` list.

A false DOWN therefore either shrinks coverage or spends effort routing around a
lane that was working. Last night's run already recorded "The Codex lane was not
used this run" in its skipped list.

## False-positive surface

Very small. The change alters only how argv[0] is resolved, not what counts as
up: `exit code === 0` remains the sole UP test, and the 10 s timer remains the
hard bound. `buildSpawnArgs` returns the input unchanged off win32. The one
behaviour change on win32 is that a `.cmd` target is launched through
`cmd.exe /d /s /c`, which is what `runSafe` already does everywhere else on this
machine.

The risk that remains is the opposite of today's: a `.cmd` shim that exits 0
without the underlying CLI being usable would now read UP. That is the same bound
every other consumer of `buildSpawnArgs` lives under, and the row's own `note`
already limits the claim to "installed and launchable".

## Red-green evidence

`RED-AT.txt` carries the observed failure at HEAD `23079f37`, the verbatim
assertion, and the green half proven against `candidate-offload-lane-data.mjs`.
The test (`lane-probe-shim.test.mjs`) is hermetic: it builds its own shim pair on
a temporary PATH and probes a fixture lane row, so it spends no quota and does
not depend on Codex being installed.

Note that the test lives here, not under `tests/`, deliberately. Its subject is a
machine-wide module that is not tracked in this repository, and a repo test that
reads it would be a gate asking the local disk. When the fix lands, the test
belongs beside `spawn-safe.test.mjs` in `~/.agent-config/`.
