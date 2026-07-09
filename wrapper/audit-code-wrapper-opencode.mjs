// Best-effort import of shared OpenCode permission helpers.
// On a fresh checkout before `npm run build`, the dist may not exist yet;
// buildMergedOpenCodeProjectConfig throws a clear error in that case.
let mergeOpenCodeAgentPermissionRule;
let withoutOpenCodeWildcard;
let migrateOpenCodeGlobalExternalDirectory;
let composeOpenCodeBashCeiling;
export let sharedOpenCodePermissions = false;

try {
  const shared = await import('audit-tools/shared');
  mergeOpenCodeAgentPermissionRule = shared.mergeOpenCodeAgentPermissionRule;
  withoutOpenCodeWildcard = shared.withoutOpenCodeWildcard;
  migrateOpenCodeGlobalExternalDirectory = shared.migrateOpenCodeGlobalExternalDirectory;
  composeOpenCodeBashCeiling = shared.composeOpenCodeBashCeiling;
  sharedOpenCodePermissions = true;
} catch {
  // shared not yet built — callers that need merge logic will throw below
}

export const OPENCODE_AUDIT_EDIT_PERMISSION = {
  '*': 'ask',
  '.audit-code/**': 'allow',
  '.audit-tools/**': 'allow',
};

// Subcommands allowed for both the global bin and the dev wrapper.
// Adding or removing a subcommand here applies to both invocation forms.
const AUDIT_CODE_ALLOWED_SUBCOMMANDS = [
  'ensure*',
  'next-step*',
  'prepare-dispatch*',
  'submit-packet*',
  'merge-and-ingest*',
  'validate*',
];
// Extra subcommands that only make sense via the dev wrapper (not the global bin).
const AUDIT_CODE_WRAPPER_EXTRA_SUBCOMMANDS = ['worker-run*'];
// Subcommands denied for every invocation form.
const AUDIT_CODE_DENIED_SUBCOMMANDS = ['synthesize*', 'cleanup*', 'requeue*', 'ingest-results*'];

function buildAuditBashPermissions() {
  // Hardened default (parity with the remediator): the wildcard is 'ask', with
  // the audit-code invocations enumerated explicitly below.
  /** @type {Record<string, 'allow' | 'ask' | 'deny'>} */
  const perm = { '*': 'ask' };
  // Deny rules for every form of invocation (bin, dist, wrapper).
  for (const sub of AUDIT_CODE_DENIED_SUBCOMMANDS) {
    perm[`audit-code ${sub}`] = 'deny';
    perm[`*dist*index.js* ${sub}`] = 'deny';
    perm[`*audit-code.mjs* ${sub}`] = 'deny';
  }
  // Allow rules: bare bin and each subcommand for both the global bin and wrapper.
  perm['audit-code'] = 'allow';
  for (const sub of AUDIT_CODE_ALLOWED_SUBCOMMANDS) {
    perm[`audit-code ${sub}`] = 'allow';
    perm[`*audit-code.mjs* ${sub}`] = 'allow';
  }
  perm['*audit-code.mjs'] = 'allow';
  for (const sub of AUDIT_CODE_WRAPPER_EXTRA_SUBCOMMANDS) {
    perm[`*audit-code.mjs* ${sub}`] = 'allow';
  }
  perm['git status*'] = 'allow';
  perm['git diff*'] = 'allow';
  perm['grep *'] = 'allow';
  perm['Select-String *'] = 'allow';
  perm['rm *'] = 'deny';
  return perm;
}

export const OPENCODE_AUDIT_BASH_PERMISSION = buildAuditBashPermissions();

export function renderOpenCodePermissionConfig() {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: { ...OPENCODE_AUDIT_EDIT_PERMISSION },
    bash: { ...OPENCODE_AUDIT_BASH_PERMISSION },
  };
}

