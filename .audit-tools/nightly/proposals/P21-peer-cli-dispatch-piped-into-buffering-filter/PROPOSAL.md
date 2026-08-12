# P21 — a peer-CLI dispatch (`codex exec` / `agy -p`) piped into a buffering filter shows ZERO bytes until it exits

**Leg 3 (recurring-problem solutions). Proposal only — nothing here has been applied.**
**Recurrence: the SAME defect class the shell-trap guard already promoted to a DENY rule for one
command family (test/verify suites, 2026-07-24) has now re-hit a second, unguarded command family
(peer-CLI dispatch, 2026-08-09) — same mechanism, same fix, no shared enforcement.**

## The trap

`tail`/`head`/`grep`/`wc`/`sed`/`awk` all buffer to EOF before printing anything. Piping a
long-running command into one of them makes a LIVE run and a HUNG run look identical on stdout —
both show zero bytes until the process exits.

This project already found and fixed one instance of this: `npm test 2>&1 | tail -50` was an
ADVISORY, got read past, manufactured a false-green ("masked suite exit code," `docs/backlog/durable-traps.md`
lines 339-345 in git history / the current "masked suite exit code" rule in
`.claude/hooks/shell-trap-guard.mjs`), and was promoted to a DENY rule
(`SUITE_CMD` + `FILTER_PIPE` in `shell-trap-guard.mjs`).

The identical mechanism re-hit a different command family and is **not** covered by that rule,
because `SUITE_CMD` only matches `npm`/`pnpm`/`yarn`/`vitest`/`node --test`:

> **`docs/backlog/durable-traps.md`, "A background lane piped through tail/head shows ZERO bytes
> until it exits (2026-08-09)."** Running a refutation lane as
> `codex exec '<prompt>' < /dev/null 2>&1 | tail -120` in the background makes the whole run
> invisible: the filter buffers to EOF, so the task output file stays 0 bytes for the entire job
> and there is no way to tell a working lane from a hung one … One lane sat at 0 bytes for ~30 min
> and then returned a complete, useful verdict. Redirect to a file instead (`… *> run.log`) and
> read the log separately, which is the same shape the shell-trap guard already forces on suite
> commands for the exit-code reason.

The very next night the cost of losing that visibility compounded further — a wedged `codex exec`
run had already produced 24 usable findings in its transcript before hanging, recoverable ONLY
because that particular run happened to be redirected to a file rather than piped:

> **`docs/backlog/durable-traps.md`, "A broad multi-file review scope kills both peer-CLI lanes …
> (2026-08-09 and 2026-08-10, four deaths in two nights)."** `codex exec` dies slow and quiet: it
> works for ~20-50 minutes, then wedges … and sits at `collab: Wait` until killed. ⚠ **Codex's
> output is NOT lost — read the trace before writing the scope off.** The 2026-08-10 lane had
> already emitted 24 findings into its transcript before wedging; the run that assumed a wedge
> meant no output would have discarded them. Redirect to a file, and on a wedge `awk
> '/^FINDING:/,0'` the trace.

Recorded in the commit history the same way the suite-command version was: `b3e5fcf5` ("traps: the
two peer-CLI lanes die in opposite shapes, and codex's output survives the wedge") and the commit
immediately before it in the durable-traps history that added the tail/head entry — both
2026-08-09/2026-08-10, both re-deriving "redirect to a file" as the fix by hand, in prose, after
the fact — exactly the shape the masked-suite-exit rule's own docblock says an advisory cannot
survive ("An advisory cannot fix a signal that reads green — hence the promotion to DENY").

**Count: 2 distinct dates for the general class (2026-07-24 fixed for suite commands, 2026-08-09
unfixed for peer-CLI dispatch), plus the 2026-08-10 near-miss where the fix existed only because
one particular invocation happened not to be piped.** A one-off would not justify a new rule; this
is the second command family the identical mechanism has hit, and the fix already has a proven
shape in this file.

## Why it isn't already covered

- Not caught by the existing `codex exec` stdin rule — that rule checks for an unclosed stdin,
  unrelated to output buffering.
- Not caught by the existing agy rules — those check `--dangerously-skip-permissions` and piping
  INTO agy (stdin), not piping agy's OUTPUT into a filter.
- Not caught by the masked-suite-exit rule — its `SUITE_CMD` regex matches only
  `npm`/`pnpm`/`yarn run …`/`vitest`/`node --test`; `codex exec` and `agy -p` do not match it.
- Not a duplicate of any proposal in this directory (P1-P20 checked; none targets peer-CLI output
  piping).

## The mechanism

Extend `.claude/hooks/shell-trap-guard.mjs` with one more DENY rule, reusing the `FILTER_PIPE` and
`bypassEnabled()` machinery the masked-suite-exit rule already built: detect `codex exec` or
`agy … -p`/`--print` piped into a buffering filter, and refuse with the same "redirect to a file"
fix, plus the salvage technique (`awk '/^FINDING:/,0'`) the 2026-08-10 incident actually used.

DENY, not advisory — same reasoning the masked-suite-exit rule's own comment gives: there is a
strictly better form for every legitimate use (redirect to a file, then read/tail/grep the FILE
separately), so an advisory here would only repeat the "fires and is read past" failure this
project has already observed once for the sibling rule.

### Patch

See `patch.md` for the full diff to `.claude/hooks/shell-trap-guard.mjs` and the test additions to
`tests/shared/hook-trap-guards.test.ts`.

## What it would have caught historically

Both 2026-08-09 incidents cited above: the `codex exec '<prompt>' < /dev/null 2>&1 | tail -120`
invocation that hid a live 30-minute run, and — had the 2026-08-10 wedged run been piped instead
of redirected — the loss of the 24 findings that were in fact salvaged only because that one call
was not piped.

## False-positive surface

- **Short, genuinely bounded calls piped for convenience** (`agy -p "one-line check" | grep -c
  error`) are blocked even though they would likely have finished before the ambiguity matters.
  This is the same trade-off the masked-suite-exit rule already accepted for `npm test | grep
  fail` — the fix (redirect to a file, grep the file) costs one extra shell token and removes the
  failure mode outright, so the asymmetry favors the DENY.
- **A quoted textual mention** (`rg "codex exec foo | tail" docs/`) — guarded against exactly like
  the existing `codex exec` stdin rule: the check runs on the quote-stripped statement, so a
  mention inside a quoted string does not match the bare `codex exec` / `agy … -p` invocation
  shape.
- **`tee`** is deliberately excluded from `FILTER_PIPE` (already true of the existing rule, not a
  new gap introduced here) — `tee` streams and also writes the file, so `codex exec … | tee
  run.log` is not blocked. Not verified whether `tee`'s own stdout consumer still stalls on a slow
  producer; out of scope for this proposal, which only extends the existing rule to the new command
  family.
- **The escape hatch** (`AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH=1`) exists for a deliberate,
  supervised exception, mirroring `AUDIT_TOOLS_ALLOW_MASKED_EXIT`.
