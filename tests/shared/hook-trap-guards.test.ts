// Contract tests for the two PreToolUse trap guards in `.claude/hooks/`.
//
// These live under tests/shared (not beside the hooks) on purpose: vitest
// EXCLUDES `.claude/**`, so a test placed next to a hook never runs in CI and
// the guard is unverified exactly where it matters. Each case below pins one
// durable trap from docs/backlog.md; a guard that stops firing must go red.
//
// The guards are spawned as real processes with a real hook payload on stdin —
// the same contract Claude Code uses. Exit 2 = blocked, exit 0 = allowed.
import { describe, it, expect } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SHELL_GUARD = join(REPO_ROOT, '.claude', 'hooks', 'shell-trap-guard.mjs');
const INPUT_GUARD = join(REPO_ROOT, '.claude', 'hooks', 'tool-input-guard.mjs');
const CONTROL_BYTE_CHECK = join(REPO_ROOT, 'scripts', 'check-control-bytes.mjs');

describe('check-control-bytes: index entries deleted from the working tree', () => {
  it('skips a tracked file whose unstaged deletion is part of the current atomic change', () => {
    const root = mkdtempSync(join(tmpdir(), 'control-byte-deletion-'));
    const git = (...args: string[]) =>
      spawnSyncHidden('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
    try {
      expect(git('init', '-q').status).toBe(0);
      expect(git('config', 'user.email', 'test@example.com').status).toBe(0);
      expect(git('config', 'user.name', 'Test').status).toBe(0);
      writeFileSync(join(root, 'retired.ts'), 'export const retired = true;\n', 'utf8');
      expect(git('add', 'retired.ts').status).toBe(0);
      expect(git('commit', '--no-gpg-sign', '-q', '-m', 'fixture').status).toBe(0);
      rmSync(join(root, 'retired.ts'));

      const result = spawnSyncHidden(process.execPath, [CONTROL_BYTE_CHECK], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
      expect(result.stdout).toMatch(/0 present tracked source files clean/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Every guard bypass, scrubbed from the inherited environment before a hook runs.
 *
 * The harness spreads `process.env`, so a developer (or a wrapping command) with
 * `AUDIT_TOOLS_ALLOW_MASKED_EXIT=1` exported silently disabled the very rule the
 * test below asserts — the guard exited 0 and three `expect(code).toBe(2)` cases
 * failed for a reason that had nothing to do with the guard. The dangerous
 * direction is the other one: had those cases been written to expect 0, the suite
 * would have gone GREEN while the rule was off.
 *
 * That is the same class as the ambient-`PATH` red in `durable-traps.md` — a
 * fixture whose verdict depends on what happens to be set in the shell that ran
 * it. So bypass state is EXPLICIT per test: scrubbed here, and re-added only by a
 * case that is deliberately testing a bypass.
 */
const BYPASS_VARS = [
  'AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE',
  'AUDIT_TOOLS_ALLOW_BACKTICKS',
  'AUDIT_TOOLS_ALLOW_MASKED_EXIT',
  'AUDIT_TOOLS_ALLOW_UNSET_ENV',
  'AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH',
  'AUDIT_TOOLS_ALLOW_INLINE_SCRIPT',
  'AUDIT_TOOLS_ALLOW_LONG_DISPATCH',
];

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface RunHookOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
}

function runHook(
  hook: string,
  payload: HookPayload,
  { root = REPO_ROOT, env = {} }: RunHookOptions = {},
): { code: number | null; stderr: string } {
  const scrubbed: NodeJS.ProcessEnv = { ...process.env };
  for (const name of BYPASS_VARS) delete scrubbed[name];
  const r = spawnSyncHidden(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...scrubbed, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

const bash = (command: string): HookPayload => ({ tool_name: 'Bash', tool_input: { command } });
const bashBg = (command: string): HookPayload => ({
  tool_name: 'Bash',
  tool_input: { command, run_in_background: true },
});
const ps = (command: string): HookPayload => ({
  tool_name: 'PowerShell',
  tool_input: { command },
});
const psBg = (command: string): HookPayload => ({
  tool_name: 'PowerShell',
  tool_input: { command, run_in_background: true },
});

describe('shell-trap-guard: codex stdin (backlog: logged 3x, hangs at exit 0 + empty output)', () => {
  it('blocks `codex exec` with no stdin redirect', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('codex exec --sandbox read-only "review this"'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/dev\/null/);
  });

  it('allows `codex exec` with `< /dev/null`', () => {
    expect(runHook(SHELL_GUARD, bash('codex exec "review this" < /dev/null')).code).toBe(0);
  });

  it('allows a prompt piped in on stdin', () => {
    expect(runHook(SHELL_GUARD, bash('cat prompt.txt | codex exec')).code).toBe(0);
  });

  it('does not fire on an unrelated command that merely mentions codex', () => {
    expect(runHook(SHELL_GUARD, bash('git log --oneline -- src/codex')).code).toBe(0);
  });

  it('quote-aware split: a `;` inside the quoted prompt must not detach the stdin redirect', () => {
    // A quote-blind statement split broke this command at the semicolons INSIDE
    // the prompt, so the codex statement "lost" its `< /dev/null` and a correct
    // command was false-blocked (observed live 2026-07-23).
    const cmd = 'codex exec --sandbox read-only "review this; check exit 2 = block; be terse" < /dev/null';
    const { code, stderr } = runHook(SHELL_GUARD, bash(cmd));
    expect(code, `expected allow; stderr:\n${stderr}`).toBe(0);
  });

  it('an ESCAPED quote inside the prompt does not break the span and false-block', () => {
    const cmd = 'codex exec "review \\"a; b\\" carefully" < /dev/null';
    const { code, stderr } = runHook(SHELL_GUARD, bash(cmd));
    expect(code, `expected allow; stderr:\n${stderr}`).toBe(0);
  });

  it('a QUOTED textual mention (`rg "codex exec" docs`) is not an invocation', () => {
    expect(runHook(SHELL_GUARD, bash('rg "codex exec" docs/')).code).toBe(0);
  });

  it('a file redirect (`< prompt.txt`) also closes stdin and is allowed', () => {
    expect(runHook(SHELL_GUARD, bash('codex exec < prompt.txt')).code).toBe(0);
  });
});

describe('shell-trap-guard: Bash-tool syntax traps', () => {
  it('blocks an unquoted Windows backslash path (bash eats the separators)', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('node C:\\Code\\audit-tools\\x.mjs'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/forward slashes/);
  });

  it('allows the same path quoted, where the shell leaves it alone', () => {
    expect(runHook(SHELL_GUARD, bash("node 'C:\\Code\\audit-tools\\x.mjs'")).code).toBe(0);
  });

  it('allows a forward-slash Windows path', () => {
    expect(runHook(SHELL_GUARD, bash('node C:/Code/audit-tools/x.mjs')).code).toBe(0);
  });

  it('blocks a PowerShell here-string in a Bash command', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash("git commit -m @'\nsubject\nbody\n'@"));
    expect(code).toBe(2);
    expect(stderr).toMatch(/commit -F/);
  });

  it('blocks `mktemp` (msys path native tools cannot resolve)', () => {
    expect(runHook(SHELL_GUARD, bash('d=$(mktemp -d) && node x.mjs $d')).code).toBe(2);
  });

  it('does NOT apply the bash-only syntax rules to PowerShell', () => {
    const payload = { tool_name: 'PowerShell', tool_input: { command: 'node C:\\Code\\x.mjs' } };
    expect(runHook(SHELL_GUARD, payload).code).toBe(0);
  });

  it('blocks relative (`.\\x`) and UNC (`\\\\server\\share`) backslash paths too', () => {
    expect(runHook(SHELL_GUARD, bash('node .\\scripts\\check.mjs')).code).toBe(2);
    expect(runHook(SHELL_GUARD, bash('node \\\\server\\share\\tool.mjs')).code).toBe(2);
  });

  it('does not fire the backslash rule on escaped-backslash text (`sed s/\\\\n//`)', () => {
    expect(runHook(SHELL_GUARD, bash('sed s/\\\\n//g file.txt')).code).toBe(0);
  });

  it('mktemp as a SEARCH TERM (`rg mktemp docs`) is not an invocation', () => {
    expect(runHook(SHELL_GUARD, bash('rg mktemp docs/')).code).toBe(0);
  });

  // P15 (nightly sol-1, owner decision 2026-08-09). $TMPDIR is not set by Git
  // Bash here and $CLAUDE_PROJECT_DIR is a hook-invocation variable Claude Code
  // substitutes into .claude/settings.json command lines, never exported to a
  // tool shell. An unset name expands to the EMPTY STRING, so the failure names
  // the wrong cause — hit four times on four dates, the last one with an
  // accurate durable-traps entry already written, which is why it is now a rule.
  it('blocks a DOUBLE-QUOTED $TMPDIR expansion (the form every observed hit took)', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('npm run check > "$TMPDIR/parity.log" 2>&1'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/\$TMPDIR/);
    expect(stderr).toMatch(/EMPTY STRING/);
  });

  it('blocks a BARE $TMPDIR expansion', () => {
    expect(runHook(SHELL_GUARD, bash('cat $TMPDIR/out.txt')).code).toBe(2);
  });

  it('blocks ${CLAUDE_PROJECT_DIR}, the braced form, and names it', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.mjs"'),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/CLAUDE_PROJECT_DIR/);
  });

  it('does not fire on a SINGLE-quoted $TMPDIR — inside single quotes it is inert text', () => {
    expect(runHook(SHELL_GUARD, bash("rg '$TMPDIR' docs/")).code).toBe(0);
  });

  it('does not fire when the command SETS the variable itself (correct usage)', () => {
    expect(runHook(SHELL_GUARD, bash('TMPDIR=/c/tmp; node x.mjs "$TMPDIR/a"')).code).toBe(0);
  });

  it('honours AUDIT_TOOLS_ALLOW_UNSET_ENV as a deliberate inline bypass', () => {
    expect(
      runHook(SHELL_GUARD, bash('AUDIT_TOOLS_ALLOW_UNSET_ENV=1 cat "$TMPDIR/x"')).code,
    ).toBe(0);
  });

  it('does not fire on an unrelated variable whose name merely CONTAINS a listed one', () => {
    // The name regex must match a whole variable name: TMPDIR_OTHER is not TMPDIR.
    expect(runHook(SHELL_GUARD, bash('echo "$TMPDIR_OTHER/x"')).code).toBe(0);
  });
});

describe('shell-trap-guard: a live backtick substitutes, including inside double quotes', () => {
  // A backlog file was corrupted this way: markdown backticks written inside a
  // double-quoted shell string are COMMAND SUBSTITUTION, so the shell ran what
  // they wrapped and spliced the output into the file in place of the prose.
  it('blocks markdown backticks inside a double-quoted commit message', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('git commit -m "fix `npm run check` drift"'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/backtick/i);
  });

  it('allows the same text in SINGLE quotes, where a backtick is literal', () => {
    expect(runHook(SHELL_GUARD, bash("git commit -m 'fix `npm run check` drift'")).code).toBe(0);
  });

  it('blocks a bare backtick substitution and names $() as the replacement', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('echo `git rev-parse HEAD`'));
    expect(code).toBe(2);
    expect(stderr).toContain('$(...)');
  });

  it('allows the $() form it points at', () => {
    expect(runHook(SHELL_GUARD, bash('echo $(git rev-parse HEAD)')).code).toBe(0);
  });

  it('allows a BACKSLASH-ESCAPED backtick — it does not substitute', () => {
    expect(runHook(SHELL_GUARD, bash('git commit -m "literal \\` tick"')).code).toBe(0);
  });

  it('does not fire on backticks inside a heredoc body (stdin data, not argv)', () => {
    const cmd = ["cat > msg.txt <<'EOF'", 'docs: explain `npm run check`', 'EOF'].join('\n');
    const { code, stderr } = runHook(SHELL_GUARD, bash(cmd));
    expect(code, `expected allow; stderr:\n${stderr}`).toBe(0);
  });

  it('does NOT apply to PowerShell, where a backtick is the escape character', () => {
    const payload = { tool_name: 'PowerShell', tool_input: { command: 'Write-Output "a`nb"' } };
    expect(runHook(SHELL_GUARD, payload).code).toBe(0);
  });

  it('honours the deliberate-use override', () => {
    const r = runHook(SHELL_GUARD, bash('echo `date`'), { env: { AUDIT_TOOLS_ALLOW_BACKTICKS: '1' } });
    expect(r.code).toBe(0);
  });
});

