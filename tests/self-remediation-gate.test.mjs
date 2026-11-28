import assert from "node:assert/strict";
import test from "node:test";
import { runRemediationGateSmoke } from "../scripts/remediate/smoke-remediate-gate.mjs";

test("remediation's own final gate uses the replacement suite and refuses its failure", async () => {
  const { failed } = await runRemediationGateSmoke();
  assert.equal(failed, 0, "the built gate smoke must pass every fixture check");
});
