import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareConceptualDispatch } from "../dist/audit/cli/conceptualDispatch.js";
import { functionalPreflightPath, functionalPreflightStep } from "../dist/audit/cli/functionalPreflight.js";
import { writeCurrentStep } from "../dist/audit/cli/steps.js";
import { readExistingRunConsentUnlocked } from "../dist/shared/analyzerRunConsent.js";

const cli = fileURLToPath(new URL("../audit-code.mjs", import.meta.url));
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-status-publication-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const steps = join(artifactsDir, "steps");
  await mkdir(steps, { recursive: true });
  const status = async expectedExitCode => {
    const response = await exec(process.execPath, [cli, "status", "--root", root], {
      cwd: root, windowsHide: true, timeout: 15000,
    }).then(result => ({ code: 0, ...result }), error => error);
    assert.equal(response.code, expectedExitCode, response.stderr);
    return JSON.parse(response.stdout);
  };
  return { root, artifactsDir, stepPath: join(steps, "current-step.json"), status };
}

const damagedPublications = [
  ["malformed JSON", path => writeFile(path, "{malformed")],
  ["schema-invalid JSON", path => writeFile(path, JSON.stringify({ step_kind: "design_review_conceptual" }))],
  ["directory in place of the file", path => mkdir(path)],
];

function assertUnavailable(report, stepPath) {
  assert.equal(report.current_step.state, "unavailable");
  assert.equal(report.current_step.path, stepPath);
  assert.match(report.current_step.summary, /could not verify continuation/i);
  assert.equal(report.current_step.step_kind, undefined);
  assert.equal(report.current_step.action, undefined);
  assert.equal(report.functional_preflight, undefined);
  assert.equal(report.conceptual_review_progress, undefined);
}

test("before state exists, only absence reports no active audit; verified preflight still offers continuation", async t => {
  const { root, artifactsDir, stepPath, status } = await fixture(t);
  assert.equal((await status(1)).status, "no_active_audit");
  for (const [description, damage] of damagedPublications) {
    await t.test(description, async () => {
      await damage(stepPath);
      const report = await status(1);
      assert.equal(report.status, "current_step_unavailable");
      assertUnavailable(report, stepPath);
      await rm(stepPath, { recursive: true });
    });
  }

  await writeCurrentStep(await functionalPreflightStep(root, artifactsDir));
  const consent = await readExistingRunConsentUnlocked(root, artifactsDir);
  await writeFile(functionalPreflightPath(artifactsDir), JSON.stringify({
    contract_version: "audit-functional-preflight/v1",
    run_id: consent.run_id, repository_root: consent.repository_root,
    source_inspection: { available: true, evidence: "Fixture source inspection." },
    relationship_inspection: { available: true, evidence: "Fixture relationship inspection." },
    decision: "ready",
  }));
  const report = await status(0);
  assert.equal(report.current_step, undefined);
  assert.deepEqual(report.functional_preflight, {
    run_id: consent.run_id, status: "ready", summary: "Functional preflight is ready. Run next-step to continue.",
  });
  assert.equal(report.status, "preflight");
});

test("active conceptual state retains its summary without inventing progress from an unavailable publication", async t => {
  const { root, artifactsDir, stepPath, status } = await fixture(t);
  await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({
    status: "active", last_obligation: "conceptual",
    obligations: [{ id: "conceptual", state: "present" }],
  }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir, sourceRoot: root, bundle: {}, settings: { conceptual_depth: "shallow" },
  });
  await writeFile(stepPath, JSON.stringify({
    contract_version: "audit-code-step/v1alpha1", status: "ready",
    step_kind: "design_review_conceptual", run_id: null,
    artifacts_dir: artifactsDir, repo_root: root, artifact_paths: dispatch.artifactPaths,
    prompt_path: join(artifactsDir, "unused.md"), allowed_commands: [], stop_condition: "Synthetic fixture",
  }));
  assert.equal((await status(0)).conceptual_review_progress.action, "dispatch_reviewer");
  await rm(stepPath);
  const absent = await status(0);
  assert.equal(absent.status, "active");
  assert.equal(absent.current_step, undefined);
  assert.equal(absent.conceptual_review_progress, undefined);
  for (const [description, damage] of damagedPublications) {
    await t.test(description, async () => {
      await damage(stepPath);
      const report = await status(0);
      assertUnavailable(report, stepPath);
      const { current_step, ...state } = report;
      assert.deepEqual(state, absent);
      assert.equal(state.last_obligation, "conceptual");
      assert.equal(state.obligations_summary.present, 1);
      await rm(stepPath, { recursive: true });
    });
  }
});
