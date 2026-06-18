/**
 * OpenCode permission deployment helpers shared by the audit-code and
 * remediate-code install flows (postinstall scripts and the remediate-code
 * `ensure` command). Two named scopes exist:
 *
 * - **Global top-level scope** — the `permission` block at the root of
 *   `~/.config/opencode/opencode.json`. This scope must never seed broad
 *   allows: no `bash["*"] = "allow"` and no forced
 *   `external_directory["*"] = "allow"`. It also actively migrates away
 *   previously deployed broad rules whose value exactly matches the
 *   historically managed value (`"allow"`); a matching value is treated as
 *   tool-managed and removed even if it happened to be user-authored
 *   (accepted safer failure direction). Any non-matching value (e.g. `"ask"`,
 *   `"deny"`, or a different rule shape) is left completely untouched.
 * - **Agent scope** — a per-agent `permission` block (e.g.
 *   `agent.auditor.permission`). This scope keeps the
 *   broad-allow-with-denylist deployment unchanged.
 */

/** The broad value the deploy helpers historically wrote ("tool-managed"). */
export const OPENCODE_MANAGED_BROAD_VALUE = "allow";

type PermissionRule = Record<string, string>;

function permissionRuleObject(value: unknown): PermissionRule {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PermissionRule)
    : {};
}

/** Returns a copy of `rules` without its `"*"` wildcard entry. */
export function withoutOpenCodeWildcard(rules: PermissionRule): PermissionRule {
  const copy: PermissionRule = { ...rules };
  delete copy["*"];
  return copy;
}

/**
 * Agent-scope rule merge: generated rules seed the entry, existing
 * non-wildcard user entries win over generated ones, and managed rules always
 * win (including a managed wildcard when the caller provides one — pass
 * `withoutOpenCodeWildcard(rules)` to let an existing wildcard survive).
 */
export function mergeOpenCodeAgentPermissionRule(
  existingRule: unknown,
  generatedRule: unknown,
  managedRules: PermissionRule = {},
): unknown {
  if (
    !generatedRule ||
    typeof generatedRule !== "object" ||
    Array.isArray(generatedRule)
  ) {
    return existingRule ?? generatedRule;
  }
  const generatedObject = generatedRule as PermissionRule;
  const existingObject = permissionRuleObject(existingRule);
  const merged: PermissionRule = {};

  if (typeof existingRule === "string") {
    merged["*"] = existingRule;
  } else {
    merged["*"] = existingObject["*"] ?? generatedObject["*"] ?? "ask";
  }
  for (const [key, value] of Object.entries(generatedObject)) {
    if (key !== "*") merged[key] = value;
  }
  for (const [key, value] of Object.entries(existingObject)) {
    if (key !== "*") merged[key] = value;
  }
  for (const [key, value] of Object.entries(managedRules)) {
    merged[key] = value;
  }
  return merged;
}

/**
 * Global-scope rule merge: never seeds a wildcard. An existing wildcard is
 * preserved verbatim unless it exactly matches the historically managed broad
 * value (`"allow"`), in which case it is removed as migration cleanup.
 * Non-wildcard rules merge like the agent scope (existing wins over
 * generated; managed wins over existing).
 */
export function mergeOpenCodeGlobalPermissionRule(
  existingRule: unknown,
  generatedRule: PermissionRule,
  managedRules: PermissionRule = {},
): PermissionRule {
  const existingObject =
    typeof existingRule === "string"
      ? { "*": existingRule }
      : permissionRuleObject(existingRule);
  const merged: PermissionRule = {};

  const existingWildcard = existingObject["*"];
  if (
    existingWildcard !== undefined &&
    existingWildcard !== OPENCODE_MANAGED_BROAD_VALUE
  ) {
    merged["*"] = existingWildcard;
  }
  for (const [key, value] of Object.entries(generatedRule)) {
    if (key !== "*") merged[key] = value;
  }
  for (const [key, value] of Object.entries(existingObject)) {
    if (key !== "*") merged[key] = value;
  }
  for (const [key, value] of Object.entries(managedRules)) {
    if (key !== "*") merged[key] = value;
  }
  return merged;
}

/**
 * Global-scope `external_directory` migration: the deploy helpers
 * historically forced `external_directory: { "*": "allow" }` at the top
 * level. That broad rule is no longer seeded; when an existing entry's
 * wildcard exactly matches the historically managed value it is removed.
 * Returns `undefined` when the whole entry should be dropped from the
 * permission block; any non-matching value is returned untouched.
 */
export function migrateOpenCodeGlobalExternalDirectory(
  existingRule: unknown,
): unknown {
  if (
    !existingRule ||
    typeof existingRule !== "object" ||
    Array.isArray(existingRule)
  ) {
    return existingRule;
  }
  const existingObject = existingRule as PermissionRule;
  if (existingObject["*"] !== OPENCODE_MANAGED_BROAD_VALUE) {
    return existingRule;
  }
  const rest = withoutOpenCodeWildcard(existingObject);
  return Object.keys(rest).length > 0 ? rest : undefined;
}
