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
    await writeFile(marker, JSON.stringify({ status: savedStatus }));
    const output = await status(0);
    assert.equal(output.status, savedStatus);
    assert.equal(output.last_obligation, null);
    assert.equal(output.last_executor, null);
    assert.deepEqual(output.blockers, []);
    assert.deepEqual(output.obligations_summary, {
      missing: 0, present: 0, stale: 0, blocked: 0, satisfied: 0, not_applicable: 0,
    });
  }
  const fields = {
    status: "blocked", last_obligation: "inspection", last_executor: "reviewer",
    blockers: ["Awaiting evidence"],
    obligations: [
      { id: "inspection", state: "blocked", reason: "Awaiting evidence" },
      { id: "intake", state: "satisfied" },
      { id: "scope", state: "satisfied" },
    ],
    unrelated: true,
  };
  await writeFile(marker, JSON.stringify(fields));
  const output = await status(0);
  assert.equal(output.last_obligation, fields.last_obligation);
  assert.equal(output.last_executor, fields.last_executor);
  assert.deepEqual(output.blockers, fields.blockers);
  assert.deepEqual(output.obligations_summary, {
    missing: 0, present: 0, stale: 0, blocked: 1, satisfied: 2, not_applicable: 0,
  });
  for (const invalid of [
    { obligations: {} }, { obligations: "not an array" }, { obligations: null }, { obligations: [null] },
    { obligations: [{ id: "inspection", state: "unknown" }] },
    { obligations: [{ state: "satisfied" }] },
    { last_obligation: 42 }, { last_executor: null }, { blockers: ["valid", 42] }, { blockers: "one" },
  ]) {
    await writeFile(marker, JSON.stringify({ ...fields, ...invalid }));
    const output = await status(1);
    assert.equal(output.status, "invalid_audit_state", JSON.stringify(invalid));
    assert.match(output.error, /audit_state\.json/);
    assert.equal(output.obligations_summary, undefined);
  }
});
