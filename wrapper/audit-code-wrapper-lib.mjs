import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, shouldBuildDistForPaths, assertWorkspaceInstalled } from './audit-code-wrapper-build.mjs';
import { fileExists } from './audit-code-wrapper-io.mjs';
import {
  installBootstrap,
  verifyInstalledBootstrap,
  ensureBootstrap,
  installHostPrompt,
  _INSTALL_HOST_ORDER,
  _INSTALL_HOST_DEFINITIONS,
  _getInstallHostKeys,
  _getInstallProfile,
  _renderGeminiCommandToml,
} from './audit-code-wrapper-install-hosts.mjs';
import {
  wantsInstallerVerbHelp,
  installerVerbHelp,
  installerVerbSummaries,
} from './installer-verb-help.mjs';

export { shouldBuildDistForPaths, assertWorkspaceInstalled };
export { _INSTALL_HOST_ORDER, _INSTALL_HOST_DEFINITIONS, _getInstallHostKeys, _getInstallProfile, _renderGeminiCommandToml };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(repoRoot, 'dist', 'audit', 'index.js');
const packageJsonPath = join(repoRoot, 'package.json');
const promptAssetPath = join(repoRoot, 'skills', 'audit-code', 'audit-code.prompt.md');

// Deferred (NOT a top-level await): package.json is only needed by the
// `--version` branch, and a top-level read would fail EVERY invocation —
// including `--help` — whenever package.json is unreadable (CE-006).
async function readPackageVersion() {
  return JSON.parse(await readFile(packageJsonPath, 'utf8')).version;
}

// Informational flags (--help/--version) short-circuit the wrapper only when
// they appear BEFORE the first non-flag token (the command). A whole-argv scan
// hijacks post-command tokens that belong to the dist CLI — e.g.
// `audit-code explain-task -v` printed the wrapper's version instead of
// forwarding `-v` to the dist command (CE-007).
function hasLeadingFlag(argv, name) {
  for (const token of argv) {
    if (token === name) return true;
    if (!token.startsWith('-')) return false;
  }
  return false;
}

// Every occurrence of a flag in an argv, classified by the SAME grammar
// src/audit/cli/args.ts reads with: an equals token (`--root=/x`) carries its
// value inline; a bare token (`--root /x`) consumes the FOLLOWING token as its
// value only when that token exists and is not itself a flag (the mirror of
// args.ts's isLongFlagToken guard). Reading the dist grammar here is what makes
// the wrapper's view of "what did the caller pass" agree with what the child
// will actually act on. Ordered by ascending index; spans never overlap.
function flagOccurrences(argv, name) {
  const prefix = `${name}=`;
  const occurrences = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith(prefix)) {
      occurrences.push({ index, span: 1, inline: true });
    } else if (argv[index] === name) {
      const consumesValue =
        argv[index + 1] !== undefined && !argv[index + 1].startsWith("--");
      occurrences.push({ index, span: consumesValue ? 2 : 1, inline: false });
      if (consumesValue) index += 1;
    }
  }
  return occurrences;
}

// The caller's LAST occurrence is their final word for the flag.
function lastFlagEntry(argv, name) {
  const occurrences = flagOccurrences(argv, name);
  return occurrences[occurrences.length - 1];
}

function getFlag(argv, name) {
  const entry = lastFlagEntry(argv, name);
  if (!entry) return undefined;
  return entry.inline ? argv[entry.index].slice(name.length + 1) : argv[entry.index + 1];
}

