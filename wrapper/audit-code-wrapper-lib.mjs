import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, posix, resolve, win32 } from 'node:path';
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
// sites-pinned: tests/shared/installer-verb-help.test.ts
import {
  wantsInstallerVerbHelp,
  installerVerbHelp,
  installerVerbSummaries,
} from './installer-verb-help.mjs';
import { resolveWrapperRoot } from './repo-root.mjs';

export { shouldBuildDistForPaths, assertWorkspaceInstalled };
export { _INSTALL_HOST_ORDER, _INSTALL_HOST_DEFINITIONS, _getInstallHostKeys, _getInstallProfile, _renderGeminiCommandToml };

// sites-pinned: tests/audit/cleanup.test.ts
const repoRoot = join(import.meta.dirname, '..');
const distEntry = join(repoRoot, 'dist', 'audit', 'index.js');
const packageJsonPath = join(repoRoot, 'package.json');
const promptAssetPath = join(repoRoot, 'skills', 'audit-code', 'audit-code.prompt.md');

// Deferred (NOT a top-level await): package.json is only needed by the
// version and command branches, and a top-level read would fail EVERY invocation —
// including `--help` — whenever package.json is unreadable (CE-006).
async function readPackageVersion() {
  return JSON.parse(await readFile(packageJsonPath, 'utf8')).version;
}

// Informational flags (--help/--version) short-circuit the wrapper only when
// they appear BEFORE the first non-flag token (the command). A whole-argv scan
// hijacks post-command tokens that belong to the dist CLI — e.g.
// `audit-code status -v` printed the wrapper's version instead of
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

// sites-pinned: tests/shared/installer-verb-help.test.ts
function getFlag(argv, name) {
  let value;
  for (const entry of flagOccurrences(argv, name)) {
    value = entry.inline ? argv[entry.index].slice(name.length + 1)
      : entry.span === 2 ? argv[entry.index + 1] : undefined;
    if (!value) throw new Error(`${name} requires a value; use ${name}=<value> for a value beginning with --.`);
  }
  return value;
}

// Overwrite an existing flag's value or append when absent, emitting one
// canonical two-token form (`--name value`). Every other occurrence (either spelling, including each bare
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

