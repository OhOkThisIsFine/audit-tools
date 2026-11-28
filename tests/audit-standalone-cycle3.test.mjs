import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";

import { runAuditStep } from "../dist/audit/cli/auditStep.js";
import { executeAndRecord } from "../dist/audit/cli/nextStepHelpers.js";
import { recoverFoldReceipt } from "../dist/audit/cli/foldTransaction.js";
import { questionWorkloadBindings } from "../dist/audit/cli/questionWorkloadBindings.js";
import { loadArtifactBundle } from "../dist/audit/io/artifacts.js";
import { foldReceiptPath } from "../dist/audit/io/foldReceiptPath.js";
import { decideNextStep } from "../dist/audit/orchestrator/nextStep.js";
import { EXECUTOR_RUNNERS } from "../dist/audit/orchestrator/executorRunners.js";
import { withArtifactTreeHold } from "../dist/shared/io/artifactTreeHold.js";
import { artifactTreeLockPath } from "../dist/shared/io/auditToolsPaths.js";

const source = "value.ts";
const hash = "a".repeat(64);
const manifest = { files: [{ path: source, hash, size_bytes: 17 }] };
const json = async path => JSON.parse(await fsp.readFile(path, "utf8"));
const put = (path, value) => fsp.writeFile(path, JSON.stringify(value));

