import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { hashContent } from "audit-tools/shared";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { advanceToDispatchReady, callNextStep } from "./helpers/completion-harness.js";
import { readAcceptedAnswers, readQuestionWorkload } from "./helpers/question-completion-harness.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";
import { countLines } from "../../src/audit/cli/args.js";
import { ensureRunSnapshot, runSnapshotPath } from "../../src/audit/io/runSnapshot.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { existsSync } from "node:fs";

// Two independently issued questions share the same frozen file. The
// unchanged source span is accepted, while the new live-only span is not.
test("bound question source spans are measured against the frozen snapshot, not the live edit", async () => {
  await withTempRepo(async (root) => {
    const path = "src/api/auth.ts";
    const artifactsDir = join(root, ".audit-tools", "audit");
    const step = await advanceToDispatchReady(root);
    const workload = await readQuestionWorkload(step);
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { source_root: string };
    const frozen = await countLines(join(sourceRoot, path));
    const durableWorkload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
    expect(durableWorkload.source_root).toBe(sourceRoot.replace(/\\/g, "/"));
    expect(durableWorkload.source_files).toContainEqual(expect.objectContaining({
      path, line_count: frozen, fingerprint: hashContent(await readFile(join(sourceRoot, path))),
    }));
    const picked = workload.work_items.filter(({ binding }) => binding.assignment.suggested_sources
      .some(ref => ref.path === path));
    expect(picked.length).toBeGreaterThanOrEqual(2);
    const live = join(root, path);
    await writeFile(live, (await readFile(live, "utf8")) + "export const extra = 1;\n".repeat(10));

    async function put(item: typeof picked[number], line: number): Promise<ReviewSubmission> {
      const { question, assignment } = item.binding;
      const ref = { path, start_line: line };
      const identity = { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, question_id: question.question_id,
        revision_id: question.revision_id, snapshot_id: question.snapshot_id } as const;
      const part_id = question.requested_parts[0]!.part_id;
      const answer: ReviewSubmission = {
        ...identity, assignment_id: assignment.assignment_id, submission_id: "fixture-" + assignment.assignment_id,
        inspected_sources: [ref], evidence_ids: [], limitations: [],
        answer: { outcome: "clean", findings: [],
          parts: [{ part_id, outcome: "clean", observation_ids: ["seen"] }],
          observations: [{ ...identity, observation_id: "seen", part_id, kind: "source_confirmed",
            statement: "Synthetic frozen source observation", source_refs: [ref], evidence_refs: [] }],
        },
      };
      const target = resolve(root, item.result_path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(answer));
      return answer;
    }
    const accepted = await put(picked[0]!, 1);
    await put(picked[1]!, frozen + 1);
    const resumed = await callNextStep(root, artifactsDir);
    expect(resumed.step_kind).toBe("dispatch_review");
    expect(resumed.progress.summary).toContain("Could not accept 1 saved question result");
    expect(await readAcceptedAnswers(artifactsDir, workload.run_id)).toEqual([accepted]);
  });
});

test("cleanup removes the run's snapshot with its artifacts dir", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = await ensureRunSnapshot(root, artifactsDir);
    expect(existsSync(sourceRoot)).toBe(true);
    expect((await cleanupStaleArtifactsDir(artifactsDir, { force: true, repositoryRoot: root })).action).toBe("deleted");
    expect(existsSync(sourceRoot)).toBe(false);
  });
});
