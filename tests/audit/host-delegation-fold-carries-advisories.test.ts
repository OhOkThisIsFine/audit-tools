// N1 (A2 re-review F1-1): in `runHostDelegationObligation`, when the same fold
// ingests results for still-pending tasks, it returned `{ kind: "transition" }`
// through the result-ingestion path BEFORE the semantic_review emission that
// spreads `validationWarnings`/`ingestIssues` — so in the dominant live flow
// (a host that writes results one at a time) the advisory warnings and any
// classified ingest issues from that fold were silently dropped from the
// emitted step. The contract under test: a fold that accepts a warning-only
// result whose task is still pending must carry that fold's advisories onto the
// NEXT emitted step, so the host is told what was accepted-with-warning instead
// of receiving an identical workload with no statement of it.
//
// Driven through `cmdNextStep` — the real CLI path, whose emission is what
// materializes the host workload and renders the prompt — with every
// pre-planning obligation pre-satisfied so both calls land on the
// semantic-review dispatch.
//
// Kept to the ONE recorder invariant: `recordHostResultOutcomes` stays the only
// ledger writer, and a warning never becomes a rejection.
//
// The contract is split across three files so no single file dominates the
// suite's wall (each case costs ~10 s of real next-step walking, and vitest
// runs a file's tests serially): this file holds the fixture check and the
// same-fold half; `host-delegation-fold-carry-across-calls.test.ts` the
// call-boundary half; `host-delegation-fold-carry-non-host-step.test.ts` the
// step-kind half. The shared fixture is `helpers/foldAdvisoryFixture.ts`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { DEFAULT_ACQUIRED_ANALYZER_IDS } from "../helpers/analyzerConsentFixture.js";
import {
  advanceToDispatchReview,
  callNextStep,
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

  it("renders the advisory line for a warning-only accepted result on the emitted step", async () => {
    const { root, artifactsDir } = await setup();

    // First walk: answers the incidental host pauses (consent/install/intent),
    // then mints the review run and emits dispatch_review.
    const first = (await advanceToDispatchReview(root, artifactsDir)) as {
      step_kind: string;
      run_id: string;
    };
    expect(first.step_kind).toBe("dispatch_review");
    expect(first.run_id).toBeTruthy();

    // Host writes ONE warning-only result for the FIRST published work item
    // (its id is content-derived — planning canonicalizes tasks): a declared
    // total_lines one BELOW the disk count is a ±1 counting delta → advisory
    // warning, no error. At least one other item stays pending, so the fold's
    // ingest path takes the transition branch — the live shape under test.
    const workload = JSON.parse(
      await readFile(
        join(artifactsDir, "runs", first.run_id, "host-workload.json"),
        "utf8",
      ),
    ) as {
      work_items: {
        id: string;
        lens: string;
        result_path: string;
        prompt: { sha256: string };
        scope: { files: string[] };
      }[];
    };
    expect(
      workload.work_items.length,
      "the fixture must publish ≥2 items so one acceptance leaves the rest pending",
    ).toBeGreaterThanOrEqual(2);
    const item = workload.work_items[0];
    if (!item) throw new Error("workload published no work items");
    const coveredPath = item.scope.files[0];
    if (!coveredPath) throw new Error("work item declares no files");
    const resultPath = join(root, item.result_path);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: "audit-host-result/v1alpha1",
        result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
        run_id: first.run_id,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        // Bound truth: the workload's line hints pin total_lines at 2, and the
        // envelope rule requires reviewed_lines == total_lines. So the ADVISORY
        // comes from the content gate's other warning class instead: a second
        // affected_files entry outside the declared coverage — out-of-scope
        // findings are retained with a warning (INV-09), never rejected.
        file_coverage: [
          { path: coveredPath, reviewed_lines: 2, total_lines: 2 },
        ],
        findings: [
          {
            id: "F-1",
            title: "Warning-only finding",
            category: "correctness",
            severity: "medium",
            confidence: "medium",
            lens: (item as unknown as { lens?: string }).lens,
            summary: "Accepted with an out-of-scope-file advisory.",
            // BOTH entries carry a quote. The quote-or-declaration rule lives in
            // the worker projection, which is scope-blind by construction — the
            // door cannot know which path the content gate will later call
            // out-of-scope, so it asks every entry alike. So the only defect this
            // result has is the out-of-scope sibling itself, which is the advisory
            // this test is about.
            affected_files: [
              { path: coveredPath, quoted_text: "line one" },
              { path: "src/out-of-scope.ts", quoted_text: "line one" },
            ],
            evidence: [`${coveredPath}:1-2 - boundary`],
          },
        ],
      }),
      "utf8",
    );

    // Second call: the fold ingests task-a (warning-only), transitions through
    // the result-ingestion executor because task-b is still pending, then emits…
    await callNextStep(root, artifactsDir);
    const second = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    ) as { step_kind: string };
    expect(second.step_kind).toBe("dispatch_review");

    // …and the emitted prompt must STATE the advisory on task-a.
    const prompt = await readFile(
      join(artifactsDir, "steps", "current-prompt.md"),
      "utf8",
    );
    expect(
      prompt,
      "the emitted prompt must carry the advisory channel for the accepted-with-warning result",
    ).toContain("Advisory notes on accepted results");
    // The advisory names the WORK ITEM (its content-derived id), which is what
    // the host binds results to — not the internal audit task id.
    expect(
      prompt,
      "the emitted prompt must name the accepted-with-warning work item",
    ).toContain(item.id);
  });
});
