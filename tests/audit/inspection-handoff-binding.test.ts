import { hashContent } from "audit-tools/shared";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { expect, test } from "vitest";
import {
  ingestAuditHostResults,
  ingestAuditQuestionResults,
  prepareAuditHostHandoff,
  readAuditQuestionWorkload,
} from "../../src/audit/cli/dispatch/hostHandoff.js";
import { submitWorkItemResult } from "../../src/audit/cli/submitCommand.js";
import { deriveLaneDemand } from "../../src/shared/types/stepContract.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";
import type { AuditTask } from "../../src/audit/types.js";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";

test("issued question assignments bind their scope, submission and fallback path", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const workloadPath = step.artifact_paths.host_workload;
    const artifactsDir = join(root, ".audit-tools", "audit");
    const workloadBytes = await readFile(workloadPath, "utf8");
    const { run_id: runId } = JSON.parse(workloadBytes) as { run_id: string };
    const boundary = { root, artifactsDir, runId };
    const workload = await readAuditQuestionWorkload(boundary);
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Use the frozen source, question scope and supplied evidence");
    expect(prompt).toContain("Suggested source files are starting points, not the review boundary");
    expect(prompt).toContain("Copy the exact assignment_id, question_id, revision_id and snapshot_id");
    expect(prompt).toContain("set work_item_id to the issued assignment_id");
    expect(prompt).toContain("result_path (relative to the repository root)");

    expect(workload.work_items.length).toBeGreaterThan(1);
    expect(step.progress?.pending_tasks).toBe(workload.work_items.length);
    const resultDir = join(artifactsDir, "runs", runId, "host-results");
    const destinations = workload.work_items.map(({ result_path, binding }) => {
      expect(isAbsolute(result_path)).toBe(false);
      const absolute = resolve(root, result_path);
      expect(dirname(absolute)).toBe(resultDir);
      expect(relative(resultDir, absolute)).toBe(`${hashContent(binding.assignment.assignment_id)}.json`);
      return absolute;
    });
    expect(new Set(destinations).size).toBe(destinations.length);

    const { binding: { question, assignment } } = workload.work_items[0]!;
    expect(assignment).toMatchObject({
      question_id: question.question_id,
      revision_id: question.revision_id,
      snapshot_id: question.snapshot_id,
    });
    const suggested = assignment.suggested_sources[0]!;
    expect(suggested).toBeDefined();
    expect(workload.source_files.some(file => file.path === suggested.path && file.fingerprint.length > 0)).toBe(true);
    const submission: ReviewSubmission = {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      submission_id: "fixture-answer",
      assignment_id: assignment.assignment_id,
      question_id: question.question_id,
      revision_id: question.revision_id,
      snapshot_id: question.snapshot_id,
      inspected_sources: [suggested],
      evidence_ids: [],
      limitations: ["Synthetic fixture did not establish the requested outcome."],
      answer: {
        outcome: "inconclusive", findings: [], observations: [],
        parts: [{ part_id: question.requested_parts[0]!.part_id, outcome: "inconclusive",
          observation_ids: [], reason: "No synthetic observation." }],
      },
    };
    const submit = (answer: ReviewSubmission, workItemId = assignment.assignment_id) => submitWorkItemResult({
      root, artifactsDir, workItemId, source: JSON.stringify(answer),
    });
    const fold = () => ingestAuditQuestionResults(boundary);
    const destination = destinations[0]!;
    await mkdir(resultDir, { recursive: true });

    const stale = { ...submission, revision_id: "old-revision" };
    await expect(submit(stale)).rejects.toThrow(/current issued assignment, question revision and snapshot/u);
    await expect(submit(submission, workload.work_items[1]!.binding.assignment.assignment_id))
      .rejects.toThrow(/assignment differs from its destination/u);
    await expect(submit({ ...submission, inspected_sources: [{ path: "unissued.ts" }] }))
      .rejects.toThrow(/outside this assignment/u);

    // A clean envelope at any other path is ignored; a stale binding at the
    // issued path is refused, without filling the accepted-answer ledger.
    await writeFile(join(resultDir, "unbound.json"), JSON.stringify(submission));
    await writeFile(destination, JSON.stringify(stale));
    expect(await fold()).toMatchObject({
      accepted_count: 0, answers: [],
      issues: [{ assignment_id: assignment.assignment_id, reason: "Bound answer rejected: Binding mismatch. Copy the assignment, question, revision, and snapshot IDs from the current workload." }],
    });

    // Path metadata itself is not an authority to redirect the result.
    const tampered = structuredClone(workload);
    tampered.work_items[0]!.result_path = relative(root, join(resultDir, "unbound.json")).replace(/\\/gu, "/");
    await writeFile(workloadPath, JSON.stringify(tampered));
    await expect(fold()).rejects.toThrow(/result path differs from its issued assignment/u);
    await expect(submit(submission)).rejects.toThrow(/result path differs from its issued assignment/u);
    const changedQuestion = structuredClone(workload);
    changedQuestion.work_items[0]!.binding.question.expected_outcome = "A changed obligation under an intact result path.";
    await writeFile(workloadPath, JSON.stringify(changedQuestion));
    await expect(fold()).rejects.toThrow(/no longer matches its issued digest/u);
    await expect(submit(submission)).rejects.toThrow(/no longer matches its issued digest/u);
    await writeFile(workloadPath, workloadBytes);

    await writeFile(destination, JSON.stringify(submission));
    expect(await fold()).toMatchObject({ accepted_count: 1, answers: [{ submission }], issues: [] });
    expect(await submit(submission)).toMatchObject({ disposition: "replay", submission_id: submission.submission_id });
    expect(await fold()).toMatchObject({ accepted_count: 0, answers: [{ submission }], issues: [] });
  });
});

