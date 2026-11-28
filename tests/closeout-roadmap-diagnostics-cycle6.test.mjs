import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeoutReadinessFindings } from "../scripts/shared/closeoutReadiness.mjs";

test("closeout distinguishes unavailable checks from completed HANDOFF diagnostics", async t => {
  const root = await mkdtemp(join(tmpdir(), "audit-closeout-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts", "shared");
  await mkdir(scripts, { recursive: true });
  const generator = join(scripts, "generate-handoff-roadmap.mjs");
  await writeFile(generator, "// spawn fixture\n");
  const git = (...args) => childProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "--", "scripts");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=unused-hooks", "commit", "-qm", "Fixture");
  const memory = join(root, "memory");
  await mkdir(memory);
  await writeFile(join(memory, "MEMORY.md"), "# Index\n");
  await writeFile(join(memory, "orphan.md"), "# Orphan\n");
  const oldMemory = process.env.AUDIT_TOOLS_MEMORY_DIR;
  process.env.AUDIT_TOOLS_MEMORY_DIR = memory;
  t.after(() => {
    if (oldMemory === undefined) delete process.env.AUDIT_TOOLS_MEMORY_DIR;
    else process.env.AUDIT_TOOLS_MEMORY_DIR = oldMemory;
  });

  const originalSpawn = childProcess.spawnSync;
  let response;
  const mock = t.mock.method(childProcess, "spawnSync", (file, args, options) => {
    if (file !== process.execPath || args[0] !== generator) return originalSpawn(file, args, options);
    assert.deepEqual(args, [generator, "--check"]);
    assert.equal(options.timeout, 15_000);
    return { status: null, signal: null, error: undefined, stdout: "", stderr: "", ...response };
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });

  const findings = result => {
    response = result;
    return closeoutReadinessFindings(root);
  };
  const unrelated = findings({ status: 0, stdout: "matches" });
  assert.equal(unrelated.length, 2);
  assert.match(unrelated[0], /no full-suite green on record/);
  assert.match(unrelated[1], /memory file\(s\) are NOT linked/);
  for (const result of [
    { error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }), stderr: "not a completed diagnostic" },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), signal: "SIGTERM", stderr: "partial output" },
    { signal: "SIGTERM" },
    {},
  ]) {
    assert.deepEqual(findings(result), unrelated);
  }
  for (const diagnostic of [
    "Generated state is STALE. Fix: node scripts/shared/generate-handoff-roadmap.mjs",
    "Hand-written Immediate-next section exceeds its word bound.",
    "ENOENT: could not read docs/HANDOFF.md",
  ]) {
    assert.deepEqual(findings({ status: 1, stderr: `\n${diagnostic}\n` }),
      [`generate-handoff-roadmap --check failed: ${diagnostic}`, ...unrelated]);
  }
  assert.deepEqual(findings({ status: 2 }), ["generate-handoff-roadmap --check failed: exit status 2", ...unrelated]);
  const long = findings({ status: 1, stderr: "x".repeat(8_000) });
  assert.deepEqual(long, [`generate-handoff-roadmap --check failed: ${"x".repeat(2_000)}…`, ...unrelated]);
});