export function renderOpenCodeProjectConfig(_root) {
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

export function removeManagedOpenCodeCommand(commandConfig) {
  const command = objectValue(commandConfig);
  const { 'audit-code': _managedAuditCodeCommand, ...remaining } = command;
  return remaining;
}

export function assertOpenCodeAuditPermissionConfig(permissionConfig, label) {
  for (const tool of ['read', 'glob', 'grep']) {
    if (permissionConfig?.[tool] !== 'allow') {
      throw new Error(`OpenCode ${label}.${tool} must be allow. Run "audit-code install --host opencode".`);
    }
  }
  // Hardened shape: no external_directory allow-all (the tool no longer seeds
  // the key at all; a leftover broad rule means a stale pre-hardening deploy).
  const externalDirectory = permissionConfig?.external_directory;
  if (
    externalDirectory === 'allow' ||
    (externalDirectory &&
      typeof externalDirectory === 'object' &&
      !Array.isArray(externalDirectory) &&
      externalDirectory['*'] === 'allow')
  ) {
    throw new Error(`OpenCode ${label}.external_directory must not allow-all (hardened default seeds no external_directory rule). Run "audit-code install --host opencode".`);
  }
  const edit = permissionConfig?.edit;
  const bash = permissionConfig?.bash;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw new Error(`OpenCode ${label}.edit must allow audit-owned file paths. Run "audit-code install --host opencode".`);
  }
  for (const pattern of ['.audit-code/**', '.audit-tools/**']) {
    if (edit[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.edit must allow ${pattern}. Run "audit-code install --host opencode".`);
    }
  }
  if (!bash || typeof bash !== 'object' || Array.isArray(bash)) {
    throw new Error(`OpenCode ${label}.bash must allow audit-code commands. Run "audit-code install --host opencode".`);
  }
  // Hardened shape: the bash wildcard is "ask" (broad "allow" was retired).
  if (bash['*'] !== 'ask') {
    throw new Error(`OpenCode ${label}.bash must set "*" to "ask" (hardened default; broad "allow" was retired). Run "audit-code install --host opencode".`);
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
  ]) {
    if (bash[pattern] !== 'allow') {
      throw new Error(`OpenCode ${label}.bash must allow ${pattern}. Run "audit-code install --host opencode".`);
    }
  }
  for (const pattern of [
    'audit-code synthesize*',
    'audit-code cleanup*',
    'audit-code requeue*',
    'audit-code ingest-results*',
    '*dist*index.js* synthesize*',
    '*dist*index.js* cleanup*',
    '*dist*index.js* requeue*',
    '*dist*index.js* ingest-results*',
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

// A pre-hardening deploy wrote bash['*']='allow' (the historically managed
// broad value). Migrate exactly that value away so the generated 'ask' seed
// wins on regeneration; any other user-authored wildcard survives untouched.
function withoutManagedBroadBashWildcard(rule) {
  const existing = objectValue(rule);
  if (existing['*'] !== 'allow') {
    return rule;
  }
  return withoutOpenCodeWildcard(existing);
}

function mergePermissionBlock(existingPermission, generatedPermission) {
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
      withoutOpenCodeWildcard(OPENCODE_AUDIT_EDIT_PERMISSION),
    ),
    bash: mergeOpenCodeAgentPermissionRule(
      withoutManagedBroadBashWildcard(existing.bash),
      generatedPermission.bash,
      withoutOpenCodeWildcard(OPENCODE_AUDIT_BASH_PERMISSION),
    ),
  };
  // Hardened default: no external_directory rule is seeded. A leftover
  // historically managed allow-all is migrated away; any non-matching
  // user-authored value is preserved untouched.
  const externalDirectory = migrateOpenCodeGlobalExternalDirectory(existing.external_directory);
  if (externalDirectory === undefined) {
    delete merged.external_directory;
  } else {
    merged.external_directory = externalDirectory;
  }
  return merged;
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
  delete mergedMcp.auditor;
  const existingAuditor = objectValue(objectValue(existing.agent).auditor);
  const mergedAgent = {
    ...objectValue(existing.agent),
    auditor: {
      ...existingAuditor,
      ...generated.agent.auditor,
      permission: mergePermissionBlock(
        existingAuditor.permission,
        generated.agent.auditor.permission,
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
