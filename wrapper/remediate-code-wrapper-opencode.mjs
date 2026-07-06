// Best-effort import of shared OpenCode permission helpers.
// On a fresh checkout before `npm run build`, the dist may not exist yet;
// buildMergedOpenCodeProjectConfig throws a clear error in that case.
let mergeOpenCodeAgentPermissionRule;
let withoutOpenCodeWildcard;
let composeOpenCodeBashCeiling;
export let sharedOpenCodePermissions = false;

try {
  const shared = await import('audit-tools/shared');
  mergeOpenCodeAgentPermissionRule = shared.mergeOpenCodeAgentPermissionRule;
  withoutOpenCodeWildcard = shared.withoutOpenCodeWildcard;
  composeOpenCodeBashCeiling = shared.composeOpenCodeBashCeiling;
  sharedOpenCodePermissions = true;
} catch {
  // shared not yet built — callers that need merge logic will throw below
}

export const OPENCODE_REMEDIATE_EDIT_PERMISSION = {
  '*': 'ask',
  '.remediate-code/**': 'allow',
  '.audit-tools/**': 'allow',
};

export const OPENCODE_REMEDIATE_EXTERNAL_DIRECTORY_PERMISSION = { '*': 'allow' };

// Subcommands allowed for both the global bin and the dev wrapper.
// Adding or removing a subcommand here applies to both invocation forms.
const REMEDIATE_CODE_ALLOWED_SUBCOMMANDS = [
  'ensure*',
  'next-step*',
  'prepare-implement-dispatch*',
  'merge-implement-results*',
  'accept-node*',
  'validate*',
];

function buildRemediateBashPermissions() {
  /** @type {Record<string, 'allow' | 'deny'>} */
  const perm = { '*': 'allow' };
  // Allow rules: bare bin and each subcommand for both the global bin and wrapper.
  perm['remediate-code'] = 'allow';
  for (const sub of REMEDIATE_CODE_ALLOWED_SUBCOMMANDS) {
    perm[`remediate-code ${sub}`] = 'allow';
    perm[`*remediate-code.mjs* ${sub}`] = 'allow';
  }
  perm['*remediate-code.mjs'] = 'allow';
  perm['git status*'] = 'allow';
  perm['git diff*'] = 'allow';
  perm['grep *'] = 'allow';
  perm['Select-String *'] = 'allow';
  perm['rm *'] = 'deny';
  return perm;
}

export const OPENCODE_REMEDIATE_BASH_PERMISSION = buildRemediateBashPermissions();

function renderOpenCodeExternalDirectoryPermission() {
  return { '*': 'allow' };
}

export function renderOpenCodePermissionConfig() {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    external_directory: renderOpenCodeExternalDirectoryPermission(),
    edit: { ...OPENCODE_REMEDIATE_EDIT_PERMISSION },
    bash: { ...OPENCODE_REMEDIATE_BASH_PERMISSION },
  };
}

