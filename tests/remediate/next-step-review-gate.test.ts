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
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-review-gate");
const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake, acknowledgeResume } = harness;

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
    // Note 3, part A: the up-front ambiguity gate also fires once at planning.
    // Pre-mark it decided so this fold-to-implement test isn't intercepted by it.
    await writeFile(
      join(ARTIFACTS_DIR, "ambiguity_decision.json"),
      JSON.stringify({ resolved_at: new Date().toISOString(), resolution_count: 0 }),
      "utf8",
    );
    await harness.writeIntentCheckpoint();

    // This fresh run (no state.json at entry) folds intake → plan → implementing
    // → implement dispatch in ONE call: with the checkpoint confirmed and the
    // review decided, no pre-intake gate halts it. (`confirm_resume` is for a
    // *pre-existing* in-progress run; here the entry state is null, so it derives
    // satisfied and never fires — A3 slice 2b removed the handler recursion that
    // used to re-run the pre-intake gates against the freshly-built implementing
    // state and spuriously halt here.) The assertions below are about the
    // plan_coverage written during plan build, which precedes dispatch; run with a
    // non-dispatching host so the implement frontier renders the worktree-free
    // sequential step rather than the rolling worktree path (REPO_DIR is not its
    // own git repo).
    const step = await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false });
    // Teeth for A3 slice 2b: the fold reaches the implement dispatch in ONE call.
    // If a handler still recursed into decideNextStepLoop (re-running the pre-intake
    // gates), `confirm_resume` would re-fire against the freshly-built implementing
    // state (there is no resume-ack here) and halt with a confirm_resume step.
    expect(step.step_kind).toBe("implement_rolling_sequential");

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

describe("Path-B planning review gate", () => {
  // Path B (document / conversation) has no pre-pipeline finding set — its
  // findings are derived inside the pipeline — so the gate fires at the PLANNING
  // point over the deduped/grounded node findings, gated on review_decision.json
  // being absent (Path A's decision already exists → no double review).
  const ARCH_NODE = "CP-ARCH-001";
  const SEC_NODE = "CP-SEC-001";

  async function writePathBPlan(): Promise<void> {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "arch.ts"), "// arch\n", "utf8");
    await writeFile(join(REPO_DIR, "src", "login.ts"), "// login\n", "utf8");
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "PLAN-PATH-B",
        source: "contract_pipeline",
        findings: [
          {
            id: ARCH_NODE,
            title: "Rework module boundaries",
            category: "architecture",
            severity: "medium",
            confidence: "medium",
            lens: "architecture",
            summary: "Restructure the store/db seam.",
            affected_files: [{ path: "src/arch.ts" }],
            evidence: ["obligation O-ARCH"],
          },
          {
            id: SEC_NODE,
            title: "Escape login input",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Escape the email before the query.",
            affected_files: [{ path: "src/login.ts" }],
            evidence: ["obligation O-SEC"],
          },
        ],
        blocks: [
          { block_id: "B-ARCH", items: [ARCH_NODE], parallel_safe: true },
          { block_id: "B-SEC", items: [SEC_NODE], parallel_safe: true },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      }),
      "utf8",
    );
    await harness.writeIntentCheckpoint();
    // The plan is built and persisted on the first next-step, so subsequent calls
    // see existing state — ack the resume gate so it doesn't intercept the run.
    await acknowledgeResume();
  }

  it("halts at collect_review_approval over the node findings when no decision exists", async () => {
    await writePathBPlan();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_review_approval");
    expect(step.step_kind).not.toBe("dispatch_implement");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    expect(request.total).toBe(2);
    const ids = request.tiers.flatMap((t: { items: { finding_id: string }[] }) =>
      t.items.map((i) => i.finding_id),
    );
    expect(ids).toEqual(expect.arrayContaining([ARCH_NODE, SEC_NODE]));
  });

  it("declining a node records it terminal (never silently closed) and the run proceeds", async () => {
    await writePathBPlan();
    await writeFile(join(REPO_DIR, "session-config.json"), JSON.stringify({ dispatch: { rolling_engine: false } }), "utf8");
    await decideNextStep({ root: REPO_DIR }); // halt + write request

    await writeFile(
      resolutionPath,
      JSON.stringify({ disapproved_findings: [ARCH_NODE] }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR }); // consume + proceed

    expect(step.step_kind).not.toBe("collect_review_approval");
    // A Path-B decision record is written (distinct plan id from Path A).
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    expect(decision.plan_id).toBe("path-b-review");
    expect(decision.declined.map((d: { finding_id: string }) => d.finding_id)).toEqual([ARCH_NODE]);
    // The declined node is a recorded terminal disposition, not a silent close.
    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    expect(state.items[ARCH_NODE].status).toBe("ignored");
    expect(state.items[ARCH_NODE].failure_reason).toMatch(/disapproved/i);
    expect(state.items[ARCH_NODE].completed_at).toBeTruthy();
    // The approved node stays live for implementation.
    expect(state.items[SEC_NODE].status).toBe("pending");
  });

  it("re-running after the decision does not re-halt (fires at most once)", async () => {
    await writePathBPlan();
    await writeFile(join(REPO_DIR, "session-config.json"), JSON.stringify({ dispatch: { rolling_engine: false } }), "utf8");
    await decideNextStep({ root: REPO_DIR });
    await writeFile(resolutionPath, JSON.stringify({}), "utf8");
    await decideNextStep({ root: REPO_DIR });

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("collect_review_approval");
    expect(existsSync(decisionPath)).toBe(true);
  });
});

