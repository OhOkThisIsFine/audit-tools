import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanupStaleArtifactsDir } from "../dist/audit/cli/cleanup.js";
import { ensureRunSnapshot } from "../dist/audit/io/runSnapshot.js";

async function fixture(t) {
  const temp = await fs.realpath(tmpdir());
  const dir = await fs.mkdtemp(join(temp, "audit-cleanup-cycle3-"));
  const remove = fs.rm;
  const root = join(dir, "repo");
  const owned = join(root, "output", "working");
  const sibling = join(dirname(owned), "neighbor");
  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = { [homeKey]: process.env[homeKey], AUDIT_CODE_STATE_DIR: process.env.AUDIT_CODE_STATE_DIR };
  process.env[homeKey] = dir;
  process.env.AUDIT_CODE_STATE_DIR = join(dir, "state");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const path = relative(temp, await fs.realpath(dir));
    assert.ok(path.startsWith("audit-cleanup-cycle3-") && !path.split(sep)[1]);
    await remove(dir, { recursive: true, force: true });
  });
  await fs.mkdir(owned, { recursive: true });
  await fs.mkdir(sibling);
  await fs.writeFile(join(root, "fixture.txt"), "source");
  const git = (...args) => promisify(execFile)("git", args, { cwd: root, windowsHide: true });
  await git("init", "--quiet");
  await git("config", "core.hooksPath", join(dir, "no-hooks"));
  await git("add", "fixture.txt");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const snapshot = await ensureRunSnapshot(root, owned);
  const neighborSnapshot = await ensureRunSnapshot(root, sibling);
  const marker = join(owned, "audit_state.json");
  const record = join(owned, "run-snapshot.json");
  const evidence = join(owned, "audit-report.md");
  const promoted = join(dirname(owned), "audit-findings.json");
  await fs.writeFile(marker, JSON.stringify({ status: "active" }));
  await fs.writeFile(evidence, "working evidence");
  await fs.writeFile(promoted, "promoted evidence");
  const clean = (target = owned, force = true) => cleanupStaleArtifactsDir(target, {
    force, requireAuditMarker: true, repositoryRoot: root, explicitTarget: { root, custom: true },
  });
  return { dir, root, owned, sibling, marker, record, evidence, promoted, snapshot, neighborSnapshot, git, clean };
}

