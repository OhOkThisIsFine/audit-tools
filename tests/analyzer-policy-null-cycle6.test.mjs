import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getAnalyzerPolicyPath, loadAnalyzerPolicy, persistAnalyzerSettings } from "audit-tools/shared";
import { cmdNextStep } from "../dist/audit/cli/nextStepCommand.js";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "audit-null-analyzer-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = getAnalyzerPolicyPath(root);
  await mkdir(dirname(policyPath), { recursive: true });
  return { root, policyPath };
}

test("missing policy defaults; valid settings survive while legacy consent is ignored", async (t) => {
  const { root, policyPath } = await fixture(t);
  assert.deepEqual(await loadAnalyzerPolicy(root), {});
  const analyzers = { python: "repo", css: "skip" };
  const document = JSON.stringify({ analyzers, analyzer_consent: { fixture: "granted" } });
  await writeFile(policyPath, document);
  assert.deepEqual(await loadAnalyzerPolicy(root), { analyzers });
  assert.equal(await readFile(policyPath, "utf8"), document);
});

test("present JSON null blocks next-step through the existing configuration diagnostic", async (t) => {
  const { root, policyPath } = await fixture(t);
  const document = " \nnull\n";
  await writeFile(policyPath, document);

  // Prove the loader blocks before invoking next-step, so this fixture never
  // reaches the normal audit or analyzer execution branches.
  const isInvalidPolicy = (error) => error.message.startsWith(`Invalid ${policyPath}:`);
  await assert.rejects(loadAnalyzerPolicy(root), isInvalidPolicy);
  await assert.rejects(persistAnalyzerSettings(root, { python: "skip" }), isInvalidPolicy);
  await cmdNextStep(["node", "audit-code", "next-step", "--root", root]);
  const step = JSON.parse(await readFile(join(dirname(policyPath), "steps", "current-step.json"), "utf8"));
  assert.equal(step.step_kind, "blocked");
  assert.equal(step.status, "blocked");
  assert.ok(step.progress.summary.startsWith(`Invalid ${policyPath}:`), step.progress.summary);
  assert.equal(await readFile(policyPath, "utf8"), document);
});
