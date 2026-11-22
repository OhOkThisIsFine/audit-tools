import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { advanceToDispatchReady, callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { readAcceptedAnswers, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";

test("next-step re-derives a saved rejection across calls and clears it on repair", async () => {
  await withTempRepo(async root => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const current = await readQuestionWorkload(await advanceToDispatchReady(root));
    const item = current.work_items[0]!;
    const assignmentId = item.binding.assignment.assignment_id;
    const [valid] = await submitQuestions(root, [item]);
    const resultPath = resolve(root, item.result_path);
    const staleRevision = "synthetic-outdated-revision-must-not-leak";
    await writeFile(resultPath, JSON.stringify({ ...valid, revision_id: staleRevision }));

    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await callNextStep(root, artifactsDir);
      const pending = await readQuestionWorkload(next);
      expect(pending.run_id).toBe(current.run_id);
      expect(pending.work_items.map(entry => entry.binding.assignment.assignment_id)).toContain(assignmentId);
      const prompt = await readFile(next.artifact_paths.current_prompt, "utf8");
      expect(prompt).toContain("`" + assignmentId + "`: Binding mismatch.");
      expect(prompt).not.toContain(staleRevision);
    }

    await writeFile(resultPath, JSON.stringify(valid));
    const repaired = await callNextStep(root, artifactsDir);
    expect(repaired.step_kind).toBe("dispatch_review");
    const remaining = JSON.parse(await readFile(repaired.artifact_paths.host_workload, "utf8")) as typeof current;
    expect(remaining.run_id).toBe(current.run_id);
    expect(remaining.work_items.map(entry => entry.binding.assignment.assignment_id)).not.toContain(assignmentId);
    expect(await readAcceptedAnswers(artifactsDir, current.run_id)).toEqual([valid]);
    expect(await readFile(repaired.artifact_paths.current_prompt, "utf8")).not.toContain("## Saved results not accepted");
  });
});
