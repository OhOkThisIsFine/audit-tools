// The current fold accepts a valid bound answer and can reject a different
// saved answer in the same pass. The next host emission must keep the refusal
// visible without treating the accepted answer as pending or echoing raw input.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { DEFAULT_ACQUIRED_ANALYZER_IDS } from "../helpers/analyzerConsentFixture.js";
import { readAcceptedAnswers, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { advanceToDispatchReady, callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import {
  cleanupFoldFixtures,
  CONTRACT_NAME,
  setup,
} from "./helpers/foldAdvisoryFixture.js";

afterEach(cleanupFoldFixtures);

describe(CONTRACT_NAME, () => {
  it("declines default acquired analyzers before the real fold can refresh stale fixture artifacts", async () => {
    const { root, artifactsDir } = await setup();
    const consent = await readRunConsentUnlocked(root, artifactsDir);
    expect(DEFAULT_ACQUIRED_ANALYZER_IDS.length).toBeGreaterThan(0);
    for (const id of DEFAULT_ACQUIRED_ANALYZER_IDS) expect(consent.decisions[id]).toBe("declined");
  });

  it("carries a refusal onto the next emission while accepting a different bound answer", async () => {
    await withTempRepo(async root => {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const workload = await readQuestionWorkload(await advanceToDispatchReady(root));
      const [acceptedItem, rejectedItem] = workload.work_items;
      if (!acceptedItem || !rejectedItem) throw new Error("fixture needs at least two issued questions");

      const [good, toReject] = await submitQuestions(root, [acceptedItem, rejectedItem]);
      const unissuedRevision = "synthetic-unissued-revision-must-not-leak";
      await writeFile(resolve(root, rejectedItem.result_path), JSON.stringify({
        ...toReject, revision_id: unissuedRevision,
      }));

      const next = await callNextStep(root, artifactsDir);
      expect(next).toMatchObject({
        step_kind: "dispatch_review",
        progress: {
          summary: expect.stringContaining("Could not accept 1 saved question result."),
          pending_tasks: workload.work_items.length - 1,
        },
      });
      const nextWorkload = JSON.parse(await readFile(next.artifact_paths.host_workload, "utf8")) as typeof workload;
      expect(nextWorkload.run_id).toBe(workload.run_id);
      expect(nextWorkload.work_items.map(({ binding }) => binding.assignment.assignment_id)).toEqual(
        workload.work_items.slice(1).map(({ binding }) => binding.assignment.assignment_id),
      );
      expect(await readAcceptedAnswers(artifactsDir, workload.run_id)).toEqual([good]);

      const prompt = await readFile(next.artifact_paths.current_prompt, "utf8");
      expect(prompt).toContain("## Saved results not accepted");
      expect(prompt).toContain("`" + rejectedItem.binding.assignment.assignment_id + "`: Binding mismatch.");
      expect(prompt).not.toContain("`" + acceptedItem.binding.assignment.assignment_id + "`: Binding mismatch.");
      expect(prompt).not.toContain(unissuedRevision);
    });
});
});
