import test from "node:test";
import assert from "node:assert/strict";

const { DISPATCH_QUOTA_V1ALPHA1, DISPATCH_QUOTA_V1ALPHA2 } = await import(
  "../src/quota/index.ts"
);

test("DISPATCH_QUOTA_V1ALPHA1 equals the v1alpha1 version string", () => {
  assert.equal(DISPATCH_QUOTA_V1ALPHA1, "audit-code-dispatch-quota/v1alpha1");
});

test("DISPATCH_QUOTA_V1ALPHA2 equals the v1alpha2 version string", () => {
  assert.equal(DISPATCH_QUOTA_V1ALPHA2, "audit-code-dispatch-quota/v1alpha2");
});

test("DISPATCH_QUOTA constants are distinct", () => {
  assert.notEqual(DISPATCH_QUOTA_V1ALPHA1, DISPATCH_QUOTA_V1ALPHA2);
});
