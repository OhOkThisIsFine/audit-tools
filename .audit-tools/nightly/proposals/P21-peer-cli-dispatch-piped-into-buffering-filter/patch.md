# Patch — `.claude/hooks/shell-trap-guard.mjs` + `tests/shared/hook-trap-guards.test.ts`

Proposal only. Neither diff below has been applied to the live tree.

## a. `.claude/hooks/shell-trap-guard.mjs`

Insert a new rule immediately after the existing "masked suite exit code" block (after the closing
`}` that follows `break;` at what is currently line 376, before the `// ── Emit` comment at line
378). Reuses `FILTER_PIPE` and `bypassEnabled()` already defined by the block above it — no new
imports.

```diff
   );
   break;
 }
 
+// ── Rule: a peer-CLI dispatch piped into a buffering filter ─────────────────
+// Same defect class as the masked-suite-exit rule above, hitting a different
+// command family: `tail`/`head`/`grep`/etc. buffer to EOF before printing
+// anything, so a long `codex exec` / `agy -p` dispatch piped through one of
+// them is indistinguishable from a hang on stdout. One run sat at 0 bytes for
+// ~30 minutes and then returned a complete verdict (2026-08-09,
+// docs/backlog/durable-traps.md "A background lane piped through tail/head").
+// The night after, a WEDGED `codex exec` run had already emitted 24 findings
+// into its transcript before hanging, recoverable only because that
+// particular call happened to be redirected to a file rather than piped —
+// `awk '/^FINDING:/,0'` salvaged it (2026-08-09/10, "A broad multi-file
+// review scope kills both peer-CLI lanes"). Had that run been piped instead,
+// the same 24 findings would have been lost with it. DENY, not advisory, for
+// the same reason the sibling rule above is a DENY: there is a strictly
+// better form (redirect to a file, read/grep the file separately) for every
+// legitimate use, and this project has already watched an advisory over the
+// identical mechanism get read past once ([[false-red-is-as-corrosive-as-false-green]]
+// — same mechanism, different command family).
+const CLI_DISPATCH_CMD = /\bcodex\s+exec\b|\bagy\b[^|;&]*\s(?:-p|--print)\b/;
+for (const sub of subCmds) {
+  const stripped = stripQuoted(sub);
+  if (!CLI_DISPATCH_CMD.test(stripped) || !FILTER_PIPE.test(stripped)) continue;
+  if (bypassEnabled('AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH')) continue;
+  denials.push(
+    'peer-CLI dispatch piped into a buffering filter — `codex exec` / `agy -p` output piped into ' +
+      '`tail`/`head`/`grep`/etc. shows ZERO bytes until the process exits, so a live run and a hung ' +
+      'one look identical. One run sat at 0 bytes for ~30 minutes before returning a complete verdict; ' +
+      'a wedged run the following night had already emitted 24 findings into its transcript, recoverable ' +
+      "only because that call was redirected to a FILE, not piped — a pipe would have discarded them.\n" +
+      (isBash
+        ? '  fix: redirect to a file instead — `codex exec "…" < /dev/null > run.log 2>&1 &` (or ' +
+          '`*> run.log` in PowerShell), then read/tail/grep `run.log` separately. On a wedge, salvage a ' +
+          "partial transcript with e.g. `awk '/^FINDING:/,0' run.log`.\n"
+        : '  fix: redirect to a file instead — `*> run.log`, then read/tail/grep `run.log` separately.\n') +
+      `  offending statement: ${sub.slice(0, 200)}`,
+  );
+  break;
+}
+
 // ── Emit ─────────────────────────────────────────────────────────────────────
```

## b. `tests/shared/hook-trap-guards.test.ts`

### b.1 — register the new bypass var (scrubbed like every other one)

```diff
 const BYPASS_VARS = [
   'AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE',
   'AUDIT_TOOLS_ALLOW_BACKTICKS',
   'AUDIT_TOOLS_ALLOW_MASKED_EXIT',
   'AUDIT_TOOLS_ALLOW_UNSET_ENV',
+  'AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH',
 ];
```

### b.2 — new `describe` block, inserted after the existing "masked suite exit code" block
(after the line that currently closes that block, i.e. after line 339 `});` in the file read for
this proposal)

```diff
+describe('shell-trap-guard: a peer-CLI dispatch piped into a buffering filter (2026-08-09/10)', () => {
+  it('blocks `codex exec` piped into tail', () => {
+    const { code, stderr } = runHook(
+      SHELL_GUARD,
+      bash("codex exec '<prompt>' < /dev/null 2>&1 | tail -120"),
+    );
+    expect(code).toBe(2);
+    expect(stderr).toMatch(/buffering filter/);
+    expect(stderr).toMatch(/redirect to a file/);
+  });
+
+  it('blocks `agy -p` piped into grep', () => {
+    expect(
+      runHook(SHELL_GUARD, bash('agy --sandbox -p "review this" 2>&1 | grep -i error')).code,
+    ).toBe(2);
+  });
+
+  it('blocks `agy --print` piped into head', () => {
+    expect(
+      runHook(SHELL_GUARD, bash('agy --print "review this" | head -50')).code,
+    ).toBe(2);
+  });
+
+  it('allows the correct form: redirect to a file, read it separately', () => {
+    const { code } = runHook(
+      SHELL_GUARD,
+      bash('codex exec "review" < /dev/null > run.log 2>&1 &'),
+    );
+    expect(code).toBe(0);
+  });
+
+  it('does not fire on codex exec with no pipe', () => {
+    expect(runHook(SHELL_GUARD, bash('codex exec "review" < /dev/null')).code).toBe(0);
+  });
+
+  it('does not fire on an unrelated command piped into a filter', () => {
+    expect(runHook(SHELL_GUARD, bash('git log --oneline | head -20')).code).toBe(0);
+  });
+
+  it('does not fire on a QUOTED textual mention', () => {
+    expect(
+      runHook(SHELL_GUARD, bash('rg "codex exec foo | tail -50" docs/')).code,
+    ).toBe(0);
+  });
+
+  it('honors the deliberate escape hatch', () => {
+    const r = runHook(SHELL_GUARD, bash('codex exec "review" < /dev/null | tail -50'), {
+      env: { AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH: '1' },
+    });
+    expect(r.code).toBe(0);
+  });
+});
+
```

### Red-green proof (why this pins the trap, not just the code shape)

- **RED before the patch:** every `it` above that expects `code === 2` fails against the unpatched
  hook — `CLI_DISPATCH_CMD` does not exist yet, so `codex exec … | tail` and `agy -p … | grep` both
  fall through every existing rule and exit 0. Verified by reading the current file (no rule in it
  matches `codex exec` / `agy … -p` piped into a filter — the closest rules are the stdin-close
  rule, which only inspects `<` redirects and pipes INTO the command, and the masked-suite-exit
  rule, whose `SUITE_CMD` regex does not include `codex`/`agy`).
- **GREEN after the patch:** the new block matches on the same `stripped`/`FILTER_PIPE` machinery
  already proven correct by the sibling rule's own passing tests.
