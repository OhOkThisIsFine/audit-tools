// The step-KIND half of the contract described in
// `host-delegation-fold-carries-advisories.test.ts` (split out so no single
// file dominates the suite's wall). The call-boundary case drains the carry onto
// a semantic-review step, which has an advisory CHANNEL
// (ingestIssues/validationWarnings) of its own. A run whose next emission is a
// DIFFERENT step kind has no such channel, so a drain hung off the
// semantic-review obligation drops the carry exactly when the run moved on — the
// advisory is lost with no record. The carry must therefore be stated on
// whichever step the emission produced.
//
// The next step kind is reached the same way the run reaches it: by putting
// the bundle in the state that selects it. Here a design review is due, so the
// emission is `design_review_contract`.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  advanceToDispatchReview,
  callNextStep,
  carryFileStillPresent,
  cleanupFoldFixtures,
  CONTRACT_NAME,
  setup,
} from "./helpers/foldAdvisoryFixture.js";

afterEach(cleanupFoldFixtures);

describe(CONTRACT_NAME, () => {
  it("states a persisted carry on a NON-host-delegation step (design review), then drains it", async () => {
    const { root, artifactsDir } = await setup();
    const first = (await advanceToDispatchReview(root, artifactsDir)) as {
      step_kind: string;
      run_id: string;
    };
    expect(first.step_kind).toBe("dispatch_review");

    // Revoke both review passes: the next emission is the design-review
    // contract step, NOT a semantic review.
    const { readJsonFile, writeJsonFile } = await import("audit-tools/shared");
    const assessmentPath = join(artifactsDir, "design_assessment.json");
    const assessment = (await readJsonFile(assessmentPath)) as Record<
      string,
      unknown
    >;
    await writeJsonFile(assessmentPath, {
      ...assessment,
      contract_reviewed: false,
      conceptual_reviewed: false,
    });

    const carriedMessage = "carried onto a step that has no advisory channel";
    const carryPath = join(artifactsDir, "steps", "pending-advisories.json");
    await writeFile(
      carryPath,
      JSON.stringify({
        ingestIssues: [
          {
            code: "submission_missing",
            check: "result_path",
            work_item_id: "wi-pending-under-ready-inspection",
            result_path:
              ".audit-tools/audit/runs/earlier/host-results/wi-pending.json",
            message: "work item 'wi-pending-under-ready-inspection' submitted nothing at its bound path",
          },
        ],
        validationWarnings: [
          {
            work_item_id: "wi-carried-onto-a-design-review",
            result_path:
              ".audit-tools/audit/runs/earlier/host-results/wi-carried.json",
            message: carriedMessage,
          },
        ],
      }),
      "utf8",
    );

    const emitted = (await callNextStep(root, artifactsDir)) as {
      step_kind: string;
    };
    expect(
      emitted.step_kind,
      "the fixture must land on a non-host-delegation step kind",
    ).not.toBe("semantic_review");

    const prompt = await readFile(
      join(artifactsDir, "steps", "current-prompt.md"),
      "utf8",
    );
    expect(
      prompt,
      "a carry must be stated on WHICHEVER step the emission produced, not only on a semantic review",
    ).toContain(carriedMessage);
    // The carry reports on OTHER work, so it follows the step's own
    // instructions: the step states its own task first (owner, 2026-10-06).
    expect(
      prompt.trimEnd().endsWith(carriedMessage),
      "the carried report must come after the step's own instructions",
    ).toBe(true);
    // This design review carries a ready-inspection workload in its own task,
    // above the report, and the pending items are in it.
    const lead = prompt.indexOf("Before you run next-step, read the report below");
    expect(lead, "a lead line introduces the carried report").toBeGreaterThan(
      prompt.indexOf("## Ready scoped inspection"),
    );
    expect(prompt.indexOf("## Ready scoped inspection")).toBeGreaterThan(-1);
    expect(prompt).toContain(
      "1 result is not yet written. The workload file named above lists each one",
    );
    expect(prompt).not.toContain("wi-pending-under-ready-inspection");

    // Stated once, then drained — the same one-statement property, on the kind
    // that has no advisory channel to carry it as data.
    expect(
      await carryFileStillPresent(carryPath),
      "the emission that stated the carry must drain it",
    ).toBe(false);
  });
});
