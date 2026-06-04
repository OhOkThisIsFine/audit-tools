import { access, cp, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const distEntry = join(repoRoot, 'dist', 'index.js');
const packageJsonPath = join(repoRoot, 'package.json');
const promptAssetPath = join(repoRoot, 'skills', 'audit-code', 'audit-code.prompt.md');
const skillAssetPath = join(repoRoot, 'skills', 'audit-code', 'SKILL.md');
const tsconfigPath = join(repoRoot, 'tsconfig.json');
const sourceRoot = join(repoRoot, 'src');
const buildLockPath = join(repoRoot, '.audit-code-build.lock');
const BUILD_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const BUILD_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const BUILD_LOCK_WAIT_INTERVAL_MS = 200;
const INSTALL_MARKER_START = '<!-- audit-code:begin -->';
const INSTALL_MARKER_END = '<!-- audit-code:end -->';
const INSTALL_GUIDE_FILENAME = 'GETTING-STARTED.md';
const INSTALL_MANIFEST_FILENAME = 'manifest.json';
const DEFAULT_INSTALL_HOST = 'all';
const INSTALLED_PROMPT_FILENAME = 'audit-code.import.md';
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

function requireFlagValue(argv, name) {
  const value = getFlag(argv, name);
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function newestMtimeMs(path) {
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtimeMs(childPath));
      continue;
    }
    if (entry.isFile()) {
      newest = Math.max(newest, (await stat(childPath)).mtimeMs);
    }
  }
  return newest;
}

export async function shouldBuildDistForPaths({
  distEntryPath,
  sourceRootPath,
  tsconfigPath: tsconfigPathValue,
}) {
  if (!(await fileExists(distEntryPath))) {
    if (!(await fileExists(sourceRootPath)) || !(await fileExists(tsconfigPathValue))) {
      throw new Error(
        'Bundled dist is missing and source files are unavailable for rebuild.',
      );
    }
    return true;
  }

  if (!(await fileExists(sourceRootPath)) || !(await fileExists(tsconfigPathValue))) {
    return false;
  }

  const distMtime = (await stat(distEntryPath)).mtimeMs;
  const sourceMtime = await newestMtimeMs(sourceRootPath);
  const tsconfigMtime = (await stat(tsconfigPathValue)).mtimeMs;
  const newestInput = Math.max(sourceMtime, tsconfigMtime);
  return distMtime < newestInput;
}

async function shouldBuildDist() {
  return await shouldBuildDistForPaths({
    distEntryPath: distEntry,
    sourceRootPath: sourceRoot,
    tsconfigPath,
  });
}

async function releaseBuildLock(handle) {
  try {
    await handle?.close();
  } finally {
    await unlink(buildLockPath).catch(() => {});
  }
}

