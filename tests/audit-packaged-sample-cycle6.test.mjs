import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";

const entrypoint = join(import.meta.dirname, "..", "audit-code.mjs");

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "audit-packaged-sample-cycle6-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "fixture-repo");
  const cwd = join(root, "caller directory");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(cwd);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };
  return {
    root, cwd,
    run(...args) {
      const result = spawnSync(process.execPath, [entrypoint, ...args], { cwd, env, encoding: "utf8" });
      assert.ifError(result.error);
      return result;
    },
  };
}

async function assertSample(result, destination) {
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sample, true);
  assert.equal(normalize(payload.artifacts_dir), destination);
  assert.equal(normalize(payload.findings), join(destination, "audit-findings.json"));
  assert.equal(normalize(payload.report), join(destination, "audit-report.md"));
  assert.ok(JSON.parse(await readFile(payload.findings, "utf8")).contract_version);
  assert.ok((await readFile(payload.report, "utf8")).length > 0);
}

test("packaged sample defaults to its own area and leaves normal audit artifacts untouched", async (t) => {
  const { root, run } = await fixture(t);
  const normal = join(root, ".audit-tools", "audit");
  const protectedReport = Buffer.from("Synthetic ordinary audit report.\r\n");
  const stateSentinel = Buffer.from('{"status":"fixture-only"}\n');
  await mkdir(normal, { recursive: true });
  await writeFile(join(normal, "audit-report.md"), protectedReport);
  await writeFile(join(normal, "audit_state.json"), stateSentinel);

  await assertSample(run("sample-run"), join(root, ".audit-tools", "sample"));
  assert.deepEqual((await readdir(normal)).sort(), ["audit-report.md", "audit_state.json"]);
  assert.deepEqual(await readFile(join(normal, "audit-report.md")), protectedReport);
  assert.deepEqual(await readFile(join(normal, "audit_state.json")), stateSentinel);

  const status = run("status");
  assert.equal(status.status, 1, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.status, "invalid_audit_state");
  assert.equal(normalize(payload.artifacts_dir), normal);
});

test("packaged sample resolves an explicit relative artifact destination from caller cwd", async (t) => {
  const { root, cwd, run } = await fixture(t);
  await assertSample(run("sample-run", "--artifacts-dir=demo output"), join(cwd, "demo output"));
  await assert.rejects(readdir(join(root, ".audit-tools")), { code: "ENOENT" });
});
