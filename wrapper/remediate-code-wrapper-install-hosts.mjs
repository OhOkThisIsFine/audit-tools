import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileExists,
  readJson,
  readTextIfExists,
  writeGeneratedJson,
  writeGeneratedMarkdown,
  writeManagedMarkdown,
  writeMergedGeneratedJson,
} from './remediate-code-wrapper-io.mjs';
import {
  assertOpenCodeRemediatePermissionConfig,
  buildMergedOpenCodeProjectConfig,
} from './remediate-code-wrapper-opencode.mjs';
import {
  findLegacyRemediateCodeSurfaceFiles,
  removeLegacyRemediateCodeSurfaceFiles,
} from './remediate-code-wrapper-legacy.mjs';
import {
  renderVSCodeAgentFile,
  renderCodexAutomationRecipe,
  renderAntigravityPlanningGuide,
  renderGeminiCommandToml as _renderGeminiCommandTomlImpl,
} from './remediate-code-wrapper-install-renderers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const promptAssetPath = join(repoRoot, 'skills', 'remediate-code', 'remediate-code.prompt.md');
const skillAssetPath = join(repoRoot, 'skills', 'remediate-code', 'SKILL.md');
const INSTALL_MARKER_START = '<!-- remediate-code:begin -->';
const INSTALL_MARKER_END = '<!-- remediate-code:end -->';
const INSTALL_GUIDE_FILENAME = 'GETTING-STARTED.md';
const INSTALL_MANIFEST_FILENAME = 'manifest.json';
const DEFAULT_INSTALL_HOST = 'all';
const INSTALLED_PROMPT_FILENAME = 'remediate-code.import.md';
const INSTALL_DIR = '.remediate-code';

function hasFlag(argv, name) {
  return argv.includes(name);
}

function getFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function requireFlagValue(argv, name) {
  const value = getFlag(argv, name);
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
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
    '## /remediate-code',
    'When the user enters `/remediate-code`, treat it as this repository\'s autonomous remediation workflow.',
    `If your host does not automatically register the installed slash command file, load and follow [the repo-local remediate directive](${relativePromptPath.replace(/\\/g, '/')}).`,
    'Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.',
    INSTALL_MARKER_END,
  ].join('\n');
}

// Host-asset render functions (renderVSCodeAgentFile, renderCodexAutomationRecipe,
// renderAntigravityPlanningGuide, renderGeminiCommandToml) are imported from
// remediate-code-wrapper-install-renderers.mjs. Each one is a thin wrapper that
// derives its asset from the ONE canonical loader prompt body via the shared
// renderHostAsset helper — no host re-authors loader prose, so no asset can drift
// from the body.
const renderGeminiCommandToml = _renderGeminiCommandTomlImpl;

// Exported for testing only — delegates to the canonical implementation in renderers.
export const _renderGeminiCommandToml = renderGeminiCommandToml;

export const INSTALL_PROFILE_FLAGS = [
  'writeVSCode',
  'writeCopilotInstructions',
  'writeOpenCode',
  'writeCodex',
  'writeAntigravity',
  'writeAgents',
];

export const INSTALL_HOST_ORDER = [
  'codex',
  'opencode',
  'vscode',
  'antigravity',
];

