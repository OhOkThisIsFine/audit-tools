import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareConceptualDispatch } from "../dist/audit/cli/conceptualDispatch.js";
import { readAuditReviewBinding } from "../dist/audit/cli/auditReviewBindings.js";
import { laneSubmissionValidator } from "../dist/audit/cli/laneValidators.js";
import { recordLaneOutcome } from "../dist/audit/cli/laneSubmissions.js";
import { readAuditReviewSubmission } from "../dist/audit/cli/reviewSubmission.js";
import { readSubmissionLedger } from "../dist/shared/submission/submissionLedger.js";
import {
  loadConceptualPerspectiveFindings,
  MalformedConceptualPerspectivesError,
  readConceptualReviewRoundManifest,
} from "../dist/audit/types/conceptualAdjudication.js";

const marker = "UNTRUSTED_FIXTURE_CONTENT";
const finding = {
  id: "test-finding",
  title: "A synthetic finding",
  category: "unnecessary_complexity",
  severity: "low",
  confidence: "high",
  lens: "architecture",
  summary: "A local test fixture.",
  affected_files: [],
};

test("deep perspective admission rejects raw tool verdicts before schema shaping", async () => {
  const validate = laneSubmissionValidator("design_review_conceptual_p1_test", { repoFiles: new Set() });
  assert.ok(validate);
  for (const field of ["verification_status", "evidence_lane", "lead_lineage", "severity_downgraded_from", "question_review_sources"]) {
    for (const wrap of [items => items, findings => ({ findings, metadata: "allowed" })]) {
      const issue = validate(wrap([finding, { ...finding, [field]: marker }]));
      assert.equal(issue.code, "submission_contract_invalid");
      assert.match(issue.message, new RegExp("findings\\[1\\]\\." + field));
      assert.ok(!issue.message.includes(marker));
    }
  }
  assert.equal(validate([finding]), null);
  assert.equal(validate({ findings: [], metadata: "allowed" }), null);
});

test("deep dispatch diagnoses bad content and reuses matching bound results through correction and judge intake", async t => {
  const root = await mkdtemp(join(tmpdir(), "conceptual-intake-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const artifactsDir = join(root, ".audit-tools");
  const opts = { artifactsDir, sourceRoot: root, bundle: {}, settings: { conceptual_depth: "deep", perspectives: 4 } };
  const initial = await prepareConceptualDispatch(opts);
  const [accepted, malformed, unavailable, missing] = initial.workload.pending_perspectives;
  assert.ok(missing);
  const write = async (lane, result, mode = "independent") => {
    const binding = await readAuditReviewBinding(artifactsDir, lane.lane_id);
    await mkdir(dirname(lane.result_path), { recursive: true });
    await writeFile(lane.result_path, JSON.stringify({
      contract_version: "review-submission/v1",
      prompt_sha256: binding.promptSha256,
      review: { mode, reason: marker },
      result,
    }));
    return binding.promptSha256;
  };
  const acceptedDigest = await write(accepted, [finding]);
  const repairDigest = await write(malformed, { findings: [{ ...finding, verification_status: marker }] });
  await write(unavailable, null, "unavailable");

  const pending = await prepareConceptualDispatch(opts);
  const instructions = pending.instructionLines.join("\n");
  assert.match(instructions, /Perspective 2: malformed result: findings\[0\]\.verification_status/);
  assert.match(instructions, /Perspective 3: declared unavailable/);
  assert.match(instructions, /Perspective 4: result not received/);
  assert.ok(!instructions.includes(marker));
  assert.equal(pending.workload.judge.ready, false);
  assert.deepEqual(pending.workload.pending_perspectives, [malformed, unavailable, missing]);
  assert.equal((await readAuditReviewBinding(artifactsDir, accepted.lane_id)).promptSha256, acceptedDigest);

  const manifest = await readConceptualReviewRoundManifest(artifactsDir);
  const judgeInputs = () => loadConceptualPerspectiveFindings(manifest, (path, lane) => readAuditReviewSubmission(path, artifactsDir, lane));
  await write(unavailable, []);
  await write(missing, []);
  await assert.rejects(judgeInputs, error => {
    assert.ok(error instanceof MalformedConceptualPerspectivesError);
    assert.equal(error.failures[0].path, malformed.result_path);
    assert.match(error.message, /verification_status/);
    assert.ok(!error.message.includes(marker));
    return true;
  });

  await write(malformed, [{ ...finding, severity: marker }]);
  const badSchema = await prepareConceptualDispatch(opts);
  assert.match(badSchema.instructionLines.join("\n"), /malformed result: findings\[0\]\.severity/);
  assert.ok(!badSchema.instructionLines.join("\n").includes(marker));
  await writeFile(malformed.result_path, `not valid JSON: ${marker}`);
  const badJson = await prepareConceptualDispatch(opts);
  assert.match(badJson.instructionLines.join("\n"), /malformed result: result file is not valid JSON/);
  assert.ok(!badJson.instructionLines.join("\n").includes(marker));

  // Existing quarantine/recovery may remove the bad file and leave only a
  // refusal. Keep the bound prompt stable and do not replay old parser text.
  await rm(malformed.result_path);
  await recordLaneOutcome(artifactsDir, malformed.lane_id, {
    kind: "rejected",
    issueCode: "submission_malformed",
    message: marker,
  });
  const refused = await prepareConceptualDispatch(opts);
  assert.match(refused.instructionLines.join("\n"), /Perspective 2: previous result rejected/);
  assert.ok(!refused.instructionLines.join("\n").includes(marker));
  assert.equal((await readAuditReviewBinding(artifactsDir, malformed.lane_id)).promptSha256, repairDigest);
  await write(malformed, { findings: [finding] });
  const corrected = await prepareConceptualDispatch(opts);
  assert.deepEqual(corrected.workload.pending_perspectives, []);
  assert.equal(corrected.workload.judge.ready, true);
  const inputs = await judgeInputs();
  assert.equal(inputs.size, 4);
  assert.deepEqual(inputs.get(accepted.lane_id), [finding]);
  assert.deepEqual(inputs.get(malformed.lane_id), [finding]);

  // Superseding an unjudged round must not let the generic ledger observer
  // turn a malformed result with a nonempty array into findings coverage.
  await write(malformed, [{ ...finding, lead_lineage: marker }]);
  await prepareConceptualDispatch({ ...opts, reReviewSection: "A fresh review round." });
  const outcomes = (await readSubmissionLedger(artifactsDir)).filter(event => event.lane === malformed.lane_id);
  assert.equal(outcomes.filter(event => event.kind === "lane_outcome").length, 0);
  const refusal = outcomes.find(event => event.kind === "rejected" && event.message !== marker);
  assert.match(refusal.message, /Malformed perspective result: findings\[0\]\.lead_lineage/);
  assert.ok(!refusal.message.includes(marker));
});
