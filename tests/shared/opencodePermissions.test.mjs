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
  unionOpenCodeBashCeiling,
  composeOpenCodeBashCeiling,
  verifyOpenCodeBashCeiling,
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

// ── unionOpenCodeBashCeiling ──────────────────────────────────────────────────

test("unionOpenCodeBashCeiling: wildcard is the broadest across agents", () => {
  // auditor '*': 'allow' is broader than remediator '*': 'ask' → ceiling allow.
  const ceiling = unionOpenCodeBashCeiling([{ "*": "allow" }, { "*": "ask" }]);
  expect(ceiling["*"], "broadest wildcard wins the ceiling").toBe("allow");
});

test("unionOpenCodeBashCeiling: defaults wildcard to 'ask' when no agent sets one", () => {
  const ceiling = unionOpenCodeBashCeiling([{ "cmd a": "allow" }, { "cmd b": "allow" }]);
  expect(ceiling["*"]).toBe("ask");
});

test("unionOpenCodeBashCeiling: a command any agent allows is allowed at the ceiling", () => {
  // Only the remediator needs 'remediate-code'; the ceiling must permit it so
  // the remediator's own commands are within the ceiling.
  const ceiling = unionOpenCodeBashCeiling([
    { "*": "allow", "audit-code": "allow" },
    { "*": "ask", "remediate-code": "allow" },
  ]);
  expect(ceiling["audit-code"]).toBe("allow");
  expect(ceiling["remediate-code"]).toBe("allow");
});

test("unionOpenCodeBashCeiling: a shared deny survives at the ceiling (no allow wins)", () => {
  // Both agents deny 'rm *'; no agent allows it → ceiling deny (least-privilege).
  const ceiling = unionOpenCodeBashCeiling([
    { "*": "allow", "rm *": "deny" },
    { "*": "ask", "rm *": "deny" },
  ]);
  expect(ceiling["rm *"], "a command every mentioning agent denies stays denied").toBe("deny");
});

test("unionOpenCodeBashCeiling: allow beats deny when agents disagree on a key", () => {
  // If one agent allows and another denies the same key, the ceiling (max
  // privilege) allows it; the denying agent keeps its own deny in its block.
  const ceiling = unionOpenCodeBashCeiling([
    { "cmd": "allow" },
    { "cmd": "deny" },
  ]);
  expect(ceiling["cmd"]).toBe("allow");
});

test("unionOpenCodeBashCeiling: a key no agent mentions is omitted (covered by wildcard)", () => {
  const ceiling = unionOpenCodeBashCeiling([{ "*": "allow" }, { "*": "ask" }]);
  expect(Object.keys(ceiling)).toEqual(["*"]);
});

test("unionOpenCodeBashCeiling: order-stable ('*' first, then keys sorted)", () => {
  const ceiling = unionOpenCodeBashCeiling([
    { "*": "allow", "z cmd": "allow", "a cmd": "allow" },
    { "m cmd": "allow" },
  ]);
  expect(Object.keys(ceiling), "keys are '*' then lexicographic — deterministic, no churn").toEqual([
    "*",
    "a cmd",
    "m cmd",
    "z cmd",
  ]);
});

test("unionOpenCodeBashCeiling: tolerates null/undefined/non-object agent sets", () => {
  const ceiling = unionOpenCodeBashCeiling([null, undefined, { "*": "allow", cmd: "allow" }, "nope"]);
  expect(ceiling["*"]).toBe("allow");
  expect(ceiling.cmd).toBe("allow");
});

// ── composeOpenCodeBashCeiling ────────────────────────────────────────────────

test("composeOpenCodeBashCeiling: managed union first (stable order), user extras appended sorted", () => {
  const auditor = { "*": "allow", "audit-code": "allow" };
  const existingTop = { "*": "ask", "npm test*": "allow", "aaa user*": "allow" };
  const composed = composeOpenCodeBashCeiling(existingTop, [auditor]);
  // Managed union keys come first in their own stable order; the wildcard is
  // the broadest (allow), NOT the user's stale 'ask'.
  expect(composed["*"]).toBe("allow");
  expect(composed["audit-code"]).toBe("allow");
  // User-only extras survive, appended in sorted order after the union.
  expect(composed["npm test*"]).toBe("allow");
  expect(composed["aaa user*"]).toBe("allow");
  const keys = Object.keys(composed);
  expect(keys.indexOf("audit-code"), "managed key precedes user extras").toBeLessThan(
    keys.indexOf("aaa user*"),
  );
  expect(keys.indexOf("aaa user*"), "user extras appended in sorted order").toBeLessThan(
    keys.indexOf("npm test*"),
  );
});

