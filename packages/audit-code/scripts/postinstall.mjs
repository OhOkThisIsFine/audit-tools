#!/usr/bin/env node
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
const promptSourceFile = join(pkgRoot, 'skills', 'audit-code', 'audit-code.prompt.md');
const skillSourceFile = join(pkgRoot, 'skills', 'audit-code', 'SKILL.md');
const codexOpenAiAgentSourceFile = join(pkgRoot, 'skills', 'audit-code', 'agents', 'openai.yaml');

function readRequiredSource(path, label) {
  if (!existsSync(path)) {
    console.warn(`audit-code: ${label} source not found at ${path} - skipping global command install`);
    process.exitCode = 0;
    return null;
  }

  return readFileSync(path);
}

function readOptionalSource(path, label) {
  if (!existsSync(path)) {
    console.warn(`audit-code: ${label} source not found at ${path} - skipping optional install`);
    return null;
  }

  return readFileSync(path);
}

function writeGeneratedFile(path, content) {
  const action = existsSync(path) ? 'updated' : 'installed';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return action;
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
  'node* .audit-code/install/run-mcp-server.mjs*': 'allow',
  'node* ./.audit-code/install/run-mcp-server.mjs*': 'allow',
  'git status*': 'allow',
  'git diff*': 'allow',
  'grep *': 'allow',
  'rm *': 'deny',
};

function replaceBackslashes(value) {
  return value.replace(/\\/g, '/');
}

function renderOpenCodeExternalDirectoryPermission() {
  return { '*': 'allow' };
}

