# P27 — the shell-trap guard's own remedy text prescribes the false-green it exists to prevent

Nightly leg 3, 2026-08-13. Queue item `sol-2`. Propose-only.

## The defect

`.claude/hooks/shell-trap-guard.mjs` denies a test/verify command piped into a filter, because
the pipe reports the FILTER's status and a red suite comes back exit 0. Its DENY message then
tells the caller what to do instead — and the suggested shape is itself exit-masking when the
command is **backgrounded**:

- bash branch: `` `npm test > run.log 2>&1; echo "EXIT=$?"` ``
- PowerShell branch: `` `npm test *> run.log; "EXIT=$LASTEXITCODE"` ``

Run as a background task, the trailing statement becomes the compound's exit status, so the
harness completion notice reads *exit code 0* for a RED suite. `docs/backlog/durable-traps.md`
documents exactly this failure and names it as an **enforceable half, not yet enforced**.

So the guard is currently teaching the trap it exists to prevent. No hook anywhere reads
`run_in_background`, so the guard cannot distinguish the safe foreground use from the
false-green background one.

The PowerShell branch is worse than the bash one: a bare string expression as the trailing
statement does not even print reliably.

## Recurrence — counted, 3 dates for the class

| Date | Variant | Status |
|---|---|---|
| 2026-07-24 | pipe form (`npm test \| tail`) | ENFORCED (masked-suite-exit DENY) |
| 2026-08-09 | peer-CLI dispatch piped into a buffering filter | ENFORCED (buffered-dispatch DENY) |
| 2026-08-12 | background form (`suite > log; echo EXIT=$?`) | **NOT enforced** |

The 2026-08-12 incident: a backgrounded suite reported exit 0 while the log held two TS2345
errors. Nobody opened the log before claiming green; CI caught it.

## Mechanism — two shapes, and the owner should pick

**(a) The literal rule** the backlog entry already specifies: for a statement matching the
existing `SUITE_CMD` regex, deny a trailing `; echo …` / `; "EXIT=$LASTEXITCODE"` that becomes
the compound's exit status when the payload is backgrounded. Reuses `SUITE_CMD`,
`splitShellStatements`, and the existing `bypassEnabled` pattern — roughly fifteen lines.

**(b) The class rule**, which is the one the repo's own principle argues for
(*fix the defect CLASS, not the named instance*): a status-laundering detector that inspects
whichever element actually produces the statement's exit status, rather than matching a third
literal pattern one incident at a time.

**Either way, the remedy text must be corrected on BOTH branches first** — that half is
unambiguous and is the part currently doing active harm.

## What it would have caught

The 2026-08-12 false green that reached CI carrying two type errors.

## False-positive surface

A deliberate `cmd; echo done` where the caller genuinely does not care about the status. Narrow,
because the rule is gated on `SUITE_CMD` — test/verify/build commands only.

The honest caveat: this is the **third** instance of one class, each patched as a named
syntactic variant. Shipping (a) is cheap and closes tonight's hole; shipping (b) is the right
shape and stops the fourth variant from needing a fourth patch.

## Not authored this run

Patch and red-green tests not written. Tests belong under `tests/` — vitest excludes
`.claude/**`, so a test beside the hook never runs.
