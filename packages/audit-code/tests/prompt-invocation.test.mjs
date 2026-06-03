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
      nextStepCommand("/repo", "/repo/.audit-artifacts"),
      /^audit-code next-step --root \/repo --artifacts-dir /,
    );
    assert.match(
      mergeAndIngestCommand("/repo/.audit-artifacts", "run-1"),
      /^audit-code merge-and-ingest --artifacts-dir .* --run-id run-1$/,
    );
  });
});

test("continuation commands honor AUDIT_CODE_INVOCATION (source-checkout dogfooding)", () => {
  withInvocation(
    JSON.stringify(["node", "C:/Code/audit-tools/packages/audit-code/audit-code.mjs"]),
    () => {
      const cmd = nextStepCommand("/repo", "/repo/.audit-artifacts");
      assert.match(cmd, /^node /);
      assert.match(cmd, /audit-code\.mjs next-step/);
      assert.doesNotMatch(cmd, /^audit-code /);
      assert.match(
        mergeAndIngestCommand("/repo/.audit-artifacts", "run-1"),
        /^node .*audit-code\.mjs merge-and-ingest /,
      );
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