async function waitForPeerBuild() {
  const start = Date.now();

  while (true) {
    if (!(await fileExists(buildLockPath))) {
      return;
    }

    if (Date.now() - start > BUILD_LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for build lock ${buildLockPath}.`);
    }

    await sleep(BUILD_LOCK_WAIT_INTERVAL_MS);
  }
}

async function acquireBuildLock() {
  while (true) {
    try {
      const handle = await open(buildLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          const lockStats = await stat(buildLockPath);
          if (Date.now() - lockStats.mtimeMs > BUILD_LOCK_MAX_AGE_MS) {
            await unlink(buildLockPath).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }

        await waitForPeerBuild();
        if (!(await shouldBuildDist())) {
          return null;
        }
        continue;
      }
      throw error;
    }
  }
}

// Pure, testable core of the build preflight. `sharedManifestPath` is the
// resolved path of @audit-tools/shared's package.json (or null if it could not
// be resolved at all); `checkoutRoot` is the root this wrapper belongs to.
export function assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath }) {
  if (!sharedManifestPath) {
    throw new Error(
      'Dependencies are not installed for this checkout. Run `npm install` from ' +
        'the repository root, then retry — building from source needs node_modules ' +
        '(including the @audit-tools/shared workspace link).',
    );
  }

  const relToCheckout = relative(checkoutRoot, sharedManifestPath);
  if (relToCheckout.startsWith('..') || isAbsolute(relToCheckout)) {
    throw new Error(
      `@audit-tools/shared resolved to ${sharedManifestPath}, outside this ` +
        `checkout (${checkoutRoot}). node_modules was never installed here — ` +
        'common in a fresh git worktree — so building would typecheck against ' +
        "another checkout's stale dist and report phantom \"missing export\" " +
        "errors. Run `npm install` from this checkout's root.",
    );
  }
}

// Catches the common fresh-checkout trap before `npm run build` runs: with no
// local node_modules, Node/tsc resolve @audit-tools/shared against a different
// checkout (e.g. the main repo when running inside a git worktree).
async function preflightWorkspace() {
  const requireFromHere = createRequire(import.meta.url);
  let sharedManifestPath = null;
  try {
    sharedManifestPath = requireFromHere.resolve('@audit-tools/shared/package.json');
  } catch {
    sharedManifestPath = null;
  }
  assertWorkspaceInstalled({
    checkoutRoot: resolve(repoRoot, '..', '..'),
    sharedManifestPath,
  });
}

async function ensureBuilt() {
  if (!(await shouldBuildDist())) {
    return;
  }

  await preflightWorkspace();

  const lockHandle = await acquireBuildLock();
  if (!lockHandle) {
    return;
  }

  try {
    if (!(await shouldBuildDist())) {
      return;
    }
    await run(npmExecutable(), ['run', 'build']);
  } finally {
    await releaseBuildLock(lockHandle);
  }
}

function printHelp({ usageName, preferredEntrypoint }) {
  const lines = [
    `Usage: node ${usageName} [--single-step] [--root PATH] [--artifacts-dir PATH] [--results FILE] [--batch-results DIR] [--updates FILE] [--external-analyzer-results FILE] [--timeout MS]`,
    '',
    'Helper commands:',
    '- prompt-path prints the absolute path to the canonical /audit-code prompt asset',
    '- ensure lazily bootstraps repo-local /audit-code assets when they are missing or stale',
    '- install bootstraps /audit-code into supported repo-local host surfaces',
    '- verify-install smoke-tests the generated host assets after install',
    '- mcp starts the local stdio MCP server for repo-local IDE integrations',
    '- install-host --host copilot keeps the narrower Copilot-focused install path available',
    '- next-step advances deterministic audit state and writes .audit-artifacts/steps/current-step.json plus current-prompt.md',
    '- validate checks the current artifact bundle plus session-config/provider readiness and exits non-zero when issues exist',
    '- validate-results --results FILE validates AuditResult payloads against the active task manifest without ingesting them',
    '- explain-task <task_id> prints the resolved file coverage and current status for a task id',
    '- prepare-dispatch --run-id <id> [--artifacts-dir <dir>] creates packet prompt files and a slim dispatch-plan.json for parallel subagent dispatch',
    '- submit-packet --run-id <id> --packet-id <id> [--artifacts-dir <dir>] validates AuditResult[] from stdin and writes only backend-assigned result files',
    '- merge-and-ingest --run-id <id> [--root <dir>] [--artifacts-dir <dir>] merges assigned packet results and ingests them into the coverage matrix',
    '- validate-result --run-id <id> --task-id <id> [--artifacts-dir <dir>] validates a single task result against the schema and line counts',
    '  generated packet prompts may use --run-id-b64, --task-id-b64, and --artifacts-dir-b64 to avoid shell-sensitive raw ids',
    '',
    'Primary usage:',
    '- from the repository root, run the wrapper with no arguments',
    '- default behavior advances the audit automatically until it completes or no further automatic progress is possible',
    '- each wrapper response refreshes operator-handoff.json and operator-handoff.md under the artifacts directory',
    '- use --single-step only for debugging or bounded-step testing',
    '',
    'Defaults:',
    '- --root .',
    '- --artifacts-dir <root>/.audit-artifacts',
    '',
    'Completion signals:',
    '- done: audit_state.status is complete',
    '- blocked/no further automatic progress: progress_made is false and next_likely_step is null'
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

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function splitFrontmatter(markdown) {
  const normalized = normalizeNewlines(markdown);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) {
    return { frontmatter: null, body: normalized };
  }

  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length),
  };
}

function renderFrontmatter(fields) {
  const entries = Object.entries(fields).filter(([, value]) => {
    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === 'string') {
      return value.length > 0;
    }

    return true;
  });
  if (entries.length === 0) {
    return '';
  }

  return [
    '---',
    ...entries.map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
  ].join('\n');
}

function renderPromptFile(fields, body) {
  return `${renderFrontmatter(fields)}${body.trimStart()}`;
}

function toRepoRelativePath(root, targetPath) {
  const value = relative(root, targetPath).replace(/\\/g, '/');
  return value.length > 0 ? value : '.';
}

function buildInstallDirective(relativePromptPath) {
  return [
    INSTALL_MARKER_START,
    '## /audit-code',
    'When the user enters `/audit-code`, treat it as this repository\'s autonomous audit workflow.',
    `If your host does not automatically register the installed slash command file, load and follow [the repo-local audit directive](${relativePromptPath.replace(/\\/g, '/')}).`,
    'Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.',
    INSTALL_MARKER_END,
  ].join('\n');
}

function upsertManagedBlock(existingContent, blockContent) {
  const normalized = normalizeNewlines(existingContent);
  const blockPattern = new RegExp(
    `${INSTALL_MARKER_START}[\\s\\S]*?${INSTALL_MARKER_END}`,
    'u',
  );

  if (blockPattern.test(normalized)) {
    return normalized.replace(blockPattern, blockContent);
  }

  if (normalized.trim().length === 0) {
    return `${blockContent}\n`;
  }

  return `${normalized.replace(/\s+$/u, '')}\n\n${blockContent}\n`;
}

async function writeManagedMarkdown(targetPath, blockContent) {
  const existed = await fileExists(targetPath);
  const existingContent = existed ? await readFile(targetPath, 'utf8') : '';
  const nextContent = upsertManagedBlock(existingContent, blockContent);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, nextContent, 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

async function writeGeneratedMarkdown(targetPath, content) {
  const existed = await fileExists(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

function looksLikeAuditCodeSkill(content) {
  const normalized = normalizeNewlines(content);
  return (
    /^name:\s*audit-code\b/mu.test(normalized)
    || normalized.includes('Conversation-first autonomous code auditing workflow for the /audit-code command.')
    || normalized.includes('The canonical entrypoint is `/audit-code` in conversation.')
  );
}

function looksLikeAuditCodePrompt(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('# `/audit-code`')
    && (
      normalized.includes('audit-code orchestrator')
      || normalized.includes('Autonomous local loop code auditing')
      || normalized.includes('Conversation-first autonomous code auditing workflow')
    )
  );
}

function looksLikeAuditCodeInterfaceMetadata(content) {
  const normalized = normalizeNewlines(content);
  return (
    normalized.includes('audit-code')
    && (
      normalized.includes('display_name:')
      || normalized.includes('short_description:')
      || normalized.includes('default_prompt:')
    )
    && (
      normalized.includes('/audit-code')
      || normalized.includes('Start /audit-code')
    )
  );
}

async function buildLegacyAuditCodeSurfaceTargets(root) {
  const targets = [
    {
      host: 'codex',
      surface: 'skill',
      path: join(root, '.codex', 'skills', 'audit-code', 'SKILL.md'),
      matches: looksLikeAuditCodeSkill,
    },
    {
      host: 'codex',
      surface: 'prompt',
      path: join(root, '.codex', 'skills', 'audit-code', 'audit-code.prompt.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'command',
      path: join(root, '.opencode', 'commands', 'audit-code.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'opencode',
      surface: 'skill',
      path: join(root, '.opencode', 'skills', 'audit-code', 'SKILL.md'),
      matches: looksLikeAuditCodeSkill,
    },
    {
      host: 'opencode',
      surface: 'prompt',
      path: join(root, '.opencode', 'skills', 'audit-code', 'audit-code.prompt.md'),
      matches: looksLikeAuditCodePrompt,
    },
    {
      host: 'claude',
      surface: 'command',
      path: join(root, '.claude', 'commands', 'audit-code.md'),
      matches: looksLikeAuditCodePrompt,
    },
  ];

  const codexAgentDir = join(root, '.codex', 'skills', 'audit-code', 'agents');
  const codexAgentEntries = await readdir(codexAgentDir).catch(() => []);
  for (const entry of codexAgentEntries) {
    targets.push({
      host: 'codex',
      surface: 'interface-metadata',
      path: join(codexAgentDir, entry),
      matches: looksLikeAuditCodeInterfaceMetadata,
    });
  }

  return targets;
}

async function findLegacyAuditCodeSurfaceFiles(root) {
  const matches = [];
  for (const target of await buildLegacyAuditCodeSurfaceTargets(root)) {
    const existing = await readTextIfExists(target.path);
    if (existing !== null && target.matches(existing)) {
      matches.push(target.path);
    }
  }
  return matches;
}

async function removeLegacyAuditCodeSurfaceFiles(root) {
  const removed = [];
  for (const target of await buildLegacyAuditCodeSurfaceTargets(root)) {
    const existing = await readTextIfExists(target.path);
    if (existing === null || !target.matches(existing)) {
      continue;
    }
    await unlink(target.path);
    removed.push({
      path: target.path,
      mode: 'removed',
    });
  }
  return removed;
}

async function writeGeneratedJson(targetPath, value) {
  const existed = await fileExists(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

async function readJsonObjectIfExists(targetPath, description) {
  if (!(await fileExists(targetPath))) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(targetPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${description} exists but is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${description} must be a JSON object when it already exists.`);
  }

  return parsed;
}

async function writeMergedGeneratedJson(targetPath, description, buildValue) {
  const existed = await fileExists(targetPath);
  const existing = await readJsonObjectIfExists(targetPath, description);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    JSON.stringify(buildValue(existing), null, 2) + '\n',
    'utf8',
  );
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

