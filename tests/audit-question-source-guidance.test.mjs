import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ingestAuditQuestionResults,
  publishAuditQuestionWorkload,
  submitAuditQuestionResult,
} from "../dist/audit/cli/dispatch/hostHandoff.js";

test("question intake gives distinct, redacted scope and span corrections", async t => {
  const root = await mkdtemp(join(tmpdir(), "audit-question-source-guidance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boundary = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-fixture" };
  const identity = {
    schema_version: "audit-tools/question-review/v1", snapshot_id: "snapshot",
    revision_id: "revision", question_id: "question",
  };
  const question = {
    ...identity, lens: "operability", inventory_item_ids: ["inventory"], expected_outcome: "Synthetic review",
    requested_parts: [{ part_id: "part", expectation: "Review fixture" }],
    source_dependencies: [], evidence_dependencies: [], plan_status: "active",
  };
  const admitted = "src/admitted.txt";
  const excluded = "src/EXCLUDED_PATH_SENTINEL.txt";
  const sourceLine = "FROZEN_SOURCE_LINE_SENTINEL";
  const submissionText = "SUBMITTED_TEXT_SENTINEL";
  const rawErrorValue = "RAW_ERROR_VALUE_SENTINEL";
  const assignment = {
    ...identity, assignment_id: "assignment", authorized_scope: { include: ["src"], exclude: [excluded] },
    suggested_sources: [], available_evidence_ids: [],
  };
  await mkdir(join(root, "src"));
  await writeFile(join(root, admitted), `${sourceLine}\nsynthetic line\n`);
  const { workload } = await publishAuditQuestionWorkload({
    ...boundary, sourceRoot: root,
    bindings: [{
      question, assignment, dependencies: [], evidence: [],
      sourceFiles: [
        { path: admitted, line_count: 2, fingerprint: "admitted-fixture" },
        { path: excluded, line_count: 41, fingerprint: "excluded-fixture" },
      ],
    }],
  });
  const resultPath = join(root, workload.work_items[0].result_path);
  await mkdir(dirname(resultPath), { recursive: true });
  const submission = {
    ...identity, assignment_id: assignment.assignment_id, submission_id: "answer", evidence_ids: [],
    limitations: [submissionText],
    answer: { outcome: "inconclusive", parts: [], observations: [], findings: [] },
  };
  async function reject(ref, overrides = {}) {
    const body = { ...submission, inspected_sources: [ref], ...overrides };
    await writeFile(resultPath, JSON.stringify(body));
    const result = await ingestAuditQuestionResults(boundary);
    assert.equal(result.accepted_count, 0);
    assert.deepEqual(result.answers, []);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    assert.equal(issue.assignment_id, assignment.assignment_id);
    for (const secret of [excluded, admitted, sourceLine, submissionText, rawErrorValue]) {
      assert.ok(!issue.reason.includes(secret));
    }
    return issue.reason;
  }
  const scope = await reject({ path: excluded, start_line: 1, end_line: 42 });
  assert.match(scope, /source reference outside scope.*authorized_scope include\/exclude.*frozen source inventory/i);
  assert.doesNotMatch(scope, /41|42|bounds|line count/);
  const span = await reject({ path: admitted, start_line: 1, end_line: 99 });
  assert.match(span, /invalid source citation span.*start_line and end_line.*frozen evidence/i);
  assert.match(span, /1-based bounds 1–2 \(issued line count: 2\)/);
  assert.doesNotMatch(span, /99/);
  assert.match(await reject({ path: admitted, start_line: 0 }), /schema mismatch at inspected_sources\.0\.start_line/i);
  assert.match(await reject({ path: admitted }, { evidence_ids: [rawErrorValue] }), /evidence is unavailable or unissued/i);

  const body = { ...submission, inspected_sources: [{ path: admitted, start_line: 1, end_line: 2 }] };
  await assert.rejects(submitAuditQuestionResult({
    ...boundary, assignmentId: assignment.assignment_id,
    source: JSON.stringify({ ...body, inspected_sources: [{ path: excluded }] }),
  }), error => error.message === scope);
  await writeFile(resultPath, JSON.stringify(body));
  const corrected = await ingestAuditQuestionResults(boundary);
  assert.equal(corrected.accepted_count, 1);
  assert.deepEqual(corrected.issues, []);
  assert.deepEqual(corrected.answers[0].submission, body);
  const replay = await ingestAuditQuestionResults(boundary);
  assert.equal(replay.accepted_count, 0);
  assert.deepEqual(replay.issues, []);
  assert.deepEqual(replay.answers, corrected.answers);
});
