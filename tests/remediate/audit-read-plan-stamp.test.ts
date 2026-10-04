import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRead, Finding } from "audit-tools/shared";
import { buildAuditFindingsDeliverable } from "../../src/shared/reporting/auditDeliverable.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  writePathASeedFromFindings,
} from "../../src/remediate/steps/contractPipeline.js";
import { readPlanSource, readApprovedExecutionPlan, PlanSubmissionSchema } from "../../src/remediate/contractPipeline/executionPlan.js";
import { canonicalPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

// The remediator half of the `audit_read` contract: the value on `state.plan`
// is what the close phase's evidence leg turns into `verified_already_fixed` /
// `refuted`, so it must come from the TOOL's read of the validated source
// report — never from the host-writable extracted plan.

const RECORDED: AuditRead = { commit: "c".repeat(40), dirty_paths: ["src/auth.ts"] };

const FINDING: Finding = {
  id: "F-1",
  title: "Auth flow",
  category: "correctness",
  severity: "high",
  confidence: "high",
  lens: "correctness",
  summary: "The auth flow needs a cleanup.",
  affected_files: [{ path: "src/auth.ts" }],
  evidence: ["src/auth.ts: unguarded branch"],
};

const h = createNextStepHarness(".test-audit-read-plan-stamp");

/** Write a findings report to disk and seed Path A from it, as intake does. */
async function seedFrom(auditRead: AuditRead | null): Promise<string> {
  const report = buildAuditFindingsDeliverable([FINDING], auditRead);
  const reportPath = join(h.REPO_DIR, "audit-findings.json");
  await writeFile(reportPath, JSON.stringify(report), "utf8");
  await writePathASeedFromFindings(h.ARTIFACTS_DIR, reportPath, report);
  return reportPath;
}

/** A ready free-form intake, so `decideNextStep` reaches DAG promotion. */
async function writeReadyIntake(): Promise<void> {
  const inputPath = join(h.REPO_DIR, "feedback.md");
  const intakeDir = join(h.ARTIFACTS_DIR, "intake");
  await mkdir(intakeDir, { recursive: true });
  await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
  await writeFile(
    join(intakeDir, "source-manifest.json"),
    JSON.stringify({
      schema_version: "remediate-code-intake-source-manifest/v1alpha1",
      created_from: "input",
      sources: [{ type: "document", path: inputPath }],
    }),
    "utf8",
  );
  await writeFile(
    join(intakeDir, "intake-summary.json"),
    JSON.stringify(
      intakeSummaryFixture({
        goals: ["Clean up the auth flow."],
        affected_files: [{ path: "src/auth.ts" }],
      }),
    ),
    "utf8",
  );
  await h.writeIntentCheckpoint();
  await h.acknowledgeResume();
}

async function persistedPlan(): Promise<Record<string, unknown>> {
  const state = JSON.parse(
    await readFile(join(h.ARTIFACTS_DIR, "state.json"), "utf8"),
  ) as { plan: Record<string, unknown> };
  return state.plan;
}

beforeEach(async () => {
  await h.resetTestRepo();
});

afterAll(async () => {
  await h.cleanupTestRepo();
});

describe("tool-owned original audit-read provenance", () => {
  it("returns the audit_read the seeded report recorded", async () => {
    await seedFrom(RECORDED);

    expect((await readPlanSource(h.ARTIFACTS_DIR))?.audit_read ?? null).toEqual(RECORDED);
  });

  it("is null when the report itself states null", async () => {
    await seedFrom(null);

    expect((await readPlanSource(h.ARTIFACTS_DIR))?.audit_read ?? null).toBeNull();
  });

  it("is null when the run has no Path-A seed", async () => {
    expect((await readPlanSource(h.ARTIFACTS_DIR))?.audit_read ?? null).toBeNull();
  });

  it("refuses activation when the source report changed after the seed bound its digest, even to another VALID report", async () => {
    const reportPath = await seedFrom(RECORDED);
    await h.writeApprovedExecutionPlan();
    // A fully valid report with a different commit: only the seed's own sha256
    // of this file can tell it from the one the run was built from.
    const swapped = buildAuditFindingsDeliverable([FINDING], {
      commit: "e".repeat(40),
      dirty_paths: [],
    });
    await writeFile(reportPath, JSON.stringify(swapped), "utf8");

    expect(await readApprovedExecutionPlan(h.ARTIFACTS_DIR)).toBeUndefined();
    expect((await readPlanSource(h.ARTIFACTS_DIR))?.audit_read).toEqual(RECORDED);
  });

  it("refuses activation when the source report no longer passes the strict validator", async () => {
    const reportPath = await seedFrom(RECORDED);
    await h.writeApprovedExecutionPlan();
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    // Still carries a well-formed audit_read — but the report around it is no
    // longer a valid contract, so nothing in it is believed.
    delete report.summary;
    await writeFile(reportPath, JSON.stringify(report), "utf8");

    expect(await readApprovedExecutionPlan(h.ARTIFACTS_DIR)).toBeUndefined();
    expect((await readPlanSource(h.ARTIFACTS_DIR))?.audit_read).toEqual(RECORDED);
  });
});

describe("plan application stamps state.plan.audit_read from the tool's read", () => {
  it("a pipeline-promoted plan in a seeded run carries the source report's audit_read", async () => {
    await writeReadyIntake();
    await seedFrom(RECORDED);
    await h.writeApprovedExecutionPlan();
    await h.approveReviewGate();

    await decideNextStep({ root: h.REPO_DIR });

    const plan = await persistedPlan();
    expect(plan.source).toBe("execution_plan");
    expect(plan.audit_read).toEqual(RECORDED);
  });

  it("a pipeline-promoted plan with NO audit-side source states null", async () => {
    await writeReadyIntake();
    await h.writeApprovedExecutionPlan();
    await h.approveReviewGate();

    await decideNextStep({ root: h.REPO_DIR });

    const plan = await persistedPlan();
    expect(plan.source).toBe("execution_plan");
    expect(plan.audit_read).toBeNull();
  });

  it("host-authored semantic submissions cannot overwrite audit provenance", async () => {
    await seedFrom(RECORDED); await h.writeApprovedExecutionPlan();
    const approved = await readApprovedExecutionPlan(h.ARTIFACTS_DIR);
    expect(approved?.source.audit_read).toEqual(RECORDED);
    expect(PlanSubmissionSchema.safeParse({ base_revision_sha256: approved!.canonical.revision_sha256,
      plan: { ...approved!.canonical.plan, audit_read: { commit: "f".repeat(40), dirty_paths: [] } }, retired_requirements: [] }).success).toBe(false);
  });
});


// With zero survivors the review gate never rewrites a stale-schema decision, so
// the plan-join ledger must not take declines from one: the current run never
// decided them. The current-schema case is the control that proves the path is
// reached at all.
describe("the plan-join coverage ledger reads review declines through the current schema", () => {
  async function activateWithDecision(schemaVersion: string): Promise<number> {
    await writeReadyIntake();
    await seedFrom(RECORDED);
    await h.writeApprovedExecutionPlan();
    await writeFile(join(h.ARTIFACTS_DIR, "review_decision.json"), JSON.stringify({
      schema_version: schemaVersion, plan_id: "REVIEW-OLD", approved_ids: [],
      declined: [{ finding_id: FINDING.id, reason: "declined in an older run" }],
      created_at: new Date().toISOString(),
    }), "utf8");
    await decideNextStep({ root: h.REPO_DIR });
    const state = JSON.parse(await readFile(join(h.ARTIFACTS_DIR, "state.json"), "utf8")) as {
      plan_coverage?: { declined_review_count: number };
    };
    return state.plan_coverage!.declined_review_count;
  }

  it("takes no decline from a stale-schema record", async () => {
    expect(await activateWithDecision("remediate-code-review-decision/v0")).toBe(0);
  });

  it("takes the decline from a current-schema record (control)", async () => {
    expect(await activateWithDecision("remediate-code-review-decision/v1")).toBe(1);
  });
});

describe("remediation plan contract ownership", () => {
  it("rejects unused top-level themes while retaining the live intent filter", async () => {
    const { RemediationPlanSchema } = await import("../../src/remediate/state/types.js");
    const { IntentFiltersSchema } = await import("../../src/shared/types/intentCheckpoint.js");
    const plan = canonicalPlanFixture({ plan_id: "contract-test" });
    expect(RemediationPlanSchema.safeParse(plan).success).toBe(true);
    expect(RemediationPlanSchema.safeParse({ ...plan, themes: [] }).success).toBe(false);
    expect(IntentFiltersSchema.parse({ themes: ["T-1"] })).toEqual({ themes: ["T-1"] });
  });
});