const VERSION_PREFIX = '--expect-version=';
const NODE_COMMAND = /^node(?:\.exe)?$/i;
const SHELL_UNSAFE_LAUNCH_PATH = /[\u0000-\u001f\u007f"'$!%&|<>^`]/u;

function concreteLauncherPath(token) {
  return !SHELL_UNSAFE_LAUNCH_PATH.test(token)
    && (posix.isAbsolute(token) || (win32.isAbsolute(token) && /^(?:[a-z]:|\\\\)/i.test(token)));
}

/** Accept a concrete launcher, not a PATH-dependent audit-code alias or command. */
function invocationOverride(raw) {
  if (!raw) return undefined;
  try {
    const argv = JSON.parse(raw);
    if (!Array.isArray(argv) || !argv.every(arg => typeof arg === 'string' && arg.length > 0)) return undefined;
    const launcher = argv.filter(arg => !arg.startsWith(VERSION_PREFIX));
    if (launcher.length === 1 && concreteLauncherPath(launcher[0])) return launcher;
    if (launcher.length === 2
      && (NODE_COMMAND.test(launcher[0])
        || (concreteLauncherPath(launcher[0]) && NODE_COMMAND.test(win32.basename(launcher[0]))))
      && concreteLauncherPath(launcher[1]) && /\.mjs$/i.test(launcher[1])) return launcher;
  } catch {
    // A malformed override must not emit an unbound PATH lookup.
  }
  return undefined;
}

// Bind generated commands to the current release, even when the host supplies
// a concrete launcher. An old pin is replaced, not trusted or left duplicated.
async function selfInvocationEnv() {
  const raw = process.env.AUDIT_CODE_INVOCATION;
  const override = invocationOverride(raw);
  if (raw && !override) console.warn('[audit-code] Invalid AUDIT_CODE_INVOCATION; using this version-bound wrapper instead.');
  return {
    AUDIT_CODE_INVOCATION: JSON.stringify([
      ...(override ?? ['node', join(repoRoot, 'audit-code.mjs')]),
      VERSION_PREFIX + await readPackageVersion(),
    ]),
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

// sites-pinned: tests/audit/cleanup.test.ts
/** @returns {Promise<void>} */
function run(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const resolved = resolveSpawn(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: repoRoot,
      stdio: 'inherit',
      // Node-worktree guard: this spawn pins cwd to the PACKAGE root, so the
      // backend's process.cwd() carries no evidence of where the CALLER ran
      // from. Stamp the caller's true cwd so the backend guard can refuse
      // driver lifecycle commands invoked from inside a tool-created worktree.
      // Literal must match AUDIT_TOOLS_CALLER_CWD_ENV in
      // src/shared/io/nodeWorktreeGuard.ts (pinned by
      // tests/shared/node-worktree-guard.test.mjs).
      env: { ...env, AUDIT_TOOLS_CALLER_CWD: process.cwd() }
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code}.`));
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
    '  agent follows only the returned step prompt and its version-bound command',
    '',
    'Helper commands:',
    '- prompt-path prints the absolute path to the canonical /audit-code prompt asset',
    // The four wrapper-intercepted installer verbs are RENDERED from the module
    // this file already answers `<verb> --help` from, so the listing and the
    // per-verb help cannot disagree. They were hand-restated here and had
    // already drifted from it on two of the four.
    ...installerVerbSummaries('/audit-code'),
    // sites-pinned: none — help text; it asserts no behaviour
    '- mcp serves the submit-only MCP tool (submit_result) over stdio',
    '- submit --work-item ID --from FILE checks one work item result and writes it to its bound path only when it passes',
    '- validate checks the current artifact bundle and canonical session intent and exits non-zero when issues exist',
    '- status summarizes deterministic audit state and pending review work',
    '',
    'Defaults:',
    '- --root the repository the working directory is in (nearest ancestor owning .audit-tools/ or .git); pass it only to target a repository you are not inside',
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

// sites-pinned: tests/audit/cleanup.test.ts
async function runDistCommand(commandName, argv) {
  const commandArgs = [...argv];
  // An absent --root is DISCOVERED (nearest ancestor owning .audit-tools/.git),
  // not defaulted to the caller's cwd verbatim: the wrapper normalizes the root
  // to an absolute path before the child sees it (CE-001), so a cwd-verbatim
  // default here would pin the wrong root no matter what dist resolves.
  const rootValue = resolveWrapperRoot(getFlag(commandArgs, '--root'));
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-tools', 'audit'));

  // Overwrite (not default) so a user-supplied relative value is normalized to
  // the caller-cwd-resolved absolute path before it reaches the child (CE-001).
  setFlag(commandArgs, '--root', rootValue);
  setFlag(commandArgs, '--artifacts-dir', artifactsDir);

  await ensureBuilt();
  await run(process.execPath, [distEntry, commandName, ...commandArgs], {
    ...process.env,
    ...await selfInvocationEnv(),
  });
}

/** @param {{usageName: string, argv?: string[], preferredEntrypoint?: string}} options */
export async function runAuditCodeWrapper({
  usageName,
  argv = process.argv.slice(2),
  preferredEntrypoint
}) {
  if (argv[0]?.startsWith(VERSION_PREFIX)) {
    const expected = argv[0].slice(VERSION_PREFIX.length);
    const actual = await readPackageVersion();
    if (actual !== expected) {
      throw new Error(
        `audit-tools version changed: this continuation expects ${expected}, but this wrapper is ${actual}. No audit state was modified. To stay on the original release, run the same arguments with that release. To intentionally continue on this release, replace only the leading ${VERSION_PREFIX}${expected} with ${VERSION_PREFIX}${actual} and rerun the same command; the usual state checks still apply.`,
      );
    }
    argv = argv.slice(1);
  }
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