async function writeGeneratedBinary(targetPath, content) {
  const existed = await fileExists(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
  return {
    path: targetPath,
    mode: existed ? 'updated' : 'created',
  };
}

function replaceBackslashes(value) {
  return value.replace(/\\/g, '/');
}

function renderVSCodeAgentFile() {
  return [
    '---',
    'description: Plan and orchestrate /audit-code through the next-step machine before making code changes.',
    '---',
    '',
    '# Auditor Agent',
    '',
    'Use `audit-code next-step` as the primary integration surface for the audit workflow. The installed auditor MCP server is a compatibility adapter over the same step contract.',
    '',
    'When the user asks to run or continue `/audit-code`:',
    '',
    '- run `audit-code next-step` directly when shell access is available',
    '- if MCP is the only available integration, call `start_audit`, `get_status`, and `continue_audit`; those tools return the same one-step contract',
    '- read `audit-code://handoff/current` and `audit-code://artifacts/current` when the audit blocks or you need current context',
    '- prefer imported audit results and runtime updates over ad hoc manual state edits',
    '- treat the deterministic audit report as the final source of truth once the audit completes',
    '',
  ].join('\n');
}

function renderCodexAutomationRecipe() {
  return [
    '# Codex re-audit automation recipe',
    '',
    'Suggested recurring task:',
    '',
    '- Prompt: Re-run the autonomous audit workflow for this repository with `audit-code next-step`, summarize only new or regressed findings, and stop once the deterministic report is current.',
    '- Cadence: daily on active branches or before release cut-offs',
    '- Inputs: repository root',
    '',
    'Use this recipe as a starting point for a Codex automation once the local workflow is stable in your environment.',
    '',
  ].join('\n');
}

const OPENCODE_AUDIT_EDIT_PERMISSION = {
  '*': 'ask',
  '.audit-code/**': 'allow',
  '.audit-artifacts/**': 'allow',
  'audit-report.md': 'allow',
};

const OPENCODE_AUDIT_BASH_PERMISSION = {
  '*': 'allow',
  'audit-code run-to-completion*': 'deny',
  'audit-code synthesize*': 'deny',
  'audit-code cleanup*': 'deny',
  'audit-code requeue*': 'deny',
  'audit-code ingest-results*': 'deny',
  '*dist*index.js* run-to-completion*': 'deny',
  '*dist*index.js* synthesize*': 'deny',
  '*dist*index.js* cleanup*': 'deny',
  '*dist*index.js* requeue*': 'deny',
  '*dist*index.js* ingest-results*': 'deny',
  '*audit-code.mjs* run-to-completion*': 'deny',
  '*audit-code.mjs* synthesize*': 'deny',
  '*audit-code.mjs* cleanup*': 'deny',
  '*audit-code.mjs* requeue*': 'deny',
  '*audit-code.mjs* ingest-results*': 'deny',
  'audit-code': 'allow',
  'audit-code ensure*': 'allow',
  'audit-code next-step*': 'allow',
  'audit-code prepare-dispatch*': 'allow',
  'audit-code submit-packet*': 'allow',
  'audit-code merge-and-ingest*': 'allow',
  'audit-code validate*': 'allow',
  '*audit-code.mjs': 'allow',
  '*audit-code.mjs* ensure*': 'allow',
  '*audit-code.mjs* next-step*': 'allow',
  '*audit-code.mjs* prepare-dispatch*': 'allow',
  '*audit-code.mjs* submit-packet*': 'allow',
  '*audit-code.mjs* merge-and-ingest*': 'allow',
  '*audit-code.mjs* worker-run*': 'allow',
  '*audit-code.mjs* validate*': 'allow',
  '*node* *auditor-lambda*dist*index.js* worker-run*': 'allow',
  'git status*': 'allow',
  'git diff*': 'allow',
  'grep *': 'allow',
  'rm *': 'deny',
};

function externalDirectoryPattern(path) {
  return `${replaceBackslashes(path).replace(/\/+$/u, '')}/**`;
}

function renderOpenCodeExternalDirectoryPermission() {
  return { '*': 'allow' };
}

function renderOpenCodePermissionConfig() {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    external_directory: renderOpenCodeExternalDirectoryPermission(),
    edit: { ...OPENCODE_AUDIT_EDIT_PERMISSION },
    bash: { ...OPENCODE_AUDIT_BASH_PERMISSION },
  };
}


function renderOpenCodeProjectConfig(_root) {
  const auditPermission = renderOpenCodePermissionConfig();
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: auditPermission,
    agent: {
      auditor: {
        description:
          'Read-heavy audit orchestration agent for the /audit-code workflow.',
        permission: {
          ...auditPermission,
          'auditor_*': 'allow',
          question: 'allow',
          task: 'allow',
        },
      },
    },
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function mergeOpenCodePermissionRule(existingRule, generatedRule, managedRules = {}) {
  if (generatedRule && typeof generatedRule === 'object' && !Array.isArray(generatedRule)) {
    const generatedObject = generatedRule;
    const merged = {};
    const existingObject =
      existingRule && typeof existingRule === 'object' && !Array.isArray(existingRule)
        ? existingRule
        : {};

    if (typeof existingRule === 'string') {
      merged['*'] = existingRule;
    } else {
      merged['*'] = existingObject['*'] ?? generatedObject['*'] ?? 'ask';
    }

    for (const [key, value] of Object.entries(generatedObject)) {
      if (key !== '*') merged[key] = value;
    }
    for (const [key, value] of Object.entries(existingObject)) {
      if (key !== '*') merged[key] = value;
    }
    for (const [key, value] of Object.entries(managedRules)) {
      merged[key] = value;
    }

    return merged;
  }

  return existingRule ?? generatedRule;
}

function mergeOpenCodePermissionConfig(existingPermission, generatedPermission) {
  if (!existingPermission || typeof existingPermission !== 'object' || Array.isArray(existingPermission)) {
    return generatedPermission;
  }

  return {
    ...generatedPermission,
    ...existingPermission,
    read: generatedPermission.read,
    glob: generatedPermission.glob,
    grep: generatedPermission.grep,
    external_directory: mergeOpenCodePermissionRule(
      existingPermission.external_directory,
      generatedPermission.external_directory,
      generatedPermission.external_directory,
    ),
    edit: mergeOpenCodePermissionRule(
      existingPermission.edit,
      generatedPermission.edit,
      OPENCODE_AUDIT_EDIT_PERMISSION,
    ),
    bash: mergeOpenCodePermissionRule(
      existingPermission.bash,
      generatedPermission.bash,
      OPENCODE_AUDIT_BASH_PERMISSION,
    ),
  };
}

function removeManagedOpenCodeCommand(commandConfig) {
  const command = objectValue(commandConfig);
  const { 'audit-code': _managedAuditCodeCommand, ...remaining } = command;
  return remaining;
}

function assertOpenCodeAuditPermissionConfig(permissionConfig, label) {
  for (const tool of ['read', 'glob', 'grep']) {
    if (permissionConfig?.[tool] !== 'allow') {
      throw new Error(`OpenCode ${label}.${tool} must be allow. Run "audit-code install --host opencode".`);
    }
  }
  const externalDirectory = permissionConfig?.external_directory;
  if (!externalDirectory || typeof externalDirectory !== 'object' || Array.isArray(externalDirectory)) {
    throw new Error(`OpenCode ${label}.external_directory must set "*" to "allow". Run "audit-code install --host opencode".`);
  }
  if (externalDirectory['*'] !== 'allow') {
    throw new Error(`OpenCode ${label}.external_directory must set "*" to "allow". Run "audit-code install --host opencode".`);
  }
  const edit = permissionConfig?.edit;
  const bash = permissionConfig?.bash;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw new Error(`OpenCode ${label}.edit must allow audit-owned file paths. Run "audit-code install --host opencode".`);
  }
  for (const pattern of ['.audit-code/**', '.audit-artifacts/**', 'audit-report.md']) {
    if (edit[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.edit must allow ${pattern}. Run "audit-code install --host opencode".`);
    }
  }
  if (!bash || typeof bash !== 'object' || Array.isArray(bash)) {
    throw new Error(`OpenCode ${label}.bash must allow audit-code commands. Run "audit-code install --host opencode".`);
  }
  for (const pattern of [
    'audit-code',
    'audit-code ensure*',
    'audit-code next-step*',
    'audit-code prepare-dispatch*',
    'audit-code submit-packet*',
    'audit-code merge-and-ingest*',
    '*audit-code.mjs',
    '*audit-code.mjs* next-step*',
    '*audit-code.mjs* submit-packet*',
    '*audit-code.mjs* merge-and-ingest*',
    '*audit-code.mjs* worker-run*',
    '*node* *auditor-lambda*dist*index.js* worker-run*',
  ]) {
    if (bash[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.bash must allow ${pattern}. Run "audit-code install --host opencode".`);
    }
  }
  for (const pattern of [
    'audit-code run-to-completion*',
    'audit-code synthesize*',
    'audit-code cleanup*',
    'audit-code requeue*',
    'audit-code ingest-results*',
    '*dist*index.js* run-to-completion*',
    '*dist*index.js* synthesize*',
    '*dist*index.js* cleanup*',
    '*dist*index.js* requeue*',
    '*dist*index.js* ingest-results*',
    '*audit-code.mjs* run-to-completion*',
    '*audit-code.mjs* synthesize*',
    '*audit-code.mjs* cleanup*',
    '*audit-code.mjs* requeue*',
    '*audit-code.mjs* ingest-results*',
  ]) {
    if (bash[pattern] !== 'deny') {
      throw new Error(`OpenCode ${label}.bash must deny ${pattern}. Run "audit-code install --host opencode".`);
    }
  }
}

