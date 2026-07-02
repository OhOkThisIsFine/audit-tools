/**
 * Tests for opencodePermissions.ts — merge logic covering subtle precedence
 * rules in mergeOpenCodeAgentPermissionRule, mergeOpenCodeGlobalPermissionRule,
 * and migrateOpenCodeGlobalExternalDirectory.
 *
 * Regression lock for FND-TST-1c3aec1a.
 */
import { test, expect } from "vitest";

const {
  mergeOpenCodeAgentPermissionRule,
  mergeOpenCodeGlobalPermissionRule,
  migrateOpenCodeGlobalExternalDirectory,
  withoutOpenCodeWildcard,
  OPENCODE_MANAGED_BROAD_VALUE,
} = await import("../../src/shared/opencodePermissions.ts");

// ── withoutOpenCodeWildcard ────────────────────────────────────────────────────

test("withoutOpenCodeWildcard removes the wildcard key", () => {
  const result = withoutOpenCodeWildcard({ "*": "allow", bash: "allow", read: "ask" });
  expect(result["*"]).toBe(undefined);
  expect(result.bash).toBe("allow");
  expect(result.read).toBe("ask");
});

test("withoutOpenCodeWildcard is a no-op on an object without a wildcard", () => {
  const original = { bash: "allow", read: "ask" };
  const result = withoutOpenCodeWildcard(original);
  expect(result).toEqual(original);
  // Must return a copy, not mutate.
  expect(result).not.toBe(original);
});

// ── mergeOpenCodeAgentPermissionRule ─────────────────────────────────────────

test("mergeOpenCodeAgentPermissionRule: generated rule seeds defaults", () => {
  const result = mergeOpenCodeAgentPermissionRule(
    undefined,
    { "*": "allow", bash: "allow" },
  );
  expect(result["*"]).toBe("allow");
  expect(result.bash).toBe("allow");
});

test("mergeOpenCodeAgentPermissionRule: existing non-wildcard wins over generated", () => {
  // The existing config has bash='ask'; the generated rule has bash='allow'.
  // After merge, 'ask' must win (user preference over generated default).
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "allow", bash: "ask" },
    { "*": "allow", bash: "allow" },
  );
  expect(result.bash, "existing non-wildcard key wins over generated").toBe("ask");
});

test("mergeOpenCodeAgentPermissionRule: managed rules win over existing", () => {
  // Even if the user has bash='ask', a managed rule bash='deny' wins.
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "allow", bash: "ask" },
    { "*": "allow", bash: "allow" },
    { bash: "deny" },
  );
  expect(result.bash, "managed rules win over existing").toBe("deny");
});

test("mergeOpenCodeAgentPermissionRule: managed wildcard wins", () => {
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "ask" },
    { "*": "allow" },
    { "*": "deny" },
  );
  expect(result["*"], "managed wildcard wins over existing wildcard").toBe("deny");
});

test("mergeOpenCodeAgentPermissionRule: string existing rule becomes wildcard", () => {
  // If existingRule is a plain string (old format), it should become {"*": string}.
  const result = mergeOpenCodeAgentPermissionRule(
    "ask",
    { "*": "allow", bash: "allow" },
  );
  expect(result["*"], "string existing value promotes to wildcard").toBe("ask");
  expect(result.bash, "generated non-wildcard keys are still present").toBe("allow");
});

test("mergeOpenCodeAgentPermissionRule: non-object generated rule returns existing", () => {
  // When generatedRule is not an object, the existing value should be returned.
  const result = mergeOpenCodeAgentPermissionRule({ "*": "ask" }, null);
  expect(result).toEqual({ "*": "ask" });
});

test("mergeOpenCodeAgentPermissionRule: wildcard defaults to 'ask' when absent from both", () => {
  // Neither existing nor generated has a wildcard — should default to 'ask'.
  const result = mergeOpenCodeAgentPermissionRule(
    { bash: "allow" },
    { read: "allow" },
  );
  expect(result["*"], "missing wildcard defaults to 'ask'").toBe("ask");
});

// ── mergeOpenCodeGlobalPermissionRule ─────────────────────────────────────────

test("mergeOpenCodeGlobalPermissionRule: never seeds a wildcard", () => {
  // Even if the generated rule has a wildcard, the global merge must not emit it.
  const result = mergeOpenCodeGlobalPermissionRule(
    {},
    { "*": "allow", bash: "allow" },
  );
  expect(result["*"], "global merge must never seed a wildcard").toBe(undefined);
  expect(result.bash).toBe("allow");
});

