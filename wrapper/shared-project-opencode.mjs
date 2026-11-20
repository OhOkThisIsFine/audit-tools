// sites-pinned: tests/shared/installer-host-compatibility.test.ts, tests/shared/install-bootstrap-opencode-stability.test.ts
// Project installs need all four operations. A missing or older build still
// permits loading the wrapper and reports the rebuild advice at the merge.
/** @type {Partial<typeof import('audit-tools/shared')>} */
const shared = await import('audit-tools/shared').catch(() => ({}));
/** @returns {never} */
export function unavailableProjectPermissions() {
  throw new Error('audit-tools/shared is not available. Run "npm run build" before deploying OpenCode config.');
}

export const {
  mergeOpenCodeAgentPermissionRule = unavailableProjectPermissions,
  withoutOpenCodeWildcard = unavailableProjectPermissions,
  migrateOpenCodeGlobalExternalDirectory = unavailableProjectPermissions,
  composeOpenCodeBashCeiling = unavailableProjectPermissions,
} = shared;
export const sharedOpenCodePermissions = [
  mergeOpenCodeAgentPermissionRule,
  withoutOpenCodeWildcard,
  migrateOpenCodeGlobalExternalDirectory,
  composeOpenCodeBashCeiling,
].every(helper => typeof helper === 'function' && helper !== unavailableProjectPermissions);
