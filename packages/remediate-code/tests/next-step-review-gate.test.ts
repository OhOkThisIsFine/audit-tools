// Review-approval gate (go-forward program item 1) — state-machine wiring.
//
// The gate fires on the Path-A (structured_audit) intake BEFORE the contract
// pipeline collapses the original findings into DAG nodes, so every finding —
// especially the strategic (architecture / design-review) ones that previously
// vanished into quality-tail blocks — is surfaced for an explicit approve /
// disapprove, and disapproved findings are recorded (never silently closed).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../src/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-review-gate");
const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake } = harness;

const STRATEGIC_ID = "ARC-design-001";
const CONCRETE_ID = "SEC-fix-001";

/** Two-finding audit report: one architecture (strategic), one security (concrete). */
function auditReport(): string {
  return JSON.stringify({
    contract_version: "audit-code-findings/v1alpha1",
    findings: [
      {
        id: STRATEGIC_ID,
        title: "Module boundaries leak persistence concerns",
        category: "architecture",
        severity: "medium",
        confidence: "medium",
        lens: "architecture",
        summary: "The store layer reaches across module seams.",
        affected_files: [{ path: "src/store.ts" }, { path: "src/db.ts" }],
        evidence: ["src/store.ts:1 evidence"],
      },
      {
        id: CONCRETE_ID,
        title: "Unvalidated input in login handler",
        category: "security",
        severity: "high",
        confidence: "high",
        lens: "security",
        summary: "User email flows into the query unescaped.",
        affected_files: [{ path: "src/auth/login.ts" }],
        evidence: ["src/auth/login.ts:42 evidence"],
      },
    ],
    work_blocks: [],
  });
}

// A non-default-candidate path: bare `next-step` then resumes the persisted
// intake instead of re-deriving the manifest from default-discovery candidates
// (which would discard the ready summary). This mirrors real usage where intake
// was synthesized on a prior turn.
const auditPath = join(REPO_DIR, "my-audit.json");

async function writeAuditIntake(): Promise<string> {
  await writeFile(auditPath, auditReport(), "utf8");
  await writeReadyStructuredAuditIntake(auditPath);
  return auditPath;
}

const requestPath = join(ARTIFACTS_DIR, "review_request.json");
const resolutionPath = join(ARTIFACTS_DIR, "review_resolution.json");
const decisionPath = join(ARTIFACTS_DIR, "review_decision.json");
const seedPath = join(ARTIFACTS_DIR, "intake", "contract", "path_a_seed.json");
const approvedFindingsPath = join(ARTIFACTS_DIR, "intake", "contract", "approved-findings.json");

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

describe("review-approval gate: halt", () => {
  it("structured-audit intake halts at collect_review_approval before the pipeline", async () => {
    await writeAuditIntake();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_review_approval");
    expect(step.status).toBe("blocked");
    expect(step.step_kind).not.toBe("contract_pipeline");
    // The request artifact is written and points the host at the resolution file.
    expect(existsSync(requestPath)).toBe(true);
    expect(step.artifact_paths.review_resolution).toMatch(/review_resolution\.json$/);
  });

  it("the request tiers every finding, with the architecture finding marked strategic", async () => {
    await writeAuditIntake();

    await decideNextStep({ root: REPO_DIR });

    const request = JSON.parse(await readFile(requestPath, "utf8"));
    expect(request.total).toBe(2);
    expect(request.counts.strategic).toBe(1);
    const strategicTier = request.tiers.find((t: { necessity: string }) => t.necessity === "strategic");
    expect(strategicTier.items.map((i: { finding_id: string }) => i.finding_id)).toContain(STRATEGIC_ID);
    // The prompt surfaces both findings for an explicit decision.
    const prompt = await readFile((await decideNextStep({ root: REPO_DIR })).prompt_path, "utf8");
    expect(prompt).toContain(STRATEGIC_ID);
    expect(prompt).toContain(CONCRETE_ID);
    expect(prompt).toMatch(/Strategic/);
  });

  it("re-running while still awaiting a decision re-halts (does not advance)", async () => {
    await writeAuditIntake();

    await decideNextStep({ root: REPO_DIR });
    const again = await decideNextStep({ root: REPO_DIR });

    expect(again.step_kind).toBe("collect_review_approval");
    expect(existsSync(decisionPath)).toBe(false);
  });
});

describe("review-approval gate: approve-all resolution", () => {
  it("an empty resolution approves everything and advances into the contract pipeline", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR }); // halt + write request

    await writeFile(resolutionPath, JSON.stringify({}), "utf8");
    const step = await decideNextStep({ root: REPO_DIR }); // consume + proceed

    expect(step.step_kind).toBe("contract_pipeline");
    // A durable, reasoned decision record is written; nothing is declined.
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.declined).toEqual([]);
    expect(decision.approved_ids).toEqual(expect.arrayContaining([STRATEGIC_ID, CONCRETE_ID]));
    // The consumed inputs are archived so the gate cannot re-halt.
    expect(existsSync(resolutionPath)).toBe(false);
    const archived = (await readdir(ARTIFACTS_DIR)).filter((f) => f.includes("review_resolution.json.consumed"));
    expect(archived.length).toBe(1);
    // Approve-all writes no filtered findings file (seed carries every finding).
    expect(existsSync(approvedFindingsPath)).toBe(false);
    const seed = JSON.parse(await readFile(seedPath, "utf8"));
    expect(seed.finding_count).toBe(2);
  });

  it("the decision gates the gate: a later run does not re-halt", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });
    await writeFile(resolutionPath, JSON.stringify({}), "utf8");
    await decideNextStep({ root: REPO_DIR });

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
  });
});

