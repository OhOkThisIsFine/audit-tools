#!/usr/bin/env node
// sites-pinned: tests/shared/push-gate.test.ts
// Agent-only protected-branch push boundary. Bind the checkout-local suite
// stamp to each local source tree actually sent to main/master. The payload cwd
// (or process cwd) identifies the checkout; CLAUDE_PROJECT_DIR may name another
// worktree and must never provide evidence for this push.
// Unsupported relocated/complex shell selection is announced fail-open, as are
// git infrastructure faults. Plain terminal pushes and content-free deletions
// remain outside this policy. Explicit feature destinations do not arm it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readSuiteGreenStamp, suiteGreenVerdict } from '../../scripts/shared/suiteGreenStamp.mjs';
import { splitShellStatements, stripHeredocBodies, stripQuoted } from './shell-split.mjs';

const PROTECTED = ['main', 'master'];

function noteFailOpen(reason) {
  console.error(`[push gate] FAIL-OPEN (allowing the push): ${reason}`);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // no payload = not a tool call we can judge
}
const command = payload?.tool_input?.command;
if (typeof command !== 'string' || command.trim() === '') process.exit(0);

// THE AGENT BOUNDARY. CLAUDE_CODE_SESSION_ID / CLAUDE_PID mark a Claude Code
// session; AUDIT_TOOLS_CHILD_SESSION marks a dispatched child. A plain terminal
// carries none and is not gated.
const isAgentSession = Boolean(
  process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_PID || process.env.AUDIT_TOOLS_CHILD_SESSION,
);
if (!isAgentSession) process.exit(0);

let root = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (top.status !== 0) {
  noteFailOpen('cannot resolve the push working directory');
  process.exit(0);
}
root = top.stdout.trim();

const statements = splitShellStatements(stripHeredocBodies(command));

// A \`cd X && git push\` chain and a \`git -C X push\` hop are OUT of scope: the target
// repository cannot be established here without a second copy of the commit
// gate's jurisdiction machinery, and guessing it would refuse a push into an
// unrelated repository (the 2026-08-19 false-red class). Announced, never
// silent — the one case where a skip would otherwise read as a pass.
if (/\bgit\b[^\n]*\bpush\b/.test(command) && /\bgit\s+-C\b|\b(?:cd|chdir|pushd|set-location|push-location)\b/i.test(command)) {
  noteFailOpen(
    'a relocated push (a \`cd\`/\`Set-Location\` prefix or a \`git -C\` hop) is not judged here — ' +
      'establish the target repository and run the full suite before pushing to main.',
  );
  process.exit(0);
}

// \`git push\`, not a dry run (which writes no ref), and with no hop that could
// relocate it (handled above).
const isPushStatement = (s) => {
  const t = stripQuoted(s).trim();
  if (/\bgit\s+push\b/.test(t) === false) return false;
  return !/(?:^|\s)--dry-run(?:\s|$)/.test(t);
};

const pushes = statements.filter(isPushStatement);
if (pushes.length === 0) process.exit(0);

const git = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
};

// Git sends a source-only refspec to the full ref name its source resolves to,
// so a symbolic source (`HEAD`, `@`) lands on the checked-out branch. An
// unresolvable or detached source keeps its literal name: git refuses that push.
const sourceOnlyDestination = (source) => {
  const full = git(['rev-parse', '--symbolic-full-name', '--end-of-options', source]);
  // rev-parse echoes `--end-of-options` itself as a line; the name is the last.
  const name = full.ok ? (full.stdout.trim().split(/\r?\n/).pop() ?? '') : '';
  return name.startsWith('refs/') ? name : source;
};

