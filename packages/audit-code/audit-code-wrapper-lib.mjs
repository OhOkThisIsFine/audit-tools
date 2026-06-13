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

const repoRoot = dirname(fileURLToPath(import.meta.url));
const distEntry = join(repoRoot, 'dist', 'index.js');
const packageJsonPath = join(repoRoot, 'package.json');
const promptAssetPath = join(repoRoot, 'skills', 'audit-code', 'audit-code.prompt.md');
const packageVersion = JSON.parse(await readFile(packageJsonPath, 'utf8')).version;

function hasFlag(argv, name) {
  return argv.includes(name);
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

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSpawn(command, args) {
  if (!(process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
  };
}

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

  setDefaultFlag(commandArgs, '--root', rootValue);
  setDefaultFlag(commandArgs, '--artifacts-dir', artifactsDir);

  if (ensureArtifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
  }

  await ensureBuilt();
  await run(nodeExecutable(), [distEntry, commandName, ...commandArgs], {
    env: { ...process.env, ...selfInvocationEnv() },
  });
}

async function runDistCommandInline(commandName, argv) {
  const commandArgs = [...argv];
  const rootValue = resolve(getFlag(commandArgs, '--root') ?? '.');
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-tools', 'audit'));

  setDefaultFlag(commandArgs, '--root', rootValue);
  setDefaultFlag(commandArgs, '--artifacts-dir', artifactsDir);

  await mkdir(artifactsDir, { recursive: true });
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
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printHelp({ usageName, preferredEntrypoint });
    return;
  }

  if (hasFlag(argv, '--version') || hasFlag(argv, '-v')) {
    console.log(packageVersion);
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

  if (argv[0] === 'validate') {
    await runDistCommand('validate', argv.slice(1));
    return;
  }

  if (argv[0] === 'validate-results') {
    await runDistCommand('validate-results', argv.slice(1));
    return;
  }

  if (argv[0] === 'explain-task') {
    await runDistCommand('explain-task', argv.slice(1));
    return;
  }

  if (argv[0] === 'mcp') {
    await runDistCommandInline('mcp', argv.slice(1));
    return;
  }

  if (argv[0] === 'next-step') {
    await runDistCommand('next-step', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  if (argv[0] === 'prepare-dispatch') {
    await runDistCommand('prepare-dispatch', argv.slice(1));
    return;
  }

  if (argv[0] === 'validate-result') {
    await runDistCommand('validate-result', argv.slice(1));
    return;
  }

  if (argv[0] === 'quota') {
    await runDistCommand('quota', argv.slice(1), { ensureArtifactsDir: true });
    return;
  }

  if (argv[0] === 'submit-packet') {
    await runDistCommand('submit-packet', argv.slice(1));
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
  // usage; an unrecognized command fails loudly instead of silently running
  // something else.
  if (argv.length === 0) {
    printHelp({ usageName, preferredEntrypoint });
    return;
  }

  printHelp({ usageName, preferredEntrypoint });
  throw new Error(`Unknown command: ${argv[0]}`);
}