function renderGlobalMcpLauncher(installedPkgRoot) {
  return [
    "import { access, readFile, appendFile } from 'node:fs/promises';",
    "import { constants } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { join } from 'node:path';",
    "import { homedir } from 'node:os';",
    '',
    "const repoRoot = process.env.AUDIT_CODE_REPO_ROOT || process.cwd();",
    "const artifactsDir = process.env.AUDIT_CODE_ARTIFACTS_DIR || join(repoRoot, '.audit-artifacts');",
    `const globalPackageRoot = ${JSON.stringify(installedPkgRoot)};`,
    "const logPath = join(homedir(), '.audit-code', 'mcp-server.log');",
    '',
    'async function log(msg) {',
    '  try {',
    '    const ts = new Date().toISOString();',
    "    await appendFile(logPath, `${ts} ${msg}\\n`, 'utf8');",
    '  } catch {',
    '    // ignore log failures',
    '  }',
    '}',
    '',
    'async function exists(path) {',
    '  try {',
    '    await access(path, constants.F_OK);',
    '    return true;',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function spawnForward(command, args) {',
    '  return new Promise((resolvePromise, rejectPromise) => {',
    '    const child = spawn(command, args, {',
    '      cwd: repoRoot,',
    '      env: process.env,',
    "      stdio: ['inherit', 'inherit', 'inherit'],",
    '    });',
    "    child.on('error', rejectPromise);",
    "    child.on('exit', (code) => resolvePromise(code ?? 1));",
    '  });',
    '}',
    '',
    'async function tryCandidates() {',
    "  const localPackageEntrypoint = join(repoRoot, 'node_modules', 'auditor-lambda', 'audit-code.mjs');",
    "  const localBin = process.platform === 'win32'",
    "    ? join(repoRoot, 'node_modules', '.bin', 'audit-code.cmd')",
    "    : join(repoRoot, 'node_modules', '.bin', 'audit-code');",
    "  const repoPackageJsonPath = join(repoRoot, 'package.json');",
    "  const globalPackageEntrypoint = globalPackageRoot ? join(globalPackageRoot, 'audit-code.mjs') : null;",
    "  const sharedArgs = ['mcp', '--root', repoRoot, '--artifacts-dir', artifactsDir];",
    '',
    '  if (await exists(localPackageEntrypoint)) {',
    "    await log(`launching local node_modules candidate: ${localPackageEntrypoint}`);",
    '    return await spawnForward(process.execPath, [localPackageEntrypoint, ...sharedArgs]);',
    '  }',
    '',
    "  if (await exists(repoPackageJsonPath) && await exists(join(repoRoot, 'audit-code.mjs'))) {",
    '    try {',
    "      const packageJson = JSON.parse(await readFile(repoPackageJsonPath, 'utf8'));",
    "      if (packageJson?.name === 'auditor-lambda') {",
    "        await log(`launching repo-root candidate: ${join(repoRoot, 'audit-code.mjs')}`);",
    "        return await spawnForward(process.execPath, [join(repoRoot, 'audit-code.mjs'), ...sharedArgs]);",
    '      }',
    '    } catch {',
    '      // fall through to the next candidate',
    '    }',
    '  }',
    '',
    '  if (globalPackageEntrypoint && await exists(globalPackageEntrypoint)) {',
    "    await log(`launching global candidate: ${globalPackageEntrypoint}`);",
    '    return await spawnForward(process.execPath, [globalPackageEntrypoint, ...sharedArgs]);',
    '  }',
    '',
    '  if (await exists(localBin)) {',
    "    await log(`launching local bin candidate: ${localBin}`);",
    '    return await spawnForward(localBin, sharedArgs);',
    '  }',
    '',
    "  const pathCandidate = process.platform === 'win32' ? 'audit-code.cmd' : 'audit-code';",
    "  await log(`trying PATH candidate: ${pathCandidate}`);",
    '  let exitCode = await spawnForward(pathCandidate, sharedArgs).catch(() => null);',
    "  if (typeof exitCode === 'number') {",
    '    return exitCode;',
    '  }',
    '',
    "  exitCode = await spawnForward('npx', ['--no-install', 'audit-code', ...sharedArgs]).catch(() => null);",
    "  if (typeof exitCode === 'number') {",
    '    return exitCode;',
    '  }',
    '',
    "  await log('ERROR: no candidate found');",
    '  throw new Error(',
    "    'Unable to locate an audit-code executable. Install auditor-lambda globally or as a local dependency.',",
    '  );',
    '}',
    '',
    "log(`run-mcp-server.mjs started: node=${process.execPath} cwd=${repoRoot} globalPkg=${globalPackageRoot}`).catch(() => {});",
    'const code = await tryCandidates().catch(async (err) => {',
    "  await log(`FATAL: ${err.message}`);",
    '  process.stderr.write(err.message + "\\n");',
    '  return 1;',
    '});',
    'process.exitCode = code;',
    '',
  ].join('\n');
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

const opencodeCommandTemplateFile = join(pkgRoot, 'skills', 'audit-code', 'opencode-command-template.txt');
const OPENCODE_MCP_COMMAND_TEMPLATE = readFileSync(opencodeCommandTemplateFile, 'utf8').replace(/\r\n/g, '\n').trim();

function mergeOpenCodeGlobalConfig(existing) {
  const parsed = existing ? JSON.parse(existing) : {};
  const auditPermission = renderOpenCodePermissionConfig();
  const existingAuditor = objectValue(objectValue(parsed.agent).auditor);
  const pkgEntrypoint = replaceBackslashes(join(pkgRoot, 'audit-code.mjs'));
  return {
    ...parsed,
    command: {
      ...(parsed.command && typeof parsed.command === 'object' && !Array.isArray(parsed.command)
        ? parsed.command
        : {}),
      'audit-code': {
        template: OPENCODE_MCP_COMMAND_TEMPLATE,
        description: 'Autonomous local loop code auditing',
        agent: 'auditor',
        subtask: false,
      },
    },
    mcp: {
      ...objectValue(parsed.mcp),
      auditor: {
        type: 'local',
        command: ['node', pkgEntrypoint, 'mcp'],
        enabled: true,
        timeout: 10000,
      },
    },
    permission: {
      ...mergeOpenCodePermissionConfig(parsed.permission, auditPermission),
      external_directory: { '*': 'allow' },
    },
    agent: {
      ...(parsed.agent && typeof parsed.agent === 'object' && !Array.isArray(parsed.agent)
        ? parsed.agent
        : {}),
      auditor: {
        ...existingAuditor,
        description: 'Read-heavy audit orchestration agent for the /audit-code workflow.',
        permission: {
          ...mergeOpenCodePermissionConfig(existingAuditor.permission, auditPermission),
          external_directory: { '*': 'allow' },
          'auditor_*': 'allow',
          question: 'allow',
          task: 'allow',
        },
      },
    },
  };
}

function claudePluginExternalDir() {
  return join(homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'audit-code');
}

function claudeDesktopConfigPath() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function mergeClaudeDesktopConfig(existing, globalMcpLauncherPath) {
  const parsed = existing ? JSON.parse(existing) : {};
  const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers
    : {};
  return {
    ...parsed,
    mcpServers: {
      ...mcpServers,
      auditor: {
        command: 'node',
        args: [replaceBackslashes(globalMcpLauncherPath)],
      },
    },
  };
}

function installMergedJson(path, buildMerged) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const merged = buildMerged(existing);
  const action = existing ? 'updated' : 'installed';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return action;
}

const promptSource = readRequiredSource(promptSourceFile, 'prompt');
const skillSource = readRequiredSource(skillSourceFile, 'skill');

if (!promptSource || !skillSource) {
  process.exit(0);
}

const codexOpenAiAgentSource = readOptionalSource(codexOpenAiAgentSourceFile, 'Codex skill UI metadata');

const postinstallStart = Date.now();
let succeeded = 0;
let failed = 0;

const installs = [
  {
    label: 'Claude command',
    path: join(homedir(), '.claude', 'commands', 'audit-code.md'),
    sourcePath: promptSourceFile,
    content: promptSource,
  },
  {
    label: 'Codex skill',
    path: join(homedir(), '.codex', 'skills', 'audit-code', 'SKILL.md'),
    sourcePath: skillSourceFile,
    content: skillSource,
  },
  {
    label: 'Codex prompt',
    path: join(homedir(), '.codex', 'skills', 'audit-code', 'audit-code.prompt.md'),
    sourcePath: promptSourceFile,
    content: promptSource,
  },
  ...(codexOpenAiAgentSource
    ? [
        {
          label: 'Codex skill UI metadata',
          path: join(homedir(), '.codex', 'skills', 'audit-code', 'agents', 'openai.yaml'),
          sourcePath: codexOpenAiAgentSourceFile,
          content: codexOpenAiAgentSource,
        },
      ]
    : []),
];

for (const install of installs) {
  try {
    const action = writeGeneratedFile(install.path, install.content);
    console.log(`audit-code: ${action} global ${install.label} at ${install.path}`);
    succeeded++;
  } catch (err) {
    console.warn(`audit-code: could not install global ${install.label} (${err.message})`);
    console.warn(`  To install manually, copy from:`);
    console.warn(`    ${install.sourcePath}`);
    console.warn(`  to:`);
    console.warn(`    ${install.path}`);
    failed++;
  }
}

// Install global MCP launcher for OpenCode (and other hosts that support global config)
const globalMcpLauncherPath = join(homedir(), '.audit-code', 'run-mcp-server.mjs');
try {
  const action = writeGeneratedFile(globalMcpLauncherPath, Buffer.from(renderGlobalMcpLauncher(pkgRoot)));
  console.log(`audit-code: ${action} global MCP launcher at ${globalMcpLauncherPath}`);
  succeeded++;
} catch (err) {
  console.warn(`audit-code: could not install global MCP launcher (${err.message})`);
  failed++;
}

// Install OpenCode global command and MCP via merged config
const opencodeGlobalConfig = join(homedir(), '.config', 'opencode', 'opencode.json');
try {
  const action = installMergedJson(opencodeGlobalConfig, (existing) =>
    mergeOpenCodeGlobalConfig(existing),
  );
  console.log(`audit-code: ${action} global OpenCode config in ${opencodeGlobalConfig}`);
  succeeded++;
} catch (err) {
  console.warn(`audit-code: could not install global OpenCode config (${err.message})`);
  console.warn(`  To install manually, add the mcp.auditor and command["audit-code"] entries to:`);
  console.warn(`    ${opencodeGlobalConfig}`);
  failed++;
}

// Install Antigravity plugin (global skill for Gemini IDE / Antigravity Hub)
const antigravityPluginDir = join(homedir(), '.gemini', 'config', 'plugins', 'audit-code');
const antigravityPluginJsonPath = join(antigravityPluginDir, 'plugin.json');
const antigravityPluginSkillPath = join(antigravityPluginDir, 'skills', 'SKILL.md');

try {
  const pluginJsonAction = writeGeneratedFile(
    antigravityPluginJsonPath,
    Buffer.from(JSON.stringify({ name: 'audit-code', version: '1.0.0' }, null, 2) + '\n'),
  );
  console.log(`audit-code: ${pluginJsonAction} Antigravity plugin manifest at ${antigravityPluginJsonPath}`);

  const skillAction = writeGeneratedFile(antigravityPluginSkillPath, skillSource);
  console.log(`audit-code: ${skillAction} Antigravity plugin skill at ${antigravityPluginSkillPath}`);
  succeeded++;
} catch (err) {
  console.warn(`audit-code: could not install Antigravity plugin (${err.message})`);
  failed++;
}

// Install Claude Desktop plugin so /audit-code appears in the slash-command menu
// Claude Desktop reads external plugins from ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/
const claudePluginDir = claudePluginExternalDir();
const claudePluginManifestPath = join(claudePluginDir, '.claude-plugin', 'plugin.json');
const claudePluginCommandPath = join(claudePluginDir, 'commands', 'audit-code.md');
const claudePluginSkillPath = join(claudePluginDir, 'skills', 'audit-code', 'SKILL.md');
try {
  const manifest = {
    name: 'audit-code',
    description: 'Autonomous local-loop code auditing workflow',
    version: packageVersion,
    author: {
      name: 'auditor-lambda',
      url: 'https://github.com/OhOkThisIsFine/auditor-lambda',
    },
    homepage: 'https://github.com/OhOkThisIsFine/auditor-lambda',
    repository: 'https://github.com/OhOkThisIsFine/auditor-lambda',
    license: 'MIT',
    keywords: ['audit', 'code-audit', 'static-analysis', 'orchestration'],
  };
  const manifestAction = writeGeneratedFile(
    claudePluginManifestPath,
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  );
  console.log(`audit-code: ${manifestAction} Claude Desktop plugin manifest at ${claudePluginManifestPath}`);

  const commandAction = writeGeneratedFile(claudePluginCommandPath, promptSource);
  console.log(`audit-code: ${commandAction} Claude Desktop plugin command at ${claudePluginCommandPath}`);

  const skillAction = writeGeneratedFile(claudePluginSkillPath, skillSource);
  console.log(`audit-code: ${skillAction} Claude Desktop plugin skill at ${claudePluginSkillPath}`);

  console.log(`audit-code: restart Claude Desktop for /audit-code to appear in the slash-command menu`);
  succeeded++;
} catch (err) {
  console.warn(`audit-code: could not install Claude Desktop plugin (${err.message})`);
  console.warn(`  Plugin directory: ${claudePluginDir}`);
  failed++;
}

// Register auditor MCP server with Claude Desktop so /audit-code appears in its slash-command menu
const claudeDesktopConfig = claudeDesktopConfigPath();
try {
  const action = installMergedJson(claudeDesktopConfig, (existing) =>
    mergeClaudeDesktopConfig(existing, globalMcpLauncherPath),
  );
  console.log(`audit-code: ${action} Claude Desktop MCP server entry in ${claudeDesktopConfig}`);
  console.log(`audit-code: restart Claude Desktop for /audit-code to appear`);
  console.log(`audit-code: to target a specific repo, set AUDIT_CODE_REPO_ROOT in Claude Desktop's MCP env settings`);
  succeeded++;
} catch (err) {
  console.warn(`audit-code: could not update Claude Desktop config (${err.message})`);
  console.warn(`  To register manually, add "mcpServers.auditor" to:`);
  console.warn(`    ${claudeDesktopConfig}`);
  console.warn(`  with command "node" and args ["${replaceBackslashes(globalMcpLauncherPath)}"]`);
  failed++;
}

console.log(`audit-code: postinstall complete — ${succeeded} succeeded, ${failed} failed (${Date.now() - postinstallStart}ms)`);