describe('shell-trap-guard: a heredoc BODY is data, not argv', () => {
  // Writing the commit message for this very change was refused: the body named
  // `mktemp` and the agy flag while describing them. A heredoc body reaches
  // stdin, never argv, so it cannot execute the trap it mentions.
  it('does not fire on trap names that appear only inside a heredoc body', () => {
    const cmd = [
      "cat > msg.txt <<'EOF'",
      'feat(hooks): trap guards',
      '',
      'Blocks `agy -p "x" --dangerously-skip-permissions` and `mktemp` in the Bash tool,',
      'and a `git checkout -- <file>` that would eat unstaged work.',
      'EOF',
      'git commit -F msg.txt',
    ].join('\n');
    const { code, stderr } = runHook(SHELL_GUARD, bash(cmd));
    expect(code, `expected allow; stderr:\n${stderr}`).toBe(0);
  });

  it('still fires on a real command AFTER a heredoc closes', () => {
    const cmd = ["cat > msg.txt <<'EOF'", 'harmless prose', 'EOF', 'd=$(mktemp -d)'].join('\n');
    expect(runHook(SHELL_GUARD, bash(cmd)).code).toBe(2);
  });
});

describe('shell-trap-guard: agy headless (three silent-failure traps)', () => {
  it('blocks `--dangerously-skip-permissions` with a prompt (agy answers about the flag)', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash('agy -p "analyze provider confirmation" --dangerously-skip-permissions'),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/latches onto its OWN flag/);
  });

  it('blocks piping a document into `agy -p` (stdin is ignored)', () => {
    expect(runHook(SHELL_GUARD, bash('cat doc.md | agy -p "review the following"')).code).toBe(2);
  });

  it('allows a plain `agy -p` but advises that exit 0 is not success', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('agy --sandbox -p "hello"'));
    expect(code).toBe(0);
    expect(stderr).toMatch(/exit code 0 does NOT mean success/);
  });
});

