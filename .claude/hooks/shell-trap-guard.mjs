#!/usr/bin/env node
// PreToolUse guard for Bash / PowerShell commands: mechanize the durable shell
// traps from `docs/backlog.md` so they cannot be re-hit by any host, strong or
// weak. Each rule below cost real time at least once and is listed there with a
// date; "remember to be careful" is not a fix (enforce-in-tooling).
//
// Payload on stdin: { tool_name, tool_input: { command } }.
// Exit 0 = allow (stderr, if any, is advice). Exit 2 = block; stderr is fed
// back to the agent as the reason.
//
// TWO CLASSES OF RULE:
//   DENY   — the command is silently wrong or destructive; there is a correct
//            form and the message states it verbatim.
//   ADVISE — the pattern is usually wrong but legitimately used; blocking would
//            train an override reflex, so it prints to stderr and exits 0.
//
// Failure policy: FAIL-OPEN on anything unexpected (unparseable payload, git
// fault). A guard must never wedge the session.
import { spawnSync } from 'node:child_process';
import { stripQuoted, splitShellStatements, stripHeredocBodies } from './shell-split.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0); // unparseable — never wedge the session
}

const rawCmd = payload?.tool_input?.command ?? '';
const toolName = payload?.tool_name ?? '';
if (!rawCmd.trim()) process.exit(0);

// Rules read the command with HEREDOC BODIES BLANKED. A body is stdin data, not
// argv — a commit message that merely NAMES a trap (`git commit -F -` with a
// body describing `mktemp`) must not be refused as if it were the trap. Every
// rule below therefore reasons about executable text only.
const cmd = stripHeredocBodies(rawCmd);

// The Bash tool is Git Bash (POSIX sh) on this box; PowerShell is native. Some
// rules are shell-specific — a Windows path is mangled by one and correct in the
// other — so the shell is part of the rule, never assumed.
const isBash = toolName === 'Bash';

// Shell statements, split QUOTE-AWARE (shell-split.mjs — shared with the
// pre-commit gate) so a separator inside a quoted prompt cannot break a
// statement apart and detach e.g. a stdin redirect from its codex statement.
// Pipes stay INSIDE a statement on purpose: "is something piped into this
// command" is a question rules ask.
const subCmds = splitShellStatements(cmd);

const denials = [];
const advisories = [];

// ── git helper — never throws; callers branch on `.ok`. ──────────────────────
function git(args) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

// ── Rule: `codex exec` must close stdin ──────────────────────────────────────
// Codex reads stdin to append a `<stdin>` block EVEN when the prompt is a
// positional argument. Under any non-TTY spawn (background task, CI, most
// wrappers) it blocks forever on "Reading additional input from stdin..." and is
// killed with EXIT 0 AND EMPTY OUTPUT — indistinguishable from a model that
// returned nothing. Logged three times (2026-07-19 / -21 / -23), each costing a
// wasted background run.
for (const sub of subCmds) {
  if (!/\bcodex\b/.test(sub) || !/\bexec\b/.test(sub)) continue;
  const stripped = stripQuoted(sub);
  const redirectsStdin = /<\s*(\/dev\/null|NUL\b|nul\b|\$null)/i.test(stripped);
  // Something piped INTO codex also satisfies stdin (the prompt-on-stdin form).
  const pipedInto = /\|[^|]*\bcodex\b/.test(stripped);
  if (!redirectsStdin && !pipedInto) {
    denials.push(
      'codex exec without stdin closed — it will HANG FOREVER on "Reading additional input from stdin..." ' +
        'and be killed with exit 0 + empty output (looks exactly like a model that returned nothing).\n' +
        `  fix: append \`< /dev/null\` to the codex invocation, or pass the prompt ON stdin instead of as an argument.\n` +
        `  offending statement: ${sub.slice(0, 200)}`,
    );
  }
}