function buildMergedOpenCodeProjectConfig(existing, root) {
  const generated = renderOpenCodeProjectConfig(root);
  const mergedMcp = objectValue(existing.mcp);
  delete mergedMcp.auditor;
  return {
    ...existing,
    $schema: existing.$schema ?? generated.$schema,
    command: removeManagedOpenCodeCommand(existing.command),
    mcp: mergedMcp,
    permission: {
      ...mergeOpenCodePermissionConfig(existing.permission, generated.permission),
      external_directory: { '*': 'allow' },
    },
    agent: {
      ...objectValue(existing.agent),
      auditor: {
        ...objectValue(objectValue(existing.agent).auditor),
        ...generated.agent.auditor,
        permission: {
          ...mergeOpenCodePermissionConfig(
            objectValue(objectValue(existing.agent).auditor).permission,
            generated.agent.auditor.permission,
          ),
          external_directory: { '*': 'allow' },
        },
      },
    },
  };
}

function renderAntigravityPlanningGuide(root) {
  return [
    '# Antigravity planning-mode guide',
    '',
    'Recommended workflow:',
    '',
    '1. Open Antigravity in Planning mode.',
    '2. Load the repo-local prompt asset or the AGENTS instructions before starting the audit conversation.',
    '3. Ask Antigravity to use `audit-code next-step` directly.',
    '4. Review Antigravity artifacts before accepting major code changes or imported evidence.',
    '',
    'Recommended repo-local paths:',
    `- prompt asset: \`${toRepoRelativePath(root, join(root, '.audit-code', 'install', INSTALLED_PROMPT_FILENAME))}\``,
    '',
    'Artifact round-tripping policy:',
    '',
    '- Browser walkthroughs and validation artifacts should be converted into runtime validation updates before import.',
    '- Task-specific review artifacts should be normalized into `AuditResult` payloads before using `import_results`.',
    '',
  ].join('\n');
}

function renderGeminiCommandToml(promptBody) {
  const escapedBody = promptBody.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '# /audit-code \u2014 Autonomous local-loop code auditing',
    '# Registered as a Gemini/Antigravity slash command.',
    '',
    'description = "Autonomous local-loop code auditing \u2014 loads one backend-rendered audit step at a time"',
    '',
    'prompt = """',
    promptBody.trimEnd(),
    '"""',
    '',
  ].join('\n');
}

const INSTALL_PROFILE_FLAGS = [
  'writeVSCode',
  'writeCopilotInstructions',
  'writeOpenCode',
  'writeCodex',
  'writeAntigravity',
  'writeAgents',
];

const INSTALL_HOST_ORDER = [
  'codex',
  'opencode',
  'vscode',
  'antigravity',
];

const INSTALL_HOST_DEFINITIONS = {
  codex: {
    host: 'codex',
    label: 'Codex',
    support_level: 'supported',
    setup_kind: 'global-skill+instructions',
    summary:
      'Use the global Codex skill installed by npm plus AGENTS fallback instructions for this repository. Repo-local Codex skill bundles are intentionally not generated.',
    primary_path_key: 'agentsInstructionsPath',
    supporting_path_keys: [
      'installedPromptPath',
    ],
    steps: [
      'Open this repository in Codex.',
      'Use the global `/audit-code` skill installed by `npm install -g auditor-lambda`.',
      'If the global skill is unavailable, follow the AGENTS fallback instructions that point at the repo-local prompt asset.',
    ],
    profile: {
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'codex_global_surface', async () => {
        const content = await readFile(assetPaths.agentsInstructionsPath, 'utf8');
        if (!content.includes('/audit-code')) {
          throw new Error(`AGENTS instructions do not reference /audit-code: ${assetPaths.agentsInstructionsPath}`);
        }
        return {
          summary: 'Codex uses the global skill surface with AGENTS fallback instructions.',
          path: assetPaths.agentsInstructionsPath,
        };
      });
    },
  },
  opencode: {
    host: 'opencode',
    label: 'OpenCode',
    support_level: 'supported',
    setup_kind: 'global-command+project-permissions',
    summary:
      'Use the global OpenCode `/audit-code` command installed by npm plus generated project permissions.',
    primary_path_key: 'opencodeConfigPath',
    supporting_path_keys: [
      'agentsInstructionsPath',
    ],
    steps: [
      'Open this repository in OpenCode.',
      'Use the global `/audit-code` command installed by `npm install -g auditor-lambda`.',
      'Let OpenCode load the generated `opencode.json` for project permissions; the global command drives `audit-code next-step` directly.',
    ],
    profile: {
      writeOpenCode: true,
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'opencode_config', async () => {
        const config = await readJson(assetPaths.opencodeConfigPath, 'OpenCode project config');
        if (config?.command?.['audit-code']) {
          throw new Error('OpenCode project config must not define command["audit-code"]; the slash command is global npm-installed state. Run "audit-code install --host opencode" to remove the stale local command.');
        }
        if (config?.mcp?.auditor) {
          throw new Error('OpenCode project config must not define mcp.auditor; the MCP server is supplied by the global npm-installed config. Run "audit-code install --host opencode" to remove the stale project-level MCP entry.');
        }
        assertOpenCodeAuditPermissionConfig(config?.permission, 'permission');
        assertOpenCodeAuditPermissionConfig(config?.agent?.auditor?.permission, 'agent.auditor.permission');
        return {
          summary: 'OpenCode project config has audit permissions; /audit-code is supplied by the global npm-installed config.',
          path: assetPaths.opencodeConfigPath,
        };
      });
    },
  },
  vscode: {
    host: 'vscode',
    label: 'VS Code',
    support_level: 'supported',
    setup_kind: 'prompt+agent',
    summary:
      'Use the generated prompt file and custom agent for next-step-first VS Code integration.',
    primary_path_key: 'vscodePromptPath',
    supporting_path_keys: [
      'vscodeAgentPath',
      'copilotInstructionsPath',
    ],
    steps: [
      'Open this repository in VS Code with Copilot.',
      'Invoke `/audit-code` from the generated prompt or chat so the workflow calls `audit-code next-step` directly.',
    ],
    profile: {
      writeVSCode: true,
      writeCopilotInstructions: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'vscode_prompt', async () => {
        const content = await readFile(assetPaths.vscodePromptPath, 'utf8');
        if (!content.includes('name: audit-code')) {
          throw new Error(`VS Code prompt file is missing the expected frontmatter name: ${assetPaths.vscodePromptPath}`);
        }
        const { body: promptBody } = splitFrontmatter(content);
        const { body: sourceBody } = splitFrontmatter(await readFile(promptAssetPath, 'utf8'));
        if (promptBody !== sourceBody.trimStart()) {
          throw new Error(
            `VS Code prompt body is out of sync with the source prompt. Run "audit-code install --host vscode" or "audit-code install".`,
          );
        }
        return {
          summary: 'VS Code prompt file is present and uses the source prompt body.',
          path: assetPaths.vscodePromptPath,
        };
      });
    },
  },
  antigravity: {
    host: 'antigravity',
    label: 'Antigravity',
    support_level: 'supported',
    setup_kind: 'agent-skill+gemini-command+planning-guide',
    summary:
      'Uses the project-scoped .agent/skills/audit-code/SKILL.md skill, the .gemini/commands/audit-code.toml slash command, the planning guide, and AGENTS instructions.',
    primary_path_key: 'antigravitySkillPath',
    supporting_path_keys: [
      'geminiCommandPath',
      'antigravityPlanningGuidePath',
      'agentsInstructionsPath',
      'installedPromptPath',
    ],
    steps: [
      'Open this repository in Antigravity.',
      'The audit-code skill is automatically discovered from .agent/skills/audit-code/SKILL.md.',
      'The /audit-code slash command is also available from .gemini/commands/audit-code.toml.',
      'Use `audit-code next-step` directly.',
    ],
    profile: {
      writeAntigravity: true,
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'antigravity_skill', async () => {
        const content = await readFile(assetPaths.antigravitySkillPath, 'utf8');
        if (!content.includes('name: audit-code')) {
          throw new Error('Antigravity skill SKILL.md must contain "name: audit-code" in frontmatter.');
        }
        return {
          summary: 'Antigravity .agent/skills/audit-code/SKILL.md is present and valid.',
          path: assetPaths.antigravitySkillPath,
        };
      });
      await collect(checks, 'antigravity_guide', async () => {
        const content = await readFile(assetPaths.antigravityPlanningGuidePath, 'utf8');
        if (!content.includes(INSTALLED_PROMPT_FILENAME)) {
          throw new Error(`Antigravity guide must reference ${INSTALLED_PROMPT_FILENAME}.`);
        }
        return {
          summary: 'Antigravity planning guide references the repo-local prompt asset.',
          path: assetPaths.antigravityPlanningGuidePath,
        };
      });
    },
  },
};