describe('shell-trap-guard: a masked suite exit code is REFUSED (manufactured false green)', () => {
  // Was an advisory until 2026-07-24. The advisory fired on `npm test 2>&1 |
  // tail -50` and was read past: the suite was RED, the status said 0, and the
  // buffered `tail` output held only build notices. An advisory cannot fix a
  // signal that reads green — hence the promotion to DENY.
  it('blocks `npm test` piped into tail, with the BACKGROUND-SAFE remedy', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('npm test 2>&1 | tail -50'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/masked suite exit code/);
    // The old remedy (`; echo "EXIT=$?"`) IS the laundering trap when the
    // command is backgrounded — the guard must never prescribe it.
    expect(stderr).toMatch(/let the suite's exit BE/);
    expect(stderr).not.toMatch(/echo "EXIT=\$\?"/);
  });

  it('PowerShell branch remedy is a real status pass-through (`exit $LASTEXITCODE`)', () => {
    const { code, stderr } = runHook(SHELL_GUARD, ps('npm test 2>&1 | Select-String error'));
    expect(code).toBe(2);
    expect(stderr).toMatch(/exit \$LASTEXITCODE/);
  });

  it('blocks a verify command piped into grep', () => {
    expect(runHook(SHELL_GUARD, bash('npm run verify:checks 2>&1 | grep -iE "fail|error"')).code).toBe(2);
  });

  it('covers the runners invoked directly, not only via npm scripts', () => {
    expect(runHook(SHELL_GUARD, bash('npx vitest run 2>&1 | tail -50')).code).toBe(2);
    expect(runHook(SHELL_GUARD, bash('vitest run tests/shared | head -20')).code).toBe(2);
    expect(runHook(SHELL_GUARD, bash('node --test tests/ | wc -l')).code).toBe(2);
  });

  it('allows the correct form: redirect to a file, then read the status', () => {
    const { code } = runHook(SHELL_GUARD, bash('npm test > run.log 2>&1; echo "EXIT=$?"'));
    expect(code).toBe(0);
  });

  it('allows a pipe that PROPAGATES the real status (`pipefail` / `PIPESTATUS`)', () => {
    expect(runHook(SHELL_GUARD, bash('set -o pipefail; npm test 2>&1 | tail -50')).code).toBe(0);
    expect(runHook(SHELL_GUARD, bash('npm test 2>&1 | tail -50; exit ${PIPESTATUS[0]}')).code).toBe(0);
  });

  it('honors the deliberate escape hatch', () => {
    const r = runHook(SHELL_GUARD, bash('npm test 2>&1 | tail -50'), {
      env: { AUDIT_TOOLS_ALLOW_MASKED_EXIT: '1' },
    });
    expect(r.code).toBe(0);
  });

  it('does not fire on a QUOTED mention of the shape (documenting the trap is not running it)', () => {
    expect(runHook(SHELL_GUARD, bash('rg "npm test 2>&1 | tail" docs/')).code).toBe(0);
  });

  it('does not fire on an unrelated command piped into a filter', () => {
    expect(runHook(SHELL_GUARD, bash('git log --oneline | head -20')).code).toBe(0);
  });
});

