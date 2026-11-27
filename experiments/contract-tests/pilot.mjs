import test from "node:test";
import assert from "node:assert/strict";
import { execFile as exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const execFile = promisify(exec);
const canonical = p => resolve(p).replaceAll("\\", "/").toLowerCase();
const load = p => import(pathToFileURL(join(checkout, "dist", p)).href);

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "audit-contract-trial-"));
  t.after(async () => {
    const rel = relative(temp, await realpath(root));
    assert.ok(rel.startsWith("audit-contract-trial-") && !isAbsolute(rel) && !rel.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.ts"), "export function total(a: number, b: number) { return a + b; }\n");
  return root;
}

async function next(bin, root, ...args) {
  const { stdout } = await execFile(process.execPath, [join(checkout, bin), "next-step", "--root", root, ...args], {
    cwd: root,
    env: { ...process.env, AUDIT_CODE_STATE_DIR: join(root, "private-state") },
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 2_000_000,
  });
  return JSON.parse(stdout);
}

test("audit waits for a run-bound capability decision and a recorded stop survives restart", async t => {
  const root = await fixture(t);
  const first = await next("audit-code.mjs", root);
  assert.equal(first.step_kind, "functional_preflight");
  assert.equal(first.status, "ready");
  assert.ok(first.run_id);
  const artifact = first.artifact_paths.functional_preflight;
  assert.equal(canonical(artifact), canonical(join(root, ".audit-tools", "audit", "functional-preflight.json")));
  const inspected = { available: false, evidence: "No capability available in this test." };
  await writeFile(artifact, JSON.stringify({
    contract_version: "audit-functional-preflight/v1",
    run_id: first.run_id, repository_root: root,
    source_inspection: inspected, relationship_inspection: inspected,
    decision: "stop", operator_approved_degraded: false, limitation: "No inspection in this fixture.",
  }));
  const stopped = await next("audit-code.mjs", root);
  assert.equal(stopped.run_id, first.run_id);
  assert.equal(stopped.step_kind, first.step_kind);
  assert.equal(stopped.status, "blocked");
  assert.match(JSON.stringify(stopped.progress), /operator stopped/);
  const persisted = JSON.parse(await readFile(join(root, ".audit-tools", "audit", "steps", "current-step.json"), "utf8"));
  assert.equal(persisted.run_id, first.run_id);
  assert.equal(persisted.status, "blocked");
});

test("remediation retains the original request and resumes pending intake instead of beginning edits", async t => {
  const root = await fixture(t);
  const request = "Make the displayed title include the transaction count.";
  const first = await next("remediate-code.mjs", root, "--guidance", request);
  assert.equal(first.step_kind, "synthesize_intake");
  assert.equal(first.status, "ready");
  const path = join(root, ".audit-tools", "remediation", "intake", "conversation-start.md");
  const saved = await readFile(path, "utf8");
  assert.ok(saved.includes(request));
  const resumed = await next("remediate-code.mjs", root);
  assert.equal(resumed.step_kind, first.step_kind);
  assert.equal(resumed.status, first.status);
  assert.equal(await readFile(path, "utf8"), saved);
});

test("remediation evidence distinguishes a missing record from a contrary conclusion", async () => {
  const { isCompleteEvidence, mechanismContradictsOutcome } = await load("shared/types/remediationOutcome.js");
  const evidence = { file: "src/value.ts", line: "1", mechanism: "read_at_head_refutation" };
  assert.ok(isCompleteEvidence(evidence));
  assert.equal(isCompleteEvidence({ ...evidence, line: "" }), false);
  assert.equal(mechanismContradictsOutcome("verified_already_fixed", evidence.mechanism), true);
  assert.equal(mechanismContradictsOutcome("refuted", evidence.mechanism), false);
});