// ── Rule: destructive worktree restore ───────────────────────────────────────
// `git checkout -- <file>` restores from the INDEX, not HEAD-of-your-intent: on
// a file that is both staged and further edited it silently destroys every
// unstaged change, leaving a clean-looking tree. Bit twice — once costing a full
// re-apply of a 187-line diff, once losing an `assertWindowScopes` call that was
// only noticed because a red-green then behaved impossibly.
//
// Fires only on forms that TARGET PATHS: `git checkout -- <paths>`,
// `git checkout <ref> -- <paths>`, `git checkout .`, and `git restore` (unless
// it is the index-only `--staged` form, which does not touch the worktree).
// Plain `git checkout <branch>` is branch switching and is never flagged.
function restoreTargets(sub) {
  const stripped = stripQuoted(sub);
  if (!/\bgit\b/.test(stripped)) return null;

  if (/\bgit\b[^|]*\brestore\b/.test(stripped)) {
    // `--staged` alone unstages (index only) and is safe; `--worktree` (or the
    // absence of `--staged`) writes the working tree.
    if (/--staged\b/.test(stripped) && !/--worktree\b/.test(stripped)) return null;
    const args = sub.split(/\s+/).slice(sub.split(/\s+/).indexOf('restore') + 1);
    return args.filter((a) => !a.startsWith('-'));
  }

  if (!/\bgit\b[^|]*\bcheckout\b/.test(stripped)) return null;
  const tokens = sub.split(/\s+/);
  const dashDash = tokens.indexOf('--');
  if (dashDash !== -1) return tokens.slice(dashDash + 1).filter(Boolean);
  // `git checkout .` / `git checkout ./src` — a pathspec with no `--`.
  const after = tokens.slice(tokens.indexOf('checkout') + 1).filter((t) => !t.startsWith('-'));
  if (after.length === 1 && /^\.(\/|$)/.test(after[0])) return after;
  return null;
}

for (const sub of subCmds) {
  const targets = restoreTargets(sub);
  if (!targets || targets.length === 0) continue;
  if (process.env.AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE === '1') continue;
  const st = git(['status', '--porcelain', '--', ...targets]);
  if (!st.ok) continue; // git fault → fail open
  // Porcelain "XY path": Y is the WORKTREE column. A non-space Y means the file
  // carries changes that are not in the index — exactly what the restore eats.
  const atRisk = st.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 2 && l[1] !== ' ' && !l.startsWith('??'))
    .map((l) => l.slice(3).trim());
  if (atRisk.length > 0) {
    denials.push(
      'destructive restore — this would silently discard UNSTAGED work (git restores from the INDEX, ' +
        'and the resulting tree looks clean):\n' +
        atRisk.map((p) => `  - ${p}`).join('\n') +
        '\n  fix: undo a temporary (e.g. red-green mutation) edit by INVERTING it with a second targeted edit, ' +
        'or copy the file to the scratchpad first and copy it back. `git stash push -- <path>` also preserves it.\n' +
        '  deliberate discard: re-run with AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE=1.',
    );
  }
}

// ── Rule: agy headless traps ─────────────────────────────────────────────────
// Three separate silent-failure traps, all logged: (a) `-p` auto-denies its own
// tool permissions and exits 0 with only a "jetski: no output produced" line —
// so a driver must never trust the exit code; (b) `agy -p` IGNORES piped stdin
// ("No document provided") — cost a wasted dispatch round; (c) passing
// `--dangerously-skip-permissions` makes agy answer ABOUT THAT FLAG instead of
// the prompt, and in the derailed run it began executing `audit-code next-step`
// against the live repo unprompted.
for (const sub of subCmds) {
  if (!/(^|\s|\/|\\)agy(\.\w+)?(\s|$)/.test(sub)) continue;
  if (!/\s(-p|--print)(\s|$)/.test(sub)) continue;
  const stripped = stripQuoted(sub);
  if (/--dangerously-skip-permissions\b/.test(stripped)) {
    denials.push(
      'agy -p with --dangerously-skip-permissions — agy latches onto its OWN flag and answers about ' +
        '`--dangerously-skip-permissions` instead of your prompt (moving the task into a file does not help; ' +
        'the flag is still in argv). One derailed run started executing `audit-code next-step` against the live repo.\n' +
        '  fix: use codex or the NIM/LiteLLM lane for repo analysis; if agy is required, add read-only ' +
        'allow-rules to its settings.json instead of passing that flag with a substantive prompt.',
    );
  }
  if (/\|[^|]*\bagy\b/.test(stripped)) {
    denials.push(
      'piping into `agy -p` — agy does NOT read stdin; the piped document is silently ignored ' +
        '("No document provided"). Put the content in the prompt argument itself.',
    );
  }
  if (denials.length === 0) {
    advisories.push(
      'agy headless: exit code 0 does NOT mean success — a tool-permission denial prints ' +
        '"jetski: no output produced" and exits 0. Check the output text, not the status.',
    );
  }
}