describe('shell-trap-guard: a BACKGROUNDED suite exit laundered by a trailing statement (2026-08-12)', () => {
  // Under run_in_background the harness completion notice reads the COMPOUND's
  // exit — the LAST statement's — so `suite > log; echo "EXIT=$?"` reported
  // exit 0 for a RED suite with two TS2345 errors in the unread log. Detected
  // from exit-status FLOW (a suite statement followed transitively by a
  // non-`&&` separator), not as a third named syntactic instance.
  it('blocks bash `npm test > run.log 2>&1; echo "EXIT=$?"` when backgrounded', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bashBg('npm test > run.log 2>&1; echo "EXIT=$?"'),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/laundered/i);
  });

  it('blocks PowerShell `npm test *> run.log; "EXIT=$LASTEXITCODE"` when backgrounded', () => {
    const { code, stderr } = runHook(SHELL_GUARD, psBg('npm test *> run.log; "EXIT=$LASTEXITCODE"'));
    expect(code, stderr).toBe(2);
  });

  it('blocks a backgrounded `|| true` tail — same laundering, different separator', () => {
    expect(runHook(SHELL_GUARD, bashBg('npm test > log 2>&1 || true')).code).toBe(2);
  });

  it('allows the same commands FOREGROUND — the status is read directly there', () => {
    expect(runHook(SHELL_GUARD, bash('npm test > run.log 2>&1; echo "EXIT=$?"')).code).toBe(0);
    expect(runHook(SHELL_GUARD, bash('npm test > log 2>&1 || true')).code).toBe(0);
  });

  it('allows a backgrounded suite in TERMINAL position (its exit IS the compound exit)', () => {
    expect(runHook(SHELL_GUARD, bashBg('npm test > run.log 2>&1')).code).toBe(0);
  });

  it('allows a backgrounded `&&`-chain — short-circuit preserves the failure', () => {
    expect(runHook(SHELL_GUARD, bashBg('npm install && npm test > run.log 2>&1')).code).toBe(0);
  });

  it('allows a terminal status pass-through — the shape its own remedies prescribe', () => {
    const powershell = runHook(SHELL_GUARD, psBg('npm test *> run.log; exit $LASTEXITCODE'));
    expect(powershell.code, powershell.stderr).toBe(0);
    const posix = runHook(SHELL_GUARD, bashBg('npm test > run.log 2>&1; exit $?'));
    expect(posix.code, posix.stderr).toBe(0);
  });

  it('honors AUDIT_TOOLS_ALLOW_MASKED_EXIT — same trap class, same escape', () => {
    const r = runHook(SHELL_GUARD, bashBg('npm test > run.log 2>&1; echo "EXIT=$?"'), {
      env: { AUDIT_TOOLS_ALLOW_MASKED_EXIT: '1' },
    });
    expect(r.code, r.stderr).toBe(0);
  });

  it('a QUOTED mention of the shape in a backgrounded command is not the trap', () => {
    expect(runHook(SHELL_GUARD, bashBg('rg "npm test; echo" docs/')).code).toBe(0);
  });
});

