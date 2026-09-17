/**
 * A design-review findings submission is parsed ITEM BY ITEM, not only as an
 * array envelope.
 *
 * The defect this pins (measured 2026-09-17, prompt 11 review). Every one of the
 * four prompts `src/audit/orchestrator/designReviewPrompt.ts` renders shows the
 * same worked example, and that example puts the enum ALTERNATION in the field
 * value: `"severity": "one of: critical, high, medium, low, info"`. A host that
 * copies it writes exactly that string.
 *
 * On the judge path the tool refuses it — `ConceptualJudgeSubmissionSchema`
 * parses the submission and `invalid_enum_value` quarantines the round. On the
 * contract path nothing refused it: `consumeArraySubmission` unwrapped the array
 * and returned it unparsed, `groundDesignFindings` stamped the finding
 * `grounding: { status: "grounded" }`, and the assessment recorded a SUCCESS over
 * a finding whose severity no code recognises. `SEVERITY_RANK[severity]` is then
 * `undefined`, so that finding never counts as high and is never picked for
 * selective deepening — it is not dropped, it is kept, ranked below everything,
 * and reported as grounded.
 *
 * Owner decision, 2026-09-17: parse each item with the finding contract at
 * ingestion and quarantine a submission carrying an item that fails, with a
 * named reason — exactly as the judge lane already behaves.
 *
 * The CONTROL below is what stops the refusal being satisfied by a check that
 * refuses everything.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { handleDesignReviewBranch } from "../../src/audit/cli/nextStepHelpers.js";
import {
  GATE_LANES,
  laneSubmissionPath,
} from "../../src/audit/cli/laneSubmissions.js";
import { submissionsDir } from "../../src/shared/io/auditToolsPaths.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

const PLACEHOLDER_SEVERITY = "one of: critical, high, medium, low, info";

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "DR-001",
    title: "Retry limit is enforced in two places that can disagree",
    category: "inferred_contract_gap",
    severity: "high",
    confidence: "medium",
    lens: "architecture",
    summary: "The two enforcement sites read different constants.",
    affected_files: [{ path: "src/scheduling/rebook.ts" }],
    systemic: true,
    ...overrides,
  };
}

async function ingestContractSubmission(
  findings: readonly Record<string, unknown>[],
): Promise<{
  contractReviewed: boolean;
  contractFindings: readonly { severity?: string }[];
  rejectedReasons: readonly string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "dr-item-contract-"));
  try {
    const artifactsDir = join(dir, "audit");
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract),
      JSON.stringify(findings),
      "utf8",
    );

    const bundle = {
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: false,
        conceptual_reviewed: false,
      },
    } as unknown as ArtifactBundle;
    const state: AuditState = { status: "active", obligations: [] };

    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      state,
      createFoldTransaction(),
    );
    // A refused submission does not advance the fold, so the branch hands the
    // host a step to run instead of continuing — read the assessment off
    // whichever carrier this arm produced.
    const assessment =
      branch.action === "continue"
        ? branch.bundle.design_assessment
        : branch.result.bundle.design_assessment;
    return {
      contractReviewed: assessment?.contract_reviewed === true,
      contractFindings: (assessment?.contract_findings ?? []) as readonly {
        severity?: string;
      }[],
      rejectedReasons: (assessment?.rejected_submissions ?? []).map(
        (entry) => entry.reason,
      ),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a contract submission carrying the prompt's placeholder severity is REFUSED, not stamped grounded", async () => {
  const result = await ingestContractSubmission([
    finding({ severity: PLACEHOLDER_SEVERITY }),
  ]);

  expect(
    result.contractFindings.map((f) => f.severity),
    "a severity no code recognises reached the assessment as a merged finding",
  ).not.toContain(PLACEHOLDER_SEVERITY);
  expect(
    result.contractReviewed,
    "the pass was marked reviewed over a submission the finding contract refuses",
  ).toBe(false);
});

test("the refusal names the offending field", async () => {
  const result = await ingestContractSubmission([
    finding({ severity: PLACEHOLDER_SEVERITY }),
  ]);

  expect(
    result.rejectedReasons.join("\n"),
    "a refusal that does not name the field is unactionable",
  ).toContain("severity");
});

// The CONTROL. Without it the refusal above is satisfied by a check that
// refuses every contract submission.
test("a contract submission whose findings all conform is accepted", async () => {
  const result = await ingestContractSubmission([finding({})]);

  expect(result.contractReviewed).toBe(true);
  expect(result.contractFindings.map((f) => f.severity)).toEqual(["high"]);
  expect(result.rejectedReasons).toEqual([]);
});