// Resolve each explicit local source, not the current checkout content. A
// protected destination may receive a different branch or an older commit.
const sources = [];
for (const statement of pushes) {
  const words = statement.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const args = words.slice(words.indexOf('push') + 1);
  const positional = [];
  let remoteOption = '';
  let deletion = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--delete' || arg === '-d') { deletion = true; continue; }
    if (['--repo', '--receive-pack', '--exec', '--push-option', '-o'].includes(arg)) {
      if (arg === '--repo') remoteOption = args[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('--repo=')) remoteOption = arg.slice('--repo='.length);
    if (['--all', '--mirror', '--tags', '--prune'].includes(arg) || /[$`*?]/.test(arg)) {
      noteFailOpen('unsupported push ref selection — the protected-branch check was SKIPPED');
      process.exit(0);
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  if (deletion) continue; // Deletes send no content tree to certify.
  let refs = remoteOption ? positional : positional.slice(1);
  if (refs.length === 0) {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!head.ok) {
      noteFailOpen('cannot resolve HEAD — the protected-branch check was SKIPPED');
      process.exit(0);
    }
    const branch = head.stdout.trim();
    const config = (key) => {
      const value = git(['config', '--get', key]);
      return value.ok ? value.stdout.trim() : '';
    };
    const remote = remoteOption || positional[0] || config(`branch.${branch}.pushRemote`) ||
      config('remote.pushDefault') || config(`branch.${branch}.remote`) || 'origin';
    const configured = git(['config', '--get-all', `remote.${remote}.push`]);
    if (config(`remote.${remote}.mirror`) === 'true') {
      noteFailOpen('configured mirror push selection is unsupported — suite check SKIPPED');
      process.exit(0);
    }
    if (configured.ok && configured.stdout.trim()) {
      refs = configured.stdout.trim().split(/\r?\n/);
    } else {
      const mode = config('push.default') || 'simple';
      if (mode === 'nothing') continue;
      if (!['simple', 'upstream', 'current'].includes(mode)) {
        noteFailOpen(`configured push.default=${mode} is unsupported — suite check SKIPPED`);
        process.exit(0);
      }
      const upstreamRemote = config(`branch.${branch}.remote`);
      const upstream = config(`branch.${branch}.merge`);
      // A triangular simple push uses the current branch name. Upstream mode
      // names the upstream destination; git itself refuses a mismatched remote.
      const target = mode !== 'current' && upstream && (!upstreamRemote || upstreamRemote === remote)
        ? upstream : branch;
      refs = [`HEAD:${target}`];
    }
  }
  for (const raw of refs) {
    if (raw === ':' || /[$`*?]/.test(raw)) {
      noteFailOpen('configured matching/wildcard push selection is unsupported — suite check SKIPPED');
      process.exit(0);
    }
    const ref = raw.replace(/^\+/, '');
    const colon = ref.indexOf(':');
    const source = colon < 0 ? ref : ref.slice(0, colon);
    // A source-only refspec pushes to the source's own full ref name, as git
    // resolves it: `HEAD` and `@` on main name refs/heads/main, not "HEAD".
    const named = colon < 0 ? sourceOnlyDestination(ref) : ref.slice(colon + 1);
    const target = named.replace(/^refs\/heads\//, '');
    if (source && PROTECTED.includes(target)) sources.push(source);
  }
}
if (sources.length === 0) process.exit(0);
const stamp = readSuiteGreenStamp(root);
let verdict;
for (const source of sources) {
  const resolved = git(['rev-parse', '--verify', '--end-of-options', `${source}^{tree}`]);
  if (!resolved.ok) {
    noteFailOpen(`cannot resolve pushed source ${source} — the suite check was SKIPPED`);
    process.exit(0);
  }
  verdict = suiteGreenVerdict(stamp, resolved.stdout.trim());
  if (!verdict.ok) break;
}
if (verdict?.ok) process.exit(0);

console.error(
  `[push gate] push to a PROTECTED branch (${PROTECTED.join('/')}) refused — ${verdict && !verdict.ok ? verdict.reason : 'no pushed tree evidence'}.\n` +
    `Every narrow gate passes on a touched area; a CROSS-AREA invariant is only reachable by the\n` +
    `full suite, which nothing local runs before a push (two commits shipped red this way on\n` +
    `2026-08-27). Run the full suite, then push again:\n` +
    `  npm test\n` +
    `A green FULL run writes the stamp this gate reads, bound to the tree it ran on. The local\n` +
    `source ref being pushed must carry that exact content. A FILTERED run (a file path, --shard,\n` +
    `--exclude) mints no stamp by design: a subset is not whole-tree evidence.`,
);
process.exit(2);
