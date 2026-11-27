import { expect, test } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { advanceToDispatchReady, callNextStep } from "./helpers/completion-harness.js";
import { persistAnalyzerSettings } from "../../src/shared/analyzerPolicy.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { type ToolingManifest } from "../../src/audit/types/toolingManifest.js";
import { hasStaleReopenedWorkingReport, qualifyQuestionReviewTooling } from "../../src/audit/cli/questionReviewSession.js";
import { REVIEW_QUESTION_CONTRACT_VERSION as version, type ReviewAssignment, type ReviewQuestion, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

test("compacted answers can be consolidated again after an answer is reopened", async () => {
  await withTempRepo(async root => {
    const run = (args: string[]) => runWrapper(args, { cwd: root }).then(result => JSON.parse(result.stdout));
    const artifactsDir = join(root, ".audit-tools", "audit");
    // This validates consolidation, not analyzer selection/acquisition.
    await persistAnalyzerSettings(root, { typescript: "skip" });
    const next = () => callNextStep(root, artifactsDir);
    const step = await advanceToDispatchReady(root);
    const { run_id, work_items } = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
      run_id: string;
      work_items: { binding: { question: ReviewQuestion; assignment: ReviewAssignment }; result_path: string }[];
    };
    const eligible = work_items.filter(({ binding }) => binding.assignment.suggested_sources.length > 0);
    expect(eligible.length).toBeGreaterThan(1);
    const makeAnswer = ({ question, assignment }: typeof work_items[number]["binding"], accepted: boolean): ReviewSubmission => {
      const identity = { schema_version: version, question_id: question.question_id, revision_id: question.revision_id,
        snapshot_id: question.snapshot_id } as const;
      const part_id = question.requested_parts[0]!.part_id;
      const refs = [...assignment.suggested_sources.slice(0, 1)];
      return {
        ...identity, assignment_id: assignment.assignment_id, submission_id: "answer-" + assignment.assignment_id,
        inspected_sources: refs, evidence_ids: [], limitations: [],
        answer: accepted ? {
          outcome: "findings", parts: [{ part_id, outcome: "findings", observation_ids: ["observed"] }],
          observations: [{ ...identity, observation_id: "observed", part_id, kind: "source_confirmed",
            statement: "The same ordinary fixture issue occurs.", source_refs: refs, evidence_refs: [] }],
          findings: [{ schema_version: version, question_id: identity.question_id, revision_id: identity.revision_id,
            finding_id: "claim", kind: "confirmed_defect", severity: "medium", confidence: "high",
            claim: "Fixture behavior needs repair", consequence: "Incorrect result", next_step: "Fix the shared check",
            source_refs: refs, evidence_ids: [], observation_ids: ["observed"],
            verification: [{ kind: "assertion", obligation_id: assignment.assignment_id, expected: "Shared check is corrected", source_refs: refs }] }],
        } : {
          outcome: "inconclusive", parts: [], observations: [], findings: [],
        },
      };
    };
    // Exercise normal result intake at the fold boundary. Spawning a wrapper
    // for every ordinary answer duplicates the submission tests and exhausts
    // this integration test's wall-clock allowance in parallel Windows runs.
    const put = async (item: typeof work_items[number], answer: ReviewSubmission) => {
      const file = resolve(root, item.result_path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(answer));
    };
    const chosen = eligible.slice(0, 2);
    const rest = work_items.filter(item => !chosen.includes(item));
    expect(rest.length).toBeGreaterThan(0);
    const accepted = chosen.map(({ binding }) => makeAnswer(binding, true));
    await Promise.all(chosen.map((item, index) => put(item, accepted[index]!)));
    const compacted = await next();
    expect(compacted.progress.pending_tasks).toBe(rest.length);
    const file = join(root, ".audit-tools", "same-repair.json");
    const decision = { decision_id: "same-repair", decided_by: "fixture-operator", reason: "Both reports require the same check.",
      sources: accepted.map(answer => ({ answer_id: answer.submission_id, finding_id: "claim" })) };
    await writeFile(file, JSON.stringify(decision));
    expect(await run(["consolidate-findings", "--from", file])).toMatchObject({ run_id, disposition: "accepted" });
    expect(await run(["consolidate-findings", "--from", file])).toMatchObject({ run_id, disposition: "replay" });
    const ledger = JSON.parse(await readFile(join(root, ".audit-tools/audit", "runs", run_id, "host-accepted-results-ledger.json"), "utf8"));
    expect(ledger.answers.map(({ submission }: { submission: ReviewSubmission }) => submission)).toEqual(accepted);
    expect(ledger.consolidations).toEqual([decision]);
    const decisions = [decision];
    const target = accepted[0]!;
    const reopenFile = join(root, ".audit-tools", "reopen-one.json");
    // The same reopen fixture also covers the historical-tooling authorization
    // and report-currency boundaries without starting a second full audit.
    const toolingPath = join(artifactsDir, "tooling_manifest.json");
    const metadataPath = join(artifactsDir, "artifact_metadata.json");
    const current = JSON.parse(await readFile(toolingPath, "utf8")) as ToolingManifest;
    const prior = { ...current, implementation_hash: "f".repeat(64) };
    const recordedToolingHash = hashArtifactValue("tooling_manifest.json", prior);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.artifacts["tooling_manifest.json"].content_hash = recordedToolingHash;
    await writeFile(toolingPath, JSON.stringify(prior));
    await writeFile(metadataPath, JSON.stringify(metadata));
    const tooling_transition = {
      prior_implementation_hash: prior.implementation_hash, current_implementation_hash: current.implementation_hash,
      reason: "Only the review tool changed; preserve the frozen inputs.",
    };
    const qualify = () => qualifyQuestionReviewTooling({
      artifactsDir, snapshotId: target.snapshot_id, prior, current, recordedToolingHash,
      allowQualifiedReview: true,
    });
    await expect(qualifyQuestionReviewTooling({
      artifactsDir, snapshotId: target.snapshot_id, prior, current, recordedToolingHash,
      requested: { ...tooling_transition, current_implementation_hash: "e".repeat(64) }, allowQualifiedReview: true,
    })).rejects.toThrow(/exact historical and current implementation/u);
    await writeFile(reopenFile, JSON.stringify({ reopen_id: "bad-answer", reason: "Review used the wrong subject.",
      questions: [{ question_id: target.question_id, revision_id: target.revision_id, snapshot_id: target.snapshot_id,
        expected_submission_ids: [target.submission_id] }], tooling_transition }));
    await run(["reopen-questions", "--from", reopenFile]);
    const guidance = join(artifactsDir, "intake", "conversation-start.md");
    await mkdir(dirname(guidance), { recursive: true });
    await writeFile(guidance, "Unapproved change to intent.\n", { flag: "wx" });
    try {
      await expect(qualify()).rejects.toThrow(/qualified review tooling inputs changed/i);
    } finally {
      await unlink(guidance);
    }
    expect(await hasStaleReopenedWorkingReport(artifactsDir)).toBe(true);
    const reissued = await next();
    const active = JSON.parse(await readFile(reissued.artifact_paths.host_workload, "utf8")) as { work_items: typeof work_items };
    const replacement = active.work_items.find(item => item.binding.question.question_id === target.question_id)!;
    const newAnswer = makeAnswer(replacement.binding, true);
    await put(replacement, newAnswer);
    await next();
    const combined = { ...decision, decision_id: "replacement-repair",
      sources: [decision.sources[1]!, { answer_id: newAnswer.submission_id, finding_id: "claim" }] };
    await writeFile(file, JSON.stringify(combined));
    expect(await run(["consolidate-findings", "--from", file])).toMatchObject({ disposition: "accepted" });
    decisions.push(combined);
    await Promise.all(rest.map(item => put(item, makeAnswer(item.binding, false))));
    // The final report still comes from a new public CLI process.
    const finished = await run(["next-step"]);
    const report = JSON.parse(await readFile(join(root, ".audit-tools/audit", "audit-findings.json"), "utf8"));
    expect(finished.step_kind).not.toBe("dispatch_review");
    expect(report.question_review.consolidations).toEqual(decisions);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].question_review_sources).toHaveLength(2);
    expect(await hasStaleReopenedWorkingReport(artifactsDir)).toBe(false);
  });
});