for (const acquiring of [false, true]) {
  test(`forced custom cleanup retries after snapshot teardown (${acquiring ? "acquisition" : "published"} record)`, async t => {
    const { owned, sibling, marker, record, evidence, promoted, snapshot, neighborSnapshot, git, clean } = await fixture(t);
    const retained = acquiring ? join(owned, "run-snapshot-acquiring.json") : record;
    if (acquiring) await fs.rename(record, retained);
    const recordBytes = await fs.readFile(retained);
    const remove = fs.rm;
    // Fault only the first sweep of this exact fixture file, after real Git
    // teardown and before cleanup finishes deleting the run's artifacts.
    const patch = t.mock.method(fs, "rm", async (path, options) => {
      if (path === evidence) throw new Error("fixture sweep interruption");
      return remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(clean(), /fixture sweep interruption/);
    } finally {
      patch.mock.restore();
      syncBuiltinESMExports();
    }
    await assert.rejects(fs.stat(snapshot.source_root), { code: "ENOENT" });
    await assert.rejects(git("show-ref", "--verify", snapshot.pins[0].ref));
    assert.ok(!(await git("worktree", "list", "--porcelain")).stdout.includes(snapshot.pins[0].path.split(sep).join("/")));
    assert.deepEqual(await fs.readFile(retained), recordBytes);
    assert.equal(JSON.parse(await fs.readFile(marker)).status, "active");
    assert.equal(await fs.readFile(evidence, "utf8"), "working evidence");
    assert.equal((await clean()).action, "deleted");
    await assert.rejects(fs.stat(owned), { code: "ENOENT" });
    assert.equal(await fs.readFile(join(neighborSnapshot.source_root, "fixture.txt"), "utf8"), "source");
    await git("show-ref", "--verify", neighborSnapshot.pins[0].ref);
    assert.ok((await fs.stat(join(sibling, "run-snapshot.json"))).isFile());
    assert.equal(await fs.readFile(promoted, "utf8"), "promoted evidence");
  });
}

for (const failAt of ["receipt", "record"]) {
  test(`forced retry finishes exact terminal residue after the marker is removed (${failAt})`, async t => {
    const { owned, sibling, marker, record, evidence, promoted, snapshot, neighborSnapshot, git, clean } = await fixture(t);
    const receipt = join(owned, "cleanup-sweep.json");
    await fs.writeFile(receipt, "{}");
    const original = await fs.readFile(record);
    const remove = fs.rm;
    const patch = t.mock.method(fs, "rm", async (path, options) => {
      if (path === (failAt === "receipt" ? receipt : record)) throw new Error("fixture tail interruption");
      return remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(clean(), /fixture tail interruption/);
    } finally {
      patch.mock.restore();
      syncBuiltinESMExports();
    }
    for (const path of [marker, evidence, snapshot.source_root]) {
      await assert.rejects(fs.stat(path), { code: "ENOENT" });
    }
    assert.deepEqual(await fs.readFile(record), original);
    await fs.writeFile(evidence, "unexpected payload");
    assert.match((await clean()).reason, /no longer has its identity marker/);
    assert.equal(await fs.readFile(evidence, "utf8"), "unexpected payload");
    await fs.rm(evidence);
    await fs.copyFile(join(sibling, "run-snapshot.json"), record);
    assert.match((await clean()).reason, /no longer has its identity marker/);
    await fs.writeFile(record, original);
    assert.equal((await clean()).action, "deleted");
    await assert.rejects(fs.stat(owned), { code: "ENOENT" });
    await git("show-ref", "--verify", neighborSnapshot.pins[0].ref);
    assert.equal(await fs.readFile(promoted, "utf8"), "promoted evidence");
  });
}

test("cleanup keeps ownership boundaries, pending folds and unpromoted evidence", async t => {
  const { root, owned, sibling, marker, record, evidence, snapshot, clean } = await fixture(t);
  assert.match((await clean(owned, false)).reason, /audit is active/);
  await fs.rm(marker);
  await fs.rm(evidence);
  assert.match((await clean()).reason, /no longer has its identity marker/);
  assert.equal(await fs.readFile(join(snapshot.source_root, "fixture.txt"), "utf8"), "source");
  await fs.writeFile(evidence, "working evidence");
  await fs.writeFile(marker, JSON.stringify({ status: "complete" }));
  assert.match((await clean(owned, false)).reason, /not fully promoted/);
  const fold = join(owned, ".fold-receipt.json");
  await fs.writeFile(fold, "{}");
  assert.match((await clean()).reason, /incomplete fold receipt/);
  await fs.rm(fold);
  const original = await fs.readFile(record);
  await fs.copyFile(join(sibling, "run-snapshot.json"), record);
  await assert.rejects(clean(), /source_root is not the owned source directory/);
  await fs.writeFile(record, original);
  const unrelated = join(root, "unrelated");
  await fs.mkdir(unrelated);
  await fs.copyFile(marker, join(unrelated, "audit_state.json"));
  await assert.rejects(clean(unrelated), /expected exactly one working-run snapshot record/);
  const alias = join(root, "alias");
  const lstat = fs.lstat;
  let linkProbe;
  try {
    await fs.symlink(owned, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    // Restricted Windows runners cannot make reparse points. Exercise the
    // same lstat rejection without creating a link or skipping the assertion.
    await fs.mkdir(alias);
    linkProbe = t.mock.method(fs, "lstat", async (path, ...options) =>
      path === alias ? { isDirectory: () => true, isSymbolicLink: () => true } : lstat(path, ...options));
    syncBuiltinESMExports();
    t.diagnostic("Windows fixture reparse points unavailable; simulated lstat link bit");
  }
  try {
    await assert.rejects(clean(alias), /unsafe directory topology/);
  } finally {
    if (linkProbe) {
      linkProbe.mock.restore();
      syncBuiltinESMExports();
    }
  }
  assert.equal(await fs.readFile(evidence, "utf8"), "working evidence");
  assert.equal(await fs.readFile(join(snapshot.source_root, "fixture.txt"), "utf8"), "source");
});