function supportedInstallHostsMessage() {
  return ['all', 'copilot', ...INSTALL_HOST_ORDER].join(', ');
}

function getInstallHostKeys(host) {
  if (host === 'all') {
    return INSTALL_HOST_ORDER;
  }

  if (host === 'copilot') {
    return ['vscode'];
  }

  if (INSTALL_HOST_DEFINITIONS[host]) {
    return [host];
  }

  throw new Error(
    `Unsupported host "${host}". Supported hosts: ${supportedInstallHostsMessage()}.`,
  );
}

function getInstallProfile(host) {
  const profile = Object.fromEntries(
    INSTALL_PROFILE_FLAGS.map((flag) => [flag, false]),
  );

  for (const hostKey of getInstallHostKeys(host)) {
    const hostProfile = INSTALL_HOST_DEFINITIONS[hostKey].profile;
    for (const flag of INSTALL_PROFILE_FLAGS) {
      profile[flag] = profile[flag] || Boolean(hostProfile[flag]);
    }
  }

  return profile;
}

export {
  INSTALL_HOST_ORDER as _INSTALL_HOST_ORDER,
  INSTALL_HOST_DEFINITIONS as _INSTALL_HOST_DEFINITIONS,
  getInstallHostKeys as _getInstallHostKeys,
  getInstallProfile as _getInstallProfile,
};

function buildHostCatalog({ root, host, assets }) {
  return getInstallHostKeys(host)
    .map((hostKey) => {
      const definition = INSTALL_HOST_DEFINITIONS[hostKey];
      const primaryPath = assets[definition.primary_path_key];
      if (!primaryPath) {
        return null;
      }

      return {
        host: definition.host,
        label: definition.label,
        support_level: definition.support_level,
        setup_kind: definition.setup_kind,
        summary: definition.summary,
        primary_path: primaryPath,
        supporting_paths: definition.supporting_path_keys
          .map((key) => assets[key])
          .filter(Boolean),
        steps: definition.steps,
      };
    })
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      primary_path: entry.primary_path,
      supporting_paths: entry.supporting_paths,
      repo_relative_primary_path: toRepoRelativePath(root, entry.primary_path),
      repo_relative_supporting_paths: entry.supporting_paths.map((path) => toRepoRelativePath(root, path)),
    }));
}

function renderInstallGuide({
  root,
  host,
  installedPromptPath,
  installedSkillPath,
  installManifestPath,
  hostGuidance,
}) {
  const lines = [
    '# audit-code bootstrap guide',
    '',
    'The canonical product route is `/audit-code` in conversation.',
    '',
    'Shared repo-local assets:',
    `- prompt asset: \`${toRepoRelativePath(root, installedPromptPath)}\``,
    `- skill asset: \`${toRepoRelativePath(root, installedSkillPath)}\``,
    `- host manifest: \`${toRepoRelativePath(root, installManifestPath)}\``,
    '',
    'Host-specific quick starts:',
  ];

  for (const guide of hostGuidance) {
    lines.push(`- ${guide.label}: ${guide.summary}`);
  }

  for (const guide of hostGuidance) {
    lines.push('', `## ${guide.label}`, '');
    lines.push(`Support level: ${guide.support_level}`);
    lines.push(`Setup kind: ${guide.setup_kind}`);
    lines.push('');
    lines.push(guide.summary);
    lines.push('');
    lines.push('Primary repo-local path:');
    lines.push(`- \`${toRepoRelativePath(root, guide.primary_path)}\``);
    if (guide.supporting_paths.length > 0) {
      lines.push('', 'Supporting repo-local paths:');
      for (const path of guide.supporting_paths) {
        lines.push(`- \`${toRepoRelativePath(root, path)}\``);
      }
    }
    lines.push('', 'Recommended steps:');
    for (const step of guide.steps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push('', 'Backend fallback:');
  lines.push('- from the repository root, run `audit-code` only when you intentionally need the repo-local backend wrapper');
  lines.push('- run `audit-code verify-install` after bootstrap when you want to smoke-test the generated launchers and host configs');
  lines.push('- rerun `audit-code install` to refresh every generated host surface from the shared prompt and skill assets together');

  if (host !== 'all') {
    lines.push('');
    lines.push(`This install was scoped to \`${host}\`, so assets for other hosts may be intentionally omitted.`);
  }

  lines.push('');
  return lines.join('\n');
}

async function assertDirectoryExists(path, description) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${description} does not exist: ${path}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${description} is not a directory: ${path}`);
  }
}

async function collectVerifyCheck(target, id, fn) {
  try {
    const details = await fn();
    target.push({
      id,
      status: 'ok',
      ...(details ?? {}),
    });
  } catch (error) {
    target.push({
      id,
      status: 'error',
      summary: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ensureFile(path, description) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${description} does not exist: ${path}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${description} is not a file: ${path}`);
  }

  return stats;
}

