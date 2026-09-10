#!/usr/bin/env node
// The audit-code host-install entry.
//
// What this file owns: the AUDIT-CODE HALF OF THE PLAN — the OpenCode permission
// tables (what an auditor may touch) and the two prompt renderers. Everything
// structural now comes from `scripts/shared/host-asset-plan.mjs`: which hosts are
// served, what each target path is, which source file feeds it, the command
// description, the agent name. Before that module existed, this file and its
// remediate twin each carried their own copy of all of it — two installers built
// around one shared installer, differing only by a tool token, and free to
// drift the moment either changed.
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  readRequiredSource,
  readOptionalSource,
  objectValue,
  resolveSharedOpenCodePermissions,
  runInstalls,
  installOpenCodeGlobalConfig,
  installAntigravityPlugin,
  installClaudeDesktopPlugin,
  finishPostinstall,
} from '../shared/install-host-assets.mjs';
import {
  HOST_ASSET_PLANS,
  PKG_ROOT,
  planClaudePluginDir,
  planInstalls,
  planOpenCodeCommand,
  planOpenCodeConfigPath,
  planSources,
} from '../shared/host-asset-plan.mjs';

const TOOL = 'audit-code';
const PLAN = HOST_ASSET_PLANS[TOOL];
const SOURCES = planSources(PLAN);
const pkgRoot = PKG_ROOT;
const packageVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';

// Seed literals are passed through the shared canonical orderer below
// (orderOpenCodePermissionRule) so the FIRST deploy already emits the order
// every later merge emits — a fresh config takes the short-circuit branch that
// returns the seed verbatim, so an out-of-order literal here would make run 1
// and run 2 differ byte-wise with no value changed.
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
  'audit-code validate*': 'allow',
  '*audit-code.mjs': 'allow',
  '*audit-code.mjs* ensure*': 'allow',
  '*audit-code.mjs* next-step*': 'allow',
  '*audit-code.mjs* validate*': 'allow',
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
const sharedOpenCodePermissions = /** @type {NonNullable<Awaited<ReturnType<typeof resolveSharedOpenCodePermissions>>>} */ (
  await resolveSharedOpenCodePermissions()
);

// A pre-hardening deploy wrote agent-scope bash['*']='allow' (the historically
// managed broad value). Migrate exactly that value away so the generated 'ask'
// seed wins on re-deploy; any other user-authored wildcard survives untouched.
// This mirrors the install wrapper so an upgrade that only ever runs
// `npm install` converges on the same hardened agent block — otherwise the
// postinstall is the one path that keeps a broad wildcard alive.
function withoutManagedBroadBashWildcard(rule) {
  const { withoutOpenCodeWildcard, OPENCODE_MANAGED_BROAD_VALUE } = sharedOpenCodePermissions;
  const existing = objectValue(rule);
  if (existing['*'] !== OPENCODE_MANAGED_BROAD_VALUE) {
    return rule;
  }
  return withoutOpenCodeWildcard(existing);
}

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
      withoutManagedBroadBashWildcard(existingPermission.bash),
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
  const { orderOpenCodePermissionRule } = sharedOpenCodePermissions ?? {};
  // Guarded: on a fresh checkout before `npm run build` the shared helpers are
  // unavailable and the caller skips the OpenCode deployment entirely, so the
  // un-ordered literal below simply never reaches a file.
  const ordered = (rule) =>
    typeof orderOpenCodePermissionRule === 'function'
      ? orderOpenCodePermissionRule(rule)
      : { ...rule };
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: ordered(OPENCODE_AUDIT_EDIT_PERMISSION),
    bash: ordered(OPENCODE_AUDIT_BASH_PERMISSION),
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
      // The command ENTRY comes from the plan; only the template is this tool's
      // (an MCP-server invocation rather than the prompt body).
      [TOOL]: planOpenCodeCommand(PLAN, OPENCODE_MCP_COMMAND_TEMPLATE),
    },
    permission: mergeOpenCodeGlobalPermissionConfig(parsed.permission, auditPermission),
    agent: {
      ...(parsed.agent && typeof parsed.agent === 'object' && !Array.isArray(parsed.agent)
        ? parsed.agent
        : {}),
      [PLAN.agentName]: {
        ...existingAuditor,
        description: PLAN.agentDescription,
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

const promptSource = readRequiredSource(SOURCES.prompt, 'prompt', TOOL);
const skillSource = readRequiredSource(SOURCES.skill, 'skill', TOOL);

if (!promptSource || !skillSource) {
  process.exit(0);
}

const codexOpenAiAgentSource = readOptionalSource(SOURCES.codexUiMetadata, 'Codex skill UI metadata', TOOL);

const postinstallStart = Date.now();
const counts = { succeeded: 0, failed: 0 };

runInstalls(
  TOOL,
  planInstalls(PLAN, {
    promptContent: promptSource,
    skillContent: skillSource,
    // readOptionalSource yields null when absent; the plan omits the target then.
    codexUiMetadataContent: codexOpenAiAgentSource ?? undefined,
  }),
  counts,
);

// Install OpenCode global command and MCP via merged config
const opencodeGlobalConfig = planOpenCodeConfigPath();
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
    pluginName: TOOL,
    pluginVersion: PLAN.pluginVersion === 'packageVersion' ? packageVersion : PLAN.pluginVersion,
    skillSource,
  },
  counts,
);

// Install Claude Desktop plugin so /audit-code appears in the slash-command menu
installClaudeDesktopPlugin(
  {
    toolName: TOOL,
    pluginDir: planClaudePluginDir(PLAN),
    manifest: {
      name: TOOL,
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
    },
    commandContent: promptSource,
    skillContent: skillSource,
  },
  counts,
);

finishPostinstall(TOOL, counts, postinstallStart);
