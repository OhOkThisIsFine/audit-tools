import { canonicalStateFromLegacyFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
// Review-approval gate (go-forward program item 1) — state-machine wiring.
//
// The gate fires on Path-A intake before planning, so every finding —
// especially the strategic (architecture / design-review) ones that previously
// vanished into quality-tail blocks — is surfaced for an explicit approve /
// decline, and declined findings are recorded (never silently closed).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readPlanSource, readApprovedExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import type { ExecutableChangePlan } from "../../src/shared/types/executionPlan.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { readOptionalJsonFile, writeJsonFile } from "../../src/shared/index.js";
import {
  buildAuditFindingsDeliverable,
  type Finding,
} from "audit-tools/shared";

const harness = createNextStepHarness(".test-next-step-review-gate");
const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake, acknowledgeResume } = harness;

const STRATEGIC_ID = "ARC-design-001";
const CONCRETE_ID = "SEC-fix-001";

/** Two-finding audit report: one architecture (strategic), one security (concrete). */
function auditReport(): string {
  const findings: Finding[] = [
      {
        id: STRATEGIC_ID,
        title: "Module boundaries leak persistence concerns",
        category: "architecture",
        severity: "medium",
        confidence: "medium",
        lens: "architecture",
        summary: "The store layer reaches across module seams.",
        affected_files: [
          { path: "src/store.ts" },
          { path: "src/db.ts" },
          { path: "src/shared-boundary.ts" },
        ],
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
        affected_files: [
          { path: "src/auth/login.ts" },
          { path: "src/shared-boundary.ts" },
        ],
        evidence: ["src/auth/login.ts:42 evidence"],
      },
    ];
  return JSON.stringify(buildAuditFindingsDeliverable(findings, null));
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
const seedPath = executionPlanPaths(ARTIFACTS_DIR).source;
const approvedFindingsPath = join(executionPlanPaths(ARTIFACTS_DIR).directory, "approved-findings.json");

let prevRollingEngine: string | undefined;
beforeEach(async () => {
  await harness.resetTestRepo();
  await writeFile(
    join(REPO_DIR, "session-config.json"),
    JSON.stringify({
      block_quota: { context_tokens: 200_000, reserved_output_tokens: 8_000 },
    }),
    "utf8",
  );
  prevRollingEngine = process.env.REMEDIATE_ROLLING_ENGINE;
  process.env.REMEDIATE_ROLLING_ENGINE = "false";
});
afterEach(async () => {
  await harness.cleanupTestRepo();
  if (prevRollingEngine === undefined) delete process.env.REMEDIATE_ROLLING_ENGINE;
  else process.env.REMEDIATE_ROLLING_ENGINE = prevRollingEngine;
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
    expect(seed.findings).toHaveLength(2);
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

describe("review-approval gate: a decline is recorded and excluded", () => {
  it("a declined finding is recorded with a reason and dropped from the pipeline seed", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });

    await writeFile(
      resolutionPath,
      JSON.stringify({
        declined_findings: [{ finding_id: STRATEGIC_ID, reason: "the router is replaced next quarter" }],
      }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.declined.map((d: { finding_id: string }) => d.finding_id)).toEqual([STRATEGIC_ID]);
    // The user's own reason reaches the record (prompt 17b).
    expect(decision.declined[0].reason).toBe(
      "Declined by the user at the review gate: the router is replaced next quarter",
    );
    expect(decision.approved_ids).toEqual([CONCRETE_ID]);
    // The declined finding is excluded from the seed AND from the filtered source.
    const seed = JSON.parse(await readFile(seedPath, "utf8"));
    expect(seed.findings).toHaveLength(1);
    expect(seed.findings.map((f: { id: string }) => f.id)).toEqual([CONCRETE_ID]);
    const approved = JSON.parse(await readFile(approvedFindingsPath, "utf8"));
    expect(approved.findings.map((f: { id: string }) => f.id)).toEqual([CONCRETE_ID]);
    // The filtered source remains a canonical report. The original shared-file
    // component is pruned in place (not recomputed), and all derived block and
    // summary metadata describes only the approved survivor.
    expect(approved.coherence_trace.components).toEqual([[CONCRETE_ID]]);
    expect(approved.coherence_trace.normalized_items.map((item: { id: string }) => item.id))
      .toEqual([CONCRETE_ID]);
    expect(approved.work_blocks).toHaveLength(1);
    expect(approved.work_blocks[0]).toMatchObject({
      finding_ids: [CONCRETE_ID],
      owned_files: ["src/auth/login.ts", "src/shared-boundary.ts"],
      role: "implementation",
      max_severity: "high",
    });
    expect(approved.work_block_seams).toEqual([]);
    expect(approved.summary).toMatchObject({
      finding_count: 1,
      work_block_count: 1,
      severity_breakdown: { high: 1, medium: 0 },
      lens_breakdown: { architecture: 0, security: 1 },
    });
  });

  it("declining a whole tier records every finding in it", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });

    await writeFile(
      resolutionPath,
      JSON.stringify({ declined_tiers: ["strategic"] }),
      "utf8",
    );
    await decideNextStep({ root: REPO_DIR });

    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.declined.map((d: { finding_id: string }) => d.finding_id)).toEqual([STRATEGIC_ID]);
    expect(decision.declined[0].reason).toMatch(/tier/i);
  });
});