async function readJson(path, description) {
  const content = await readFile(path, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function verifyZipFile(path, description) {
  const content = await readFile(path);
  if (content.length < 4 || content[0] !== 0x50 || content[1] !== 0x4b) {
    throw new Error(`${description} is not a valid ZIP-like archive: ${path}`);
  }
  return content.length;
}

async function verifyInstalledBootstrap(argv) {
  const root = resolve(getFlag(argv, '--root') ?? '.');
  const requestedHost = getFlag(argv, '--host')?.toLowerCase() ?? null;
  const installManifestPath = join(
    root,
    '.audit-code',
    'install',
    INSTALL_MANIFEST_FILENAME,
  );
  const installGuidePath = join(
    root,
    '.audit-code',
    'install',
    INSTALL_GUIDE_FILENAME,
  );

  await assertDirectoryExists(root, 'Target repository root');

  const generalChecks = [];
  const hostResults = [];
  let installManifest;

  await collectVerifyCheck(generalChecks, 'install_manifest', async () => {
    await ensureFile(installManifestPath, 'Install manifest');
    installManifest = await readJson(installManifestPath, 'Install manifest');
    if (installManifest?.contract_version !== 'audit-code-install/v1alpha1') {
      throw new Error(
        `Unexpected install manifest contract version: ${installManifest?.contract_version ?? 'missing'}.`,
      );
    }
    return {
      summary: 'Install manifest parsed successfully.',
      path: installManifestPath,
    };
  });

  if (!installManifest) {
    console.log(
      JSON.stringify(
        {
          root,
          requested_host: requestedHost ?? 'all',
          status: 'error',
          issue_count: generalChecks.filter((check) => check.status === 'error').length,
          checks: generalChecks,
          hosts: [],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const assetPaths = installManifest.asset_paths ?? {};
  const hostCatalog = new Map(
    (installManifest.hosts ?? []).map((entry) => [entry.host, entry]),
  );
  const selectedHosts = requestedHost && requestedHost !== 'all'
    ? getInstallHostKeys(requestedHost)
    : [...hostCatalog.keys()];

  await collectVerifyCheck(generalChecks, 'install_guide', async () => {
    const guide = await readFile(installGuidePath, 'utf8');
    if (!guide.includes('# audit-code bootstrap guide')) {
      throw new Error(`Install guide does not look like an audit-code bootstrap guide: ${installGuidePath}`);
    }
    return {
      summary: 'Install guide is present and readable.',
      path: installGuidePath,
    };
  });

  await collectVerifyCheck(generalChecks, 'installed_prompt', async () => {
    await ensureFile(assetPaths.installedPromptPath, 'Installed prompt asset');
    const installedPrompt = await readFile(assetPaths.installedPromptPath, 'utf8');
    const sourcePrompt = await readFile(promptAssetPath, 'utf8');
    if (installedPrompt !== sourcePrompt) {
      throw new Error(
        `Installed prompt is out of sync with the source prompt. Run "audit-code install" from ${root}.`,
      );
    }
    return {
      summary: 'Installed prompt asset is present and matches the source prompt.',
      path: assetPaths.installedPromptPath,
    };
  });

  await collectVerifyCheck(generalChecks, 'installed_skill', async () => {
    await ensureFile(assetPaths.installedSkillPath, 'Installed skill asset');
    const installedSkill = (await readFile(assetPaths.installedSkillPath, 'utf8')).replace(/\r\n/g, '\n');
    const sourceSkill = (await readFile(skillAssetPath, 'utf8')).replace(/\r\n/g, '\n');
    if (installedSkill !== sourceSkill) {
      throw new Error(
        `Installed skill is out of sync with the source skill. Run "audit-code install" from ${root}.`,
      );
    }
    return {
      summary: 'Installed skill asset is present and matches the source skill.',
      path: assetPaths.installedSkillPath,
    };
  });

  await collectVerifyCheck(generalChecks, 'legacy_local_surfaces', async () => {
    const legacySurfaces = await findLegacyAuditCodeSurfaceFiles(root);
    if (legacySurfaces.length > 0) {
      throw new Error(
        `Legacy local /audit-code surfaces are still present: ${legacySurfaces.join(', ')}. Run "audit-code install" from ${root}.`,
      );
    }
    return {
      summary: 'No legacy local /audit-code command or skill surfaces were found.',
    };
  });

  for (const hostKey of selectedHosts) {
    const checks = [];
    const hostEntry = hostCatalog.get(hostKey);

    if (!hostEntry) {
      checks.push({
        id: 'host_manifest_entry',
        status: 'error',
        summary: `Install manifest does not contain host guidance for "${hostKey}".`,
      });
      hostResults.push({ host: hostKey, status: 'error', checks });
      continue;
    }

    await collectVerifyCheck(checks, 'host_manifest_entry', async () => ({
      summary: `Host guidance exists for ${hostEntry.label}.`,
      primary_path: hostEntry.primary_path,
    }));

    const hostDefinition = INSTALL_HOST_DEFINITIONS[hostKey];
    if (hostDefinition?.verify) {
      await hostDefinition.verify({ checks, root, assetPaths, collectVerifyCheck });
    } else {
      checks.push({
        id: 'host_handler',
        status: 'error',
        summary: `No verification handler is implemented for host "${hostKey}".`,
      });
    }

    hostResults.push({
      host: hostKey,
      status: checks.some((check) => check.status === 'error') ? 'error' : 'ok',
      checks,
    });
  }

  const issueCount =
    generalChecks.filter((check) => check.status === 'error').length +
    hostResults.reduce(
      (sum, host) => sum + host.checks.filter((check) => check.status === 'error').length,
      0,
    );

  console.log(
    JSON.stringify(
      {
        root,
        requested_host: requestedHost ?? 'all',
        manifest_path: installManifestPath,
        status: issueCount > 0 ? 'error' : 'ok',
        issue_count: issueCount,
        checks: generalChecks,
        hosts: hostResults,
      },
      null,
      2,
    ),
  );

  process.exitCode = issueCount > 0 ? 1 : 0;
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function detectBootstrapRefreshReason(root, host) {
  const installManifestPath = join(
    root,
    '.audit-code',
    'install',
    INSTALL_MANIFEST_FILENAME,
  );

  if (!(await fileExists(installManifestPath))) {
    return 'missing_install_manifest';
  }

  let installManifest;
  try {
    installManifest = JSON.parse(await readFile(installManifestPath, 'utf8'));
  } catch {
    return 'invalid_install_manifest';
  }

  if (installManifest?.contract_version !== 'audit-code-install/v1alpha1') {
    return 'stale_install_manifest_contract';
  }

  const assetPaths = installManifest.asset_paths ?? {};
  const hostCatalog = new Set(
    (installManifest.hosts ?? []).map((entry) => entry.host),
  );

  if (hostCatalog.has('codex') && (assetPaths.codexSkillPath || assetPaths.codexPromptPath)) {
    return 'legacy_local_audit_code_surface';
  }

  if ((await findLegacyAuditCodeSurfaceFiles(root)).length > 0) {
    return 'legacy_local_audit_code_surface';
  }

  for (const hostKey of getInstallHostKeys(host)) {
    if (!hostCatalog.has(hostKey)) {
      return `missing_host_surface:${hostKey}`;
    }

    const definition = INSTALL_HOST_DEFINITIONS[hostKey];
    const requiredPathKeys = [
      definition.primary_path_key,
      ...definition.supporting_path_keys,
    ];
    for (const pathKey of requiredPathKeys) {
      const targetPath = assetPaths[pathKey];
      if (targetPath && !(await fileExists(targetPath))) {
        return `missing_host_asset:${hostKey}:${pathKey}`;
      }
    }
  }

  const installedPrompt = await readTextIfExists(assetPaths.installedPromptPath);
  if (installedPrompt === null) {
    return 'missing_installed_prompt';
  }
  const sourcePrompt = await readFile(promptAssetPath, 'utf8');
  if (installedPrompt !== sourcePrompt) {
    return 'stale_installed_prompt';
  }
  const { body: sourcePromptBody } = splitFrontmatter(sourcePrompt);

  const installedSkill = await readTextIfExists(assetPaths.installedSkillPath);
  if (installedSkill === null) {
    return 'missing_installed_skill';
  }
  const sourceSkill = (await readFile(skillAssetPath, 'utf8')).replace(/\r\n/g, '\n');
  if (installedSkill.replace(/\r\n/g, '\n') !== sourceSkill) {
    return 'stale_installed_skill';
  }

  for (const hostKey of getInstallHostKeys(host)) {
    switch (hostKey) {
      case 'codex': {
        break;
      }
      case 'opencode': {
        const opencodeConfig = await readJson(assetPaths.opencodeConfigPath, 'OpenCode config').catch(() => null);
        if (opencodeConfig?.command?.['audit-code']) {
          return 'stale_host_asset:opencode:local_command';
        }
        if (opencodeConfig?.mcp?.auditor) {
          return 'stale_host_asset:opencode:project_mcp';
        }
        try {
          assertOpenCodeAuditPermissionConfig(opencodeConfig?.permission, 'permission');
          assertOpenCodeAuditPermissionConfig(opencodeConfig?.agent?.auditor?.permission, 'agent.auditor.permission');
        } catch {
          return 'stale_host_asset:opencode:permissions';
        }
        if (await fileExists(join(root, '.opencode', 'commands', 'audit-code.md'))) {
          return 'stale_host_asset:opencode:legacy_command_file';
        }
        break;
      }
      case 'vscode': {
        const vscodePrompt = await readTextIfExists(assetPaths.vscodePromptPath);
        if (vscodePrompt === null) {
          return 'missing_host_asset:vscode:prompt';
        }
        if (splitFrontmatter(vscodePrompt).body !== sourcePromptBody.trimStart()) {
          return 'stale_host_asset:vscode:prompt';
        }
        break;
      }
      case 'antigravity': {
        const expectedSkillPath = join(root, '.agent', 'skills', 'audit-code', 'SKILL.md');
        if (!(await fileExists(expectedSkillPath))) {
          return 'missing_host_asset:antigravity:skill';
        }
        const antigravitySkill = await readTextIfExists(expectedSkillPath);
        if (antigravitySkill !== null && antigravitySkill.replace(/\r\n/g, '\n') !== sourceSkill) {
          return 'stale_host_asset:antigravity:skill';
        }
        break;
      }
      default:
        break;
    }
  }

  return null;
}

async function ensureBootstrap(argv) {
  const host = (getFlag(argv, '--host') ?? DEFAULT_INSTALL_HOST).toLowerCase();
  const root = resolve(getFlag(argv, '--root') ?? '.');
  const quiet = hasFlag(argv, '--quiet');
  const force = hasFlag(argv, '--force');
  await assertDirectoryExists(root, 'Target repository root');

  const reason = force
    ? 'forced'
    : await detectBootstrapRefreshReason(root, host);

  if (reason) {
    const installed = await installBootstrap(argv, { quiet: true });
    const payload = {
      status: 'ok',
      action: 'installed',
      reason,
      host: installed.host,
      repo_root: installed.repo_root,
      install_manifest_path: installed.install_manifest_path,
      host_count: installed.host_guidance.length,
      file_count: installed.files.length,
    };
    if (!quiet) {
      console.log(JSON.stringify(payload, null, 2));
    }
    return payload;
  }

  const payload = {
    status: 'ok',
    action: 'skipped',
    reason: null,
    host,
    repo_root: root,
    install_manifest_path: join(
      root,
      '.audit-code',
      'install',
      INSTALL_MANIFEST_FILENAME,
    ),
  };
  if (!quiet) {
    console.log(JSON.stringify(payload, null, 2));
  }
  return payload;
}

// Compute the full asset-path map for an install profile. Each per-host path is
// gated on its profile flag (null when the host is not part of this profile).
function buildInstallAssetPaths(root, profile) {
  const installedPromptPath = join(root, '.audit-code', 'install', INSTALLED_PROMPT_FILENAME);
  const installedSkillPath = join(root, '.audit-code', 'install', 'SKILL.md');
  const installGuidePath = join(root, '.audit-code', 'install', INSTALL_GUIDE_FILENAME);
  const installManifestPath = join(root, '.audit-code', 'install', INSTALL_MANIFEST_FILENAME);
  return {
    installedPromptPath,
    installedSkillPath,
    installGuidePath,
    installManifestPath,
    agentsInstructionsPath: profile.writeAgents ? join(root, 'AGENTS.md') : null,
    copilotInstructionsPath: profile.writeCopilotInstructions
      ? join(root, '.github', 'copilot-instructions.md')
      : null,
    codexSkillPath: profile.writeCodex
      ? join(root, '.codex', 'skills', 'audit-code', 'SKILL.md')
      : null,
    codexPromptPath: profile.writeCodex
      ? join(root, '.codex', 'skills', 'audit-code', 'audit-code.prompt.md')
      : null,
    codexAutomationRecipePath: profile.writeCodex
      ? join(root, '.audit-code', 'install', 'codex', 'RE-AUDIT-AUTOMATION.md')
      : null,
    opencodeConfigPath: profile.writeOpenCode
      ? join(root, 'opencode.json')
      : null,
    vscodePromptPath: profile.writeVSCode
      ? join(root, '.github', 'prompts', 'audit-code.prompt.md')
      : null,
    vscodeAgentPath: profile.writeVSCode
      ? join(root, '.github', 'agents', 'auditor.agent.md')
      : null,
    antigravityPlanningGuidePath: profile.writeAntigravity
      ? join(root, '.audit-code', 'install', 'antigravity', 'PLANNING-MODE.md')
      : null,
    geminiCommandPath: profile.writeAntigravity
      ? join(root, '.gemini', 'commands', 'audit-code.toml')
      : null,
    antigravitySkillPath: profile.writeAntigravity
      ? join(root, '.agent', 'skills', 'audit-code', 'SKILL.md')
      : null,
  };
}

// Always-written core assets (installed prompt + skill,
// AGENTS/copilot compatibility directive blocks) plus legacy-surface cleanup.
async function writeCoreInstallAssets(root, assetPaths, promptSource, skillSource) {
  const results = [];
  const legacyInstalledPromptPath = join(root, '.audit-code', 'install', 'audit-code.prompt.md');
  if (await fileExists(legacyInstalledPromptPath)) {
    await unlink(legacyInstalledPromptPath).catch(() => {});
  }
  results.push(await writeGeneratedMarkdown(assetPaths.installedPromptPath, promptSource));
  results.push(await writeGeneratedMarkdown(assetPaths.installedSkillPath, skillSource));

  const compatibilityBlockTargets = [
    assetPaths.agentsInstructionsPath,
    assetPaths.copilotInstructionsPath,
  ].filter(Boolean);
  for (const targetPath of compatibilityBlockTargets) {
    results.push(
      await writeManagedMarkdown(
        targetPath,
        buildInstallDirective(
          relative(dirname(targetPath), assetPaths.installedPromptPath) || `./.audit-code/install/${INSTALLED_PROMPT_FILENAME}`,
        ),
      ),
    );
  }

  results.push(...await removeLegacyAuditCodeSurfaceFiles(root));
  return results;
}

async function writeCodexAssets(assetPaths, promptSource, skillSource) {
  return [
    await writeGeneratedMarkdown(assetPaths.codexSkillPath, skillSource),
    await writeGeneratedMarkdown(assetPaths.codexPromptPath, promptSource),
    await writeGeneratedMarkdown(assetPaths.codexAutomationRecipePath, renderCodexAutomationRecipe()),
  ];
}

async function writeOpenCodeAssets(assetPaths, root) {
  return [
    await writeMergedGeneratedJson(
      assetPaths.opencodeConfigPath,
      'OpenCode project config',
      (existing) => buildMergedOpenCodeProjectConfig(existing, root),
    ),
  ];
}

async function writeVSCodeAssets(assetPaths, promptBody) {
  return [
    await writeGeneratedMarkdown(
      assetPaths.vscodePromptPath,
      renderPromptFile(
        {
          name: 'audit-code',
          description: 'Autonomous local loop code auditing',
          agent: 'auditor',
        },
        promptBody,
      ),
    ),
    await writeGeneratedMarkdown(assetPaths.vscodeAgentPath, renderVSCodeAgentFile()),
  ];
}

async function writeAntigravityAssets(assetPaths, promptBody, skillSource, root) {
  return [
    await writeGeneratedMarkdown(
      assetPaths.antigravityPlanningGuidePath,
      renderAntigravityPlanningGuide(root),
    ),
    await writeGeneratedMarkdown(assetPaths.geminiCommandPath, renderGeminiCommandToml(promptBody)),
    await writeGeneratedMarkdown(assetPaths.antigravitySkillPath, skillSource),
  ];
}

async function installBootstrap(argv, options = {}) {
  const host = (getFlag(argv, '--host') ?? DEFAULT_INSTALL_HOST).toLowerCase();
  const root = resolve(getFlag(argv, '--root') ?? '.');
  await assertDirectoryExists(root, 'Target repository root');
  const profile = getInstallProfile(host);
  const promptSource = await readFile(promptAssetPath, 'utf8');
  const skillSource = (await readFile(skillAssetPath, 'utf8')).replace(/\r\n/g, '\n');
  const { body: promptBody } = splitFrontmatter(promptSource);
  const assetPaths = buildInstallAssetPaths(root, profile);
  const {
    installedPromptPath,
    installedSkillPath,
    installGuidePath,
    installManifestPath,
  } = assetPaths;

  const results = [];
  results.push(...await writeCoreInstallAssets(root, assetPaths, promptSource, skillSource));

  if (profile.writeCodex) {
    results.push(...await writeCodexAssets(assetPaths, promptSource, skillSource));
  }
  if (profile.writeOpenCode) {
    results.push(...await writeOpenCodeAssets(assetPaths, root));
  }
  if (profile.writeVSCode) {
    results.push(...await writeVSCodeAssets(assetPaths, promptBody));
  }
  if (profile.writeAntigravity) {
    results.push(...await writeAntigravityAssets(assetPaths, promptBody, skillSource, root));
  }

  const hostGuidance = buildHostCatalog({
    root,
    host,
    assets: assetPaths,
  });

  const installManifest = {
    contract_version: 'audit-code-install/v1alpha1',
    host,
    repo_root: root,
    installed_prompt_path: installedPromptPath,
    installed_skill_path: installedSkillPath,
    install_guide_path: installGuidePath,
    install_manifest_path: installManifestPath,
    source_prompt_path: resolve(promptAssetPath),
    source_skill_path: resolve(skillAssetPath),
    asset_paths: assetPaths,
    hosts: hostGuidance,
  };

  results.push(
    await writeGeneratedMarkdown(
      installGuidePath,
      renderInstallGuide({
        root,
        host,
        installedPromptPath,
        installedSkillPath,
        installManifestPath,
        hostGuidance,
      }),
    ),
  );
  results.push(await writeGeneratedJson(installManifestPath, installManifest));

  const sessionConfigPath = join(root, '.audit-artifacts', 'session-config.json');
  if (!(await fileExists(sessionConfigPath))) {
    const defaultConfig = { provider: 'local-subprocess' };
    await mkdir(dirname(sessionConfigPath), { recursive: true });
    await writeFile(sessionConfigPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
    results.push({ path: sessionConfigPath, mode: 'created' });
  }

  const payload = {
    host,
    repo_root: root,
    installed_prompt_path: installedPromptPath,
    installed_skill_path: installedSkillPath,
    install_guide_path: installGuidePath,
    install_manifest_path: installManifestPath,
    source_prompt_path: resolve(promptAssetPath),
    source_skill_path: resolve(skillAssetPath),
    files: results,
    slash_command_surfaces: {
      vscode_prompt: assetPaths.vscodePromptPath,
      opencode_config: assetPaths.opencodeConfigPath,
      gemini_command: assetPaths.geminiCommandPath,
      antigravity_skill: assetPaths.antigravitySkillPath,
    },
    instruction_surfaces: {
      agents: assetPaths.agentsInstructionsPath,
      copilot_instructions: assetPaths.copilotInstructionsPath,
    },
    host_guidance: hostGuidance,
    unsupported_hosts: [],
    next_steps: [
      'Open the repository in your preferred host and follow the matching host_guidance entry.',
      `Open ${installGuidePath} for repo-local quick-start steps for Codex, OpenCode, VS Code, and Antigravity.`,
      'Run `audit-code verify-install` from the repository root to smoke-test the generated host configs.',
    ],
  };

  if (!options.quiet) {
    console.log(JSON.stringify(payload, null, 2));
  }

  return payload;
}

async function installHostPrompt(argv) {
  const host = requireFlagValue(argv, '--host').toLowerCase();

  if (host !== 'copilot') {
    throw new Error(
      `install-host currently supports only "copilot". Use "install --host ${host}" for the broader bootstrap flow.`,
    );
  }

  await installBootstrap(argv);
}

async function runDistCommand(commandName, argv, { ensureArtifactsDir = false } = {}) {
  const commandArgs = [...argv];
  const rootValue = resolve(getFlag(commandArgs, '--root') ?? '.');
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-artifacts'));

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
  const artifactsDir = resolve(getFlag(commandArgs, '--artifacts-dir') ?? join(rootValue, '.audit-artifacts'));

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
  ensureArtifactsDir = true,
  preferredEntrypoint,
  defaultSingleStep = false
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

  const wrapperArgs = [...argv];
  if (defaultSingleStep && !hasFlag(wrapperArgs, '--single-step')) {
    wrapperArgs.push('--single-step');
  }
  const rootValue = resolve(getFlag(wrapperArgs, '--root') ?? '.');
  const artifactsDir = resolve(getFlag(wrapperArgs, '--artifacts-dir') ?? join(rootValue, '.audit-artifacts'));

  setDefaultFlag(wrapperArgs, '--root', rootValue);
  setDefaultFlag(wrapperArgs, '--artifacts-dir', artifactsDir);

  if (ensureArtifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
  }

  await ensureBuilt();
  const command = hasFlag(wrapperArgs, '--single-step') ? 'advance-audit' : 'run-to-completion';
  await run(nodeExecutable(), [distEntry, command, ...wrapperArgs]);
}
