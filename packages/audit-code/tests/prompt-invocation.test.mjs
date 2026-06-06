import test from "node:test";
import assert from "node:assert/strict";
import {
  nextStepCommand,
  mergeAndIngestCommand,
} from "../src/cli/prompts.ts";

function withInvocation(value, fn) {
  const prev = process.env.AUDIT_CODE_INVOCATION;
  if (value === undefined) delete process.env.AUDIT_CODE_INVOCATION;
  else process.env.AUDIT_CODE_INVOCATION = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AUDIT_CODE_INVOCATION;
    else process.env.AUDIT_CODE_INVOCATION = prev;
  }
}

test("continuation commands default to the audit-code bin when no invocation hint is set", () => {
  withInvocation(undefined, () => {
    assert.match(
      nextStepCommand("/repo", "/repo/.audit-tools/audit"),
      /^audit-code next-step --root \/repo --artifacts-dir /,
    );
    assert.match(
      mergeAndIngestCommand("/repo/.audit-tools/audit", "run-1"),
      /^audit-code merge-and-ingest --artifacts-dir .* --run-id run-1$/,
    );
  });
});

test("continuation commands honor AUDIT_CODE_INVOCATION (source-checkout dogfooding)", () => {
  withInvocation(
    JSON.stringify(["node", "C:/Code/audit-tools/packages/audit-code/audit-code.mjs"]),
    () => {
      const cmd = nextStepCommand("/repo", "/repo/.audit-tools/audit");
      assert.match(cmd, /^node /);
      assert.match(cmd, /audit-code\.mjs next-step/);
      assert.doesNotMatch(cmd, /^audit-code /);
      assert.match(
        mergeAndIngestCommand("/repo/.audit-tools/audit", "run-1"),
        /^node .*audit-code\.mjs merge-and-ingest /,
      );
    },
  );
});

test("continuation commands emit POSIX separators so Windows backslash paths survive a bash host", () => {
  withInvocation(
    JSON.stringify(["node", "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs"]),
    () => {
      // Backslash invocation path AND backslash root/artifacts-dir args.
      const next = nextStepCommand("C:\\Code\\repo", "C:\\Code\\repo\\.audit-tools/audit");
      const merge = mergeAndIngestCommand("C:\\Code\\repo\\.audit-tools/audit", "run-1");
      // No backslash may survive: a bash host treats `\` as an escape and would
      // collapse `node C:\a\b.mjs` to `node C:ab.mjs`.
      assert.doesNotMatch(next, /\\/);
      assert.doesNotMatch(merge, /\\/);
      assert.match(
        next,
        /^node C:\/Code\/audit-tools\/packages\/audit-code\/audit-code\.mjs next-step --root C:\/Code\/repo --artifacts-dir C:\/Code\/repo\/\.audit-tools\/audit$/,
      );
      assert.match(merge, /--run-id run-1$/);
    },
  );
});

test("malformed AUDIT_CODE_INVOCATION falls back to the audit-code bin", () => {
  withInvocation("not-json", () => {
    assert.match(nextStepCommand("/repo", "/a"), /^audit-code next-step /);
  });
  // Non-array JSON and empty array are also rejected.
  withInvocation("{}", () => {
    assert.match(nextStepCommand("/repo", "/a"), /^audit-code /);
  });
  withInvocation("[]", () => {
    assert.match(nextStepCommand("/repo", "/a"), /^audit-code /);
  });
});
