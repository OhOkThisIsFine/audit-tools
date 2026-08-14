# P31 — an inline `node -e` / `python -c` payload carrying a regex is mangled by the shell before it runs

**Leg:** 3 (recurring-problem solutions) · **Night:** 2026-08-14 · **Status:** proposal only, nothing landed

## The recurrence, counted

| Date | Where | What happened |
|---|---|---|
| 2026-08-14 | this run, leg 1 | A `node -e` scan whose payload held a JS regex literal died in `bash` with `syntax error near unexpected token` — the regex's `\`` and `/` were re-read by the shell. Rewritten as a `.mjs` file in the scratchpad, it ran first try. |
| ≥5 sessions | `/insights` 2026-08-14 report, *Shell quoting and environment fragility* | "Shell quoting mangled inline `node -e` repair scripts twice and corrupted a probe test that had to be redone from scratch." Counted across 18,214 Bash + 2,030 PowerShell calls. |
| standing | memory [[powershell-inline-json-guard-hook]] | The PowerShell half of the same class already earned a hook. |
| standing | memory [[python-write-mode-truncates-before-write]] | Same shape: an inline interpreter payload doing file work, wrong before it ran. |
| standing | memory [[backslash-u-escape-decodes-in-tool-json]], [[submit-packet-shell-traps]] | Escape sequences in a tool-JSON payload decode one layer early. |

Five distinct records, four distinct dates, one shape: **a payload written for an
interpreter is parsed by a shell first, and the shell wins.**

## Why the existing guard does not catch it

`.claude/hooks/shell-trap-guard.mjs` denies a *live* backtick — one that would
command-substitute. Tonight's payload used `\`` inside double quotes, which is
**correctly** not live, so the rule abstained and was right to. The failure was
one layer up: the escaping that made the backtick inert also made the JS regex
invalid. The guard covers substitution; it does not cover **payload integrity**.

That is the honest gap: the covered half is real, and stating it as covered
would be the "trap enforced only partly" mistake `CLAUDE.md` names.

## Proposed mechanism

Extend `shell-trap-guard.mjs` (PreToolUse Bash/PowerShell) with one DENY:

> An inline interpreter payload — `node -e`, `node --eval`, `python -c`,
> `perl -e`, `ruby -e`, `bash -c` — whose body contains a **regex literal**
> (`/…/` with flags, or a `\`-escape run of length ≥ 2) is refused.
> **fix:** write the script to the session scratchpad and run it by path.
> **deliberate:** `AUDIT_TOOLS_ALLOW_INLINE_SCRIPT=1`.

Narrow on purpose. `node -e "console.log(require('./x.json').v)"` — the shape
used four times successfully tonight — carries no regex and no escape run, and
must keep working. The rule fires only on the payloads that historically broke.

## What it would have caught

Tonight's leg-1 citation scan, on the call that failed; and, by the report's
own account, two repair scripts and one probe test that had to be redone from
scratch.

## False-positive surface

A legitimate one-shot regex — `node -e` with a trivial `/foo/` — is refused and
costs one scratchpad file. That is the intended trade: the remedy is strictly
better (re-runnable, diffable, no double-escaping) and takes one extra tool
call. The escape hatch exists for the case where it genuinely is not.

The risk to weigh is **guard fatigue**: this is the fourth DENY on the Bash
path. If the owner judges the rule too broad, the narrower cut is to fire only
on `\`-escape runs (tonight's exact failure) and leave bare regex literals
alone.

## Prefer the fix that removes the trap

There is no way to design away shell-parses-first for an inline payload; the
trap is inherent to the form. So a guard is correct here — but the *guidance*
half also matters, and it belongs with the guard's remedy text, not in a doc
nobody reads at the moment of writing the command.

## Patch + tests

Not written. The rule is one predicate in an existing rule chain, and its
red-green tests belong beside the other guard tests in
`tests/shared/hook-trap-guards.test.ts` (vitest excludes `.claude/**`). Writing
it before the owner rules on the breadth question above would be building the
wrong width.
