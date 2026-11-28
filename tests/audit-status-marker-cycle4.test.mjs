import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../audit-code.mjs", import.meta.url));
const exec = promisify(execFile);

test("status distinguishes legal, absent and invalid saved status markers", async t => {
  const root = await mkdtemp(join(tmpdir(), "audit-status-marker-cycle4-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const marker = join(artifactsDir, "audit_state.json");
  await mkdir(artifactsDir, { recursive: true });

  const status = async expectedExitCode => {
    const response = await exec(process.execPath, [cli, "status", "--root", root], {
      cwd: root, windowsHide: true, timeout: 15000,
    }).then(result => ({ code: 0, ...result }), error => error);
    assert.equal(response.code, expectedExitCode, response.stderr);
    return JSON.parse(response.stdout);
  };

  assert.equal((await status(1)).status, "no_active_audit");
  for (const markerContents of ["{not json", "null", "{}", '{"status":"in_progress"}']) {
    await writeFile(marker, markerContents);
    const output = await status(1);
    assert.equal(output.status, "invalid_audit_state", markerContents);
    assert.match(output.error, /audit_state\.json/);
  }
  for (const savedStatus of ["not_started", "active", "blocked", "complete"]) {
    await writeFile(marker, JSON.stringify({ status: savedStatus, obligations: [] }));
    assert.equal((await status(0)).status, savedStatus);
  }
});
