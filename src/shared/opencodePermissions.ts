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

// ── Union permission ceiling (INV-RCI-16, reframed) ──────────────────────────
//
// The shared repo-root opencode.json carries one top-level `permission.bash`
// plus one bash block per agent (auditor, remediator, …). The top-level block
// is NOT one agent's private policy — it is the deterministic **union ceiling**:
// the broadest privilege any agent needs, so both installers can regenerate the
// shared file in any order, idempotently, without breaking the invariant. The
// old model (top-level pinned byte-equal to the auditor block) is retired: it
// made the two installers mutually blind (one greenlit exactly the state the
// other rejected) and broke the moment the remediate installer's commands
// landed at top-level.

/**
 * Privilege rank for a bash permission value. A higher rank is broader
 * (grants more). Unknown values rank below `deny` so a malformed value never
 * silently widens the ceiling.
 */
const OPENCODE_PRIVILEGE_RANK: Record<string, number> = {
  allow: 3,
  ask: 2,
  deny: 1,
};

function privilegeRank(value: unknown): number {
  return typeof value === "string" ? (OPENCODE_PRIVILEGE_RANK[value] ?? 0) : 0;
}

/**
 * Deterministic, order-stable union of every agent's bash rule set into one
 * top-level privilege ceiling. The result is a plain object whose keys are
 * emitted in a stable, content-derived order (`"*"` first, then the remaining
 * keys sorted lexicographically) so re-deriving it never churns the artifact's
 * content hash.
 *
 * Semantics, per command key `K`:
 * - Wildcard `"*"`: the broadest wildcard across all agents (allow > ask >
 *   deny). If no agent sets one, it defaults to `"ask"`.
 * - A non-wildcard `K` any agent explicitly `allow`s → ceiling `allow` (at
 *   least one agent needs it, so the ceiling must permit it).
 * - Otherwise a `K` any agent explicitly `deny`s → ceiling `deny` (a shared
 *   deny — e.g. `rm *`, `audit-code synthesize*` — survives at the ceiling).
 * - A `K` no agent mentions explicitly is omitted (covered by the wildcard).
 *
 * This is a true privilege ceiling: it introduces no command no agent needs,
 * and every agent's own rules remain a subset of it. Each agent block still
 * carries its own (possibly more restrictive) wildcard + denies, so widening
 * the ceiling to `allow` never silently grants a read-only agent another
 * agent's mutating commands — least-privilege is enforced per-agent.
 */
export function unionOpenCodeBashCeiling(
  agentBashRuleSets: Array<Record<string, unknown> | null | undefined>,
): PermissionRule {
  const sets = agentBashRuleSets.map(permissionRuleObject);

  let ceilingWildcard = "ask";
  let ceilingWildcardRank = privilegeRank(ceilingWildcard);
  for (const set of sets) {
    const rank = privilegeRank(set["*"]);
    if (rank > ceilingWildcardRank) {
      ceilingWildcardRank = rank;
      ceilingWildcard = set["*"] as string;
    }
  }

  const keys = new Set<string>();
  for (const set of sets) {
    for (const key of Object.keys(set)) {
      if (key !== "*") keys.add(key);
    }
  }

  const ceiling: PermissionRule = { "*": ceilingWildcard };
  for (const key of [...keys].sort()) {
    let anyAllow = false;
    let anyDeny = false;
    for (const set of sets) {
      const value = set[key];
      if (value === "allow") anyAllow = true;
      else if (value === "deny") anyDeny = true;
    }
    if (anyAllow) ceiling[key] = "allow";
    else if (anyDeny) ceiling[key] = "deny";
    // else: covered by the wildcard, omit.
  }
  return ceiling;
}

/**
 * Compose the top-level bash block an installer should write: the managed union
 * ceiling of all agents (emitted in its stable, content-derived order — `"*"`
 * first, then sorted keys) followed by any user-authored top-level keys the
 * union does not cover (appended in sorted order, non-clobber). The result is
 * therefore order-stable regardless of which installer ran last: the managed
 * portion is always the same sorted union, so re-running either installer in
 * any order is byte-idempotent and never churns the artifact's content hash.
 */
