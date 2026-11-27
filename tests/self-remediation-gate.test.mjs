import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("remediation's own final gate uses the replacement suite and refuses its failure", () => {
  const result = spawnSync(process.execPath, ["scripts/remediate/smoke-remediate-gate.mjs"], {
    cwd: new URL("../", import.meta.url), encoding:"utf8", windowsHide:true, timeout:20000,
  });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
});
