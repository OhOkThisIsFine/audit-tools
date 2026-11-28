import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hasCurrentQuestionReport, refreshEndedQuestionReport } from "../dist/audit/io/artifacts.js";
import { buildQuestionAuditFindingsReport } from "../dist/audit/reporting/questionReport.js";
import {
  auditFindingsPath, auditReportPath, promotedAuditFindingsPath, promotedAuditReportPath,
} from "../dist/shared/io/auditToolsPaths.js";

const checkpoint = {
  schema_version: "intent-checkpoint/v1",
  confirmed_by: "host",
  confirmed_at: "2026-11-28T00:00:00Z",
  scope_summary: "Full",
  intent_summary: "Review",
  excluded_scope: [{ path: "excluded.ts", reason: "Outside the confirmed scope" }],
  disposition_overrides: [{ path: "override.ts", status: "included", reason: "Confirmed inclusion" }],
};

async function fixture(t, gaps, intent) {
  const root = await mkdtemp(join(tmpdir(), "report-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  const json = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
  const plan = {
    schema_version: "audit-tools/question-review/v1", snapshot_id: "report-checkpoint",
    inventory: [], questions: [], omissions: [], lens_decisions: [],
  };
  const report = buildQuestionAuditFindingsReport({
    plan, accepted: [], evidence: [], dependenciesByQuestion: new Map(), auditRead: null,
    fileCoverage: { admitted_count: gaps.length, inspected_count: 0, gaps },
  });
  const working = auditReportPath(dir);
  const promoted = promotedAuditReportPath(dir);
  const machine = auditFindingsPath(dir);
  const promotedMachine = promotedAuditFindingsPath(dir);
  await mkdir(dirname(promoted), { recursive: true });
  await mkdir(dirname(promotedMachine), { recursive: true });
  await Promise.all([
    json("review_plan.json", plan),
    json("review_session.json", {
      schema_version: "audit-tools/question-review-session/v1", run_id: "question-review-fixture",
    }),
    json("scope.json", { mode: "full" }),
    json("repo_manifest.json", {
      files: ["excluded.ts", "override.ts"].map(path => ({ path, hash: path })),
    }),
    json("file_disposition.json", {
      files: [{ path: "excluded.ts", status: "included" }, { path: "override.ts", status: "doc_only" }],
    }),
    ...(intent ? [json("intent_checkpoint.json", intent)] : []),
    writeFile(machine, JSON.stringify(report)),
    writeFile(promotedMachine, JSON.stringify(report)),
    writeFile(working, "Old working Markdown"),
    writeFile(promoted, "Old promoted Markdown"),
  ]);
  return { dir, working, promoted, machine, promotedMachine, json };
}

test("a current checkpoint applies both the exclusion and override to full coverage", async t => {
  const { dir, working, promoted } = await fixture(t, ["override.ts"], checkpoint);
  assert.equal(await hasCurrentQuestionReport(dir), false);
  assert.equal(await refreshEndedQuestionReport(dir), true);
  assert.equal(await hasCurrentQuestionReport(dir), true);
  assert.deepEqual(await readFile(working), await readFile(promoted));
});

test("a missing checkpoint still uses frozen dispositions for full coverage", async t => {
  const { dir } = await fixture(t, ["excluded.ts"]);
  assert.equal(await refreshEndedQuestionReport(dir), true);
  assert.equal(await hasCurrentQuestionReport(dir), true);
});

test("an incompatible checkpoint blocks verification and refresh without changing existing bytes", async t => {
  const { dir, working, promoted, machine, promotedMachine, json } = await fixture(t, ["override.ts"], checkpoint);
  assert.equal(await refreshEndedQuestionReport(dir), true);
  assert.equal(await hasCurrentQuestionReport(dir), true);
  await json("intent_checkpoint.json", { ...checkpoint, schema_version: "intent-checkpoint/v0" });
  const mismatch = {
    name: "SchemaVersionMismatchError",
    artifactName: "intent_checkpoint.json",
    expected: "intent-checkpoint/v1",
    actual: "intent-checkpoint/v0",
    message: /preserve this artifact/i,
  };
  await assert.rejects(hasCurrentQuestionReport(dir), mismatch);
  await writeFile(working, "Working Markdown awaiting refresh");
  await writeFile(promoted, "Promoted Markdown awaiting refresh");
  const paths = [working, promoted, machine, promotedMachine, join(dir, "intent_checkpoint.json")];
  const before = await Promise.all(paths.map(path => readFile(path)));
  await assert.rejects(refreshEndedQuestionReport(dir), mismatch);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});