test("a run resumed under a differently spelled root re-binds or refuses as classified stale, never as a throw", async () => {
  const base = await mkdtemp(join(tmpdir(), "audit-root-spelling-"));
  try {
    const prepareAt = async (root: string) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
      return prepareAuditHostHandoff({
        root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "spelling-run",
        tasks: [{ ...SPELLING_TASK, demand: deriveLaneDemand({ tokenEstimate: 10, fileCount: 1, riskScore: 0 }), token_estimate: 10,
          file_line_counts: { "src/a.ts": 2 }, priority: "low" }],
      });
    };
    const writeResult = async (root: string, item: { id: string; result_path: string; prompt: { sha256: string } }) => {
      const path = resolve(root, item.result_path);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({
        contract_version: "audit-host-result/v1alpha1", result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
        run_id: "spelling-run", work_item_id: item.id, prompt_sha256: item.prompt.sha256,
        file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }], findings: [],
      }));
    };
    const ingestAt = (root: string) => ingestAuditHostResults({
      root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "spelling-run",
      auditTasks: [SPELLING_TASK], lineIndex: { "src/a.ts": 2 }, pendingTaskIds: new Set(),
    });

    const first = join(base, "first");
    const prepared = await prepareAt(first);
    const item = prepared.workload.work_items[0]!;
    await writeResult(first, item);

    // A drive letter spelled in the other case names the same directory: the
    // prompt re-renders identically and the result is accepted.
    if (/^[A-Za-z]:/u.test(first)) {
      const flipped = first[0] === first[0]!.toUpperCase()
        ? first[0]!.toLowerCase() + first.slice(1)
        : first[0]!.toUpperCase() + first.slice(1);
      expect((await ingestAt(flipped)).accepted_count).toBe(1);
    }

    // A root that really MOVED refuses as the classified, re-preparable stale.
    const moved = join(base, "moved");
    await cp(first, moved, { recursive: true });
    await rm(join(moved, ".audit-tools", "audit", "runs", "spelling-run", "host-accepted-results-ledger.json"), { force: true });
    await rm(join(moved, ".audit-tools", "audit", "runs", "spelling-run", "host-accepted-results.json"), { force: true });
    const stale = await ingestAt(moved);
    expect(stale.accepted_count).toBe(0);
    expect(stale.issues.map((issue) => issue.code)).toContain("workload_stale");
    // ...and re-preparing under the new root restores the binding.
    const republished = await prepareAt(moved);
    await writeResult(moved, republished.workload.work_items[0]!);
    expect((await ingestAt(moved)).accepted_count).toBe(1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

const SPELLING_TASK: AuditTask = {
  task_id: "spelling-task",
  unit_id: "unit-spelling",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};