async function fixture(t) {
  const temp = await fsp.realpath(tmpdir());
  const root = await fsp.mkdtemp(join(temp, "audit-standalone-cycle3-"));
  const artifactsDir = join(root, "artifacts");
  await fsp.mkdir(artifactsDir);
  t.after(async () => {
    const name = relative(temp, await fsp.realpath(root));
    assert.ok(name.startsWith("audit-standalone-cycle3-") && !name.includes(sep));
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(join(root, source), "first\nsecond\nthird");
  await put(join(artifactsDir, "repo_manifest.json"), manifest);
  // Terminal-source fixture: exercise the real artifact hold and advance adapter
  // without acquiring a snapshot or invoking external analyzers.
  await put(join(artifactsDir, "audit_state.json"), { status: "complete" });
  return { root, artifactsDir, runLog: false };
}

function patchBuiltin(t, target, property, replacement) {
  const mock = t.mock.method(target, property, replacement);
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return mock;
}

test("standalone journals exact writes and prunes before touching core, then fold recovery replays them", async t => {
  const options = await fixture(t);
  const { artifactsDir } = options;
  const receiptPath = foldReceiptPath(artifactsDir);
  const prunePath = join(artifactsDir, "git_history.json");
  await put(prunePath, { entries: [] });
  const newManifest = { ...manifest, repository: "changed" };
  t.mock.method(EXECUTOR_RUNNERS, "intake_executor", async bundle => ({
    updated: { ...bundle, repo_manifest: newManifest, git_history: undefined },
    artifacts_written: ["repo_manifest.json"],
    progress_summary: "Synthetic core update",
  }));
  const originalRename = fsp.rename;
  const originalUnlink = fsp.unlink;
  const manifestPath = join(artifactsDir, "repo_manifest.json");
  let wroteManifest = false;
  const rename = patchBuiltin(t, fsp, "rename", async (from, to) => {
    if (to === manifestPath) {
      const receipt = await json(receiptPath);
      assert.deepEqual(receipt.core.writes.repo_manifest, newManifest);
      assert.deepEqual(receipt.applied, []);
      assert.deepEqual(receipt.snapshots, []);
      assert.ok(receipt.core.prunes.includes("git_history"));
      wroteManifest = true;
    }
    return originalRename(from, to);
  });
  const unlink = patchBuiltin(t, fsp, "unlink", async path => {
    if (path === prunePath) {
      assert.ok(wroteManifest);
      throw new Error("fixture interrupted before prune");
    }
    return originalUnlink(path);
  });
  await assert.rejects(runAuditStep({ ...options, preferredExecutor: "intake_executor" }), /fixture interrupted before prune/u);
  assert.deepEqual(await json(manifestPath), newManifest);
  assert.deepEqual(await json(prunePath), { entries: [] });

  await assert.rejects(runAuditStep({ ...options, preferredExecutor: "synthesis_executor" }), /incomplete fold receipt/u);
  assert.deepEqual(await json(prunePath), { entries: [] });
  rename.mock.restore();
  unlink.mock.restore();
  syncBuiltinESMExports();
  await withArtifactTreeHold(artifactsDir, undefined, async owns => {
    assert.equal(await recoverFoldReceipt(artifactsDir, owns), true);
    assert.equal(await recoverFoldReceipt(artifactsDir, owns), false);
  });
  const loaded = await loadArtifactBundle(artifactsDir);
  assert.deepEqual(loaded.repo_manifest, newManifest);
  assert.equal(loaded.git_history, undefined);
  assert.equal(loaded.audit_state.last_executor, "intake_executor");
  await assert.rejects(fsp.stat(receiptPath), { code: "ENOENT" });
});

test("standalone without hold ownership cannot publish its core redo or write core", async t => {
  const options = await fixture(t);
  const path = join(options.artifactsDir, "repo_manifest.json");
  const before = await fsp.readFile(path);
  const lock = artifactTreeLockPath(options.artifactsDir);
  t.mock.method(EXECUTOR_RUNNERS, "intake_executor", async bundle => {
    await fsp.writeFile(lock, "fixture successor owner");
    return {
      updated: { ...bundle, repo_manifest: { ...manifest, repository: "not owned" } },
      artifacts_written: ["repo_manifest.json"], progress_summary: "Synthetic core update",
    };
  });
  await assert.rejects(runAuditStep({ ...options, preferredExecutor: "intake_executor" }), /File lock ownership lost/u);
  assert.deepEqual(await fsp.readFile(path), before);
  assert.equal(await fsp.readFile(lock, "utf8"), "fixture successor owner");
  await assert.rejects(fsp.stat(foldReceiptPath(options.artifactsDir)), { code: "ENOENT" });
});

test("candidate advance avoids unused line reads, but actual reviewer bindings measure admitted source", async t => {
  const options = await fixture(t);
  const path = join(options.root, source);
  const originalReadStream = fs.createReadStream;
  let lineReads = 0;
  patchBuiltin(t, fs, "createReadStream", (file, ...args) => {
    if (file === path) lineReads++;
    return originalReadStream(file, ...args);
  });
  t.mock.method(EXECUTOR_RUNNERS, "intake_executor", async (bundle, { options }) => {
    assert.equal(Object.hasOwn(options, "lineIndex"), false);
    assert.equal(Object.hasOwn(options, "sizeIndex"), false);
    return { updated: bundle, artifacts_written: [], progress_summary: "Fixture dispatch" };
  });
  await runAuditStep({ ...options, preferredExecutor: "intake_executor" });
  assert.equal(lineReads, 0, "standalone must not stream every manifest file");
  const bundle = await loadArtifactBundle(options.artifactsDir);
  const decision = decideNextStep(bundle, { emitStaleness: false });
  assert.ok(decision.selected_executor in EXECUTOR_RUNNERS, "fixture must reach a deterministic runner");
  if (decision.selected_executor !== "intake_executor") {
    t.mock.method(EXECUTOR_RUNNERS, decision.selected_executor, EXECUTOR_RUNNERS.intake_executor);
  }
  const result = await executeAndRecord({ ...options, sourceRoot: options.root }, undefined,
    decision, 0, "", bundle, { failureRef: { value: {} } });
  assert.equal(result.progress_summary, "Fixture dispatch");
  assert.equal(lineReads, 0, "fold dispatch must not stream every manifest file");

  const [binding] = await questionWorkloadBindings({
    repo_manifest: manifest,
    file_disposition: { files: [{ path: source, status: "included" }] },
    review_plan: {
      inventory: [],
      questions: [{
        question_id: "behavior:fixture", plan_status: "pending", revision_id: "revision",
        snapshot_id: "snapshot", inventory_item_ids: [], evidence_dependencies: [], source_dependencies: [],
      }],
    },
  }, options.root, []);
  assert.deepEqual(binding.sourceFiles, [{ path: source, line_count: 3, fingerprint: hash }]);
  assert.equal(lineReads, 1, "review binding must measure the actual file");
  await fsp.unlink(path);
  await assert.rejects(questionWorkloadBindings({
    repo_manifest: manifest,
    file_disposition: { files: [{ path: source, status: "included" }] },
    review_plan: { inventory: [], questions: [binding.question] },
  }, options.root, []), /Cannot measure admitted audit source/u);
});