// ── Rule: Bash-tool syntax traps (Git Bash on Windows) ───────────────────────
if (isBash) {
  const stripped = stripQuoted(cmd);
  // Unquoted `C:\path` — bash eats the backslashes (`C:\a\b` -> `C:ab`).
  if (/[A-Za-z]:\\/.test(stripped)) {
    denials.push(
      'unquoted Windows backslash path in a Bash-tool command — bash strips the backslashes ' +
        '(`C:\\Code\\x` becomes `C:Codex`).\n' +
        '  fix: use forward slashes (`C:/Code/x`), or run the command through the PowerShell tool.',
    );
  }
  // PowerShell here-string in a POSIX shell: parsed as literal `@` plus a syntax
  // error, and a commit lands with a mangled/truncated message.
  if (/@['"]\s*\r?\n/.test(cmd)) {
    denials.push(
      'PowerShell here-string (@\'...\'@) in a Bash-tool command — POSIX sh parses it as literal `@` ' +
        'characters plus a syntax error, and a commit message lands mangled or truncated.\n' +
        '  fix: write the body to the scratchpad and use `git commit -F <file>` (single-line messages via -m are fine), ' +
        'or run it through the PowerShell tool.',
    );
  }
  // `mktemp -d` yields an msys `/tmp/...` path that native tools (node, the
  // packaged CLI, --root) resolve against the Windows CWD and cannot find.
  if (/\bmktemp\b/.test(stripped)) {
    denials.push(
      '`mktemp` in the Bash tool returns an msys path (`/tmp/tmp.XXXX`) that node / the packaged CLI ' +
        'cannot resolve — it is re-rooted at the Windows CWD.\n' +
        '  fix: use the session scratchpad directory (an absolute `C:/...` path) for temp files.',
    );
  }
}

// ── ADVISE: exit-code masking ────────────────────────────────────────────────
// `$?` after a pipe is the FILTER's status. Reading `exit=0` off a grep produced
// a confident false-green on `verify:checks` that CI then caught. Same family:
// `npm test > out; echo done` reports the trailing command, and a background job
// piped through `tail` stays EMPTY until EOF (tail buffers), so progress polling
// reads an empty file for minutes.
const VERIFY_CMD = /\bnpm\s+(test|run\s+(check|build|verify|test|ci)[\w:]*)/;
for (const sub of subCmds) {
  if (!VERIFY_CMD.test(sub)) continue;
  if (/\|\s*(grep|rg|tail|head|Select-String)\b/.test(sub)) {
    advisories.push(
      'exit-code masking: `$?` after a pipe reports the FILTER\'s status, not the command\'s — this exact ' +
        'shape produced a false-green on verify:checks that CI then caught. Capture the status first ' +
        '(`cmd > log 2>&1 && echo PASS || echo "FAIL=$?"`) and read the log separately. ' +
        'For a BACKGROUND job never pipe through `tail` — it buffers and the output file stays empty until exit.',
    );
    break;
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────────
if (denials.length > 0) {
  console.error(
    `shell-trap guard: command blocked (${denials.length} rule${denials.length > 1 ? 's' : ''}).\n\n` +
      denials.map((d) => `• ${d}`).join('\n\n'),
  );
  process.exit(2);
}
if (advisories.length > 0) {
  console.error(`shell-trap guard (advisory):\n` + advisories.map((a) => `• ${a}`).join('\n'));
}
process.exit(0);
