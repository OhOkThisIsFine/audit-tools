#!/usr/bin/env node
// PreToolUse gate: block `git commit` until `npm run check` is green.
// Receives the hook payload on stdin: { tool_name, tool_input: { command } }.
// Exit 0 = allow, exit 2 = block (stderr is fed back to the agent).
// Fires on every Bash/PowerShell call; non-commit commands exit in ~ms.
import { execSync } from 'node:child_process';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let cmd = '';
try {
  cmd = JSON.parse(raw)?.tool_input?.command ?? '';
} catch {
  process.exit(0); // unparseable payload — never wedge the session
}

// A real commit invocation: `git … commit` within one shell statement,
// not the word "commit" elsewhere (e.g. git log --grep=commit).
if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(cmd)) process.exit(0);

// Gate-bypass vectors — a commit that disables hooks makes this gate a no-op,
// so refuse it outright (the gate can't run `check` if git skips the hook, and
// silently allowing the bypass defeats green-at-every-commit). Covers the
// `--no-verify`/`-n` flag and any `core.hooksPath` override (`-c core.hooksPath=…`
// or the GIT_CONFIG_* env form), matched anywhere in the statement.
if (/--no-verify\b|(^|[\s;&|])-n(?=[\s;&|]|$)|\bcore\.hooksPath\b/.test(cmd)) {
  console.error(
    'pre-commit gate: commit rejected — hook-bypass flag detected (`--no-verify`/`-n` or `core.hooksPath` override). ' +
      'These skip the green-at-every-commit gate. Remove the bypass and commit normally; if `npm run check` fails, fix it first.',
  );
  process.exit(2);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  execSync('npm run check', {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  });
  process.exit(0);
} catch (err) {
  const tail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    .trim()
    .split('\n')
    .slice(-40)
    .join('\n');
  console.error(
    `pre-commit gate: \`npm run check\` FAILED — commit blocked (green-at-every-commit invariant). Fix the type errors, then retry the commit.\n${tail}`,
  );
  process.exit(2);
}