// Overwrite an existing flag's value or append when absent, ALWAYS emitting the
// bare two-token form (`--name value`) — the only spelling
// src/audit/cli/args.ts parses (argv.indexOf, no '=' handling anywhere in
// src/audit), so forwarding an equals-form token verbatim means dist silently
// drops it and the CLI default wins — explicit loses, the exact failure class
// this guards. Every OTHER occurrence (either spelling, including each bare
// occurrence's consumed value token) is removed, so exactly one canonical
// occurrence reaches the child and dist's first-match parse cannot land on a
// stale one. A fill-only-if-missing default would otherwise forward a
// user-supplied RELATIVE --root/--artifacts-dir raw, re-resolved against the
// child's cwd (repoRoot), not the caller's cwd — e.g. `--root .` pointed at the
// package dir (CE-001). Normalizing to an absolute path here makes the
// forwarded value cwd-stable.
function setFlag(argv, name, value) {
  const occurrences = flagOccurrences(argv, name);
  const kept = occurrences[occurrences.length - 1];

  // Drop the superseded occurrences, highest index first, together with the
  // value token each bare one consumed.
  for (let occ = occurrences.length - 2; occ >= 0; occ -= 1) {
    argv.splice(occurrences[occ].index, occurrences[occ].span);
  }

  if (!kept) {
    argv.push(name, value);
    return;
  }

  // Removed occurrences shifted the kept one left; recompute its index.
  const removedBefore = occurrences.reduce(
    (span, occ) => (occ.index < kept.index ? span + occ.span : span),
    0,
  );
  const index = kept.index - removedBefore;
  if (kept.span === 2) {
    // Bare with a value slot: overwrite the value in place.
    argv[index + 1] = value;
    return;
  }
  // Inline (`--name=x`) or dangling bare: collapse the token to the bare flag
  // and insert the value after it.
  argv[index] = name;
  argv.splice(index + 1, 0, value);
}

export { hasLeadingFlag, setFlag };

function nodeExecutable() {
  return process.execPath;
}

// When the wrapper runs from a source checkout (its package dir is NOT inside a
// node_modules tree), generated continuation commands should re-invoke THIS
// wrapper via `node <path>` so a dogfooded monorepo run stays pinned to local
// code instead of silently falling back to a globally-installed `audit-code`
// bin. Installed copies leave the hint unset so the dist CLI keeps emitting the
// `audit-code` bin. Returned as an env fragment scoped to the spawned child so
// it never leaks into the parent process (e.g. the test runner).
function selfInvocationEnv() {
  if (process.env.AUDIT_CODE_INVOCATION) {
    return { AUDIT_CODE_INVOCATION: process.env.AUDIT_CODE_INVOCATION };
  }
  if (/[\\/]node_modules[\\/]/.test(repoRoot)) {
    return {};
  }
  return {
    AUDIT_CODE_INVOCATION: JSON.stringify(['node', join(repoRoot, 'audit-code.mjs')]),
  };
}

// Byte-mirrors `quoteForCmd` in src/shared/tooling/exec.ts (see that file's
// doc comment for the full CVE-2024-27980 rationale: cmd.exe's own line-scan
// recognizes `& | < > ^` even inside a double-quoted region, so quote-doubling
// alone is not enough for the `.cmd`/`.bat` shim-wrapping path below; `%`
// cannot be neutralized this way at all, so it throws instead). This copy
// exists only because the wrapper runs pre-dist (bootstrap constraint) and
// cannot import the shared TS source — pinned byte-equal to the shared
// implementation by tests/shared/wrapper-quote-parity.test.mjs so the two
// copies cannot drift.
const CMD_ARGV_METACHARS = /[&|<>^]/u;

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (arg.includes('%')) {
    throw new Error(
      `quoteForCmd: refusing to quote an argument containing "%" for a ` +
        `.cmd/.bat shim invocation through cmd.exe — cmd.exe's ` +
        `percent-expansion cannot be reliably neutralized by caret-escaping ` +
        `(see CVE-2024-27980 and its documented residual gap). Argument: ` +
        `${JSON.stringify(arg)}`,
    );
  }
  const needsQuoting = /[\s"]/u.test(arg);
  const needsMetaEscape = CMD_ARGV_METACHARS.test(arg);
  if (!needsQuoting && !needsMetaEscape) return arg;
  const quoted = needsQuoting ? `"${arg.replace(/"/g, '""')}"` : arg;
  return needsMetaEscape ? quoted.replace(/([&|<>^])/g, '^$1') : quoted;
}