describe('shell-trap-guard: a peer-CLI dispatch piped into a buffering filter (2026-08-09/10)', () => {
  // CLI_DISPATCH_CMD extends the masked-suite rule's mechanism to the two
  // peer-CLI dispatch lanes — the commands most likely to run for many minutes
  // with zero visible output when piped.
  it('blocks `codex exec` piped into tail', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash("codex exec '<prompt>' < /dev/null 2>&1 | tail -120"),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/buffering filter/);
    expect(stderr).toMatch(/redirect to a file/);
  });

  it('blocks `agy -p` piped into grep', () => {
    expect(
      runHook(SHELL_GUARD, bash('agy --sandbox -p "review this" 2>&1 | grep -i error')).code,
    ).toBe(2);
  });

  it('blocks `agy --print` piped into head', () => {
    expect(
      runHook(SHELL_GUARD, bash('agy --print "review this" | head -50')).code,
    ).toBe(2);
  });

  it('allows the correct form: redirect to a file, read it separately', () => {
    const { code } = runHook(
      SHELL_GUARD,
      bash('codex exec "review" < /dev/null > run.log 2>&1 &'),
    );
    expect(code).toBe(0);
  });

  it('does not fire on codex exec with no pipe', () => {
    expect(runHook(SHELL_GUARD, bash('codex exec "review" < /dev/null')).code).toBe(0);
  });

  it('does not fire on an unrelated command piped into a filter', () => {
    expect(runHook(SHELL_GUARD, bash('git log --oneline | head -20')).code).toBe(0);
  });

  it('does not fire on a QUOTED textual mention', () => {
    expect(
      runHook(SHELL_GUARD, bash('rg "codex exec foo | tail -50" docs/')).code,
    ).toBe(0);
  });

  it('honors the deliberate escape hatch', () => {
    const r = runHook(SHELL_GUARD, bash('codex exec "review" < /dev/null | tail -50'), {
      env: { AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH: '1' },
    });
    expect(r.code).toBe(0);
  });
});