// Owner decision: a review decision under a stale schema is DISCARDED AND
// RE-ASKED. Discarding alone is not enough: the gate opened only when the file
// was ABSENT, so a present-but-stale record kept it shut, the discarded record
// replayed as "no declines", and every survivor was approved — reversing the
// operator's earlier declines in silence. (After the pipeline seed exists the
// intake handler resumes the pipeline before the gate is reached, so the gate
// replays a decision only on this pre-seed path.)
describe("review-approval gate: a stale-schema decision is re-asked, never replayed as approve-all", () => {
  async function writeStaleDecision(): Promise<void> {
    await writeFile(
      decisionPath,
      JSON.stringify({
        schema_version: "remediate-code-review-decision/v0",
        plan_id: "path-a-review-old",
        approved_ids: [CONCRETE_ID],
        declined: [{ finding_id: STRATEGIC_ID, reason: "declined under the old schema" }],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
  }

  it("before the plan exists: re-halts at the review gate instead of seeding every survivor", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR }); // halt + write request
    await writeStaleDecision();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_review_approval");
    expect(existsSync(seedPath)).toBe(false);
  });
});

// Prompt 17b: the gate's default is APPROVE, so a resolution the tool cannot
// read must never be read as "no declines". A mistyped (here: the retired)
// field name used to approve the finding the user declined, in silence.
describe("review-approval gate: an unreadable resolution is refused whole", () => {
  it("archives the file, records nothing, and re-halts with the reason in the banner", async () => {
    await writeAuditIntake();
    await decideNextStep({ root: REPO_DIR });

    await writeFile(
      resolutionPath,
      JSON.stringify({ disapproved_findings: [STRATEGIC_ID] }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_review_approval");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("REFUSED and archived — nothing was recorded.");
    expect(prompt).toContain("`disapproved_findings` is not a field — write `declined_findings`");
    // Nothing was decided, and the refused file cannot be re-read as an answer.
    expect(existsSync(decisionPath)).toBe(false);
    expect(existsSync(resolutionPath)).toBe(false);
    const refused = (await readdir(ARTIFACTS_DIR)).filter((f) =>
      f.startsWith("review_resolution.json.refused-"),
    );
    expect(refused.length).toBe(1);
  });
});

describe("Path-A coverage is built over the original findings", () => {
  it("records planned/declined/folded/dropped dispositions over originals, not nodes", async () => {
    // A node source file so the promoted extracted-plan node survives grounding.
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "node.ts"), "// node\n", "utf8");

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
    const stateFixture = canonicalStateFromLegacyFixture({
      status: "planning",
      plan: {
        plan_id: "PLAN-CP", findings: [orig("ORIG-PLAN") as Finding],
        blocks: [{ block_id: "CP-001", items: ["ORIG-PLAN"], touched_files: ["src/node.ts"] }],
      },
    });
    await writeApprovedPlanFixture(ARTIFACTS_DIR, stateFixture, REPO_DIR);

    // This fresh run (no state.json at entry) folds intake → plan → implementing
    // → implement dispatch in ONE call: with the checkpoint confirmed and the
    // review decided, no pre-intake gate halts it. (`confirm_resume` is for a
    // *pre-existing* in-progress run; here the entry state is null, so it derives
    // satisfied and never fires — A3 slice 2b removed the handler recursion that
    // used to re-run the pre-intake gates against the freshly-built implementing
    // state and spuriously halt here.) The assertions below are about the
    // plan_coverage written during plan build, which precedes the provider-neutral
    // host handoff.
    const step = await decideNextStep({ root: REPO_DIR });
    // Teeth for A3 slice 2b: the fold reaches the implement dispatch in ONE call.
    // If a handler still recursed into decideNextStepLoop (re-running the pre-intake
    // gates), `confirm_resume` would re-fire against the freshly-built implementing
    // state (there is no resume-ack here) and halt with a confirm_resume step.
    expect(step.step_kind).toBe("dispatch_implement");

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

describe("Path-B canonical owner choices", () => {
  const ARCH_UNIT = "UNIT-architecture";
  const SEC_UNIT = "UNIT-login";
  const paths = executionPlanPaths(ARTIFACTS_DIR);
  const ownerPath = join(paths.directory, "owner-decision.json");
  const nextOptions = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR, finalGateRunner: harness.finalGateRunner };

  async function writeRequestPlan() {
    await harness.writeIntentCheckpoint();
    await acknowledgeResume();
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    for (const file of ["arch.ts", "login.ts"]) await writeFile(join(REPO_DIR, "src", file), "// original implementation\n");
    const input = join(ARTIFACTS_DIR, "request.md");
    await writeFile(input, "Restructure the store boundary and reject invalid login input. Choose the scope of both changes before implementation.\n");
    const options = { ...nextOptions, runId: "REQUEST-owner-choices", sourcePaths: [input] };
    await buildNextContractPipelineStep(options);
    const source = (await readPlanSource(ARTIFACTS_DIR))!;
    const plan: ExecutableChangePlan = {
      plan_id: source.plan_id, objective: "Improve the store boundary and login input handling", non_goals: ["No database migration"],
      requirements: [
        { id: "REQ-architecture", description: "Keep storage calls behind the module interface", source_finding_ids: [], change_kind: "addition",
          assertions: [{ kind: "positive", description: "Public callers use the storage interface", scope_paths: ["src/arch.ts"] }] },
        { id: "REQ-login", description: "Reject invalid login input", source_finding_ids: [], change_kind: "addition",
          assertions: [{ kind: "positive", description: "Invalid input is rejected before querying", scope_paths: ["src/login.ts"] }] },
      ],
      units: [
        { id: ARCH_UNIT, title: "Rework storage boundary", description: "Choose the minimal store/interface boundary change",
          source_finding_ids: [], requirement_ids: ["REQ-architecture"], dependencies: [], read_paths: ["src/arch.ts"], allowed_files: ["src/arch.ts"], required_tests: [],
          affected_interfaces: [{ name: "storage", description: "Keep persistence private to the storage interface" }], addresses_counterexample_ids: [] },
        { id: SEC_UNIT, title: "Reject invalid login input", description: "Validate login input before the query without changing the public response contract",
          source_finding_ids: [], requirement_ids: ["REQ-login"], dependencies: [], read_paths: ["src/login.ts"], allowed_files: ["src/login.ts"], required_tests: [],
          affected_interfaces: [{ name: "login", description: "Preserve the public response contract" }], addresses_counterexample_ids: [] },
      ], source_dispositions: [],
    };
    await writeJsonFile(paths.submission, { base_revision_sha256: null, plan, retired_requirements: [] });
    expect((await ingestExecutionPlan(options)).issues).toEqual([]);
    return { options, plan, canonical: (await readCanonicalPlan(ARTIFACTS_DIR))! };
  }

  async function approveIndependentReviews(f: Awaited<ReturnType<typeof writeRequestPlan>>) {
    for (const role of ["critique", "critic", "judge"] as const) {
      const step = await decideNextStep(nextOptions);
      expect(step.step_kind).toBe("contract_pipeline");
      const request = (await readOptionalJsonFile<{ prompt_sha256: string }>(paths.review(role).request))!;
      expect(request).toBeDefined();
      const result = role === "critique" ? { verdict: "approved", issues: [] } : role === "critic" ? { counterexamples: [] } : {
        verdict: "approved", classifications: [], disposition_assessments: [],
        requirement_assessments: f.plan.requirements.map(requirement => ({ requirement_id: requirement.id, verdict: "satisfied", evidence: ["Reviewed the source, unit boundaries and scoped assertions"] })),
      };
      await writeJsonFile(paths.review(role).submission, { contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
        review: { mode: "independent", reason: "A separate reviewer inspected this executable plan" }, result });
    }
  }

  it("batches scope questions over the concrete units before any review or dispatch", async () => {
    const f = await writeRequestPlan();
    const step = await decideNextStep(nextOptions);
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.status).toBe("blocked");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("Batch scope/behavior questions now");
    expect(prompt).toContain(ARCH_UNIT);
    expect(prompt).toContain(SEC_UNIT);
    expect(step.artifact_paths.execution_plan).toBe(paths.canonical.replaceAll("\\", "/"));
    expect(f.canonical.plan.units.map(unit => unit.title)).toEqual(["Rework storage boundary", "Reject invalid login input"]);
    expect((await readPlanSource(ARTIFACTS_DIR))!.findings).toEqual([]);
    expect(await new StateStore(ARTIFACTS_DIR).loadState()).toBeNull();
    expect(existsSync(paths.review("critique").request)).toBe(false);
    for (const file of ["ambiguity_request.json", "ambiguity_resolution.json", "ambiguity_decision.json"]) {
      expect(existsSync(join(ARTIFACTS_DIR, file))).toBe(false);
    }
  });

  it.each(["missing", "stale", "incomplete", "reasonless"] as const)("a %s owner choice cannot authorize implementation", async kind => {
    const f = await writeRequestPlan();
    if (kind !== "missing") await writeJsonFile(ownerPath, {
      revision_sha256: kind === "stale" ? "0".repeat(64) : f.canonical.revision_sha256,
      confirmed_by: "host", approved_unit_ids: kind === "incomplete" || kind === "reasonless" ? [SEC_UNIT] : [ARCH_UNIT, SEC_UNIT],
      declined_units: kind === "reasonless" ? [{ id: ARCH_UNIT, reason: "" }] : [],
    });
    const step = await decideNextStep(nextOptions);
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.status).toBe("blocked");
    expect(await readApprovedExecutionPlan(ARTIFACTS_DIR)).toBeUndefined();
    expect(await new StateStore(ARTIFACTS_DIR).loadState()).toBeNull();
  });

  it("the current choice opens independent review rather than directly approving the plan", async () => {
    const f = await writeRequestPlan();
    await writeJsonFile(ownerPath, { revision_sha256: f.canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: [ARCH_UNIT, SEC_UNIT], declined_units: [] });
    const step = await decideNextStep(nextOptions);
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.status).toBe("ready");
    expect(existsSync(paths.review("critique").request)).toBe(true);
    expect(await readApprovedExecutionPlan(ARTIFACTS_DIR)).toBeUndefined();
  });

  it("an initial decline keeps its reason and repeated continuation only dispatches the approved unit", async () => {
    const f = await writeRequestPlan();
    await writeJsonFile(ownerPath, { revision_sha256: f.canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: [SEC_UNIT],
      declined_units: [{ id: ARCH_UNIT, reason: "Defer the architecture change until the next release" }] });
    const ownerBytes = await readFile(ownerPath, "utf8");
    await approveIndependentReviews(f);
    const first = await decideNextStep(nextOptions);
    expect(first.step_kind).toBe("dispatch_implement");
    const initial = (await new StateStore(ARTIFACTS_DIR).loadState())!;
    expect(initial.plan!.findings).toEqual([]);
    expect(initial.items![ARCH_UNIT]!.status).toBe("ignored");
    expect(initial.items![ARCH_UNIT]!.failure_reason).toBe("Defer the architecture change until the next release");
    expect(initial.items![SEC_UNIT]!.status).toBe("pending");
    const again = await decideNextStep(nextOptions);
    expect(again.step_kind).toBe("dispatch_implement");
    const repeated = (await new StateStore(ARTIFACTS_DIR).loadState())!;
    expect(repeated.items![ARCH_UNIT]).toEqual(initial.items![ARCH_UNIT]);
    expect(await readFile(ownerPath, "utf8")).toBe(ownerBytes);
    for (const step of [first, again]) {
      const workload = (await readOptionalJsonFile<{ work_items: Array<{ id: string }> }>(step.artifact_paths.host_workload!))!;
      expect(workload.work_items.map(item => item.id)).toEqual([SEC_UNIT]);
    }
  });
});

describe("review-approval gate: skip conditions", () => {
  it("an empty-findings report skips the gate entirely", async () => {
    await writeFile(
      auditPath,
      JSON.stringify(buildAuditFindingsDeliverable([], null)),
      "utf8",
    );
    await writeReadyStructuredAuditIntake(auditPath);

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
    expect(existsSync(requestPath)).toBe(false);
  });
});
