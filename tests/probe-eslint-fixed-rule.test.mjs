import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { qualifyFixedRuleRows } from "../scripts/shared/probe-eslint-fixed-rule.mjs";

test("fixed-rule ESLint probe preserves clean rows and refuses incomplete results", () => {
  const clean = resolve("clean.js"), affected = resolve("affected.js");
  /** @param {string} filePath @param {{ruleId: string, severity: number, line: number}[]} [messages] */
  const row = (filePath, messages = []) =>
    ({ filePath, messages, fatalErrorCount: 0, warningCount: 0, errorCount: messages.length, suppressedMessages: [] });
  const a = row(clean), b = row(affected, [{ ruleId: "no-debugger", severity: 2, line: 1 }]);
  const expected = [clean, affected];
  assert.deepEqual(qualifyFixedRuleRows(JSON.stringify([a, b]), 1, expected), [
    { path: affected, findings: [{ rule: "no-debugger", line: 1 }] }, { path: clean, findings: [] },
  ]);
  for (const invalid of [[b], [a, a, b], [a, { ...b, fatalErrorCount: 1 }], [a, row(affected)],
    [a, b, row(resolve("extra.js"))], [a, row(affected, [{ ruleId: "other", severity: 2, line: 1 }])],
    [a, { ...b, suppressedMessages: [{}] }]]) {
    assert.throws(() => qualifyFixedRuleRows(JSON.stringify(invalid), 1, expected));
  }
});