describe("up-front ambiguity gate (note 3, part A)", () => {
  // Findings whose scope/judgment is ambiguous must be resolved in ONE batched
  // round at planning, before any implement dispatch — never fall to mid-run
  // triage. The deterministic heuristics seed candidates; the gate halts only
  // when at least one is detected.
  const AMBIG_ID = "CP-ARCH-broad";
  const CLEAR_ID = "CP-SEC-clear";
  const ambiguityRequestPath = join(ARTIFACTS_DIR, "ambiguity_request.json");
  const ambiguityResolutionPath = join(ARTIFACTS_DIR, "ambiguity_resolution.json");
  const ambiguityDecisionPath = join(ARTIFACTS_DIR, "ambiguity_decision.json");

  async function writeAmbiguousPlan(): Promise<void> {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "login.ts"), "// login\n", "utf8");
    // Pre-decide the review gate so it doesn't intercept before the ambiguity gate.
    await writeFile(
      decisionPath,
      JSON.stringify({
        schema_version: "remediate-code-review-decision/v1",
        plan_id: "pre-decided",
        approved_ids: [AMBIG_ID, CLEAR_ID],
        declined: [],
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(
      join(ARTIFACTS_DIR, "extracted-plan.json"),
      JSON.stringify({
        plan_id: "PLAN-AMBIG",
        source: "contract_pipeline",
        findings: [
          {
            // architecture lens + NO cited files → scope_of_fix candidate.
            id: AMBIG_ID,
            title: "Rework module boundaries",
            category: "architecture",
            severity: "medium",
            confidence: "medium",
            lens: "architecture",
            summary: "Restructure the store/db seam.",
            affected_files: [],
            evidence: ["obligation O-ARCH"],
          },
          {
            // security + 1 cited file + high confidence → not ambiguous.
            id: CLEAR_ID,
            title: "Escape login input",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary: "Escape the email before the query.",
            affected_files: [{ path: "src/login.ts" }],
            evidence: ["obligation O-SEC"],
          },
        ],
        blocks: [
          { block_id: "B-ARCH", items: [AMBIG_ID], parallel_safe: true },
          { block_id: "B-SEC", items: [CLEAR_ID], parallel_safe: true },
        ],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      }),
      "utf8",
    );
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({ dispatch: { rolling_engine: false } }),
      "utf8",
    );
    await harness.writeIntentCheckpoint();
    await acknowledgeResume();
  }

  it("halts at collect_clarifications with the detected candidate when ambiguity exists", async () => {
    await writeAmbiguousPlan();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_clarifications");
    const request = JSON.parse(await readFile(ambiguityRequestPath, "utf8"));
    const ids = request.map((c: { finding_id: string }) => c.finding_id);
    expect(ids).toContain(AMBIG_ID); // ambiguous arch finding flagged
    expect(ids).not.toContain(CLEAR_ID); // clear security finding not flagged
    expect(request.find((c: { finding_id: string }) => c.finding_id === AMBIG_ID).category).toBe(
      "scope_of_fix",
    );
  });

  it("explicit user deferral closes the item as ignored and the run proceeds", async () => {
    await writeAmbiguousPlan();
    await decideNextStep({ root: REPO_DIR }); // halt + write request

    await writeFile(
      ambiguityResolutionPath,
      JSON.stringify([
        { finding_id: AMBIG_ID, action: "defer", rationale: "out of scope this run" },
      ]),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR }); // consume + proceed

    expect(step.step_kind).not.toBe("collect_clarifications");
    expect(existsSync(ambiguityDecisionPath)).toBe(true);
    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    // Deferred item is a recorded terminal disposition (ignored), never silently dropped.
    expect(state.items[AMBIG_ID].status).toBe("ignored");
    expect(state.items[AMBIG_ID].failure_reason).toMatch(/deferred/i);
    // The clear item stays live for implementation.
    expect(state.items[CLEAR_ID].status).toBe("pending");
  });

  it("re-running after the resolution does not re-halt (fires at most once)", async () => {
    await writeAmbiguousPlan();
    await decideNextStep({ root: REPO_DIR });
    await writeFile(
      ambiguityResolutionPath,
      JSON.stringify([{ finding_id: AMBIG_ID, action: "clarified", rationale: "minimal local fix" }]),
      "utf8",
    );
    await decideNextStep({ root: REPO_DIR });

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("collect_clarifications");
    expect(existsSync(ambiguityDecisionPath)).toBe(true);
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
