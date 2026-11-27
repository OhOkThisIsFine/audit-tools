import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { catalogCommands } from "../scripts/shared/verify-steps.mjs";
import { DOC_MANIFEST } from "../scripts/doc-manifest-data.mjs";
import { PINS, legCommand } from "../scripts/shared/derived-file-preflight.mjs";

const root = new URL("../", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
test("CI, publishing and development use the replacement without dropping the release checks", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.match(scripts.test, /npm run build && npm run test:built/);
  assert.equal(scripts["test:built"], "node scripts/shared/run-contract-tests.mjs");
  const workflow = name => YAML.parse(read(".github/workflows/" + name + ".yml")).jobs;
  const ci = workflow("audit-code-test-suite");
  const publish = workflow("publish-package");
  for (const job of [ci["orchestration-tests"], publish.test]) {
    assert.ok(job.steps.some(step => step.run === "npm test"));
    assert.ok(job.steps.every(step => !step.run?.includes("vitest")));
  }
  assert.deepEqual(publish.publish.needs, ["validate-source", "gate", "test"]);
  assert.ok(publish.gate.steps.some(step => step.run?.includes("npm run verify:checks")));
  assert.ok(publish.publish.steps.some(step => step.with?.["artifact-ids"] === "${{ needs.gate.outputs.artifact_id }}"));
  const checks = catalogCommands("checks");
  const release = catalogCommands("release");
  assert.ok(checks.some(command => command.label === "check:generated-artifacts"));
  assert.ok(release.some(command => command.args.includes("scripts/shared/run-contract-tests.mjs")));
});
test("staged release metadata has a build-free witness and rejects stray runner filters", () => {
  assert.deepEqual(PINS.get("scripts/guard-reach-data.mjs"), ["tests/release-wiring.test.mjs"]);
  assert.equal(legCommand({script:"test", testPath:"tests/release-wiring.test.mjs"}).command, "node --test tests/release-wiring.test.mjs");
  assert.ok(DOC_MANIFEST.find(row=>row.type==="ops / usage").files.includes("tests/README.md"));
  const result = spawnSync(process.execPath, ["scripts/shared/run-contract-tests.mjs", "untrusted-filter"], {cwd:root, encoding:"utf8", windowsHide:true});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support filters/);
});
