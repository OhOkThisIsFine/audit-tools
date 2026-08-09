# Patch 3/3 — `tests/shared/hook-trap-guards.test.ts`

## a. Scrub the new bypass

```diff
 const BYPASS_VARS = [
   'AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE',
   'AUDIT_TOOLS_ALLOW_BACKTICKS',
   'AUDIT_TOOLS_ALLOW_MASKED_EXIT',
+  'AUDIT_TOOLS_ALLOW_UNSET_ENV',
 ];
```

Load-bearing: the harness spreads `process.env`, and this nightly run's own shell had no such
variable set — but a future one might. Without the scrub the three blocking cases below would
go green for a reason unrelated to the guard.

## b. Six cases

Append inside the same `describe` block that holds the other Bash-tool syntax rules (the one
containing the `mktemp` cases). Three must block, three must pass; the passing three are the
false-positive surface, and they are the half that stops the rule being widened by accident.

```ts
  // $TMPDIR / $CLAUDE_PROJECT_DIR are unset in the Bash tool, so they expand to
  // the empty string and the resulting failure names the wrong cause. Hit four
  // times across four dates, the last WITH the durable-traps entry already
  // written — which is why it is a rule.
  it('blocks a DOUBLE-QUOTED $TMPDIR expansion (the form every instance took)', () => {
    const r = runHook(SHELL_GUARD, bash('npm run check > "$TMPDIR/parity.log" 2>&1'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('$TMPDIR');
  });

  it('blocks a BARE $TMPDIR expansion', () => {
    expect(runHook(SHELL_GUARD, bash('cat $TMPDIR/out.txt')).code).toBe(2);
  });

  it('blocks ${CLAUDE_PROJECT_DIR} — a hook-invocation var, never a shell export', () => {
    const r = runHook(SHELL_GUARD, bash('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.mjs"'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CLAUDE_PROJECT_DIR');
  });

  it('SINGLE-quoted $TMPDIR is inert — searching for the literal is not the trap', () => {
    expect(runHook(SHELL_GUARD, bash("rg '$TMPDIR' docs/")).code).toBe(0);
  });

  it('a command that SETS the variable first is correct usage', () => {
    expect(runHook(SHELL_GUARD, bash('TMPDIR=/c/tmp; node x.mjs "$TMPDIR/a"')).code).toBe(0);
  });

  it('honours AUDIT_TOOLS_ALLOW_UNSET_ENV as an inline prefix', () => {
    expect(
      runHook(SHELL_GUARD, bash('AUDIT_TOOLS_ALLOW_UNSET_ENV=1 cat "$TMPDIR/x"')).code,
    ).toBe(0);
  });
```

The last case is not decoration. A guard's stated escape must work **as stated**
[[a-guards-escape-must-work-as-stated]] — every bypass in this hook is advertised as an
inline prefix, and that form sets the variable for a child process the hook never sees. It
works only because `bypassEnabled()` also reads the command text, and this case is what pins
that for the new bypass.

## c. Heredoc coverage is already there

The existing case at the end of the file asserts that a heredoc body naming a trap does not
trip the guard. Every rule reads `stripHeredocBodies(rawCmd)`, so a proposal document that
quotes `$TMPDIR` in a heredoc-delivered commit message is covered by that case without a new
one — confirm it still passes rather than adding a seventh.
