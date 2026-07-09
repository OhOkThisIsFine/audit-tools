#!/usr/bin/env node
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  readRequiredSource,
  readOptionalSource,
  writeGeneratedFile,
  objectValue,
  resolveSharedOpenCodePermissions,
  runInstalls,
  installOpenCodeGlobalConfig,
  installAntigravityPlugin,
  finishPostinstall,
} from '../shared/install-host-assets.mjs';

const TOOL = 'audit-code';
const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
const promptSourceFile = join(pkgRoot, 'skills', 'audit-code', 'audit-code.prompt.md');
const skillSourceFile = join(pkgRoot, 'skills', 'audit-code', 'SKILL.md');
const codexOpenAiAgentSourceFile = join(pkgRoot, 'skills', 'audit-code', 'agents', 'openai.yaml');

const OPENCODE_AUDIT_EDIT_PERMISSION = {
  '*': 'ask',
  '.audit-code/**': 'allow',
  '.audit-tools/**': 'allow',
};

const OPENCODE_AUDIT_BASH_PERMISSION = {
  '*': 'ask',
  'audit-code synthesize*': 'deny',
  'audit-code cleanup*': 'deny',
  'audit-code requeue*': 'deny',
  'audit-code ingest-results*': 'deny',
  '*dist*index.js* synthesize*': 'deny',
  '*dist*index.js* cleanup*': 'deny',
  '*dist*index.js* requeue*': 'deny',
  '*dist*index.js* ingest-results*': 'deny',
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
  '*node* *audit-tools*dist*index.js* worker-run*': 'allow',
  'node* .audit-code/install/run-mcp-server.mjs*': 'allow',
  'node* ./.audit-code/install/run-mcp-server.mjs*': 'allow',
  'git status*': 'allow',
  'git diff*': 'allow',
  'grep *': 'allow',
  'rm *': 'deny',
};

// The scoped OpenCode permission merge helpers are single-sourced in
// audit-tools/shared (global top-level scope vs. auditor agent scope).
// Resolved best-effort: on a fresh workspace checkout the shared dist may not
// be built yet, in which case the OpenCode config deployment below is
// skipped with a warning instead of failing the whole install.
const sharedOpenCodePermissions = await resolveSharedOpenCodePermissions();

// Auditor agent scope (read-only agent, parity with the remediator hardening):
// enumerated audit-code commands stay managed allows/denies, but the bash
// wildcard defaults to "ask" (an existing user wildcard survives — the
// managed set is passed without "*") and no external_directory allow-all is
// seeded.
function mergeOpenCodeAgentPermissionConfig(existingPermission, generatedPermission) {
  const { mergeOpenCodeAgentPermissionRule, withoutOpenCodeWildcard } = sharedOpenCodePermissions;
  if (!existingPermission || typeof existingPermission !== 'object' || Array.isArray(existingPermission)) {
    return generatedPermission;
  }

  return {
    ...generatedPermission,
    ...existingPermission,
    read: generatedPermission.read,
    glob: generatedPermission.glob,
    grep: generatedPermission.grep,
    edit: mergeOpenCodeAgentPermissionRule(
      existingPermission.edit,
      generatedPermission.edit,
      OPENCODE_AUDIT_EDIT_PERMISSION,
    ),
    bash: mergeOpenCodeAgentPermissionRule(
      existingPermission.bash,
      generatedPermission.bash,
      withoutOpenCodeWildcard(OPENCODE_AUDIT_BASH_PERMISSION),
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

const promptSource = readRequiredSource(promptSourceFile, 'prompt', TOOL);
const skillSource = readRequiredSource(skillSourceFile, 'skill', TOOL);

if (!promptSource || !skillSource) {
  process.exit(0);
}

const codexOpenAiAgentSource = readOptionalSource(codexOpenAiAgentSourceFile, 'Codex skill UI metadata', TOOL);

const postinstallStart = Date.now();
const counts = { succeeded: 0, failed: 0 };

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

runInstalls(TOOL, installs, counts);

// Install OpenCode global command and MCP via merged config
const opencodeGlobalConfig = join(homedir(), '.config', 'opencode', 'opencode.json');
installOpenCodeGlobalConfig(
  {
    toolName: TOOL,
    path: opencodeGlobalConfig,
    sharedOpenCodePermissions,
    buildMerged: (existing) => mergeOpenCodeGlobalConfig(existing),
    label: 'OpenCode config',
    manualInstructions: [
      `  To install manually, add the mcp.auditor and command["audit-code"] entries to:`,
      `    ${opencodeGlobalConfig}`,
    ],
  },
  counts,
);

// Install Antigravity plugin (global skill for Gemini IDE / Antigravity Hub)
installAntigravityPlugin(
  {
    toolName: TOOL,
    homeDir: homedir(),
    pluginName: 'audit-code',
    pluginVersion: '1.0.0',
    skillSource,
  },
  counts,
);

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
      name: 'audit-tools',
      url: 'https://github.com/OhOkThisIsFine/audit-tools',
    },
    homepage: 'https://github.com/OhOkThisIsFine/audit-tools',
    repository: 'https://github.com/OhOkThisIsFine/audit-tools',
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
  counts.succeeded++;
} catch (err) {
  console.warn(`audit-code: could not install Claude Desktop plugin (${err.message})`);
  console.warn(`  Plugin directory: ${claudePluginDir}`);
  counts.failed++;
}

finishPostinstall(TOOL, counts, postinstallStart);
