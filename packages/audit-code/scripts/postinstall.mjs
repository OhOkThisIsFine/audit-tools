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

const OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION = { '*': 'allow' };

const OPENCODE_AUDIT_EDIT_PERMISSION = {
  '*': 'ask',
  '.audit-code/**': 'allow',
  '.audit-tools/**': 'allow',
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

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

// The scoped OpenCode permission merge helpers are single-sourced in
// @audit-tools/shared (global top-level scope vs. auditor agent scope).
// Resolve them best-effort: on a fresh workspace checkout the shared dist may
// not be built yet, in which case the OpenCode config deployment below is
// skipped with a warning instead of failing the whole install.
let sharedOpenCodePermissions = null;
try {
  const shared = await import('@audit-tools/shared');
  if (
    typeof shared.mergeOpenCodeAgentPermissionRule === 'function' &&
    typeof shared.mergeOpenCodeGlobalPermissionRule === 'function' &&
    typeof shared.migrateOpenCodeGlobalExternalDirectory === 'function'
  ) {
    sharedOpenCodePermissions = shared;
  }
} catch {
  // Leave null; the OpenCode deployment step reports the skip.
}

// Auditor agent scope: broad-allow-with-denylist, unchanged. Managed rules
// (including the wildcard) always win at this scope.
function mergeOpenCodeAgentPermissionConfig(existingPermission, generatedPermission) {
  const { mergeOpenCodeAgentPermissionRule } = sharedOpenCodePermissions;
  if (!existingPermission || typeof existingPermission !== 'object' || Array.isArray(existingPermission)) {
    return generatedPermission;
  }

  return {
    ...generatedPermission,
    ...existingPermission,
    read: generatedPermission.read,
    glob: generatedPermission.glob,
    grep: generatedPermission.grep,
    external_directory: mergeOpenCodeAgentPermissionRule(
      existingPermission.external_directory,
      generatedPermission.external_directory,
      OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION,
    ),
    edit: mergeOpenCodeAgentPermissionRule(
      existingPermission.edit,
      generatedPermission.edit,
      OPENCODE_AUDIT_EDIT_PERMISSION,
    ),
    bash: mergeOpenCodeAgentPermissionRule(
      existingPermission.bash,
      generatedPermission.bash,
      OPENCODE_AUDIT_BASH_PERMISSION,
    ),
  };
}

// Global top-level scope: never seeds bash['*']='allow' or
// external_directory['*']='allow', keeps the denylist hygiene rules, and
// migrates away previously deployed broad rules whose value exactly matches
// the historically managed value ('allow'). Non-matching values are untouched.
function mergeOpenCodeGlobalPermissionConfig(existingPermission, generatedPermission) {
  const {
    mergeOpenCodeAgentPermissionRule,
    mergeOpenCodeGlobalPermissionRule,
    migrateOpenCodeGlobalExternalDirectory,
  } = sharedOpenCodePermissions;
  const existing = objectValue(existingPermission);

  const merged = {
    ...generatedPermission,
    ...existing,
    read: generatedPermission.read,
    glob: generatedPermission.glob,
    grep: generatedPermission.grep,
    edit: mergeOpenCodeAgentPermissionRule(
      existing.edit,
      generatedPermission.edit,
      OPENCODE_AUDIT_EDIT_PERMISSION,
    ),
    bash: mergeOpenCodeGlobalPermissionRule(
      existing.bash,
      generatedPermission.bash,
      OPENCODE_AUDIT_BASH_PERMISSION,
    ),
  };

  const externalDirectory = migrateOpenCodeGlobalExternalDirectory(existing.external_directory);
  if (externalDirectory === undefined) {
    delete merged.external_directory;
  } else {
    merged.external_directory = externalDirectory;
  }

  return merged;
}

function renderOpenCodePermissionConfig() {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    external_directory: { ...OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION },
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
    permission: mergeOpenCodeGlobalPermissionConfig(parsed.permission, auditPermission),
    agent: {
      ...(parsed.agent && typeof parsed.agent === 'object' && !Array.isArray(parsed.agent)
        ? parsed.agent
        : {}),
      auditor: {
        ...existingAuditor,
        description: 'Read-heavy audit orchestration agent for the /audit-code workflow.',
        permission: {
          ...mergeOpenCodeAgentPermissionConfig(existingAuditor.permission, auditPermission),
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

// Install OpenCode global command and MCP via merged config
const opencodeGlobalConfig = join(homedir(), '.config', 'opencode', 'opencode.json');
try {
  if (!sharedOpenCodePermissions) {
    throw new Error(
      '@audit-tools/shared is unavailable (build the shared workspace first); skipping OpenCode config deployment',
    );
  }
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

console.log(`audit-code: postinstall complete — ${succeeded} succeeded, ${failed} failed (${Date.now() - postinstallStart}ms)`);
