import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyGuidanceFile } from "../dist/shared/intake/guidanceBootstrap.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "guidance-bootstrap-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, ".audit-tools", "remediation");
  const target = join(artifacts, "intake", "conversation-start.md");
  return { root, artifacts, target };
}

test("readable canonical guidance validates without being rewritten", async (t) => {
  const { artifacts, target } = await fixture(t);
  const contents = Buffer.from("Original guidance.\r\n\r\n");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  const sentinelTime = new Date("2001-01-01T00:00:00Z");
  await utimes(target, sentinelTime, sentinelTime);
  const before = await stat(target);

  assert.equal(applyGuidanceFile(artifacts, target), target);
  assert.deepEqual(await readFile(target), contents);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
});

test("canonical path surfaces the same missing and non-file read errors", async (t) => {
  const { artifacts, target } = await fixture(t);
  assert.throws(() => applyGuidanceFile(artifacts, target), { code: "ENOENT", path: target });
  await mkdir(target, { recursive: true });
  assert.throws(() => applyGuidanceFile(artifacts, target), { code: "EISDIR" });
  assert.ok((await stat(target)).isDirectory());
});

test("external guidance still copies verbatim and protects differing canonical bytes", async (t) => {
  const { root, artifacts, target } = await fixture(t);
  const source = join(root, "operator-guidance.md");
  const original = Buffer.from("External guidance.\r\n");
  await writeFile(source, original);
  assert.equal(applyGuidanceFile(artifacts, source), target);
  assert.deepEqual(await readFile(target), original);
  assert.equal(applyGuidanceFile(artifacts, source), target);
  await writeFile(source, "New and conflicting guidance.\n");
  assert.throws(() => applyGuidanceFile(artifacts, source), /Refusing to overwrite existing.*differing guidance/u);
  assert.deepEqual(await readFile(target), original);
});

test("remediate next-step reports a missing canonical --guidance-file instead of proceeding", async (t) => {
  const { root, target } = await fixture(t);
  const cli = join(import.meta.dirname, "..", "remediate-code.mjs");
  const result = spawnSync(process.execPath, [
    cli, "next-step", "--root", root, "--guidance-file", target,
  ], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, XDG_CONFIG_HOME: root },
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT: no such file or directory/u);
  assert.match(result.stderr, /conversation-start\.md/u);
});
