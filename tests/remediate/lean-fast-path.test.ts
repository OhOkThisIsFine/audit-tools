import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "audit-tools/shared";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  evaluateFastPath,
  buildLeanExtractedPlan,
  MAX_FAST_PATH_FINDINGS,
  MAX_FAST_PATH_FILES,
  LEAN_FAST_PATH_SOURCE,
} from "../../src/remediate/steps/leanFastPath.js";
import { createNextStepHarness, AUDIT_FIXTURE } from "./helpers/nextStepHarness.js";

/** A grounded, high-confidence, localized, non-cross-cutting finding (fast-path-eligible by default). */
function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "U-001",
    title: "Localized fix",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "A concrete, grounded fix.",
    affected_files: [{ path: "src/u.ts" }],
    evidence: ["src/u.ts cited evidence"],
    grounding: { status: "grounded" },
    ...overrides,
  };
}

describe("evaluateFastPath — the conservative gate (unit)", () => {
  it("admits a small grounded high-confidence localized batch", () => {
    const decision = evaluateFastPath([
      mkFinding({ id: "U-001", affected_files: [{ path: "src/a.ts" }] }),
      mkFinding({ id: "U-002", affected_files: [{ path: "src/b.ts" }] }),
    ]);
    expect(decision.eligible).toBe(true);
  });

  it("declines an empty approved set", () => {
    const decision = evaluateFastPath([]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/no approved findings/i);
  });

  it(`declines more than ${MAX_FAST_PATH_FINDINGS} findings`, () => {
    const findings = Array.from({ length: MAX_FAST_PATH_FINDINGS + 1 }, (_, i) =>
      mkFinding({ id: `U-${i}`, affected_files: [{ path: `src/u${i}.ts` }] }),
    );
    const decision = evaluateFastPath(findings);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/finding fast-path cap/i);
  });

  it(`declines more than ${MAX_FAST_PATH_FILES} distinct affected files`, () => {
    const decision = evaluateFastPath([
      mkFinding({
        id: "U-001",
        affected_files: Array.from({ length: MAX_FAST_PATH_FILES + 1 }, (_, i) => ({
          path: `src/f${i}.ts`,
        })),
      }),
    ]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/file fast-path cap/i);
  });

  it("declines a finding the auditor did not positively ground", () => {
    expect(evaluateFastPath([mkFinding({ grounding: { status: "ungrounded" } })]).eligible).toBe(
      false,
    );
    // A missing grounding verdict is treated as ungrounded (INV-GND-02).
    const noVerdict = evaluateFastPath([mkFinding({ grounding: undefined })]);
    expect(noVerdict.eligible).toBe(false);
    expect(noVerdict.reason).toMatch(/not positively grounded/i);
  });

  it("declines a finding below high confidence", () => {
    const decision = evaluateFastPath([mkFinding({ confidence: "medium" })]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/below high confidence/i);
  });

  it("declines a systemic / cross-cutting finding", () => {
    const decision = evaluateFastPath([mkFinding({ systemic: true })]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/systemic/i);
  });

  it("declines a finding coupled to related findings (seam risk)", () => {
    const decision = evaluateFastPath([mkFinding({ related_findings: ["OTHER-1"] })]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/coupled/i);
  });

  it("declines an architecture-lens (design-level) finding", () => {
    const decision = evaluateFastPath([mkFinding({ lens: "architecture" })]);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/architecture/i);
  });
});

describe("buildLeanExtractedPlan (unit)", () => {
  it("emits a minimal blockless plan tagged as the lean fast path", () => {
    const plan = buildLeanExtractedPlan([mkFinding()], "LEAN-TEST-1");
    expect(plan.plan_id).toBe("LEAN-TEST-1");
    expect(plan.source).toBe(LEAN_FAST_PATH_SOURCE);
    expect(plan.project_type).toBe("unknown");
    expect(plan.findings).toHaveLength(1);
    // Blocks are intentionally omitted — normalizeExtractedPlan + applyPlanPipeline derive them.
    expect("blocks" in plan).toBe(false);
  });
});

const FAST_PATH_FIXTURE = fileURLToPath(
  new URL("./fixtures/audit-findings-fast-path-eligible.json", import.meta.url),
);

const harness = createNextStepHarness(".test-lean-fast-path");
const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake, approveReviewGate } = harness;

describe("decideNextStep — lean fast path (integration)", () => {
  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("routes a small grounded high-confidence structured-audit batch past the contract pipeline", async () => {
    await writeReadyStructuredAuditIntake(FAST_PATH_FIXTURE);
    await approveReviewGate();
    // Ack the resume gate the planning→implementing fold passes through (as the
    // sibling planning-state dispatch tests do).
    await harness.acknowledgeResume();
    // Pin the wave opt-out so the post-fast-path step is a clean dispatch_implement.
    await writeFile(
      join(REPO_DIR, "session-config.json"),
      JSON.stringify({ dispatch: { rolling_engine: false } }),
      "utf8",
    );

    // T1 slice 3b — the fast path is no longer zero-scrutiny: it first emits a
    // bounded light adversarial review over the approved findings (the floor).
    const review = await decideNextStep({ root: REPO_DIR });
    expect(review.step_kind).toBe("lean_light_review");
    const extractedPlanPath = join(ARTIFACTS_DIR, "extracted-plan.json");
    expect(existsSync(extractedPlanPath)).toBe(false); // no plan until it clears

    // A clear verdict proceeds to the lean plan, consumed straight through
    // planning to implement (the contract pipeline is still skipped).
    await writeFile(
      review.artifact_paths.lean_light_review_verdict,
      JSON.stringify({ disposition: "clear" }),
      "utf8",
    );
    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).not.toBe("contract_pipeline");
    expect(step.step_kind).toBe("dispatch_implement");
    expect(existsSync(extractedPlanPath)).toBe(true);
    const plan = JSON.parse(await readFile(extractedPlanPath, "utf8"));
    expect(plan.source).toBe(LEAN_FAST_PATH_SOURCE);
    expect(plan.findings.map((f: { id: string }) => f.id)).toEqual(["FP-001", "FP-002"]);
  });

  it("declines to fast-path the ungrounded/medium-confidence simple batch (full pipeline)", async () => {
    await writeReadyStructuredAuditIntake(AUDIT_FIXTURE);
    await approveReviewGate();

    const step = await decideNextStep({ root: REPO_DIR });

    // No grounding verdict + a medium-confidence finding ⇒ the gate declines and
    // the run enters the contract pipeline at the framing phase; no lean plan.
    // A low-tier run collapses the framing group (T1 slice 4b), so the entry
    // step's terminal output is module_decomposition.json rather than goal_spec.json;
    // either way it is authoring the framing, not a lean extracted-plan.
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.artifact_paths.output).toMatch(/(goal_spec|module_decomposition)\.input\.json$/);
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(false);
  });
});
