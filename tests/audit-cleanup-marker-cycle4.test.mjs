import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanupStaleArtifactsDir } from "../dist/audit/cli/cleanup.js";

async function fixture(t, custom = false) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "audit-cleanup-marker-cycle4-"));
  t.after(async () => {
    const path = relative(temp, await realpath(root));
    assert.ok(path.startsWith("audit-cleanup-marker-cycle4-") && !path.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const dir = custom ? join(root, "custom") : join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  const clean = () => cleanupStaleArtifactsDir(dir, {
    requireAuditMarker: true, repositoryRoot: root, explicitTarget: { root, custom },
  });
  const cli = async (...flags) => {
    const run = promisify(execFile);
    const command = "import { cmdCleanup } from './dist/audit/cli/cleanupCommand.js'; await cmdCleanup(process.argv.slice(1));";
    const args = ["--input-type=module", "-e", command, "--", "--root", root, "--artifacts-dir", dir, ...flags];
    try {
      const { stdout } = await run(process.execPath, args, { windowsHide: true });
      return { code: 0, ...JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code, ...JSON.parse(error.stdout) };
    }
  };
  return { dir, clean, cli };
}

for (const [marker, diagnosis, custom] of [
  ['{"status":"invalid"}', /unrecognized audit status/, false],
  ['{"status":', /malformed JSON/, true],
]) {
  test("invalid marker is diagnosed without deleting working evidence (" + diagnosis.source + ")", async t => {
    const { dir, clean, cli } = await fixture(t, custom);
    const markerPath = join(dir, "audit_state.json");
    const report = join(dir, "audit-report.md");
    await writeFile(markerPath, marker);
    await writeFile(report, "working evidence");

    const result = await clean();
    assert.equal(result.action, "skipped");
    assert.equal(result.status, "unknown");
    assert.match(result.reason, diagnosis);
    for (const flags of [[], ["--force"]]) {
      const output = await cli(...flags);
      assert.equal(output.code, 1);
      assert.equal(output.action, flags.length === 0 ? "skipped" : "refused");
      assert.match(output.reason, /Invalid audit_state.json/);
      assert.match(output.reason, diagnosis);
      assert.doesNotMatch(output.reason, /no audit_state\.json found|no longer has its identity marker/);
    }
    assert.equal(await readFile(markerPath, "utf8"), marker);
    assert.equal(await readFile(report, "utf8"), "working evidence");
  });
}

test("an absent marker retains the absent-state diagnosis without deleting working evidence", async t => {
  const { dir, clean, cli } = await fixture(t);
  const report = join(dir, "audit-report.md");
  await writeFile(report, "working evidence");
  assert.deepEqual(await clean(), { action: "skipped", status: "unknown" });
  const unforced = await cli();
  assert.equal(unforced.code, 1);
  assert.equal(unforced.action, "skipped");
  assert.match(unforced.reason, /no audit_state\.json found/);
  const forced = await cli("--force");
  assert.equal(forced.code, 1);
  assert.equal(forced.action, "skipped");
  assert.match(forced.reason, /no longer has its identity marker/);
  assert.equal(await readFile(report, "utf8"), "working evidence");
});