describe('shell-trap-guard: inline interpreter payload with shell-active escapes (P31, 2026-08-14)', () => {
  // A `node -e "…"` payload that needs `\``/`\"`/`\$`/`\\` escaping is the exact
  // shape that got mangled: the shell ate one level of escaping, the escaped
  // backtick went inert and the regex around it became invalid — the
  // interpreter ran a DIFFERENT program from the one written. Two or more
  // shell-active escapes in one double-quoted payload = a script, not a flag
  // argument. Bash path only: PowerShell's escape char is the backtick, and
  // backslashes are literal there.
  it('blocks a node -e payload carrying two escaped backticks', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash('node -e "const s = \\`a\\`; console.log(s)"'),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/write the script/i);
    expect(stderr).toMatch(/scratchpad/);
  });

  it('blocks python -c and bash -c variants the same way', () => {
    expect(runHook(SHELL_GUARD, bash('python -c "print(\\"a\\"); print(\\"b\\")"')).code).toBe(2);
    expect(runHook(SHELL_GUARD, bash('bash -c "echo \\"hi \\$USER\\""')).code).toBe(2);
  });

  it('allows the escape-free one-liner shape (used successfully 4x)', () => {
    expect(
      runHook(SHELL_GUARD, bash('node -e "console.log(require(\'./x.json\').v)"')).code,
    ).toBe(0);
  });

  it('allows exactly ONE shell-active escape — pins the >= 2 floor', () => {
    expect(runHook(SHELL_GUARD, bash('node -e "console.log(\'cost: \\$5\')"')).code).toBe(0);
  });

  it('regex escapes (`\\d`, `\\s`) pass through double quotes untouched and do not count', () => {
    expect(
      runHook(SHELL_GUARD, bash('node -e "console.log(/\\d+\\s/.test(\'1 \'))"')).code,
    ).toBe(0);
  });

  it('does NOT apply to PowerShell', () => {
    expect(runHook(SHELL_GUARD, ps('node -e "const s = \\`a\\`; console.log(s)"')).code).toBe(0);
  });

  it('a QUOTED textual mention (`rg "node -e" docs/`) is not an invocation', () => {
    expect(runHook(SHELL_GUARD, bash('rg "node -e" docs/')).code).toBe(0);
  });

  it('a heredoc body naming node -e does not fire (stdin data, not argv)', () => {
    const cmd = [
      "cat > note.md <<'EOF'",
      'use node -e "console.log(\\`x\\` + \\`y\\`)" for quick checks',
      'EOF',
    ].join('\n');
    const { code, stderr } = runHook(SHELL_GUARD, bash(cmd));
    expect(code, `expected allow; stderr:\n${stderr}`).toBe(0);
  });

  it('honours AUDIT_TOOLS_ALLOW_INLINE_SCRIPT (env and inline-prefix forms)', () => {
    const cmd = 'node -e "const s = \\`a\\`; console.log(s)"';
    expect(
      runHook(SHELL_GUARD, bash(cmd), { env: { AUDIT_TOOLS_ALLOW_INLINE_SCRIPT: '1' } }).code,
    ).toBe(0);
    expect(runHook(SHELL_GUARD, bash(`AUDIT_TOOLS_ALLOW_INLINE_SCRIPT=1 ${cmd}`)).code).toBe(0);
  });
});

describe('shell-trap-guard: an over-long ad-hoc peer-CLI dispatch prompt (P28)', () => {
  // A mega-prompt inlined into `codex exec` / `agy -p` / `claude.ps1 -p` loses
  // the whole answer silently — nothing back, truncation, or max_tokens spent
  // reasoning. The reliable unit is ONE bounded item per call, via the
  // lane-dispatch driver.
  const LONG = 'x'.repeat(4500);
  const AT_LIMIT = 'x'.repeat(4000);

  it('blocks a >4000-char codex exec prompt and points at the lane-dispatch driver', () => {
    // Composed with stdin closed + a file redirect so the sibling rules stay
    // silent — this case isolates the prompt-size refusal.
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash(`codex exec "${LONG}" < /dev/null > run.log 2>&1 &`),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/lane-dispatch\.mjs/);
  });

  it('blocks a long agy -p prompt', () => {
    expect(runHook(SHELL_GUARD, bash(`agy --sandbox -p "${LONG}"`)).code).toBe(2);
  });

  it('blocks a long claude.ps1 -p prompt (the third dispatch lane)', () => {
    expect(
      runHook(
        SHELL_GUARD,
        ps(`powershell -File C:/Users/ethan/freellmapi/claude.ps1 -p "${LONG}"`),
      ).code,
    ).toBe(2);
  });

  it('allows a prompt AT the threshold — fires only above it', () => {
    const { code, stderr } = runHook(
      SHELL_GUARD,
      bash(`codex exec "${AT_LIMIT}" < /dev/null > run.log 2>&1 &`),
    );
    expect(code, stderr).toBe(0);
  });

  it('honours AUDIT_TOOLS_ALLOW_LONG_DISPATCH', () => {
    const r = runHook(SHELL_GUARD, bash(`codex exec "${LONG}" < /dev/null > run.log 2>&1 &`), {
      env: { AUDIT_TOOLS_ALLOW_LONG_DISPATCH: '1' },
    });
    expect(r.code, r.stderr).toBe(0);
  });
});