function resolveSpawn(command, args, platform = process.platform) {
  if (!(platform === 'win32' && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
  };
}

// Exported for tests/shared/wrapper-quote-parity.test.mjs only (behavioral
// drift guard against src/shared/tooling/exec.ts) — not part of the wrapper's
// CLI surface.
export { quoteForCmd, resolveSpawn };

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const resolved = resolveSpawn(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: repoRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // Node-worktree guard: this spawn pins cwd to the PACKAGE root, so the
      // backend's process.cwd() carries no evidence of where the CALLER ran
      // from. Stamp the caller's true cwd so the backend guard can refuse
      // driver lifecycle commands invoked from inside a tool-created worktree.
      // Literal must match AUDIT_TOOLS_CALLER_CWD_ENV in
      // src/shared/io/nodeWorktreeGuard.ts (pinned by
      // tests/shared/node-worktree-guard.test.mjs).
      env: { ...(options.env ?? process.env), AUDIT_TOOLS_CALLER_CWD: process.cwd() }
    });

    let stdout = '';
    let stderr = '';

    if (options.capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(options.capture ? stderr || `Command failed with exit code ${code}.` : `Command failed with exit code ${code}.`));
    });
  });
}

function printHelp({ usageName, preferredEntrypoint }) {
  const lines = [
    `Usage: node ${usageName} <command> [--root PATH] [--artifacts-dir PATH]`,
    '',
    'Primary usage (conversation-first):',
    '- next-step advances deterministic audit state one bounded step and writes',
    '  .audit-tools/audit/steps/current-step.json plus current-prompt.md; the host',
    '  agent follows only the returned step prompt and calls next-step again',
    '',
    'Helper commands:',
    '- prompt-path prints the absolute path to the canonical /audit-code prompt asset',
    // The four wrapper-intercepted installer verbs are RENDERED from the module
    // this file already answers `<verb> --help` from, so the listing and the
    // per-verb help cannot disagree. They were hand-restated here and had
    // already drifted from it on two of the four.
    ...installerVerbSummaries('/audit-code'),
    '- mcp starts the local stdio MCP server for repo-local IDE integrations',
    '- validate checks the current artifact bundle and canonical session intent and exits non-zero when issues exist',
    '- validate-results --results FILE validates AuditResult payloads against the active task manifest without ingesting them',
    '- explain-task <task_id> prints the resolved file coverage and current status for a task id',
    '- ingest-results --results FILE validates and ingests canonical AuditResult payloads',
    '- unaccept-results --work-item <id> (repeatable) or --all removes entries from the accepted host-results pair so a poisoned acceptance can be re-ingested after repair',
    '- status summarizes deterministic audit state and pending review work',
    '',
    'Defaults:',
    '- --root .',
    '- --artifacts-dir <root>/.audit-tools/audit',
  ];

  if (preferredEntrypoint && preferredEntrypoint !== usageName) {
    lines.push('', `Preferred entrypoint: node ${preferredEntrypoint}`);
  }

  console.log(lines.join('\n'));
}

async function printPromptPath() {
  if (!(await fileExists(promptAssetPath))) {
    throw new Error(`Canonical prompt asset is missing: ${promptAssetPath}`);
  }

  console.log(resolve(promptAssetPath));
}

async function runDistCommand(commandName, argv, { ensureArtifactsDir = false } = {}) {
  const commandArgs = [...argv];
  const rootValue = resolve(getFlag(commandArgs, '--root') ?? '.');
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-tools', 'audit'));

  // Overwrite (not default) so a user-supplied relative value is normalized to
  // the caller-cwd-resolved absolute path before it reaches the child (CE-001).
  setFlag(commandArgs, '--root', rootValue);
  setFlag(commandArgs, '--artifacts-dir', artifactsDir);

  if (ensureArtifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
  }

  await ensureBuilt();
  await run(nodeExecutable(), [distEntry, commandName, ...commandArgs], {
    env: { ...process.env, ...selfInvocationEnv() },
  });
}

