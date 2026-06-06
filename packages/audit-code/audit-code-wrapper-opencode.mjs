export const OPENCODE_AUDIT_EDIT_PERMISSION = {
  '*': 'ask',
  '.audit-code/**': 'allow',
  '.audit-artifacts/**': 'allow',
  'audit-report.md': 'allow',
};

export const OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION = { '*': 'allow' };

export const OPENCODE_AUDIT_BASH_PERMISSION = {
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
  'Select-String *': 'allow',
  'rm *': 'deny',
};

function externalDirectoryPattern(path) {
  return `${path.replace(/\\/g, '/').replace(/\/+$/u, '')}/**`;
}

function renderOpenCodeExternalDirectoryPermission() {
  return { '*': 'allow' };
}

export function renderOpenCodePermissionConfig() {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    external_directory: renderOpenCodeExternalDirectoryPermission(),
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

export function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

export function mergeOpenCodePermissionRule(existingRule, generatedRule, managedRules = {}) {
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

export function mergeOpenCodePermissionConfig(existingPermission, generatedPermission) {
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
      OPENCODE_AUDIT_EXTERNAL_DIRECTORY_PERMISSION,
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

export function buildMergedOpenCodeProjectConfig(existing, root) {
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
