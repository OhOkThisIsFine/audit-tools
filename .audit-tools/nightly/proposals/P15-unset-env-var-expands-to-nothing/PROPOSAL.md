# P15 — an env var that is unset in the Bash tool expands to nothing, and the failure names the wrong cause

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Recurrence: four instances across four dates. Two are already written down as durable traps
and were re-hit anyway, which is the point.**

## The recurrence

`$TMPDIR` and `$CLAUDE_PROJECT_DIR` are both **unset in the Bash tool's shell**. Neither is
exported: `TMPDIR` is not set by Git Bash on this box, and `CLAUDE_PROJECT_DIR` is a
hook-invocation variable that Claude Code substitutes into the hook command lines in
`.claude/settings.json` — it never reaches a tool shell.

An unset variable in POSIX sh expands to the empty string. So

```
npm run check > "$TMPDIR/parity.log" 2>&1
```

becomes `> /parity.log`, which fails with `Permission denied` — and the *reader* of that
message concludes "I cannot write to temp", not "the variable is empty". When the path is
read back rather than written, it is worse: `/plan.md` resolves against the Windows CWD as
`C:\Program Files\Git\plan.md` and the failure reads as a missing file.

Four instances, four dates:

| Date | Variable | Where it is recorded |
|---|---|---|
| 2026-07-25 | `$TMPDIR` | `docs/backlog/durable-traps.md` — the entry that names the trap |
| 2026-07-28 | `$CLAUDE_PROJECT_DIR` | same entry, "Same class, confirmed" |
| 2026-07-29 | `$TMPDIR` | `docs/backlog/open-bugs.md` friction walk, item (2) |
| 2026-08-09 | `$TMPDIR` | this nightly run's first redirect, `> "$TMPDIR/parity.log"` |

The 2026-08-09 hit is the evidence that matters. The trap has had a written durable-traps
entry since 2026-07-25, and the entry is accurate, complete, and states the fix. It did not
prevent the fourth hit, because a prose entry only works on a reader who has read it and
remembers it at the moment of writing a redirect. That is precisely the failure mode
`CLAUDE.md` names: *durable traps are MECHANICALLY enforced, not remembered*, and
*"be careful" is never a fix*.

## The mechanism

A new DENY rule in `.claude/hooks/shell-trap-guard.mjs`, Bash-tool only: refuse a command
that **expands** a variable known to be unset in that shell, and name the correct form.

The guard already carries four Bash-tool syntax rules of exactly this shape (Windows
backslash path, PowerShell here-string, `mktemp`, live backtick). This is the fifth, and it
is the cheapest of them to get right because the property is purely syntactic.

"Expands" is the load-bearing word, and it is why this rule cannot reuse `stripQuoted`.
`$TMPDIR` expands **bare and inside double quotes**, and is inert **inside single quotes** —
the same three-way context distinction `findLiveBackticks` already walks. `stripQuoted`
blanks double-quoted spans too, so it would miss `> "$TMPDIR/x"`, which is the exact form
every one of the four instances took. The patch therefore generalises the existing walk into
`findLiveExpansions(s, names)` in `.claude/hooks/shell-split.mjs` rather than adding a second,
subtly-different scanner. One quote-context walk, two callers.

### False-positive surface

Three cases must NOT fire, and each is handled:

1. **The command sets the variable itself.** `TMPDIR=/c/tmp node x.mjs` or
   `export TMPDIR=...` makes the expansion correct. Detected with the same
   statement-anchored assignment regex `bypassEnabled()` already uses, so a command that
   merely mentions the name in a string cannot suppress the rule.
2. **The name appears inside single quotes.** `grep '$TMPDIR' docs/` searches for the literal
   text; `echo 'use $TMPDIR'` writes it. Inert by construction — `findLiveExpansions` skips
   single-quoted spans.
3. **A heredoc body.** Already handled upstream: every rule reads `cmd`, which is
   `stripHeredocBodies(rawCmd)`. Writing documentation *about* the trap through a heredoc is
   not the trap.

The remaining false-positive risk is a variable that is genuinely exported in some future
shell configuration. That is why the list is **two names, enumerated**, not a heuristic over
"looks like an env var" — and why the rule carries the standard
`AUDIT_TOOLS_ALLOW_UNSET_ENV` bypass, which routes through `bypassEnabled()` like the other
three.

### What it would have caught

All four instances above, at the moment the command was submitted, with a message naming the
empty expansion rather than the downstream `Permission denied`.

## The patch

Three files. Full text in this directory:

- [`patch-shell-split.md`](patch-shell-split.md) — `findLiveExpansions()` added to
  `.claude/hooks/shell-split.mjs`, mirroring `findLiveBackticks()`.
- [`patch-shell-trap-guard.md`](patch-shell-trap-guard.md) — the rule itself, inside the
  existing `if (isBash)` block.
- [`patch-tests.md`](patch-tests.md) — six cases appended to
  `tests/shared/hook-trap-guards.test.ts`: three that must block (bare, double-quoted,
  `$CLAUDE_PROJECT_DIR`), three that must pass (single-quoted, self-assigned, bypass).

### What was actually observed, and what is still only asserted

**Observed.** The scanner + self-assignment logic was prototyped in the session scratchpad and
run against eleven commands — the four historical instances in their real form, plus the
`${BRACED}` variant and six false-positive cases. All eleven gave the wanted verdict, including
`echo "$HOME/$PATH and $TMPDIR_OTHER"`, where the name regex matches the full `TMPDIR_OTHER` and
correctly misses the set. So the detection half is not a guess.

**Still asserted.** Nothing was written into `.claude/hooks/` or `tests/`, so the wiring — that
the rule lands inside the `isBash` block, that `denials.push` produces exit 2, that the harness
scrub covers the new bypass — is unverified by execution.

### Red-green validation the applier must run

- **Red:** add the six test cases alone, run `npx vitest run tests/shared/hook-trap-guards.test.ts`
  — the three blocking cases must FAIL (guard exits 0).
- **Green:** add the two hook changes, re-run — all six pass.
- **Restore by inverting the edit, never by `git checkout`**
  [[redgreen-restore-by-inverting-never-checkout]].

## The deletion this earns

`CLAUDE.md`'s standing rule: *a trap that can be enforced is enforced, and its backlog entry
is DELETED rather than restated.* This rule covers the whole trap — both variables, both the
write and the read-back direction — so on apply, the `$TMPDIR` entry in
`docs/backlog/durable-traps.md` (including its "Same class, confirmed 2026-07-28"
`$CLAUDE_PROJECT_DIR` half) is **deleted in the same commit**, and
`scripts/guard-reach-data.mjs` gains the row for the new rule so
`npm run check:guard-reach` stays green.

The generalisation the entry carries — *"any env var seen only in hook command lines is
suspect in a tool shell"* — is the one thing the mechanism does not state, because the
mechanism enumerates two names rather than reasoning about a class. That sentence moves to
the rule's own code comment in the same edit; it does not stay behind as a backlog remainder.