export function renderOpenCodeProjectConfig(_root) {
  const remediatePermission = renderOpenCodePermissionConfig();
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: remediatePermission,
    agent: {
      remediator: {
        description:
          'Remediation orchestration agent for the /remediate-code workflow.',
        permission: {
          ...remediatePermission,
          'remediator_*': 'allow',
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

export function removeManagedOpenCodeCommand(commandConfig) {
  const command = objectValue(commandConfig);
  const { 'remediate-code': _managedRemediateCodeCommand, ...remaining } = command;
  return remaining;
}

export function assertOpenCodeRemediatePermissionConfig(permissionConfig, label) {
  for (const tool of ['read', 'glob', 'grep']) {
    if (permissionConfig?.[tool] !== 'allow') {
      throw new Error(`OpenCode ${label}.${tool} must be allow. Run "remediate-code install --host opencode".`);
    }
  }
  const externalDirectory = permissionConfig?.external_directory;
  if (!externalDirectory || typeof externalDirectory !== 'object' || Array.isArray(externalDirectory)) {
    throw new Error(`OpenCode ${label}.external_directory must set "*" to "allow". Run "remediate-code install --host opencode".`);
  }
  if (externalDirectory['*'] !== 'allow') {
    throw new Error(`OpenCode ${label}.external_directory must set "*" to "allow". Run "remediate-code install --host opencode".`);
  }
  const edit = permissionConfig?.edit;
  const bash = permissionConfig?.bash;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw new Error(`OpenCode ${label}.edit must allow remediate-owned file paths. Run "remediate-code install --host opencode".`);
  }
  for (const pattern of ['.remediate-code/**', '.audit-tools/**']) {
    if (edit[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.edit must allow ${pattern}. Run "remediate-code install --host opencode".`);
    }
  }
  if (!bash || typeof bash !== 'object' || Array.isArray(bash)) {
    throw new Error(`OpenCode ${label}.bash must allow remediate-code commands. Run "remediate-code install --host opencode".`);
  }
  for (const pattern of [
    'remediate-code',
    'remediate-code ensure*',
    'remediate-code next-step*',
    'remediate-code prepare-implement-dispatch*',
    'remediate-code merge-implement-results*',
    'remediate-code accept-node*',
    '*remediate-code.mjs',
    '*remediate-code.mjs* next-step*',
    '*remediate-code.mjs* merge-implement-results*',
    '*remediate-code.mjs* accept-node*',
  ]) {
    if (bash[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.bash must allow ${pattern}. Run "remediate-code install --host opencode".`);
    }
  }
}

function mergePermissionBlock(existingPermission, generatedPermission) {
  const existing = objectValue(existingPermission);
  return {
    ...generatedPermission,
    ...existing,
    read: generatedPermission.read,
    glob: generatedPermission.glob,
    grep: generatedPermission.grep,
    external_directory: mergeOpenCodeAgentPermissionRule(
      existing.external_directory,
      generatedPermission.external_directory,
      OPENCODE_REMEDIATE_EXTERNAL_DIRECTORY_PERMISSION,
    ),
    edit: mergeOpenCodeAgentPermissionRule(
      existing.edit,
      generatedPermission.edit,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_EDIT_PERMISSION),
    ),
    bash: mergeOpenCodeAgentPermissionRule(
      existing.bash,
      generatedPermission.bash,
      withoutOpenCodeWildcard(OPENCODE_REMEDIATE_BASH_PERMISSION),
    ),
  };
}

// Collect every agent's bash rule set from a merged agent map (in stable,
// key-sorted order) so the top-level ceiling is a deterministic union over all
// present agents — auditor, remediator, or any future agent — not just the one
// this installer owns. This is what makes the two installers mutually
// key-aware: whichever one runs unions the block the other already wrote.
function collectAgentBashRuleSets(agentMap) {
  const agents = objectValue(agentMap);
  return Object.keys(agents)
    .sort()
    .map((name) => objectValue(objectValue(agents[name]).permission).bash)
    .filter((bash) => bash && typeof bash === 'object' && !Array.isArray(bash));
}

export function buildMergedOpenCodeProjectConfig(existing, root) {
  if (!sharedOpenCodePermissions) {
    throw new Error(
      'audit-tools/shared is not available. Run "npm run build" before deploying OpenCode config.',
    );
  }
  const generated = renderOpenCodeProjectConfig(root);
  const mergedMcp = objectValue(existing.mcp);
  delete mergedMcp.remediator;
  const existingRemediator = objectValue(objectValue(existing.agent).remediator);
  const mergedAgent = {
    ...objectValue(existing.agent),
    remediator: {
      ...existingRemediator,
      ...generated.agent.remediator,
      permission: mergePermissionBlock(
        existingRemediator.permission,
        generated.agent.remediator.permission,
      ),
    },
  };
  // Top-level permission: non-bash rules keep the agent-scope merge. The
  // top-level bash is the union ceiling of EVERY final agent's bash block — a
  // true global privilege ceiling, order-stable and idempotent regardless of
  // which installer regenerates the file. User-authored top-level bash keys the
  // union does not manage are preserved (non-clobber).
  const topPermission = mergePermissionBlock(existing.permission, generated.permission);
  topPermission.bash = composeOpenCodeBashCeiling(
    objectValue(existing.permission).bash,
    collectAgentBashRuleSets(mergedAgent),
  );
  return {
    ...existing,
    $schema: existing.$schema ?? generated.$schema,
    command: removeManagedOpenCodeCommand(existing.command),
    mcp: mergedMcp,
    permission: topPermission,
    agent: mergedAgent,
  };
}