export function composeOpenCodeBashCeiling(
  existingTopBash: Record<string, unknown> | null | undefined,
  agentBashRuleSets: Array<Record<string, unknown> | null | undefined>,
): PermissionRule {
  const ceiling = unionOpenCodeBashCeiling(agentBashRuleSets);
  const existing = permissionRuleObject(existingTopBash);
  const composed: PermissionRule = { ...ceiling };
  // Append user-authored keys the union does not manage, in a stable sorted
  // order so their placement can't churn either.
  for (const key of Object.keys(existing).sort()) {
    if (!Object.prototype.hasOwnProperty.call(composed, key)) {
      composed[key] = existing[key] as string;
    }
  }
  return composed;
}

/**
 * A single subset/no-unneeded/least-privilege violation found by
 * {@link verifyOpenCodeBashCeiling}.
 */
export interface OpenCodeCeilingViolation {
  kind:
    | "agent_not_subset"
    | "ceiling_unneeded_command"
    | "ceiling_value_mismatch";
  key: string;
  detail: string;
}

/**
 * Reframed INV-RCI-16 verifier. Confirms that `topLevelBash` is exactly the
 * union ceiling of `agentBashRuleSets`, which mechanically enforces all three
 * reframed properties in one check:
 *
 * 1. **Subset** — every agent's explicit rule is reflected in the ceiling at a
 *    value at least as broad, so no agent can run a command the ceiling denies.
 * 2. **No unneeded command** — the ceiling introduces no command key that no
 *    agent needs (extra top-level keys are flagged).
 * 3. **Least-privilege deny** — a shared `deny` (e.g. `rm *`) is preserved at
 *    the ceiling rather than being widened away by another agent's wildcard
 *    `allow`; each agent block keeps its own denies so a broad ceiling wildcard
 *    never grants an agent a command it must not run.
 *
 * Mutually key-aware by construction: it consumes the full agent-rule-set list,
 * so it accepts each installer's keys in the shared block — either installer can
 * regenerate the file and this verifier greenlights the same state.
 *
 * By default the "no unneeded command" property is enforced strictly: a
 * top-level key no agent needs is a violation. This is the right check for the
 * fully tool-generated committed asset. Pass `allowExtraTopLevelKeys: true` to
 * relax it for a real user config, where a user may add their own top-level
 * bash rules that the installer preserves (non-clobber) — those must not count
 * as tool-introduced unneeded commands.
 *
 * Returns an empty array when the ceiling is valid; otherwise one entry per
 * violation. Callers throw/report as they see fit.
 */
export function verifyOpenCodeBashCeiling(
  topLevelBash: Record<string, unknown> | null | undefined,
  agentBashRuleSets: Array<Record<string, unknown> | null | undefined>,
  options: { allowExtraTopLevelKeys?: boolean } = {},
): OpenCodeCeilingViolation[] {
  const top = permissionRuleObject(topLevelBash);
  const expected = unionOpenCodeBashCeiling(agentBashRuleSets);
  const violations: OpenCodeCeilingViolation[] = [];

  // Every expected ceiling key must be present at the expected value: this
  // covers subset (an agent-allowed command must be allowed at the ceiling) and
  // least-privilege (a shared deny must remain a deny).
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(top, key)) {
      violations.push({
        kind: "agent_not_subset",
        key,
        detail: `top-level bash is missing "${key}" (expected "${value}" from the agent union).`,
      });
    } else if (top[key] !== value) {
      violations.push({
        kind: "ceiling_value_mismatch",
        key,
        detail: `top-level bash["${key}"] is "${String(top[key])}" but the agent union requires "${value}".`,
      });
    }
  }

  // No top-level key may exist that the union does not require: the ceiling
  // must introduce no command no agent needs. Skipped when the caller is
  // verifying a live user config that may legitimately carry extra user keys.
  if (!options.allowExtraTopLevelKeys) {
    for (const key of Object.keys(top)) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        violations.push({
          kind: "ceiling_unneeded_command",
          key,
          detail: `top-level bash["${key}"] is not needed by any agent (no agent block requests it).`,
        });
      }
    }
  }

  return violations;
}