describe('shell-trap-guard: destructive restore (silently discards unstaged work)', () => {
  // A real throwaway git repo: the rule's whole point is that it consults actual
  // worktree state, so a parse-only test would prove nothing.
  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'trap-guard-repo-'));
    const git = (...args: string[]) => spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(dir, 'a.txt'), 'committed\n');
    writeFileSync(join(dir, 'b.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return { dir, git };
  }

  it('blocks `git checkout -- <file>` when the file carries unstaged work', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const { code, stderr } = runHook(SHELL_GUARD, bash('git checkout -- a.txt'), { root: dir });
      expect(code).toBe(2);
      expect(stderr).toMatch(/INVERTING/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the restore when the file is clean', () => {
    const { dir } = makeRepo();
    try {
      expect(runHook(SHELL_GUARD, bash('git checkout -- a.txt'), { root: dir }).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a QUOTED at-risk target (quotes never reach git pathspecs)', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const { code } = runHook(SHELL_GUARD, bash('git restore "a.txt"'), { root: dir });
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors the deliberate-discard escape hatch', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const r = runHook(SHELL_GUARD, bash('git checkout -- a.txt'), {
        root: dir,
        env: { AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE: '1' },
      });
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The denial text says "re-run with AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE=1".
  // A caller reaches for an inline PREFIX, which sets the variable on the child
  // the guard never sees — so the guard used to refuse anyway and its own
  // documented escape did not work. A guard whose stated escape is a lie trains
  // the reader to believe the guard is broken.
  it('honors the escape given as an INLINE PREFIX, the form the message implies', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const r = runHook(
        SHELL_GUARD,
        bash('AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE=1 git checkout -- a.txt'),
        { root: dir },
      );
      expect(r.code, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors the escape given via export in an earlier statement', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const r = runHook(
        SHELL_GUARD,
        bash('export AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE=1 && git checkout -- a.txt'),
        { root: dir },
      );
      expect(r.code, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a command that merely MENTIONS the bypass does not enable it', () => {
    // Otherwise documenting the escape would disable the guard. The name is
    // preceded by a quote here, not by a statement boundary or `export`.
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      const r = runHook(
        SHELL_GUARD,
        bash('echo "set AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE=1 to override" && git checkout -- a.txt'),
        { root: dir },
      );
      expect(r.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the inline-prefix escape works for the OTHER bypasses too — the class, not the instance', () => {
    const ticks = runHook(SHELL_GUARD, bash('AUDIT_TOOLS_ALLOW_BACKTICKS=1 echo `date`'));
    expect(ticks.code, ticks.stderr).toBe(0);
    const masked = runHook(
      SHELL_GUARD,
      bash('AUDIT_TOOLS_ALLOW_MASKED_EXIT=1 npm test | tail -5'),
    );
    expect(masked.code, masked.stderr).toBe(0);
  });

  it('never fires on plain branch switching', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      expect(runHook(SHELL_GUARD, bash('git checkout -b feature/x'), { root: dir }).code).toBe(0);
      expect(runHook(SHELL_GUARD, bash('git checkout main'), { root: dir }).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks `git restore <file>` but not the index-only `--staged` form', () => {
    const { dir } = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');
      expect(runHook(SHELL_GUARD, bash('git restore a.txt'), { root: dir }).code).toBe(2);
      expect(runHook(SHELL_GUARD, bash('git restore --staged a.txt'), { root: dir }).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tool-input-guard: raw control byte at write time', () => {
  // Built with String.fromCharCode, never a backslash-u escape: the escape
  // decodes on the way through tool-call JSON, which is the trap itself.
  const NUL = String.fromCharCode(0);

  it('blocks a Write whose content carries a raw NUL', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: join(REPO_ROOT, 'src/shared/x.ts'), content: `const k = a + "${NUL}" + b;\n` },
    };
    const { code, stderr } = runHook(INPUT_GUARD, payload);
    expect(code).toBe(2);
    expect(stderr).toMatch(/BINARY/);
  });

  it('blocks an Edit whose new_string carries a raw control byte', () => {
    const payload = {
      tool_name: 'Edit',
      tool_input: {
        file_path: join(REPO_ROOT, 'src/shared/x.ts'),
        old_string: 'a',
        new_string: `b${String.fromCharCode(31)}c`,
      },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(2);
  });

  it('allows tab, LF and CR', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: join(REPO_ROOT, 'src/shared/x.ts'), content: 'a\tb\r\nc\n' },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(0);
  });

  it('ignores writes outside the project tree (scratchpad is not source)', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: join(tmpdir(), 'scratch.bin'), content: `x${NUL}y` },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(0);
  });
});

