/**
 * Tests for opencodePermissions.ts — merge logic covering subtle precedence
 * rules in mergeOpenCodeAgentPermissionRule, mergeOpenCodeGlobalPermissionRule,
 * and migrateOpenCodeGlobalExternalDirectory.
 *
 * Regression lock for FND-TST-1c3aec1a.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  mergeOpenCodeAgentPermissionRule,
  mergeOpenCodeGlobalPermissionRule,
  migrateOpenCodeGlobalExternalDirectory,
  withoutOpenCodeWildcard,
  OPENCODE_MANAGED_BROAD_VALUE,
} = await import("../src/opencodePermissions.ts");

// ── withoutOpenCodeWildcard ────────────────────────────────────────────────────

test("withoutOpenCodeWildcard removes the wildcard key", () => {
  const result = withoutOpenCodeWildcard({ "*": "allow", bash: "allow", read: "ask" });
  assert.equal(result["*"], undefined);
  assert.equal(result.bash, "allow");
  assert.equal(result.read, "ask");
});

test("withoutOpenCodeWildcard is a no-op on an object without a wildcard", () => {
  const original = { bash: "allow", read: "ask" };
  const result = withoutOpenCodeWildcard(original);
  assert.deepEqual(result, original);
  // Must return a copy, not mutate.
  assert.notEqual(result, original);
});

// ── mergeOpenCodeAgentPermissionRule ─────────────────────────────────────────

test("mergeOpenCodeAgentPermissionRule: generated rule seeds defaults", () => {
  const result = mergeOpenCodeAgentPermissionRule(
    undefined,
    { "*": "allow", bash: "allow" },
  );
  assert.equal(result["*"], "allow");
  assert.equal(result.bash, "allow");
});

test("mergeOpenCodeAgentPermissionRule: existing non-wildcard wins over generated", () => {
  // The existing config has bash='ask'; the generated rule has bash='allow'.
  // After merge, 'ask' must win (user preference over generated default).
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "allow", bash: "ask" },
    { "*": "allow", bash: "allow" },
  );
  assert.equal(result.bash, "ask", "existing non-wildcard key wins over generated");
});

test("mergeOpenCodeAgentPermissionRule: managed rules win over existing", () => {
  // Even if the user has bash='ask', a managed rule bash='deny' wins.
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "allow", bash: "ask" },
    { "*": "allow", bash: "allow" },
    { bash: "deny" },
  );
  assert.equal(result.bash, "deny", "managed rules win over existing");
});

test("mergeOpenCodeAgentPermissionRule: managed wildcard wins", () => {
  const result = mergeOpenCodeAgentPermissionRule(
    { "*": "ask" },
    { "*": "allow" },
    { "*": "deny" },
  );
  assert.equal(result["*"], "deny", "managed wildcard wins over existing wildcard");
});

test("mergeOpenCodeAgentPermissionRule: string existing rule becomes wildcard", () => {
  // If existingRule is a plain string (old format), it should become {"*": string}.
  const result = mergeOpenCodeAgentPermissionRule(
    "ask",
    { "*": "allow", bash: "allow" },
  );
  assert.equal(result["*"], "ask", "string existing value promotes to wildcard");
  assert.equal(result.bash, "allow", "generated non-wildcard keys are still present");
});

test("mergeOpenCodeAgentPermissionRule: non-object generated rule returns existing", () => {
  // When generatedRule is not an object, the existing value should be returned.
  const result = mergeOpenCodeAgentPermissionRule({ "*": "ask" }, null);
  assert.deepEqual(result, { "*": "ask" });
});

test("mergeOpenCodeAgentPermissionRule: wildcard defaults to 'ask' when absent from both", () => {
  // Neither existing nor generated has a wildcard — should default to 'ask'.
  const result = mergeOpenCodeAgentPermissionRule(
    { bash: "allow" },
    { read: "allow" },
  );
  assert.equal(result["*"], "ask", "missing wildcard defaults to 'ask'");
});

// ── mergeOpenCodeGlobalPermissionRule ─────────────────────────────────────────

test("mergeOpenCodeGlobalPermissionRule: never seeds a wildcard", () => {
  // Even if the generated rule has a wildcard, the global merge must not emit it.
  const result = mergeOpenCodeGlobalPermissionRule(
    {},
    { "*": "allow", bash: "allow" },
  );
  assert.equal(result["*"], undefined, "global merge must never seed a wildcard");
  assert.equal(result.bash, "allow");
});

test("mergeOpenCodeGlobalPermissionRule: preserves non-managed existing wildcard", () => {
  // An existing wildcard that is NOT the managed broad value should be preserved.
  const result = mergeOpenCodeGlobalPermissionRule(
    { "*": "ask", bash: "allow" },
    {},
  );
  assert.equal(result["*"], "ask", "non-managed existing wildcard must be preserved");
});

test("mergeOpenCodeGlobalPermissionRule: removes managed broad wildcard ('allow')", () => {
  // An existing wildcard of exactly the managed broad value should be removed.
  const result = mergeOpenCodeGlobalPermissionRule(
    { "*": OPENCODE_MANAGED_BROAD_VALUE },
    {},
  );
  assert.equal(
    result["*"],
    undefined,
    "managed broad wildcard ('allow') must be removed as migration cleanup",
  );
});

test("mergeOpenCodeGlobalPermissionRule: existing non-wildcard wins over generated", () => {
  const result = mergeOpenCodeGlobalPermissionRule(
    { bash: "ask" },
    { bash: "allow" },
  );
  assert.equal(result.bash, "ask", "existing non-wildcard wins over generated (global scope)");
});

test("mergeOpenCodeGlobalPermissionRule: managed rules win over existing (non-wildcard only)", () => {
  const result = mergeOpenCodeGlobalPermissionRule(
    { bash: "ask" },
    { bash: "allow" },
    { bash: "deny" },
  );
  assert.equal(result.bash, "deny", "managed non-wildcard wins over existing in global scope");
});

test("mergeOpenCodeGlobalPermissionRule: managed wildcard is stripped in global scope", () => {
  // Even a managed wildcard must not be emitted in global scope.
  const result = mergeOpenCodeGlobalPermissionRule(
    {},
    {},
    { "*": "allow", bash: "deny" },
  );
  assert.equal(result["*"], undefined, "managed wildcard must not appear in global scope result");
  assert.equal(result.bash, "deny", "managed non-wildcard key is applied");
});

test("mergeOpenCodeGlobalPermissionRule: string existing becomes wildcard (and is removed if managed value)", () => {
  // If existingRule is a plain string equal to the managed broad value, it is removed.
  const result = mergeOpenCodeGlobalPermissionRule(
    OPENCODE_MANAGED_BROAD_VALUE, // "allow"
    { bash: "allow" },
  );
  assert.equal(result["*"], undefined, "string existing = managed broad value must be removed");
  assert.equal(result.bash, "allow");
});

// ── migrateOpenCodeGlobalExternalDirectory ────────────────────────────────────

test("migrateOpenCodeGlobalExternalDirectory: drops entire entry when wildcard = managed value and no other keys", () => {
  const result = migrateOpenCodeGlobalExternalDirectory({ "*": OPENCODE_MANAGED_BROAD_VALUE });
  assert.equal(
    result,
    undefined,
    "entry with only a managed broad wildcard must return undefined (drop it)",
  );
});

test("migrateOpenCodeGlobalExternalDirectory: strips wildcard but keeps other keys", () => {
  const result = migrateOpenCodeGlobalExternalDirectory({
    "*": OPENCODE_MANAGED_BROAD_VALUE,
    "/home/user/project": "allow",
  });
  assert.equal(result["*"], undefined, "managed wildcard must be stripped");
  assert.equal(result["/home/user/project"], "allow", "other keys must be preserved");
});

test("migrateOpenCodeGlobalExternalDirectory: non-managed wildcard is not touched", () => {
  const input = { "*": "ask", "/home/user/project": "allow" };
  const result = migrateOpenCodeGlobalExternalDirectory(input);
  assert.deepEqual(result, input, "non-managed wildcard must be returned untouched");
});

test("migrateOpenCodeGlobalExternalDirectory: non-object values are returned as-is", () => {
  assert.equal(migrateOpenCodeGlobalExternalDirectory(null), null);
  assert.equal(migrateOpenCodeGlobalExternalDirectory(undefined), undefined);
  assert.equal(migrateOpenCodeGlobalExternalDirectory("allow"), "allow");
  const arr = ["allow"];
  assert.deepEqual(migrateOpenCodeGlobalExternalDirectory(arr), arr);
});

test("migrateOpenCodeGlobalExternalDirectory: entry without wildcard is returned as-is", () => {
  const input = { "/home/user": "allow" };
  const result = migrateOpenCodeGlobalExternalDirectory(input);
  assert.deepEqual(result, input);
});
