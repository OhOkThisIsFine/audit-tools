import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyHeadEvidenceAgainstFindings } from "../dist/remediate/phases/closeVerifyHeadEvidence.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-close-blobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  const run = (cues, readAtRef, state = {}) => {
    const findings = cues.map(([id, path, quoted_text], index) => ({
      id, affected_files: [{ path, quoted_text, line_start: index + 1 }],
    }));
    state.plan = {
      findings, units: [], review_revision_sha256: "a".repeat(64),
      source_dispositions: findings.map(({ id }) => ({ finding_id: id, status: "already_fixed" })),
      audit_read: { commit: base, dirty_paths: [] },
    };
    return verifyHeadEvidenceAgainstFindings({ state, root, overrides: { readAtRef } });
  };
  return { base, head, run };
}

test("close reuses exact base and HEAD blobs without sharing citation verdicts", async (t) => {
  const { base, head, run } = await fixture(t);
  const path = "src/file.txt";
  const calls = [];
  const outcome = await run([
    ["fixed", path, "removed alpha"],
    ["standing", path, "standing beta"],
    ["refuted", path, "never there"],
    ["lazy", "src/other.txt", "never there"],
    ["literal", "src/File.txt", "removed alpha"],
  ], async (_, ref, file) => {
    calls.push([ref, file]);
    if (file !== path) return "";
    return ref === base ? "removed alpha\nstanding beta" : "standing beta";
  });

  assert.deepEqual(calls, [
    [base, path], [head, path], [base, "src/other.txt"], [base, "src/File.txt"],
  ]);
  assert.equal(outcome.recorded.fixed?.disposition, "verified_already_fixed", JSON.stringify(outcome));
  assert.equal(outcome.recorded.refuted.disposition, "refuted");
  assert.equal(outcome.recorded.refuted.evidence.line, "3");
  assert.equal(outcome.recorded.lazy.disposition, "refuted");
  assert.equal(outcome.recorded.literal.disposition, "refuted");
  assert.deepEqual(outcome.withheld.map(record => record.finding_id), ["standing"]);
});

test("unreadable blobs are retried, and no read or verdict survives a new verification", async (t) => {
  const { base, head, run } = await fixture(t);
  const path = "src/file.txt";
  const cues = ["a", "b", "c"].map(id => [id, path, "old marker"]);
  const state = {};
  const calls = [];
  let baseReads = 0;
  let headReads = 0;
  const outcome = await run(cues, async (_, ref, file) => {
    calls.push([ref, file]);
    if (ref === base) return ++baseReads === 1 ? undefined : "old marker";
    return ++headReads === 1 ? undefined : "";
  }, state);

  assert.deepEqual(calls, [[base, path], [base, path], [head, path], [head, path]]);
  assert.deepEqual(outcome.withheld.map(record => record.finding_id), ["a", "b"]);
  assert.match(outcome.withheld[0].reason, /not a readable file at the audit-read commit/);
  assert.match(outcome.withheld[1].reason, /not a readable file at HEAD/);
  assert.equal(outcome.recorded.c.disposition, "verified_already_fixed");

  const failure = new Error("read failed");
  await assert.rejects(run(cues, async () => { throw failure; }, state), error => error === failure);
  assert.equal(state.source_verifications.c, undefined);

  calls.length = 0;
  const retry = await run(cues, async (_, ref, file) => {
    calls.push([ref, file]);
    return "";
  }, state);
  assert.deepEqual(calls, [[base, path]]);
  assert.deepEqual(Object.values(retry.recorded).map(record => record.disposition), [
    "refuted", "refuted", "refuted",
  ]);
});
