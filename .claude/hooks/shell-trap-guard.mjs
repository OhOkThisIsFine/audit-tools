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
import { resolve as resolvePath } from 'node:path';
import {
  stripQuoted,
  splitShellStatements,
  splitShellStatementsWithSeparators,
  stripHeredocBodies,
  findLiveBackticks,
  findLiveExpansions,
  findQuotedSpans,
  bypassEnabled,
} from './shell-split.mjs';

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
// The full tool parameter object arrives on stdin, so the background flag is
// part of the payload. Absent => foreground => the background-only rules stay
// silent (the fail-open direction).
const runInBackground = payload?.tool_input?.run_in_background === true;
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

// bypassEnabled lives in shell-split.mjs (shared with the pre-commit gate's
// child-session refusal — one mechanic, one anchoring rule). Every call below
// passes the module-level heredoc-blanked `cmd` explicitly: same env read, same
// regex, same scanned text it used to close over.

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
  const stripped = stripQuoted(sub);
  // Matched on the STRIPPED statement: `rg "codex exec" docs` is a textual
  // mention inside quotes, not an invocation, and must not fire.
  if (!/\bcodex(\.\w+)?\b/.test(stripped) || !/\bexec\b/.test(stripped)) continue;
  // ANY stdin redirect closes stdin — `< /dev/null` is the canonical form, but
  // `< prompt.txt` (prompt ON stdin) and a heredoc equally prevent the hang.
  const redirectsStdin = /<\s*\S/.test(stripped);
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
  // Shell-quoted targets reach git WITHOUT their quotes — strip them here too,
  // or a quoted path never matches the pathspec and the rule silently misses.
  const targets = restoreTargets(sub)?.map((t) => t.replace(/^['"]|['"]$/g, ''));
  if (!targets || targets.length === 0) continue;
  if (bypassEnabled('AUDIT_TOOLS_ALLOW_DESTRUCTIVE_RESTORE', cmd)) continue;
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
  // Unquoted Windows backslash path — bash eats the backslashes (`C:\a\b` ->
  // `C:ab`). Drive-letter (`C:\x`), relative (`.\x` / `..\x`), and UNC
  // (`\\server\share`) forms all mangle the same way.
  if (/[A-Za-z]:\\|(?:^|\s)\.{1,2}\\\S|(?:^|\s)\\\\[A-Za-z0-9]/.test(stripped)) {
    denials.push(
      'unquoted Windows backslash path in a Bash-tool command — bash strips the backslashes ' +
        '(`C:\\Code\\x` becomes `C:Codex`; same for `.\\x` and `\\\\server\\share`).\n' +
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
  // Command-position only: `rg mktemp docs` SEARCHES for the word, it doesn't
  // run it — fire on statement start, after a pipe, or inside `$(`/backtick
  // substitution.
  if (subCmds.some((s) => /(?:^|\||\$\(|`)\s*mktemp\b/.test(stripQuoted(s)))) {
    denials.push(
      '`mktemp` in the Bash tool returns an msys path (`/tmp/tmp.XXXX`) that node / the packaged CLI ' +
        'cannot resolve — it is re-rooted at the Windows CWD.\n' +
        '  fix: use the session scratchpad directory (an absolute `C:/...` path) for temp files.',
    );
  }

  // An env var that is UNSET in this shell expands to the empty string, and the
  // failure names the wrong cause: `> "$TMPDIR/x.log"` becomes `> /x.log` →
  // "Permission denied" (reads as a temp-dir permissions problem), and a path
  // read back later resolves against the Windows CWD as
  // `C:\Program Files\Git\x.log` (reads as a missing file). Hit 2026-07-25,
  // -07-28, -07-29 and again 2026-08-09 — the last one WITH an accurate
  // durable-traps entry already written, which is why this is a rule and not
  // prose. [[an-advisory-that-fires-and-is-read-past]]
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
  if (liveUnset.length > 0 && !bypassEnabled('AUDIT_TOOLS_ALLOW_UNSET_ENV', cmd)) {
    denials.push(
      `${liveUnset.map((n) => `$${n}`).join(' and ')} — UNSET in the Bash tool, so the expansion is the ` +
        'EMPTY STRING and the failure names the wrong cause. `> "$TMPDIR/x.log"` becomes `> /x.log` ' +
        '("Permission denied", which reads as a temp-dir problem), and a path read back later resolves ' +
        'against the Windows CWD as `C:\\Program Files\\Git\\x.log` (which reads as a missing file).\n' +
        '  fix: write the SESSION SCRATCHPAD path by its absolute value (the `C:/Users/.../scratchpad` ' +
        'path in the system prompt); for the repo root use a relative path or $(git rev-parse --show-toplevel).\n' +
        '  note: CLAUDE_PROJECT_DIR is a hook-invocation variable — it is substituted into the command ' +
        'lines in .claude/settings.json and never exported to a tool shell.\n' +
        '  deliberate: set it in the command itself (`TMPDIR=/c/tmp …`), or re-run with ' +
        'AUDIT_TOOLS_ALLOW_UNSET_ENV=1.',
    );
  }

  // A backtick in a POSIX shell is command substitution EVERYWHERE except inside
  // single quotes — including inside double quotes, which is where prose lives.
  // Markdown backticks in a commit message or a doc line therefore do not survive
  // as text: the shell RUNS what they wrap and splices the output in. That is how
  // a backlog file was corrupted — the writer read as prose, the shell read as a
  // command, and the file landed with the substitution's output in place of the
  // markdown.
  //
  // DENY rather than advise: both uses have a strictly better form ($() for a
  // real substitution, -F <file> for prose), so there is nothing this refuses
  // that has no correct rewrite ([[an-advisory-that-fires-and-is-read-past]]).
  const liveTicks = findLiveBackticks(cmd);
  if (liveTicks.length > 0 && !bypassEnabled('AUDIT_TOOLS_ALLOW_BACKTICKS', cmd)) {
    const inProse = liveTicks.some((t) => t.context === 'double');
    denials.push(
      'live backtick in a Bash-tool command — a backtick COMMAND-SUBSTITUTES everywhere except inside ' +
        "single quotes, so it substitutes inside double quotes too. Markdown backticks in a quoted " +
        'message are executed, not written; that is how a backlog file landed with command output ' +
        'spliced into its prose.\n' +
        (inProse
          ? '  fix (prose/markdown): write the body to the scratchpad and use `git commit -F <file>`, or ' +
            'single-quote the string — inside single quotes a backtick is literal.\n'
          : '') +
        '  fix (real substitution): use $(...) instead — same semantics, nests, and does not collide with markdown.\n' +
        '  deliberate: re-run with AUDIT_TOOLS_ALLOW_BACKTICKS=1.',
    );
  }

  // An inline interpreter payload (`node -e "…"` / `python -c "…"` / …) whose
  // double-quoted body needs SHELL-ACTIVE escapes — `\` before one of
  // `` ` `` `"` `$` `\` — is the exact shape that got mangled 2026-08-14: the
  // shell ate one level of escaping, the escaped backtick went inert and the
  // regex around it became invalid, so the interpreter ran a DIFFERENT program
  // from the one written. One escape is survivable; a payload needing two or
  // more (TOTAL count, not adjacent — the motivating incident's escapes were
  // separated by regex text) is a script, not a flag argument. Shell-INERT
  // escapes (`\d`, `\s`, …) pass through double quotes untouched in bash and
  // never count, so the escape-free `node -e "…require('./x.json')…"` shape —
  // used successfully 4x — stays allowed, as does any single-quoted payload
  // (no escapes exist inside single quotes). Bash path only: PowerShell's
  // escape char is the backtick, backslashes are literal there, and the PS
  // half of the class has its own guard.
  const INLINE_INTERPRETER =
    /\b(?:node\s+(?:-e|--eval)|python3?\s+-c|perl\s+-e|ruby\s+-e|(?:bash|sh)\s+-c)\b/;
  for (const sub of subCmds) {
    // Matched on the STRIPPED statement — `rg "node -e" docs/` is a quoted
    // textual mention, not an invocation, and must not fire.
    const flag = INLINE_INTERPRETER.exec(stripQuoted(sub));
    if (!flag) continue;
    if (bypassEnabled('AUDIT_TOOLS_ALLOW_INLINE_SCRIPT', cmd)) continue;
    // stripQuoted is length-preserving (collapseQuoted is NOT), so the flag's
    // index on the stripped text maps directly onto the raw statement's quoted
    // spans; the payload is the first span at or after the flag.
    const payloadSpan = findQuotedSpans(sub).find((sp) => sp.start >= flag.index);
    if (!payloadSpan || payloadSpan.quote !== '"') continue;
    const activeEscapes = payloadSpan.content.match(/\\[`"$\\]/g) ?? [];
    if (activeEscapes.length < 2) continue;
    denials.push(
      `inline interpreter payload with ${activeEscapes.length} shell-active escapes ` +
        '(`\\` before one of `` ` `` `"` `$` `\\`) — the exact shape that got mangled: the shell ' +
        'eats one level of escaping, so the interpreter runs a DIFFERENT program from the one ' +
        'written (2026-08-14: an escaped backtick went inert and the regex around it became invalid).\n' +
        '  fix: write the script to the session scratchpad and run it by path — re-runnable, ' +
        'diffable, no double-escaping.\n' +
        '  deliberate: re-run with AUDIT_TOOLS_ALLOW_INLINE_SCRIPT=1.\n' +
        `  offending statement: ${sub.slice(0, 200)}`,
    );
  }
}

// ── Rule: a suite/verify exit code masked by a pipe ──────────────────────────
// `$?` after a pipe is the FILTER's status, so `npm test 2>&1 | tail -50`
// reports EXIT 0 for a RED suite — and `tail` buffers to EOF, so the captured
// text held only the build notices. Both signals read green at once; the run
// was actually 1 failed, found only by re-running redirected to a file
// (2026-07-24). An earlier false-green on `verify:checks` reached CI the same
// way.
//
// This was an ADVISORY and the advisory FIRED — it was read past, which is
// precisely what an advisory cannot prevent. A manufactured false green is not
// the "usually wrong but legitimately used" class: there is a strictly better
// form for every use, so it is a DENY ([[false-red-is-as-corrosive-as-false-green]]).
const SUITE_CMD =
  /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:check|build|verify|test|ci|smoke|lint|fixtures)[\w:-]*)|\bnpx\s+vitest\b|\bvitest\s+run\b|\bnode\s+--test\b/;
// The OTHER half of the same class. What makes the mask dangerous is that the
// exit status is LOAD-BEARING — not that the command runs tests. Keying on test
// runners was the wrong axis: `git push origin main 2>&1 | tail -3` was admitted
// and reported EXIT 0 for a push refused as non-fast-forward, its hint scrolled
// past inside the captured tail (2026-08-27). The false green is worse here than
// on a suite, because an agent that believes a push landed stops verifying.
// Read-only verbs (`log`, `status`, `diff`, `show`, `branch`) are deliberately
// ABSENT: piping those into a filter is correct usage, and a false red would
// cost as much as the false green this rule exists to stop.
const STATE_CHANGING_CMD =
  /\bgit\s+(?:push|commit|merge|rebase|cherry-pick|tag)\b|\b(?:npm|pnpm|yarn)\s+publish\b/;
// ONE rule, two families. They differ only in their example command and their
// consequence sentence, so the skeleton stays single-sourced and the family is a
// policy axis of it — never a second copy of the rule.
const MASK_FAMILIES = [
  {
    name: 'suite',
    match: SUITE_CMD,
    subject: 'a test/verify command',
    example: 'npm test',
    exitNoun: "suite's",
    consequence:
      'so a RED suite comes back EXIT 0. `tail` also buffers to EOF, so the captured text holds ' +
      'only the early build notices: green status AND green-looking output, both false.',
  },
  {
    name: 'state-changing',
    match: STATE_CHANGING_CMD,
    subject: 'a state-changing command',
    example: 'git push origin main',
    exitNoun: "command's",
    consequence:
      'so a REFUSED push/commit/merge comes back EXIT 0, its rejection hint scrolled past inside ' +
      'the captured tail. An agent that believes the push landed stops verifying, and ' +
      'pipeline-ownership then reads as satisfied while the work sits only on the local branch.',
  },
];
/**
 * Is this statement one whose exit status is load-bearing?
 * @param {string} text statement text, already quote-stripped
 * @returns {boolean}
 */
const isStatusBearing = (text) => MASK_FAMILIES.some((f) => f.match.test(text));
const FILTER_PIPE = /\|\s*(?:grep|rg|tail|head|wc|sed|awk|Select-String|Select-Object|more|less)\b/;
// The masking is defeated when the statement propagates the pipeline's real
// status: bash `set -o pipefail` / `${PIPESTATUS[0]}`. Those are correct usage.
// Tested against the WHOLE command, never the statement: `set -o pipefail` is
// its own statement and applies to every pipeline after it, and `${PIPESTATUS[0]}`
// is read in the statement AFTER the pipe. A per-statement check sees neither.
const PIPE_STATUS_PRESERVED = /\bpipefail\b|\bPIPESTATUS\b/.test(stripQuoted(cmd));
for (const sub of subCmds) {
  const stripped = stripQuoted(sub);
  const family = MASK_FAMILIES.find((f) => f.match.test(stripped));
  if (!family || !FILTER_PIPE.test(stripped)) continue;
  if (PIPE_STATUS_PRESERVED) continue;
  if (bypassEnabled('AUDIT_TOOLS_ALLOW_MASKED_EXIT', cmd)) continue;
  denials.push(
    `masked ${family.name} exit code — ${family.subject} piped into a filter reports the FILTER's ` +
      `status, ${family.consequence}\n` +
      // Background-safe remedies ONLY: the old `; echo "EXIT=$?"` suggestion
      // IS the laundering trap when the command is backgrounded (the rule
      // below), so the guard must never prescribe it.
      (isBash
        ? `  fix: \`${family.example} > run.log 2>&1\` — let the ${family.exitNoun} exit BE the ` +
          "command's exit (no trailing `; echo`: backgrounded, a trailing statement becomes the " +
          "compound's exit and fakes green), then read/grep `run.log` in a separate call " +
          '(`set -o pipefail` also propagates the real status if you must pipe).\n'
        : `  fix: \`${family.example} *> run.log; exit $LASTEXITCODE\` then read/grep \`run.log\` in a ` +
          'separate call.\n') +
      `  offending statement: ${sub.slice(0, 200)}`,
  );
  break;
}

// ── Rule: a peer-CLI dispatch piped into a buffering filter ─────────────────
// Same defect class as the masked-suite-exit rule above, hitting a different
// command family: `tail`/`head`/`grep`/etc. buffer to EOF before printing
// anything, so a long `codex exec` / `agy -p` dispatch piped through one of
// them is indistinguishable from a hang on stdout. One run sat at 0 bytes for
// ~30 minutes and then returned a complete verdict (2026-08-09,
// docs/backlog/durable-traps.md "A background lane piped through tail/head").
// The night after, a WEDGED `codex exec` run had already emitted 24 findings
// into its transcript before hanging, recoverable only because that
// particular call happened to be redirected to a file rather than piped —
// `awk '/^FINDING:/,0'` salvaged it (2026-08-09/10, "A broad multi-file
// review scope kills both peer-CLI lanes"). Had that run been piped instead,
// the same 24 findings would have been lost with it. DENY, not advisory, for
// the same reason the sibling rule above is a DENY: there is a strictly
// better form (redirect to a file, read/grep the file separately) for every
// legitimate use, and this project has already watched an advisory over the
// identical mechanism get read past once ([[false-red-is-as-corrosive-as-false-green]]
// — same mechanism, different command family).
const CLI_DISPATCH_CMD = /\bcodex\s+exec\b|\bagy\b[^|;&]*\s(?:-p|--print)\b/;
for (const sub of subCmds) {
  const stripped = stripQuoted(sub);
  if (!CLI_DISPATCH_CMD.test(stripped) || !FILTER_PIPE.test(stripped)) continue;
  if (bypassEnabled('AUDIT_TOOLS_ALLOW_BUFFERED_DISPATCH', cmd)) continue;
  denials.push(
    'peer-CLI dispatch piped into a buffering filter — `codex exec` / `agy -p` output piped into ' +
      '`tail`/`head`/`grep`/etc. shows ZERO bytes until the process exits, so a live run and a hung ' +
      'one look identical. One run sat at 0 bytes for ~30 minutes before returning a complete verdict; ' +
      "a wedged run the following night had already emitted 24 findings into its transcript, recoverable " +
      "only because that call was redirected to a FILE, not piped — a pipe would have discarded them.\n" +
      (isBash
        ? '  fix: redirect to a file instead — `codex exec "…" < /dev/null > run.log 2>&1 &` (or ' +
          '`*> run.log` in PowerShell), then read/tail/grep `run.log` separately. On a wedge, salvage a ' +
          "partial transcript with e.g. `awk '/^FINDING:/,0' run.log`.\n"
        : '  fix: redirect to a file instead — `*> run.log`, then read/tail/grep `run.log` separately.\n') +
      `  offending statement: ${sub.slice(0, 200)}`,
  );
  break;
}

// ── Rule: an over-long ad-hoc peer-CLI dispatch prompt (P28) ─────────────────
// A mega-prompt inlined into `codex exec` / `agy -p` / `claude.ps1 -p` loses
// the whole answer SILENTLY — nothing back, hard truncation, or max_tokens
// spent reasoning out loud (six dated incidents, including an 836-line prompt
// and the broad multi-file scopes that killed both peer-CLI lanes four times).
// The reliable unit is ONE bounded item per call. Threshold: well above any
// one-bounded-item prompt, well below the lane-killing mega-prompts, measured
// on the statement's longest quoted span (the prompt argument). Uncovered
// halves, stated outright: a prompt delivered via a stdin file
// (`codex exec < prompt.txt`), `$(cat …)`, or a heredoc (bodies are blanked
// above) escapes measurement — the lane-dispatch driver is the primary fix;
// this refusal is the backstop on the inline form.
const MAX_DISPATCH_PROMPT_CHARS = 4000;
const CLI_DISPATCH_PROMPT_CMD =
  /\bcodex\s+exec\b|\bagy\b[^|;&]*\s(?:-p|--print)\b|\bclaude\.ps1\b[^|;&]*\s(?:-p|--print)\b/;
for (const sub of subCmds) {
  if (!CLI_DISPATCH_PROMPT_CMD.test(stripQuoted(sub))) continue;
  if (bypassEnabled('AUDIT_TOOLS_ALLOW_LONG_DISPATCH', cmd)) continue;
  const longest = Math.max(0, ...findQuotedSpans(sub).map((sp) => sp.content.length));
  if (longest <= MAX_DISPATCH_PROMPT_CHARS) continue;
  denials.push(
    `over-long inline dispatch prompt (${longest} chars > ${MAX_DISPATCH_PROMPT_CHARS}) — an ` +
      'over-scoped peer-CLI dispatch loses the WHOLE answer silently: nothing back, truncation, ' +
      'or max_tokens spent reasoning out loud (six dated incidents; a broad multi-file scope ' +
      'killed both lanes four times).\n' +
      '  fix: dispatch one bounded item per call via `node scripts/shared/lane-dispatch.mjs` — ' +
      'per-item logs, finish_reason + output size recorded, coverage stamp.\n' +
      '  deliberate: re-run with AUDIT_TOOLS_ALLOW_LONG_DISPATCH=1.',
  );
  break;
}

// ── Rule: a write-capable lane dispatched INTO this repo ─────────────────────
// A lane launched with this repo as its cwd does not stay a lane. It fires
// SessionStart, self-registers as an OWNER, and then obeys this repo's own
// sprint ceremony. Measured 2026-08-29: a `claude -p` lane given acceptEdits
// plus Bash/Write never answered its prompt — it ran the full suite three
// times, overwrote the DISPATCHING session's suite-green stamp with its own
// tree (voiding that session's green baseline), and pushed the branch to
// origin.
//
// `AUDIT_TOOLS_CHILD_SESSION=1` exempts a child from the session-scoped Stop
// gates, but NOTHING sets it: not the relay ladder's rendered command, not
// scripts/shared/lane-dispatch.mjs (lane-agnostic by construction — its shell
// adapter is deliberately unshipped, so it spawns no process and can set no
// env), and not any repo affordance. An exemption that works only when the
// caller remembers is host discretion, which this repo bans everywhere else.
//
// WHY HERE. The dispatching session's tool call is the one boundary this repo
// owns. The lane's own process cannot be asked: nothing inside it distinguishes
// a lane from an owner, and the signals that look like they might (a loopback
// ANTHROPIC_BASE_URL, a lane-specific CLAUDE_CONFIG_DIR) are exactly the host
// execution facts `467b1e8f` and `3bea76ee` retired. A gate states the boundary
// it owns rather than guessing at one owned by something else.
//
// UNCOVERED, stated rather than implied: a lane launched from a shell this hook
// never sees, and any dispatch reaching git through a script rather than a tool
// call (`scripts/release-and-publish.mjs`) — both already-declared halves of the
// same session-registry split in docs/backlog/durable-traps.md.
const LANE_CMD =
  /\bcodex\s+exec\b|\bagy\b[^|;&]*\s(?:-p|--print)\b|\bclaude(?:\.ps1|\.exe)?\b[^|;&]*\s(?:-p|--print)\b/;
// Write OR push capability. `Bash` alone qualifies: a lane holding a shell can
// run `git push` no matter what its other tools are.
const LANE_WRITE_CAPABLE =
  /--allowedTools[\s=]+\S*\b(?:Bash|Edit|Write|NotebookEdit)\b|--permission-mode[\s=]+(?:acceptEdits|bypassPermissions)\b|--dangerously-skip-permissions\b/;
// The child marker in BOTH dialects. Matched on STRIPPED text, so the shape of
// the assignment must sit outside quotes — a prompt that merely names the token
// is blanked to spaces and cannot switch the rule off. durable-traps records
// that `bypassEnabled` does not recognize the PowerShell form; this rule must,
// because the relay ladder renders PowerShell and a bash-only test would
// false-red every correctly-marked lane.
const CHILD_MARKER =
  /(?:^|[\s;&|(])AUDIT_TOOLS_CHILD_SESSION\s*=|\$env:AUDIT_TOOLS_CHILD_SESSION\s*=/;
const CD_STATEMENT = /^\s*(?:cd|pushd|Set-Location|sl)\b/i;
const strippedCmd = stripQuoted(cmd);
if (
  LANE_CMD.test(strippedCmd) &&
  LANE_WRITE_CAPABLE.test(strippedCmd) &&
  !CHILD_MARKER.test(strippedCmd) &&
  !bypassEnabled('AUDIT_TOOLS_ALLOW_REPO_LANE', cmd)
) {
  // Every worktree of this repository counts as "in this repo": they share one
  // object store, so a lane in a sibling worktree can still push. The common
  // git dir's parent is that family's root.
  const norm = (p) => resolvePath(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const common = git(['rev-parse', '--git-common-dir']);
  // FAIL-OPEN: no git answer means no family to compare against, so the rule
  // stands down rather than guessing.
  const family = common.ok && common.stdout.trim() ? norm(resolvePath(ROOT, common.stdout.trim(), '..')) : null;
  if (family) {
    // An explicit cd/Set-Location retargets the lane. Targets are read from the
    // RAW statement (stripQuoted blanks a quoted path), but only from statements
    // whose stripped form BEGINS with the verb — so a `cd` inside a prompt is
    // never mistaken for a real one.
    const targets = [];
    for (const st of splitShellStatements(cmd)) {
      if (!CD_STATEMENT.test(stripQuoted(st))) continue;
      const m = st.match(/^\s*(?:cd|pushd|Set-Location|sl)\s+(?:-\S+\s+)*(?:'([^']+)'|"([^"]+)"|(\S+))/i);
      const target = m && (m[1] || m[2] || m[3]);
      if (target) targets.push(target);
    }
    const inFamily = (p) => {
      const abs = norm(resolvePath(ROOT, p));
      return abs === family || abs.startsWith(family + '/');
    };
    // No cd at all: the lane inherits THIS session's cwd, which is this repo.
    if (targets.length === 0 || targets.some(inFamily)) {
      denials.push(
        'a write-capable lane dispatched INTO this repo — it will not stay a lane. It fires ' +
          'SessionStart, self-registers as an OWNER, and then runs this repo\'s sprint ceremony. ' +
          'Measured 2026-08-29: such a lane never answered its prompt; it ran the full suite three ' +
          "times, overwrote the DISPATCHING session's suite-green stamp with its own tree, and " +
          'pushed the branch to origin.\n' +
          '  fix: pick ONE — mark it a child (`AUDIT_TOOLS_CHILD_SESSION=1` inline, or ' +
          "`$env:AUDIT_TOOLS_CHILD_SESSION = '1';` in PowerShell); or give it READ-ONLY tools " +
          '(`--allowedTools Read,Grep,Glob`), which cannot commit, push, or rewrite the stamp; or ' +
          'point it at a directory outside this repository.\n' +
          '  deliberate: re-run with AUDIT_TOOLS_ALLOW_REPO_LANE=1.',
      );
    }
  }
}

// ── Rule: a backgrounded suite exit LAUNDERED by a trailing statement ────────
// Under run_in_background the harness completion notice reads the COMPOUND's
// exit — i.e. the LAST statement's — so `suite > log; echo "EXIT=$?"` reports
// exit 0 for a RED suite. 2026-08-12: a red suite reported 0 with two TS2345
// errors sitting in the unread log; CI caught it, the notice did not. This is
// the GENERAL status-laundering rule: detected from exit-status FLOW (the
// statement sequence's last exit-producing element), never a third named
// syntactic instance. A statement matching either MASK_FAMILIES entry — a suite
// OR a state-changing command, the same load-bearing-exit axis as the pipe rule
// above — followed transitively by
// any non-`&&` separator (`;`, `||`, newline) can have its red replaced by
// the trailing statement's status; `&&` chains short-circuit and PRESERVE a
// failure, and a terminal `exit $?` / `exit $LASTEXITCODE` /
// `exit ${PIPESTATUS[0]}` passes the status through — the prescribed fixes'
// own shapes, whitelisted so the guard never refuses its own remedy.
// Foreground runs are exempt (the status is read directly there). Known false
// negative, accepted: in-statement `&` backgrounding (`npm test … & echo`) is
// not a split separator and stays uncovered. Bypass reuses
// AUDIT_TOOLS_ALLOW_MASKED_EXIT — same trap class as the pipe rule above.
if (runInBackground && !bypassEnabled('AUDIT_TOOLS_ALLOW_MASKED_EXIT', cmd)) {
  const seq = splitShellStatementsWithSeparators(cmd);
  const PASSES_STATUS_THROUGH = /^exit\s+(?:\$\?|\$LASTEXITCODE\b|\$\{?PIPESTATUS)/;
  const finalPassesThrough = seq.length > 0 && PASSES_STATUS_THROUGH.test(seq[seq.length - 1].text);
  const laundered =
    !finalPassesThrough &&
    seq.some(
      (part, i) =>
        isStatusBearing(stripQuoted(part.text)) &&
        seq.slice(i + 1).some((later) => later.sepBefore !== '&&'),
    );
  if (laundered) {
    denials.push(
      'backgrounded exit status LAUNDERED by a trailing statement — under run_in_background the ' +
        "harness completion notice reads the LAST statement's exit, so a RED suite reports 0 " +
        '(2026-08-12: two TS2345 errors sat in an unread log while the notice said exit 0).\n' +
        (isBash
          ? "  fix: `npm test > run.log 2>&1` — let the suite's exit BE the command's exit (no " +
            'trailing `; echo`), then read/grep `run.log` in a separate call; `&&`-chaining and a ' +
            'terminal `exit $?` also preserve the status.\n'
          : '  fix: `npm test *> run.log; exit $LASTEXITCODE` then read/grep `run.log` in a ' +
            'separate call.\n') +
        '  deliberate: re-run with AUDIT_TOOLS_ALLOW_MASKED_EXIT=1.',
    );
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
