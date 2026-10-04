// The CALL-BOUNDARY half of the contract described in
// `host-delegation-fold-carries-advisories.test.ts` (split out so no single
// file dominates the suite's wall). The same-fold case is one call that ingests
// and emits; the case that broke is a transition that ENDS the call — the budget
// cap, the drain's budget stop, any fold boundary — where the in-memory carry
// died with the call and the advisories were never stated at all. The property
// is "stated on exactly ONE emitted step, WHICHEVER call emits it", and
// "whichever" is the half a memory-only carry cannot satisfy.
//
// The carry file is seeded DIRECTLY rather than produced by actually driving
// the drain to a budget stop: what is under test is the read-and-drain half
// (the emission that follows picks the carry up and consumes it), and the
// write half is the same file the ingest path already writes. Seeding keeps
// the test's cost off the ~20-obligation walk a real budget stop would need.
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
  it("states a carry persisted by an EARLIER call, drains it, and never restates it", async () => {
    const { root, artifactsDir } = await setup();
    const first = (await advanceToDispatchReview(root, artifactsDir)) as {
      step_kind: string;
    };
    expect(first.step_kind).toBe("dispatch_review");

    const carriedMessage = "carried from a call that ended at its budget cap";
    const carryPath = join(artifactsDir, "steps", "pending-advisories.json");
    await writeFile(
      carryPath,
      JSON.stringify({
        ingestIssues: [],
        validationWarnings: [
          {
            work_item_id: "wi-carried-by-an-earlier-call",
            result_path:
              ".audit-tools/audit/runs/earlier/host-results/wi-carried.json",
            message: carriedMessage,
          },
        ],
      }),
      "utf8",
    );

    await callNextStep(root, artifactsDir);
    const prompt = await readFile(
      join(artifactsDir, "steps", "current-prompt.md"),
      "utf8",
    );
    expect(
      prompt,
      "an advisory a PREVIOUS call persisted must be stated by THIS call's emission",
    ).toContain(carriedMessage);

    // Drained, not merely read: presence is the signal, so an emission that
    // stated the carry must leave nothing behind for the next one.
    expect(
      await carryFileStillPresent(carryPath),
      "the emission that stated the carry must drain it",
    ).toBe(false);

    // …so a LATER emission states it zero more times.
    await callNextStep(root, artifactsDir);
    const nextPrompt = await readFile(
      join(artifactsDir, "steps", "current-prompt.md"),
      "utf8",
    );
    expect(
      nextPrompt,
      "an advisory is stated on exactly ONE emitted step, never restated",
    ).not.toContain(carriedMessage);
  });
});