test("composeOpenCodeBashCeiling: order-stable regardless of which installer ran last", () => {
  const auditor = { "*": "allow", "audit-code": "allow", "rm *": "deny" };
  const remediator = { "*": "ask", "remediate-code": "allow", "rm *": "deny" };
  // Simulate audit-then-remediate vs remediate-then-audit: the managed portion
  // is the SAME sorted union either way, so the composed block is byte-equal.
  const auditFirst = composeOpenCodeBashCeiling(
    composeOpenCodeBashCeiling(undefined, [auditor]),
    [auditor, remediator],
  );
  const remFirst = composeOpenCodeBashCeiling(
    composeOpenCodeBashCeiling(undefined, [remediator]),
    [auditor, remediator],
  );
  expect(
    JSON.stringify(auditFirst),
    "top-level bash must be byte-identical regardless of installer order (no hash churn)",
  ).toBe(JSON.stringify(remFirst));
});

test("composeOpenCodeBashCeiling: idempotent — re-composing over its own output is a no-op", () => {
  const auditor = { "*": "allow", "audit-code": "allow", "rm *": "deny" };
  const once = composeOpenCodeBashCeiling(undefined, [auditor]);
  const twice = composeOpenCodeBashCeiling(once, [auditor]);
  expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
});

// ── verifyOpenCodeBashCeiling (reframed INV-RCI-16) ───────────────────────────

test("verifyOpenCodeBashCeiling: a correct union ceiling has zero violations", () => {
  const auditor = { "*": "allow", "audit-code": "allow", "rm *": "deny" };
  const remediator = { "*": "ask", "remediate-code": "allow", "rm *": "deny" };
  const ceiling = unionOpenCodeBashCeiling([auditor, remediator]);
  expect(verifyOpenCodeBashCeiling(ceiling, [auditor, remediator])).toEqual([]);
});

test("verifyOpenCodeBashCeiling: flags an agent command missing from the ceiling (not a subset)", () => {
  const auditor = { "*": "allow", "audit-code": "allow" };
  const remediator = { "*": "ask", "remediate-code": "allow" };
  // A ceiling that forgot the remediator's command → subset violation.
  const badCeiling = { "*": "allow", "audit-code": "allow" };
  const violations = verifyOpenCodeBashCeiling(badCeiling, [auditor, remediator]);
  expect(violations.some((v) => v.kind === "agent_not_subset" && v.key === "remediate-code")).toBe(true);
});

test("verifyOpenCodeBashCeiling: flags a ceiling command no agent needs (unneeded)", () => {
  const auditor = { "*": "allow", "audit-code": "allow" };
  const badCeiling = { "*": "allow", "audit-code": "allow", "unneeded cmd": "allow" };
  const violations = verifyOpenCodeBashCeiling(badCeiling, [auditor]);
  expect(violations.some((v) => v.kind === "ceiling_unneeded_command" && v.key === "unneeded cmd")).toBe(true);
});

test("verifyOpenCodeBashCeiling: flags a value mismatch (deny widened to allow at the ceiling)", () => {
  const auditor = { "*": "allow", "rm *": "deny" };
  const remediator = { "*": "ask", "rm *": "deny" };
  // A ceiling that widened the shared deny to allow → least-privilege violation.
  const badCeiling = { "*": "allow", "rm *": "allow" };
  const violations = verifyOpenCodeBashCeiling(badCeiling, [auditor, remediator]);
  expect(violations.some((v) => v.kind === "ceiling_value_mismatch" && v.key === "rm *")).toBe(true);
});

test("verifyOpenCodeBashCeiling: allowExtraTopLevelKeys lets a preserved user key through", () => {
  const auditor = { "*": "allow", "audit-code": "allow" };
  const ceiling = unionOpenCodeBashCeiling([auditor]);
  // A user added their own top-level bash rule; the installer preserves it.
  const withUserKey = { ...ceiling, "npm test*": "allow" };
  // Strict mode flags it as unneeded...
  expect(
    verifyOpenCodeBashCeiling(withUserKey, [auditor]).some(
      (v) => v.kind === "ceiling_unneeded_command" && v.key === "npm test*",
    ),
  ).toBe(true);
  // ...but the relaxed mode accepts the preserved user key.
  expect(
    verifyOpenCodeBashCeiling(withUserKey, [auditor], { allowExtraTopLevelKeys: true }),
  ).toEqual([]);
});

test("verifyOpenCodeBashCeiling: mutually key-aware — accepts either installer's keys", () => {
  // Whichever installer regenerated the block, the verifier consumes the full
  // agent list, so it greenlights the union both would produce.
  const auditor = { "*": "allow", "audit-code next-step*": "allow", "rm *": "deny" };
  const remediator = { "*": "ask", "remediate-code next-step*": "allow", "rm *": "deny" };
  const ceiling = unionOpenCodeBashCeiling([auditor, remediator]);
  // Same result regardless of the order agents are listed (order-independent union).
  expect(verifyOpenCodeBashCeiling(ceiling, [remediator, auditor])).toEqual([]);
});