describe('tool-input-guard: Agent worktree isolation on a dispatch node', () => {
  it('blocks isolation:"worktree" on a remediate dispatch prompt', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        isolation: 'worktree',
        prompt: 'Implement node N-12 for the remediate-code run; the dispatch plan names the workdir.',
      },
    };
    const { code, stderr } = runHook(INPUT_GUARD, payload);
    expect(code).toBe(2);
    expect(stderr).toMatch(/bound result ingestion sees no change/);
  });

  it('allows isolation:"worktree" for ordinary parallel work', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { isolation: 'worktree', prompt: 'Refactor the README examples into a table.' },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(0);
  });

  it('allows a dispatch prompt with no isolation flag', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt: 'Implement node N-12 for the remediate-code run.' },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(0);
  });

  it('"Implement Node.js …" is ordinary work, not a dispatch node', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { isolation: 'worktree', prompt: 'Implement Node.js stream parsing in src/shared/io.ts.' },
    };
    expect(runHook(INPUT_GUARD, payload).code).toBe(0);
  });
});

const ASYNC_TYPECHECK = join(REPO_ROOT, '.claude', 'hooks', 'async-typecheck.mjs');

describe('guards fail open', () => {
  it('allows on an unparseable payload rather than wedging the session', () => {
    for (const hook of [SHELL_GUARD, INPUT_GUARD, ASYNC_TYPECHECK]) {
      const r = spawnSyncHidden(process.execPath, [hook], {
        input: 'not json',
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      expect(r.status).toBe(0);
    }
  });

  it('allows an empty command', () => {
    expect(runHook(SHELL_GUARD, bash('')).code).toBe(0);
  });

  // async-typecheck.mjs fail-open contract (formerly a standalone node script in
  // .claude/hooks/, where vitest never ran it and its fixtures had gone stale).
  it('async-typecheck: exits 0 fast on missing/empty/non-area file paths', () => {
    const payloads = [
      { tool_name: 'Edit', tool_input: {} },
      { tool_name: 'Edit', tool_input: { file_path: '' } },
      { tool_name: 'Edit', tool_input: { file_path: '/some/random/place/foo.ts' } },
      { tool_name: 'Edit', tool_input: { file_path: join(REPO_ROOT, 'docs', 'HANDOFF.md') } },
    ];
    for (const p of payloads) {
      expect(runHook(ASYNC_TYPECHECK, p).code).toBe(0);
    }
  });
});

describe('the harness itself cannot be disabled by the ambient shell', () => {
  it('scrubs every bypass var, so an exported override cannot green a rule silently', () => {
    // Asserted by RUNNING with the bypass exported into this process: the guard
    // must still block, because the harness removed it. Without the scrub the
    // three masked-exit cases above fail (observed) — and a case written to
    // expect 0 would have passed with the rule switched off.
    const prior = process.env.AUDIT_TOOLS_ALLOW_MASKED_EXIT;
    process.env.AUDIT_TOOLS_ALLOW_MASKED_EXIT = '1';
    try {
      const r = runHook(SHELL_GUARD, bash('npm test 2>&1 | tail -30'));
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/masked suite exit code/);
    } finally {
      if (prior === undefined) delete process.env.AUDIT_TOOLS_ALLOW_MASKED_EXIT;
      else process.env.AUDIT_TOOLS_ALLOW_MASKED_EXIT = prior;
    }
  });

  it('lists every bypass the guard actually reads, so a new one cannot be forgotten', () => {
    // bypassEnabled moved to shell-split.mjs with an explicit cmd parameter, so
    // the call shape scanned here is `bypassEnabled('NAME', cmd)`.
    const guard = readFileSync(SHELL_GUARD, 'utf8');
    const used = [...guard.matchAll(/bypassEnabled\('([A-Z_]+)', cmd\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) expect(BYPASS_VARS).toContain(name);
  });
});