async function runDistCommandInline(commandName, argv, { ensureArtifactsDir = false } = {}) {
  const commandArgs = [...argv];
  const rootValue = resolve(getFlag(commandArgs, '--root') ?? '.');
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-tools', 'audit'));

  setFlag(commandArgs, '--root', rootValue);
  setFlag(commandArgs, '--artifacts-dir', artifactsDir);

  // Gate the mkdir behind the same ensureArtifactsDir flag as runDistCommand so
  // "the artifacts directory is created only for designated stateful commands"
  // holds on this path too (CE-001); mcp is a designated stateful command and
  // opts in explicitly at its call site.
  if (ensureArtifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
  }
  await ensureBuilt();

  // Propagate the invocation hint into this (long-lived) server process so it
  // and the wrapper subprocesses it spawns emit continuation commands that
  // match how the backend was launched. Safe here: this path is only the `mcp`
  // server, not a shared/test process.
  Object.assign(process.env, selfInvocationEnv());

  // Import the module that exports runCli (dist/cli.js). dist/index.js has no
  // exports — it is the bare entrypoint that runs `runCli(process.argv)` as an
  // import side effect — so importing it here both fails to provide runCli and
  // double-starts the command from this process's argv.
  const distCliEntry = join(repoRoot, 'dist', 'cli.js');
  const distUrl = new URL(`file:///${distCliEntry.replace(/\\/g, '/')}`);
  const cli = await import(distUrl.href);
  await cli.runCli([process.execPath, distCliEntry, commandName, ...commandArgs]);
}

export async function runAuditCodeWrapper({
  usageName,
  argv = process.argv.slice(2),
  preferredEntrypoint
}) {
  if (hasLeadingFlag(argv, '--help') || hasLeadingFlag(argv, '-h')) {
    printHelp({ usageName, preferredEntrypoint });
    return;
  }

  if (hasLeadingFlag(argv, '--version') || hasLeadingFlag(argv, '-v')) {
    console.log(await readPackageVersion());
    return;
  }

  // An informational flag never performs work. The installer verbs are handled
  // here rather than by the dist CLI, so commander's native `<verb> --help` never
  // reaches them — without this, `install --help` INSTALLED. hasLeadingFlag
  // cannot answer it: it stops at the first non-flag token by design, so a dist
  // command's own `-h`/`-v` is forwarded rather than hijacked (CE-007).
  if (wantsInstallerVerbHelp(argv)) {
    console.log(installerVerbHelp(argv[0], { usageName, product: '/audit-code' }));
    return;
  }

  if (argv[0] === 'prompt-path') {
    await printPromptPath();
    return;
  }

  if (argv[0] === 'ensure') {
    await ensureBootstrap(argv.slice(1));
    return;
  }

  if (argv[0] === 'install') {
    await installBootstrap(argv.slice(1));
    return;
  }

  if (argv[0] === 'install-host') {
    await installHostPrompt(argv.slice(1));
    return;
  }

  if (argv[0] === 'verify-install') {
    await verifyInstalledBootstrap(argv.slice(1));
    return;
  }

  // Commands that need special wrapper handling stay explicit:
  //  - `mcp` runs INLINE (dist/index.js's import side effect would double-start
  //    the command; only dist/cli.js's runCli export is safe to import here).
  //  - the artifact-dir-bootstrapping commands pass { ensureArtifactsDir: true }
  //    because they may be the FIRST call in a fresh repo and must create the
  //    run directory before dist reads it.
  if (argv[0] === 'mcp') {
    await runDistCommandInline('mcp', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  if (argv[0] === 'next-step') {
    await runDistCommand('next-step', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  // No implicit default command: the audit advances one bounded step per
  // invocation via `next-step` (conversation-first). A bare invocation prints
  // usage.
  if (argv.length === 0) {
    printHelp({ usageName, preferredEntrypoint });
    return;
  }

  // Every other command is forwarded verbatim to the dist CLI, which is the
  // SINGLE SOURCE OF TRUTH for the command set. This makes wrapper/CLI drift
  // structurally impossible: any command `src/audit/cli.ts` handles is reachable
  // through the packaged bin automatically — no per-command wrapper branch to
  // forget (the `cleanup` gap that motivated this) — and an unknown command
  // gets dist's authoritative "Unknown command" + available-commands list
  // (exit 1), never a wrapper-local list that can fall out of sync.
  await runDistCommand(argv[0], argv.slice(1));
}
