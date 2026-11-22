import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { REVIEW_QUESTION_CONTRACT_VERSION as version, type ReviewAssignment, type ReviewQuestion, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";

test("explicit same-repair decision after answer compaction reaches the normal durable report", async () => {
  await withTempRepo(async root => {
    const run = (args: string[]) => runWrapper(args, { cwd: root }).then(result => JSON.parse(result.stdout));
    const step = await advancePastDesignReview(root);
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
    const compacted = await run(["next-step"]);
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
    await Promise.all(rest.map(item => put(item, makeAnswer(item.binding, false))));
    const finished = await run(["next-step"]);
    const report = JSON.parse(await readFile(join(root, ".audit-tools/audit", "audit-findings.json"), "utf8"));
    expect(finished.step_kind).not.toBe("dispatch_review");
    expect(report.question_review.consolidations).toEqual([decision]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].question_review_sources).toHaveLength(2);
  });
});
