# Patch 2/3 — `.claude/hooks/shell-trap-guard.mjs`

## a. Extend the import

```diff
 import {
   stripQuoted,
   splitShellStatements,
   stripHeredocBodies,
   findLiveBackticks,
+  findLiveExpansions,
 } from './shell-split.mjs';
```

## b. Add the rule inside the existing `if (isBash) { … }` block

Place it immediately after the `mktemp` rule and before the live-backtick rule, so the two
scanner-based rules sit together.

```js
  // An env var that is UNSET in this shell expands to the empty string, and the
  // failure names the wrong cause: `> "$TMPDIR/x.log"` becomes `> /x.log` →
  // "Permission denied" (reads as a temp-dir permissions problem), and a path
  // read back later resolves against the Windows CWD as
  // `C:\Program Files\Git\x.log` (reads as a missing file). Hit 2026-07-25,
  // -07-28, -07-29 and again 2026-08-09 — the last one WITH an accurate durable-
  // traps entry already written, which is why this is a rule and not prose.
  //
  // Enumerated, not heuristic. `TMPDIR` is simply not set by Git Bash here;
  // `CLAUDE_PROJECT_DIR` is a HOOK-INVOCATION variable that Claude Code
  // substitutes into the command lines in `.claude/settings.json` and never
  // exports to a tool shell. The generalisation worth carrying: any env var seen
  // only in hook command lines is suspect in a tool shell — but the rule names
  // the two that have actually bitten rather than guessing at a class.
  //
  // findLiveExpansions, not stripQuoted: the trap's every observed instance was
  // DOUBLE-quoted (`"$TMPDIR/x"`), which stripQuoted blanks. Single-quoted
  // occurrences are inert and must not fire — `rg '$TMPDIR' docs/` is a search.
  const UNSET_IN_BASH_TOOL = ['TMPDIR', 'CLAUDE_PROJECT_DIR'];
  const expansions = findLiveExpansions(cmd, UNSET_IN_BASH_TOOL);
  // A command that SETS the variable first is correct usage. Same statement-
  // anchored form bypassEnabled() uses, so a mere mention in a string cannot
  // suppress the rule.
  const selfAssigned = new Set(
    UNSET_IN_BASH_TOOL.filter((n) =>
      new RegExp(String.raw`(?:^|[;&|]\s*|\bexport\s+)${n}=`).test(cmd),
    ),
  );
  const liveUnset = [...new Set(expansions.map((e) => e.name))].filter(
    (n) => !selfAssigned.has(n),
  );
  if (liveUnset.length > 0 && !bypassEnabled('AUDIT_TOOLS_ALLOW_UNSET_ENV')) {
    denials.push(
      `${liveUnset.map((n) => `$${n}`).join(' and ')} — UNSET in the Bash tool, so the expansion is the ` +
        'EMPTY STRING and the failure names the wrong cause. `> "$TMPDIR/x.log"` becomes `> /x.log` ' +
        '("Permission denied", which reads as a temp-dir problem), and a path read back later resolves ' +
        'against the Windows CWD as `C:\\Program Files\\Git\\x.log` (which reads as a missing file).\n' +
        '  fix: write the SESSION SCRATCHPAD path by its absolute value (the `C:/Users/.../scratchpad` ' +
        'path in the system prompt); for the repo root use a relative path or `$(git rev-parse --show-toplevel)`.\n' +
        '  note: CLAUDE_PROJECT_DIR is a hook-invocation variable — it is substituted into the command ' +
        'lines in .claude/settings.json and never exported to a tool shell.\n' +
        '  deliberate: set it in the command itself (`TMPDIR=/c/tmp …`), or re-run with ' +
        'AUDIT_TOOLS_ALLOW_UNSET_ENV=1.',
    );
  }
```

## c. Register the bypass in the test harness

`tests/shared/hook-trap-guards.test.ts` scrubs every bypass from the inherited environment so
a developer's exported variable cannot silently disable a rule under test. The new one joins
that list — see patch 3.

## d. Register the rule's reach

`scripts/guard-reach-data.mjs` holds guard wiring as declared data and
`npm run check:guard-reach` reconciles it against the tracked tree. Adding a rule to an
already-registered hook does not add a file, so no new row is required — but confirm with
`npm run check:guard-reach` in the same commit before pushing, because the registry also
records *what each guard covers*, and a covered-trap list that omits this rule is the
"partly enforced reads as a close" failure `CLAUDE.md` calls out.