test("mergeOpenCodeGlobalPermissionRule: preserves non-managed existing wildcard", () => {
  // An existing wildcard that is NOT the managed broad value should be preserved.
  const result = mergeOpenCodeGlobalPermissionRule(
    { "*": "ask", bash: "allow" },
    {},
  );
  expect(result["*"], "non-managed existing wildcard must be preserved").toBe("ask");
});

test("mergeOpenCodeGlobalPermissionRule: removes managed broad wildcard ('allow')", () => {
  // An existing wildcard of exactly the managed broad value should be removed.
  const result = mergeOpenCodeGlobalPermissionRule(
    { "*": OPENCODE_MANAGED_BROAD_VALUE },
    {},
  );
  expect(result["*"], "managed broad wildcard ('allow') must be removed as migration cleanup").toBe(undefined);
});

test("mergeOpenCodeGlobalPermissionRule: existing non-wildcard wins over generated", () => {
  const result = mergeOpenCodeGlobalPermissionRule(
    { bash: "ask" },
    { bash: "allow" },
  );
  expect(result.bash, "existing non-wildcard wins over generated (global scope)").toBe("ask");
});

test("mergeOpenCodeGlobalPermissionRule: managed rules win over existing (non-wildcard only)", () => {
  const result = mergeOpenCodeGlobalPermissionRule(
    { bash: "ask" },
    { bash: "allow" },
    { bash: "deny" },
  );
  expect(result.bash, "managed non-wildcard wins over existing in global scope").toBe("deny");
});

test("mergeOpenCodeGlobalPermissionRule: managed wildcard is stripped in global scope", () => {
  // Even a managed wildcard must not be emitted in global scope.
  const result = mergeOpenCodeGlobalPermissionRule(
    {},
    {},
    { "*": "allow", bash: "deny" },
  );
  expect(result["*"], "managed wildcard must not appear in global scope result").toBe(undefined);
  expect(result.bash, "managed non-wildcard key is applied").toBe("deny");
});

test("mergeOpenCodeGlobalPermissionRule: string existing becomes wildcard (and is removed if managed value)", () => {
  // If existingRule is a plain string equal to the managed broad value, it is removed.
  const result = mergeOpenCodeGlobalPermissionRule(
    OPENCODE_MANAGED_BROAD_VALUE, // "allow"
    { bash: "allow" },
  );
  expect(result["*"], "string existing = managed broad value must be removed").toBe(undefined);
  expect(result.bash).toBe("allow");
});

// ── migrateOpenCodeGlobalExternalDirectory ────────────────────────────────────

test("migrateOpenCodeGlobalExternalDirectory: drops entire entry when wildcard = managed value and no other keys", () => {
  const result = migrateOpenCodeGlobalExternalDirectory({ "*": OPENCODE_MANAGED_BROAD_VALUE });
  expect(result, "entry with only a managed broad wildcard must return undefined (drop it)").toBe(undefined);
});

test("migrateOpenCodeGlobalExternalDirectory: strips wildcard but keeps other keys", () => {
  const result = migrateOpenCodeGlobalExternalDirectory({
    "*": OPENCODE_MANAGED_BROAD_VALUE,
    "/home/user/project": "allow",
  });
  expect(result["*"], "managed wildcard must be stripped").toBe(undefined);
  expect(result["/home/user/project"], "other keys must be preserved").toBe("allow");
});

test("migrateOpenCodeGlobalExternalDirectory: non-managed wildcard is not touched", () => {
  const input = { "*": "ask", "/home/user/project": "allow" };
  const result = migrateOpenCodeGlobalExternalDirectory(input);
  expect(result, "non-managed wildcard must be returned untouched").toEqual(input);
});

test("migrateOpenCodeGlobalExternalDirectory: non-object values are returned as-is", () => {
  expect(migrateOpenCodeGlobalExternalDirectory(null)).toBe(null);
  expect(migrateOpenCodeGlobalExternalDirectory(undefined)).toBe(undefined);
  expect(migrateOpenCodeGlobalExternalDirectory("allow")).toBe("allow");
  const arr = ["allow"];
  expect(migrateOpenCodeGlobalExternalDirectory(arr)).toEqual(arr);
});

test("migrateOpenCodeGlobalExternalDirectory: entry without wildcard is returned as-is", () => {
  const input = { "/home/user": "allow" };
  const result = migrateOpenCodeGlobalExternalDirectory(input);
  expect(result).toEqual(input);
});
