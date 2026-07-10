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

function hasFlag(argv, name) {
  return argv.includes(name);
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

function getFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function setDefaultFlag(argv, name, value) {
  if (!hasFlag(argv, name)) {
    argv.push(name, value);
  }
}

// Overwrite an existing flag's value (or append when absent). setDefaultFlag
// only fills a MISSING flag, so a user-supplied RELATIVE --root/--artifacts-dir
// was forwarded raw and then re-resolved against the child's cwd (repoRoot),
// not the caller's cwd — e.g. `--root .` pointed at the package dir (CE-001).
// Normalizing to an absolute path here makes the forwarded value cwd-stable.
function setFlag(argv, name, value) {
  const index = argv.indexOf(name);
  if (index < 0) {
    argv.push(name, value);
  } else {
    argv[index + 1] = value;
  }
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
      env: options.env ?? process.env
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
    '- advance-audit runs exactly one deterministic advance and prints the',
    '  execution envelope (debugging / bounded-step testing)',
    '',
    'Helper commands:',
    '- prompt-path prints the absolute path to the canonical /audit-code prompt asset',
    '- ensure lazily bootstraps repo-local /audit-code assets when they are missing or stale',
    '- install bootstraps /audit-code into supported repo-local host surfaces',
    '- verify-install smoke-tests the generated host assets after install',
    '- mcp starts the local stdio MCP server for repo-local IDE integrations',
    '- install-host --host copilot keeps the narrower Copilot-focused install path available',
    '- validate checks the current artifact bundle plus session-config/provider readiness and exits non-zero when issues exist',
    '- validate-results --results FILE validates AuditResult payloads against the active task manifest without ingesting them',
    '- explain-task <task_id> prints the resolved file coverage and current status for a task id',
    '- prepare-dispatch --run-id <id> [--artifacts-dir <dir>] creates packet prompt files and a slim dispatch-plan.json for parallel subagent dispatch',
    '- submit-packet --run-id <id> --packet-id <id> [--artifacts-dir <dir>] validates AuditResult[] from stdin and writes only backend-assigned result files',
    '- merge-and-ingest --run-id <id> [--root <dir>] [--artifacts-dir <dir>] merges assigned packet results and ingests them into the coverage matrix',
    '- validate-result --run-id <id> --task-id <id> [--artifacts-dir <dir>] validates a single task result against the schema and line counts',
    '  generated packet prompts may use --run-id-b64, --task-id-b64, and --artifacts-dir-b64 to avoid shell-sensitive raw ids',
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

  if (argv[0] === 'quota') {
    await runDistCommand('quota', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  if (argv[0] === 'merge-and-ingest') {
    await runDistCommand('merge-and-ingest', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  if (argv[0] === 'advance-audit') {
    await runDistCommand('advance-audit', argv.slice(1), { ensureArtifactsDir: true });
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
