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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SHELL_GUARD = join(REPO_ROOT, '.claude', 'hooks', 'shell-trap-guard.mjs');
const INPUT_GUARD = join(REPO_ROOT, '.claude', 'hooks', 'tool-input-guard.mjs');

function runHook(hook, payload, { root = REPO_ROOT, env = {} } = {}) {
  const r = spawnSyncHidden(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

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

describe('shell-trap-guard: exit-code masking is ADVISORY, never a block', () => {
  it('advises but allows a verify command piped into grep', () => {
    const { code, stderr } = runHook(SHELL_GUARD, bash('npm run verify:checks 2>&1 | grep -iE "fail|error"'));
    expect(code).toBe(0);
    expect(stderr).toMatch(/reports the FILTER/);
  });
});

describe('shell-trap-guard: destructive restore (silently discards unstaged work)', () => {
  // A real throwaway git repo: the rule's whole point is that it consults actual
  // worktree state, so a parse-only test would prove nothing.
  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'trap-guard-repo-'));
    const git = (...args) => spawnSyncHidden('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
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
    expect(stderr).toMatch(/cherry-pick sees no diff/);
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
});

describe('guards fail open', () => {
  it('allows on an unparseable payload rather than wedging the session', () => {
    for (const hook of [SHELL_GUARD, INPUT_GUARD]) {
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
});
