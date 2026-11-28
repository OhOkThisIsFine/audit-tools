import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPackageVersion } from "../dist/audit/io/toolingManifest.js";
import {
  runSystemicChallengeExecutor, systemicChallengeSchemaForBundle,
} from "../dist/audit/orchestrator/systemicChallengeExecutor.js";
import { collectFilesSorted } from "../dist/shared/io/collectFilesSorted.js";

const bundle = {
  intent_checkpoint: { design_review: { ceiling: { rung: "deep" } } },
  repo_manifest: { files: [{ path: "src/example.ts" }] },
};
const stop = { forced: true, reason: "Host ended this round" };

test("ordinary empty findings are quiet, but omission and forced stops do not advance the streak", () => {
  const schema = systemicChallengeSchemaForBundle(bundle);
  for (const incomplete of [{}, { stop }]) {
    const result = schema.safeParse(incomplete);
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0].path, ["findings"]);
  }
  const opened = runSystemicChallengeExecutor(bundle).updated;
  assert.deepEqual(opened.systemic_challenge.rounds, []);

  const quiet = schema.parse({ findings: [] });
  const prior = runSystemicChallengeExecutor(opened, quiet).updated;
  const quietRegister = prior.systemic_challenge;
  assert.deepEqual(quietRegister.rounds.map(r => r.dry), [true]);
  assert.equal(quietRegister.converged, false);
  assert.equal(runSystemicChallengeExecutor(prior, quiet).updated.systemic_challenge.converged, true);

  const forced = runSystemicChallengeExecutor(prior, schema.parse({ findings: [], stop }), "forced-empty");
  const register = forced.updated.systemic_challenge;
  assert.deepEqual(register.rounds.map(r => r.dry), [true, false]);
  assert.equal(register.stop_reason, "host_forced");
  assert.equal(register.converged, false);
  assert.match(forced.progress_summary, /host-forced stop recorded/);
  assert.doesNotMatch(forced.progress_summary, /loop converged|quiet round/);
});

test("a forced stop banks findings, stays non-quiet, and replays without another round", () => {
  const submission = systemicChallengeSchemaForBundle(bundle).parse({
    findings: [{
      id: "synthetic", category: "confirmed_defect", title: "Synthetic improvement",
      severity: "medium", confidence: "high", lens: "behavior", summary: "Synthetic",
      affected_files: [{ path: "src/example.ts" }], evidence: ["Synthetic evidence"],
    }],
    stop,
  });
  const folded = runSystemicChallengeExecutor(bundle, submission, "forced-with-finding").updated;
  const register = folded.systemic_challenge;
  assert.equal(register.findings.length, 1);
  assert.equal(register.findings[0].title, submission.findings[0].title);
  assert.deepEqual(register.rounds[0].new_finding_ids, [register.findings[0].id]);
  assert.equal(register.rounds[0].dry, false);
  assert.equal(register.stop_reason, "host_forced");
  assert.equal(register.converged, false);
  const replay = runSystemicChallengeExecutor(folded, submission, "forced-with-finding");
  assert.deepEqual(replay.updated.systemic_challenge, register);
});

async function tempRoot(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "state-collection-cycle6-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("file collection appends a large synthetic result from a missing child in sorted order", async t => {
  const root = await tempRoot(t);
  const child = join(root, "child");
  await fs.mkdir(child);
  const originalStat = fs.stat;
  const mockedStat = t.mock.method(fs, "stat", async (path, ...args) => {
    if (path === child) throw Object.assign(new Error("Vanished child"), { code: "ENOENT" });
    return originalStat(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const count = 250_000;
    const synthetic = Array.from({ length: count }, (_, i) =>
      String(count - i).padStart(6, "0"));
    const missing = [];
    const collected = await collectFilesSorted(root, {
      onMissing: path => { missing.push(path); return synthetic; },
    });
    assert.deepEqual(missing, [child]);
    assert.deepEqual(collected, synthetic.slice().reverse());
  } finally {
    mockedStat.mock.restore();
    syncBuiltinESMExports();
  }
});

test("package version is optional on missing, malformed, and inaccessible files", async t => {
  const root = await tempRoot(t);
  const packagePath = join(root, "package.json");
  const diagnostics = [];
  const stderr = t.mock.method(process.stderr, "write", chunk => {
    diagnostics.push(String(chunk));
    return true;
  });
  try {
    assert.equal(await readPackageVersion(root), null);
    assert.deepEqual(diagnostics, []);
    await fs.writeFile(packagePath, '{"version":"1.2.3"}');
    assert.equal(await readPackageVersion(root), "1.2.3");
    assert.deepEqual(diagnostics, []);
    await fs.writeFile(packagePath, "{invalid json");
    assert.equal(await readPackageVersion(root), null);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /readPackageVersion: failed to read\/parse/);

    const denied = () => { throw Object.assign(new Error("Synthetic access denied"), { code: "EACCES" }); };
    const originalStat = fs.stat, originalRead = fs.readFile;
    const mockedStat = t.mock.method(fs, "stat", (path, ...args) =>
      path === packagePath ? denied() : originalStat(path, ...args));
    const mockedRead = t.mock.method(fs, "readFile", (path, ...args) =>
      path === packagePath ? denied() : originalRead(path, ...args));
    syncBuiltinESMExports();
    try {
      assert.equal(await readPackageVersion(root), null);
      assert.equal(mockedStat.mock.callCount(), 0);
      assert.equal(mockedRead.mock.callCount(), 1);
      assert.equal(diagnostics.length, 2);
      assert.match(diagnostics[1], /readPackageVersion: failed to read\/parse .*Synthetic access denied/);
    } finally {
      mockedRead.mock.restore();
      mockedStat.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    stderr.mock.restore();
  }
});
