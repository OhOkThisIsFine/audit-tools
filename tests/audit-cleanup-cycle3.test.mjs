import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { format, promisify } from "node:util";
import { cleanupStaleArtifactsDir } from "../dist/audit/cli/cleanup.js";
import { ensureRunSnapshot } from "../dist/audit/io/runSnapshot.js";

async function fixture(t, { defaults = false, withSnapshot = true, withNeighbor = !defaults } = {}) {
  const temp = await fs.realpath(tmpdir());
  const dir = await fs.mkdtemp(join(temp, "audit-cleanup-cycle3-"));
  const remove = fs.rm;
  const root = join(dir, "repo");
  const owned = defaults ? join(root, ".audit-tools", "audit") : join(root, "output", "working");
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
  await fs.writeFile(join(root, "fixture.txt"), "source");
  const git = (...args) => promisify(execFile)("git", args, { cwd: root, windowsHide: true });
  await git("init", "--quiet");
  await git("config", "core.hooksPath", join(dir, "no-hooks"));
  await git("add", "fixture.txt");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const snapshot = withSnapshot ? await ensureRunSnapshot(root, owned) : undefined;
  let neighborSnapshot;
  if (withNeighbor) {
    await fs.mkdir(sibling);
    neighborSnapshot = await ensureRunSnapshot(root, sibling);
  }
  const marker = join(owned, "audit_state.json");
  const record = join(owned, "run-snapshot.json");
  const evidence = join(owned, "audit-report.md");
  const promoted = join(dirname(owned), "audit-findings.json");
  await fs.writeFile(marker, JSON.stringify({ status: defaults ? "not_started" : "active" }));
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

// Run the actual CLI dispatcher in a child process so injected FS faults
// exercise CLI exit status and stderr, not only direct function rejection.
async function runCli(root, artifactsDir, command, { failAt, operation = "rm", keepAtomicTemp = false, flags = [] } = {}) {
  const entry = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const [command, root, artifactsDir, failAt, operation, keepAtomicTemp, ...flags] = process.argv.slice(1);
    if (failAt) {
      let atomicTemp;
      const remove = fs.rm;
      if (keepAtomicTemp === "1") {
        fs.rm = async (path, ...args) => {
          if (path === atomicTemp) throw new Error("fixture abrupt termination");
          return remove(path, ...args);
        };
      }
      const original = fs[operation];
      fs[operation] = async (...args) => {
        if (args[operation === "rename" ? 1 : 0] === failAt) {
          if (operation === "rename") atomicTemp = args[0];
          throw new Error("fixture terminal fault: " + operation);
        }
        return original(...args);
      };
      syncBuiltinESMExports();
    }
    const { runCli } = await import("./dist/audit/cli.js");
    await runCli([process.execPath, "audit-code", command, "--root", root, "--artifacts-dir", artifactsDir, ...flags]);
  `;
  try {
    const output = await promisify(execFile)(process.execPath,
      ["--input-type=module", "-e", entry, "--", command, root, artifactsDir, failAt ?? "", operation, keepAtomicTemp ? "1" : "0", ...flags],
      { windowsHide: true });
    return { code: 0, ...output };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const terminalField = "cleanup_terminal_sweep";

// These checks have no injected fault or child-exit behavior of their
// own. Use the real dispatcher without starting a new Node process for each
// payload/flag permutation or clean retry. The injected interruption and a
// markerless retry still cross the child boundary. Restore the process state.
async function dispatchInProcess(root, artifactsDir, command, flags = []) {
  const { runCli: dispatch } = await import("../dist/audit/cli.js");
  const { log, error } = console;
  const exitCode = process.exitCode;
  let stdout = "", stderr = "";
  try {
    process.exitCode = undefined;
    console.log = (...args) => { stdout += format(...args) + "\n"; };
    console.error = (...args) => { stderr += format(...args) + "\n"; };
    await dispatch([process.execPath, "audit-code", command, "--root", root, "--artifacts-dir", artifactsDir, ...flags]);
    return { code: process.exitCode ?? 0, stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
}

for (const stage of ["transition", "rewrite", "receipt", "record", "marker", "rmdir"]) {
  test("default cleanup exits safely and retries after interruption at " + stage, async t => {
    const withSnapshot = stage === "transition" || stage === "receipt" || stage === "record";
    const { root, owned, marker, record, evidence, snapshot, git } = await fixture(t, { defaults: true, withSnapshot });
    const receipt = join(owned, "cleanup-terminal-sweep.json");
    const failAt = { transition: receipt, rewrite: marker, receipt, record, marker, rmdir: owned }[stage];
    const operation = stage === "transition" || stage === "rewrite" ? "rename" : stage === "rmdir" ? "rmdir" : "rm";
    const initial = await runCli(root, owned, "cleanup", { failAt, operation });
    assert.equal(initial.code, 1, initial.stderr || initial.stdout);
    assert.match(JSON.parse(initial.stdout).reason, /fixture terminal fault/);
    await assert.rejects(fs.stat(evidence), { code: "ENOENT" });
    if (withSnapshot) {
      await assert.rejects(fs.stat(snapshot.source_root), { code: "ENOENT" });
      await assert.rejects(git("show-ref", "--verify", snapshot.pins[0].ref));
    }
    if (stage === "rmdir") {
      assert.deepEqual(await fs.readdir(owned), []);
      await fs.writeFile(evidence, "markerless payload");
      for (const flags of [[], ["--force"]]) {
        const refused = flags.length ? await runCli(root, owned, "cleanup", { flags }) : await dispatchInProcess(root, owned, "cleanup");
        assert.equal(refused.code, 1, refused.stdout);
        assert.equal(await fs.readFile(evidence, "utf8"), "markerless payload");
      }
      await fs.rm(evidence);
      const custom = join(root, "markerless-custom");
      await fs.mkdir(custom);
      for (const flags of [[], ["--force"]]) {
        assert.equal((await dispatchInProcess(root, custom, "cleanup", flags)).code, 1);
      }
    } else {
      const state = JSON.parse(await fs.readFile(marker));
      assert.equal(Object.hasOwn(state, terminalField), stage !== "rewrite" && stage !== "transition");
      if (stage === "transition") {
        const originalRecord = await fs.readFile(record);
        const originalReceipt = join(owned, "cleanup-sweep.json");
        const receiptBytes = await fs.readFile(originalReceipt);
        await fs.rm(record);
        const refused = await dispatchInProcess(root, owned, "cleanup");
        assert.equal(refused.code, 1);
        assert.match(JSON.parse(refused.stdout).reason, /snapshot ownership no longer matches/);
        assert.deepEqual(await fs.readFile(originalReceipt), receiptBytes);
        await fs.writeFile(record, originalRecord);
        await fs.writeFile(evidence, "replacement after failed transition");
        for (const command of ["cleanup", "next-step"]) {
          const foreign = command === "next-step" ? await runCli(root, owned, command) : await dispatchInProcess(root, owned, command);
          assert.equal(foreign.code, 1);
          assert.match(foreign.stderr || foreign.stdout, /Unexpected sweep payload not covered by its receipt/);
          assert.equal(await fs.readFile(evidence, "utf8"), "replacement after failed transition");
          assert.deepEqual(await fs.readFile(originalReceipt), receiptBytes);
          await assert.rejects(fs.stat(join(owned, "steps")), { code: "ENOENT" });
        }
        await fs.rm(evidence);
        const fold = join(owned, ".fold-receipt.json");
        await fs.writeFile(fold, "{}");
        const pending = await dispatchInProcess(root, owned, "next-step");
        assert.equal(pending.code, 1);
        assert.match(pending.stderr, /incomplete fold receipt prevents terminal cleanup/);
        assert.equal(await fs.readFile(fold, "utf8"), "{}");
        await assert.rejects(fs.stat(join(owned, "steps")), { code: "ENOENT" });
        await fs.rm(fold);
      }
      if (stage === "marker") assert.deepEqual(await fs.readdir(owned), ["audit_state.json"]);
    }
    const retry = stage === "rmdir" ? runCli : dispatchInProcess;
    const result = await retry(root, owned, "cleanup");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).action, stage === "rmdir" ? "already-complete" : "deleted");
    if (stage === "rmdir") assert.deepEqual(await fs.readdir(owned), []);
    else await assert.rejects(fs.stat(owned), { code: "ENOENT" });
  });
}

for (const withSnapshot of [false, true]) {
  test("next-step terminal retry preserves strict inventory on transient " +
      (withSnapshot ? "record" : "receipt") + " failure", async t => {
    const { root, owned, sibling, marker, record } = await fixture(t, { defaults: true, withSnapshot, withNeighbor: withSnapshot });
    const receipt = join(owned, "cleanup-terminal-sweep.json");
    const failAt = withSnapshot ? record : receipt;
    const stranded = await runCli(root, owned, "cleanup", { failAt });
    assert.equal(stranded.code, 1, stranded.stderr || stranded.stdout);
    const inventory = await fs.readdir(owned);
    const identity = await fs.readFile(marker);
    assert.ok(JSON.parse(identity)[terminalField]);
    await fs.writeFile(join(owned, "unexpected.txt"), "unexpected payload");
    const unexpected = await dispatchInProcess(root, owned, "next-step");
    assert.equal(unexpected.code, 1);
    assert.match(unexpected.stderr, /Unexpected terminal sweep entry/);
    assert.equal(await fs.readFile(join(owned, "unexpected.txt"), "utf8"), "unexpected payload");
    await fs.rm(join(owned, "unexpected.txt"));
    const control = withSnapshot ? record : receipt;
    const controlBytes = await fs.readFile(control);
    if (withSnapshot) await fs.copyFile(join(sibling, "run-snapshot.json"), control);
    else await fs.writeFile(control, '{"state_sha256":"different"}');
    const mismatched = await dispatchInProcess(root, owned, "next-step");
    assert.equal(mismatched.code, 1);
    assert.match(mismatched.stderr, withSnapshot ? /not the owned source directory/ : /Invalid terminal sweep receipt/);
    await fs.writeFile(control, controlBytes);
    const fold = join(owned, ".fold-receipt.json");
    await fs.writeFile(fold, "{}");
    const pending = await dispatchInProcess(root, owned, "next-step");
    assert.equal(pending.code, 1);
    assert.match(pending.stderr, /incomplete fold receipt prevents terminal cleanup/);
    assert.equal(await fs.readFile(fold, "utf8"), "{}");
    await fs.rm(fold);
    const interrupted = await runCli(root, owned, "next-step", { failAt });
    assert.equal(interrupted.code, 1, interrupted.stdout);
    assert.match(interrupted.stderr, /fixture terminal fault: rm/);
    assert.match(interrupted.stderr, /retry: .*next-step .*--root .*--artifacts-dir/);
    const portable = value => value.split(sep).join("/");
    assert.ok(portable(interrupted.stderr).includes(portable(root)));
    assert.ok(portable(interrupted.stderr).includes(portable(owned)));
    assert.deepEqual(await fs.readdir(owned), inventory);
    assert.deepEqual(await fs.readFile(marker), identity);
    await assert.rejects(fs.stat(join(owned, "steps")), { code: "ENOENT" });
    const retry = await runCli(root, owned, "next-step");
    assert.equal(retry.code, 0, retry.stderr || retry.stdout);
    await assert.rejects(fs.stat(failAt), { code: "ENOENT" });
    const newState = JSON.parse(await fs.readFile(marker, "utf8").catch(error => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }));
    assert.ok(!Object.hasOwn(newState, terminalField));
  });
}

test("next-step resumes original marker with a prepared receipt and a verified marker temp only", async t => {
  const { root, owned, marker, evidence } = await fixture(t, { defaults: true, withSnapshot: false });
  const options = { failAt: marker, operation: "rename", keepAtomicTemp: true };
  const initial = await runCli(root, owned, "cleanup", options);
  assert.equal(initial.code, 1);
  assert.match(JSON.parse(initial.stdout).reason, /fixture terminal fault: rename/);
  const markerBytes = await fs.readFile(marker);
  assert.ok(!Object.hasOwn(JSON.parse(markerBytes), terminalField));
  const inventory = await fs.readdir(owned);
  assert.ok(inventory.includes("cleanup-terminal-sweep.json"));
  const tempName = inventory.find(name => name.endsWith(".tmp"));
  assert.ok(tempName, "atomic marker temp was retained");
  const tempPath = join(owned, tempName);
  const tempBytes = await fs.readFile(tempPath);
  for (const command of ["cleanup", "next-step"]) {
    // Reuse a prior payload name: an ordinary restarted sweep would delete it.
    await fs.writeFile(evidence, "new, unowned payload");
    const refused = await dispatchInProcess(root, owned, command);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr || refused.stdout, /Unexpected terminal sweep entry/);
    assert.equal(await fs.readFile(evidence, "utf8"), "new, unowned payload");
    await fs.rm(evidence);
    assert.deepEqual(await fs.readdir(owned), inventory);
  }
  await fs.writeFile(tempPath, "not a verified marker temp");
  const lookalike = await dispatchInProcess(root, owned, "next-step");
  assert.equal(lookalike.code, 1);
  assert.match(lookalike.stderr, /Unexpected terminal sweep entry/);
  assert.equal(await fs.readFile(tempPath, "utf8"), "not a verified marker temp");
  await fs.writeFile(tempPath, tempBytes);
  for (const name of ["artifact-tree.lock", "artifact-tree.lock.steal"]) {
    const hold = join(owned, name);
    await fs.mkdir(hold);
    const unsafe = await dispatchInProcess(root, owned, "next-step");
    assert.equal(unsafe.code, 1);
    assert.match(unsafe.stderr, /Unsafe artifact tree hold entry/);
    assert.ok((await fs.stat(hold)).isDirectory());
    await fs.rmdir(hold);
  }
  const interrupted = await runCli(root, owned, "next-step", options);
  assert.equal(interrupted.code, 1);
  assert.match(interrupted.stderr, /fixture terminal fault: rename/);
  assert.match(interrupted.stderr, /retry: .*next-step/);
  assert.deepEqual(await fs.readFile(marker), markerBytes);
  assert.equal((await fs.readdir(owned)).filter(name => name.endsWith(".tmp")).length, 1);
  await assert.rejects(fs.stat(join(owned, "steps")), { code: "ENOENT" });
  const retry = await runCli(root, owned, "next-step");
  assert.equal(retry.code, 0, retry.stderr || retry.stdout);
  assert.ok(!(await fs.readdir(owned)).some(name => name.endsWith(".tmp") || name === "cleanup-terminal-sweep.json"));
});