describe("review-approval gate: disapproval is recorded and excluded", () => {
  it("a disapproved finding is recorded with a reason and dropped from the pipeline seed", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });

    await writeFile(
      resolutionPath,
      JSON.stringify({ disapproved_findings: [STRATEGIC_ID] }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.declined.map((d: { finding_id: string }) => d.finding_id)).toEqual([STRATEGIC_ID]);
    expect(decision.declined[0].reason).toMatch(/disapproved/i);
    expect(decision.approved_ids).toEqual([CONCRETE_ID]);
    // The declined finding is excluded from the seed AND from the filtered source.
    const seed = JSON.parse(await readFile(seedPath, "utf8"));
    expect(seed.finding_count).toBe(1);
    expect(seed.findings_summary.map((f: { id: string }) => f.id)).toEqual([CONCRETE_ID]);
    const approved = JSON.parse(await readFile(approvedFindingsPath, "utf8"));
    expect(approved.findings.map((f: { id: string }) => f.id)).toEqual([CONCRETE_ID]);
  });

  it("disapproving a whole tier records every finding in it", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });

    await writeFile(
      resolutionPath,
      JSON.stringify({ disapproved_tiers: ["strategic"] }),
      "utf8",
    );
    await decideNextStep({ root: REPO_DIR });

    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.declined.map((d: { finding_id: string }) => d.finding_id)).toEqual([STRATEGIC_ID]);
    expect(decision.declined[0].reason).toMatch(/tier/i);
  });
});

describe("Path-A coverage is built over the original findings", () => {
  it("records planned/declined/folded/dropped dispositions over originals, not nodes", async () => {
    // A node source file so the promoted extracted-plan node survives grounding.
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "node.ts"), "// node\n", "utf8");

    // The contract pipeline's promoted plan (node findings) — consumed via the
    // early extracted-plan fast path in handlePendingExtractedPlan.
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "PLAN-CP",
        source: "contract_pipeline",
        findings: [
          {
            id: "CP-001",
            title: "Implement node",
            category: "General",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "do the work",
            affected_files: [{ path: "src/node.ts" }],
            evidence: ["obligation O-1"],
          },
        ],
        blocks: [{ block_id: "B-001", items: ["CP-001"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      }),
      "utf8",
    );

    // Persisted intake filter dispositions over the ORIGINAL findings.
    const orig = (id: string) => ({
      id,
      title: id,
      category: "General",
      severity: "high",
      confidence: "high",
      lens: "security",
      summary: "s",
      affected_files: [{ path: "src/a.ts" }],
      evidence: ["e"],
    });
    await writeFile(
      join(ARTIFACTS_DIR, "review_filter_dispositions.json"),
      JSON.stringify({
        originals: [orig("ORIG-PLAN"), orig("ORIG-DECLINED"), orig("ORIG-FOLDED"), orig("ORIG-DROP")],
        mergeMap: [["ORIG-FOLDED", "ORIG-PLAN"]],
        droppedNoEvidence: ["ORIG-DROP"],
        droppedPhantomPaths: [],
        phantomPathsRemoved: [],
        droppedByCheckpoint: [],
      }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "review_decision.json"),
      JSON.stringify({
        schema_version: "remediate-code-review-decision/v1",
        plan_id: "path-a-review",
        approved_ids: ["ORIG-PLAN"],
        declined: [{ finding_id: "ORIG-DECLINED", reason: "user declined at gate" }],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    await harness.writeIntentCheckpoint();

    await decideNextStep({ root: REPO_DIR });

    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    const cov = state.plan_coverage;
    expect(cov).toBeDefined();
    // Coverage source is the 4 ORIGINAL findings (not the single node).
    expect(cov.source_finding_count).toBe(4);
    const byId = Object.fromEntries(cov.entries.map((e: { finding_id: string }) => [e.finding_id, e]));
    expect(byId["ORIG-PLAN"].disposition).toBe("planned");
    expect(byId["ORIG-DECLINED"].disposition).toBe("declined_by_review");
    expect(byId["ORIG-FOLDED"].disposition).toBe("folded_into");
    expect(byId["ORIG-FOLDED"].folded_into).toBe("ORIG-PLAN");
    expect(byId["ORIG-DROP"].disposition).toBe("dropped_no_evidence");
    // The node id is NOT in the finding-coverage — coverage accounts for findings.
    expect(byId["CP-001"]).toBeUndefined();
  });
});

describe("review-approval gate: skip conditions", () => {
  it("an empty-findings report skips the gate entirely", async () => {
    await writeFile(
      auditPath,
      JSON.stringify({ contract_version: "audit-code-findings/v1alpha1", findings: [], work_blocks: [] }),
      "utf8",
    );
    await writeReadyStructuredAuditIntake(auditPath);

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
    expect(existsSync(requestPath)).toBe(false);
  });
});