export const INSTALL_HOST_DEFINITIONS = {
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
      'Use the global `/remediate-code` skill installed by `npm install -g audit-tools`.',
      'If the global skill is unavailable, follow the AGENTS fallback instructions that point at the repo-local prompt asset.',
    ],
    profile: {
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'codex_global_surface', async () => {
        const content = await readFile(assetPaths.agentsInstructionsPath, 'utf8');
        if (!content.includes('/remediate-code')) {
          throw new Error(`AGENTS instructions do not reference /remediate-code: ${assetPaths.agentsInstructionsPath}`);
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
      'Use the global OpenCode `/remediate-code` command installed by npm plus generated project permissions.',
    primary_path_key: 'opencodeConfigPath',
    supporting_path_keys: [
      'agentsInstructionsPath',
    ],
    steps: [
      'Open this repository in OpenCode.',
      'Use the global `/remediate-code` command installed by `npm install -g audit-tools`.',
      'Let OpenCode load the generated `opencode.json` for project permissions; the global command drives `remediate-code next-step` directly.',
    ],
    profile: {
      writeOpenCode: true,
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'opencode_config', async () => {
        const config = await readJson(assetPaths.opencodeConfigPath, 'OpenCode project config');
        if (config?.command?.['remediate-code']) {
          throw new Error('OpenCode project config must not define command["remediate-code"]; the slash command is global npm-installed state. Run "remediate-code install --host opencode" to remove the stale local command.');
        }
        if (config?.mcp?.remediator) {
          throw new Error('OpenCode project config must not define mcp.remediator; the MCP server is supplied by the global npm-installed config. Run "remediate-code install --host opencode" to remove the stale project-level MCP entry.');
        }
        assertOpenCodeRemediatePermissionConfig(config?.permission, 'permission');
        assertOpenCodeRemediatePermissionConfig(config?.agent?.remediator?.permission, 'agent.remediator.permission');
        return {
          summary: 'OpenCode project config has remediate permissions; /remediate-code is supplied by the global npm-installed config.',
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
      'Invoke `/remediate-code` from the generated prompt or chat so the workflow calls `remediate-code next-step` directly.',
    ],
    profile: {
      writeVSCode: true,
      writeCopilotInstructions: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'vscode_prompt', async () => {
        const content = await readFile(assetPaths.vscodePromptPath, 'utf8');
        if (!content.includes('name: remediate-code')) {
          throw new Error(`VS Code prompt file is missing the expected frontmatter name: ${assetPaths.vscodePromptPath}`);
        }
        const { body: promptBody } = splitFrontmatter(content);
        const { body: sourceBody } = splitFrontmatter(await readFile(promptAssetPath, 'utf8'));
        if (promptBody !== sourceBody.trimStart()) {
          throw new Error(
            `VS Code prompt body is out of sync with the source prompt. Run "remediate-code install --host vscode" or "remediate-code install".`,
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
      'Uses the project-scoped .agent/skills/remediate-code/SKILL.md skill, the .gemini/commands/remediate-code.toml slash command, the planning guide, and AGENTS instructions.',
    primary_path_key: 'antigravitySkillPath',
    supporting_path_keys: [
      'geminiCommandPath',
      'antigravityPlanningGuidePath',
      'agentsInstructionsPath',
      'installedPromptPath',
    ],
    steps: [
      'Open this repository in Antigravity.',
      'The remediate-code skill is automatically discovered from .agent/skills/remediate-code/SKILL.md.',
      'The /remediate-code slash command is also available from .gemini/commands/remediate-code.toml.',
      'Use `remediate-code next-step` directly.',
    ],
    profile: {
      writeAntigravity: true,
      writeAgents: true,
    },
    async verify({ checks, assetPaths, collectVerifyCheck: collect }) {
      await collect(checks, 'antigravity_skill', async () => {
        const content = await readFile(assetPaths.antigravitySkillPath, 'utf8');
        if (!content.includes('name: remediate-code')) {
          throw new Error('Antigravity skill SKILL.md must contain "name: remediate-code" in frontmatter.');
        }
        return {
          summary: 'Antigravity .agent/skills/remediate-code/SKILL.md is present and valid.',
          path: assetPaths.antigravitySkillPath,
        };
      });
      await collect(checks, 'antigravity_guide', async () => {
        const content = await readFile(assetPaths.antigravityPlanningGuidePath, 'utf8');
        if (!content.includes('--host-models') || !content.includes('next-step')) {
          throw new Error('Antigravity guide must embed the canonical loader body (next-step capability handshake including --host-models).');
        }
        return {
          summary: 'Antigravity planning guide embeds the canonical loader body with the capability handshake.',
          path: assetPaths.antigravityPlanningGuidePath,
        };
      });
    },
  },
};

function supportedInstallHostsMessage() {
  return ['all', 'copilot', ...INSTALL_HOST_ORDER].join(', ');
}

export function getInstallHostKeys(host) {
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

export function getInstallProfile(host) {
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

export function buildInstallAssetPaths(root, profile) {
  const installedPromptPath = join(root, INSTALL_DIR, 'install', INSTALLED_PROMPT_FILENAME);
  const installedSkillPath = join(root, INSTALL_DIR, 'install', 'SKILL.md');
  const installGuidePath = join(root, INSTALL_DIR, 'install', INSTALL_GUIDE_FILENAME);
  const installManifestPath = join(root, INSTALL_DIR, 'install', INSTALL_MANIFEST_FILENAME);
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
      ? join(root, '.codex', 'skills', 'remediate-code', 'SKILL.md')
      : null,
    codexPromptPath: profile.writeCodex
      ? join(root, '.codex', 'skills', 'remediate-code', 'remediate-code.prompt.md')
      : null,
    codexAutomationRecipePath: profile.writeCodex
      ? join(root, INSTALL_DIR, 'install', 'codex', 'RE-REMEDIATE-AUTOMATION.md')
      : null,
    opencodeConfigPath: profile.writeOpenCode
      ? join(root, 'opencode.json')
      : null,
    vscodePromptPath: profile.writeVSCode
      ? join(root, '.github', 'prompts', 'remediate-code.prompt.md')
      : null,
    vscodeAgentPath: profile.writeVSCode
      ? join(root, '.github', 'agents', 'remediator.agent.md')
      : null,
    antigravityPlanningGuidePath: profile.writeAntigravity
      ? join(root, INSTALL_DIR, 'install', 'antigravity', 'PLANNING-MODE.md')
      : null,
    geminiCommandPath: profile.writeAntigravity
      ? join(root, '.gemini', 'commands', 'remediate-code.toml')
      : null,
    antigravitySkillPath: profile.writeAntigravity
      ? join(root, '.agent', 'skills', 'remediate-code', 'SKILL.md')
      : null,
  };
}

export function buildHostCatalog({ root, host, assets }) {
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

export function renderInstallGuide({
  root,
  host,
  installedPromptPath,
  installedSkillPath,
  installManifestPath,
  hostGuidance,
}) {
  const lines = [
    '# remediate-code bootstrap guide',
    '',
    'The canonical product route is `/remediate-code` in conversation.',
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
  lines.push('- from the repository root, run `remediate-code` only when you intentionally need the repo-local backend wrapper');
  lines.push('- run `remediate-code verify-install` after bootstrap when you want to smoke-test the generated launchers and host configs');
  lines.push('- rerun `remediate-code install` to refresh every generated host surface from the shared prompt and skill assets together');

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

export async function writeCoreInstallAssets(root, assetPaths, promptSource, skillSource) {
  const results = [];
  const legacyInstalledPromptPath = join(root, INSTALL_DIR, 'install', 'remediate-code.prompt.md');
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
          relative(dirname(targetPath), assetPaths.installedPromptPath) || `./${INSTALL_DIR}/install/${INSTALLED_PROMPT_FILENAME}`,
        ),
      ),
    );
  }

  results.push(...await removeLegacyRemediateCodeSurfaceFiles(root));
  return results;
}

export async function writeCodexAssets(assetPaths, promptSource, skillSource, promptBody) {
  return [
    await writeGeneratedMarkdown(assetPaths.codexSkillPath, skillSource),
    await writeGeneratedMarkdown(assetPaths.codexPromptPath, promptSource),
    await writeGeneratedMarkdown(assetPaths.codexAutomationRecipePath, renderCodexAutomationRecipe(promptBody)),
  ];
}

export async function writeOpenCodeAssets(assetPaths, root) {
  return [
    await writeMergedGeneratedJson(
      assetPaths.opencodeConfigPath,
      'OpenCode project config',
      (existing) => buildMergedOpenCodeProjectConfig(existing, root),
    ),
  ];
}

export async function writeVSCodeAssets(assetPaths, promptBody) {
  return [
    await writeGeneratedMarkdown(
      assetPaths.vscodePromptPath,
      renderPromptFile(
        {
          name: 'remediate-code',
          description: 'Autonomous local-loop remediation',
          agent: 'remediator',
        },
        promptBody,
      ),
    ),
    await writeGeneratedMarkdown(assetPaths.vscodeAgentPath, renderVSCodeAgentFile(promptBody)),
  ];
}

export async function writeAntigravityAssets(assetPaths, promptBody, skillSource) {
  return [
    await writeGeneratedMarkdown(
      assetPaths.antigravityPlanningGuidePath,
      renderAntigravityPlanningGuide(promptBody),
    ),
    await writeGeneratedMarkdown(assetPaths.geminiCommandPath, renderGeminiCommandToml(promptBody)),
    await writeGeneratedMarkdown(assetPaths.antigravitySkillPath, skillSource),
  ];
}

export async function installBootstrap(argv, options = {}) {
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
    results.push(...await writeCodexAssets(assetPaths, promptSource, skillSource, promptBody));
  }
  if (profile.writeOpenCode) {
    results.push(...await writeOpenCodeAssets(assetPaths, root));
  }
  if (profile.writeVSCode) {
    results.push(...await writeVSCodeAssets(assetPaths, promptBody));
  }
  if (profile.writeAntigravity) {
    results.push(...await writeAntigravityAssets(assetPaths, promptBody, skillSource));
  }

  const hostGuidance = buildHostCatalog({
    root,
    host,
    assets: assetPaths,
  });

  const installManifest = {
    contract_version: 'remediate-code-install/v1alpha1',
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

  const sessionConfigPath = join(root, '.audit-tools', 'remediation', 'session-config.json');
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
      'Run `remediate-code verify-install` from the repository root to smoke-test the generated host configs.',
    ],
  };

  if (!options.quiet) {
    console.log(JSON.stringify(payload, null, 2));
  }

  return payload;
}

/**
 * Run a single host's `verify()` handler from INSTALL_HOST_DEFINITIONS against
 * already-deployed assets and collect its check results. Single-sourced so the
 * `verify-install` CLI and the `verify:hosts` release gate exercise the exact
 * same per-host handler — adding a host to the table auto-extends both.
 *
 * @param {string} hostKey
 * @param {{ root: string, assetPaths: object, hostEntry?: object }} context
 * @returns {Promise<{ host: string, status: 'ok' | 'error', checks: object[] }>}
 */
export async function runHostVerifyChecks(hostKey, { root, assetPaths, hostEntry }) {
  const checks = [];

  if (hostEntry) {
    await collectVerifyCheck(checks, 'host_manifest_entry', async () => ({
      summary: `Host guidance exists for ${hostEntry.label}.`,
      primary_path: hostEntry.primary_path,
    }));
  }

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

  return {
    host: hostKey,
    status: checks.some((check) => check.status === 'error') ? 'error' : 'ok',
    checks,
  };
}

/**
 * Deploy every host's assets into an ISOLATED throwaway repo root under a
 * redirected `$HOME`/`USERPROFILE` (so the real user config is never touched),
 * then re-run each host's `verify()` handler from the SAME INSTALL_HOST_DEFINITIONS
 * table that drives the deploy. The set of hosts verified is derived from
 * INSTALL_HOST_ORDER, so adding a host to the table auto-extends verification.
 *
 * Returns a structured report; callers (the `verify:hosts` script, tests) decide
 * how to surface it. Never mutates the caller's environment beyond restoring the
 * redirected HOME/USERPROFILE on the way out.
 *
 * @param {{ keepArtifacts?: boolean }} [options]
 * @returns {Promise<{
 *   status: 'ok' | 'error',
 *   issue_count: number,
 *   verified_hosts: string[],
 *   home_dir: string,
 *   repo_root: string,
 *   hosts: { host: string, status: 'ok' | 'error', checks: object[] }[],
 * }>}
 */
export async function verifyHostsIsolated(options = {}) {
  // A temp $HOME guarantees a postinstall-style deploy (or any HOME-reading code
  // path) can never write to the operator's real ~/.config — defense in depth on
  // top of the throwaway repo root the bootstrap writes into.
  const homeDir = await mkdtemp(join(tmpdir(), 'remediate-code-verify-hosts-home-'));
  const isolatedRepoRoot = join(homeDir, 'repo');
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    await mkdir(isolatedRepoRoot, { recursive: true });
    // Deploy every host surface into the throwaway root from the canonical assets.
    await installBootstrap(['--host', 'all', '--root', isolatedRepoRoot], { quiet: true });

    // Derive expectations from the SAME table the deploy uses: profile → asset
    // paths → per-host verify(). INSTALL_HOST_ORDER is the source of truth for the
    // verified host set.
    const profile = getInstallProfile('all');
    const assetPaths = buildInstallAssetPaths(isolatedRepoRoot, profile);
    const hostCatalog = new Map(
      buildHostCatalog({ root: isolatedRepoRoot, host: 'all', assets: assetPaths }).map(
        (entry) => [entry.host, entry],
      ),
    );

    const hosts = [];
    for (const hostKey of INSTALL_HOST_ORDER) {
      hosts.push(
        await runHostVerifyChecks(hostKey, {
          root: isolatedRepoRoot,
          assetPaths,
          hostEntry: hostCatalog.get(hostKey),
        }),
      );
    }

    const issueCount = hosts.reduce(
      (sum, host) => sum + host.checks.filter((check) => check.status === 'error').length,
      0,
    );

    return {
      status: issueCount > 0 ? 'error' : 'ok',
      issue_count: issueCount,
      verified_hosts: [...INSTALL_HOST_ORDER],
      home_dir: homeDir,
      repo_root: isolatedRepoRoot,
      hosts,
    };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (!options.keepArtifacts) {
      await rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function verifyInstalledBootstrap(argv) {
  const root = resolve(getFlag(argv, '--root') ?? '.');
  const requestedHost = getFlag(argv, '--host')?.toLowerCase() ?? null;
  const installManifestPath = join(
    root,
    INSTALL_DIR,
    'install',
    INSTALL_MANIFEST_FILENAME,
  );
  const installGuidePath = join(
    root,
    INSTALL_DIR,
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
    if (installManifest?.contract_version !== 'remediate-code-install/v1alpha1') {
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
    if (!guide.includes('# remediate-code bootstrap guide')) {
      throw new Error(`Install guide does not look like a remediate-code bootstrap guide: ${installGuidePath}`);
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
        `Installed prompt is out of sync with the source prompt. Run "remediate-code install" from ${root}.`,
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
        `Installed skill is out of sync with the source skill. Run "remediate-code install" from ${root}.`,
      );
    }
    return {
      summary: 'Installed skill asset is present and matches the source skill.',
      path: assetPaths.installedSkillPath,
    };
  });

  await collectVerifyCheck(generalChecks, 'legacy_local_surfaces', async () => {
    const legacySurfaces = await findLegacyRemediateCodeSurfaceFiles(root);
    if (legacySurfaces.length > 0) {
      throw new Error(
        `Legacy local /remediate-code surfaces are still present: ${legacySurfaces.join(', ')}. Run "remediate-code install" from ${root}.`,
      );
    }
    return {
      summary: 'No legacy local /remediate-code command or skill surfaces were found.',
    };
  });

  for (const hostKey of selectedHosts) {
    const hostEntry = hostCatalog.get(hostKey);

    if (!hostEntry) {
      hostResults.push({
        host: hostKey,
        status: 'error',
        checks: [{
          id: 'host_manifest_entry',
          status: 'error',
          summary: `Install manifest does not contain host guidance for "${hostKey}".`,
        }],
      });
      continue;
    }

    hostResults.push(
      await runHostVerifyChecks(hostKey, { root, assetPaths, hostEntry }),
    );
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

export async function detectBootstrapRefreshReason(root, host) {
  const installManifestPath = join(
    root,
    INSTALL_DIR,
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

  if (installManifest?.contract_version !== 'remediate-code-install/v1alpha1') {
    return 'stale_install_manifest_contract';
  }

  const assetPaths = installManifest.asset_paths ?? {};
  const hostCatalog = new Set(
    (installManifest.hosts ?? []).map((entry) => entry.host),
  );

  if (hostCatalog.has('codex') && (assetPaths.codexSkillPath || assetPaths.codexPromptPath)) {
    return 'legacy_local_remediate_code_surface';
  }

  if ((await findLegacyRemediateCodeSurfaceFiles(root)).length > 0) {
    return 'legacy_local_remediate_code_surface';
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
        if (opencodeConfig?.command?.['remediate-code']) {
          return 'stale_host_asset:opencode:local_command';
        }
        if (opencodeConfig?.mcp?.remediator) {
          return 'stale_host_asset:opencode:project_mcp';
        }
        try {
          assertOpenCodeRemediatePermissionConfig(opencodeConfig?.permission, 'permission');
          assertOpenCodeRemediatePermissionConfig(opencodeConfig?.agent?.remediator?.permission, 'agent.remediator.permission');
        } catch {
          return 'stale_host_asset:opencode:permissions';
        }
        if (await fileExists(join(root, '.opencode', 'commands', 'remediate-code.md'))) {
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
        const expectedSkillPath = join(root, '.agent', 'skills', 'remediate-code', 'SKILL.md');
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

export async function ensureBootstrap(argv) {
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
      INSTALL_DIR,
      'install',
      INSTALL_MANIFEST_FILENAME,
    ),
  };
  if (!quiet) {
    console.log(JSON.stringify(payload, null, 2));
  }
  return payload;
}

export async function installHostPrompt(argv) {
  const host = requireFlagValue(argv, '--host').toLowerCase();

  if (host !== 'copilot') {
    throw new Error(
      `install-host currently supports only "copilot". Use "install --host ${host}" for the broader bootstrap flow.`,
    );
  }

  await installBootstrap(argv);
}

// Underscore-aliased re-exports consumed by host-bootstrap-descriptors tests
// via remediate-code-wrapper-lib.mjs. Keep these so the test import chain resolves
// without modification to the test file.
export {
  INSTALL_HOST_ORDER as _INSTALL_HOST_ORDER,
  INSTALL_HOST_DEFINITIONS as _INSTALL_HOST_DEFINITIONS,
  getInstallHostKeys as _getInstallHostKeys,
  getInstallProfile as _getInstallProfile,
};
