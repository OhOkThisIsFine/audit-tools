import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "audit-tools/shared";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import {
  buildLeanExtractedPlan,
  LEAN_FAST_PATH_SOURCE,
} from "../../src/remediate/steps/contractPipeline.js";
import { LEAN_LIGHT_REVIEW_SCHEMA_VERSION } from "../../src/remediate/riskSignal.js";
import {
  findingRiskEvidence,
  MAX_FAST_PATH_FINDINGS,
  MAX_FAST_PATH_FILES,
} from "../../src/remediate/riskSignal.js";
import { createNextStepHarness, AUDIT_FIXTURE } from "./helpers/nextStepHarness.js";

/** A grounded, high-confidence, localized, non-cross-cutting finding (low-tier by default). */
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

// D-68 — the standalone `evaluateFastPath` boolean gate was folded into the risk dial:
// the finding-level simplicity signals now raise the tier as escalate-on-evidence
// (`findingRiskEvidence`), and the lean path is taken IFF the effective tier is `low`.
// A clean handful returns `undefined` (no escalation — the tier stays `low`); any
// design-level / coupling / count signal returns the tier it forces.
describe("findingRiskEvidence — finding-level risk folds into the dial (unit)", () => {
  it("returns undefined for a small grounded high-confidence localized batch (stays low)", () => {
    expect(
      findingRiskEvidence([
        mkFinding({ id: "U-001", affected_files: [{ path: "src/a.ts" }] }),
        mkFinding({ id: "U-002", affected_files: [{ path: "src/b.ts" }] }),
      ]),
    ).toBeUndefined();
  });

  it("returns undefined for an empty set (count/routing is handled by the caller, not risk)", () => {
    expect(findingRiskEvidence([])).toBeUndefined();
  });

  it(`escalates to medium above ${MAX_FAST_PATH_FINDINGS} findings`, () => {
    const findings = Array.from({ length: MAX_FAST_PATH_FINDINGS + 1 }, (_, i) =>
      mkFinding({ id: `U-${i}`, affected_files: [{ path: `src/u${i}.ts` }] }),
    );
    const ev = findingRiskEvidence(findings);
    expect(ev?.tier).toBe("medium");
    expect(ev?.reason).toMatch(/finding low-tier cap/i);
  });

  it(`escalates to medium above ${MAX_FAST_PATH_FILES} distinct affected files`, () => {
    const ev = findingRiskEvidence([
      mkFinding({
        id: "U-001",
        affected_files: Array.from({ length: MAX_FAST_PATH_FILES + 1 }, (_, i) => ({
          path: `src/f${i}.ts`,
        })),
      }),
    ]);
    expect(ev?.tier).toBe("medium");
    expect(ev?.reason).toMatch(/file low-tier cap/i);
  });

  it("escalates to medium for a finding the auditor did not positively ground", () => {
    expect(findingRiskEvidence([mkFinding({ grounding: { status: "ungrounded" } })])?.tier).toBe(
      "medium",
    );
    // A missing grounding verdict is treated as ungrounded (INV-GND-02).
    const noVerdict = findingRiskEvidence([mkFinding({ grounding: undefined })]);
    expect(noVerdict?.tier).toBe("medium");
    expect(noVerdict?.reason).toMatch(/not positively grounded/i);
  });

  it("escalates to medium for a finding below high confidence", () => {
    const ev = findingRiskEvidence([mkFinding({ confidence: "medium" })]);
    expect(ev?.tier).toBe("medium");
    expect(ev?.reason).toMatch(/below high confidence/i);
  });

  it("escalates to medium for a finding coupled to related findings (seam risk)", () => {
    const ev = findingRiskEvidence([mkFinding({ related_findings: ["OTHER-1"] })]);
    expect(ev?.tier).toBe("medium");
    expect(ev?.reason).toMatch(/coupled/i);
  });

  it("escalates to high for a systemic / cross-cutting finding", () => {
    const ev = findingRiskEvidence([mkFinding({ systemic: true })]);
    expect(ev?.tier).toBe("high");
    expect(ev?.reason).toMatch(/systemic/i);
  });

  it("escalates to high for an architecture-lens (design-level) finding", () => {
    const ev = findingRiskEvidence([mkFinding({ lens: "architecture" })]);
    expect(ev?.tier).toBe("high");
    expect(ev?.reason).toMatch(/architecture/i);
  });

  it("prefers the highest applicable tier (a systemic finding among cheap ones ⇒ high)", () => {
    const ev = findingRiskEvidence([
      mkFinding({ id: "U-1" }),
      mkFinding({ id: "U-2", systemic: true, confidence: "medium" }),
    ]);
    expect(ev?.tier).toBe("high");
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
const RISK_SUBSYSTEM_FIXTURE = fileURLToPath(
  new URL("./fixtures/audit-findings-risk-subsystem.json", import.meta.url),
);

const harness = createNextStepHarness(".test-lean-fast-path");
const { REPO_DIR, ARTIFACTS_DIR, writeReadyStructuredAuditIntake, approveReviewGate } = harness;

describe("decideNextStep — lean path = the low risk tier (integration)", () => {
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

    // T1 slice 3b — the low tier is not zero-scrutiny: it first emits a bounded
    // light adversarial review over the approved findings (the floor).
    const review = await decideNextStep({ root: REPO_DIR });
    expect(review.step_kind).toBe("lean_light_review");
    const extractedPlanPath = join(ARTIFACTS_DIR, "extracted-plan.json");
    expect(existsSync(extractedPlanPath)).toBe(false); // no plan until it clears

    // A clear verdict proceeds to the lean plan, consumed straight through
    // planning to implement (the contract pipeline is still skipped).
    await writeFile(
      review.artifact_paths.lean_light_review_verdict,
      JSON.stringify({
        schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
        disposition: "clear",
      }),
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

    // No grounding verdict + a medium-confidence finding ⇒ finding-level risk
    // escalates the tier off `low`, so the run enters the contract pipeline at the
    // framing phase; no lean plan. A low-tier run collapses the framing group (T1
    // slice 4b), so the entry step's terminal output is module_decomposition.json
    // rather than goal_spec.json; either way it is authoring the framing.
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.artifact_paths.output).toMatch(/(goal_spec|module_decomposition)\.input\.json$/);
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(false);
  });

  it("does NOT fast-path a grounded high-confidence finding in a RISK subsystem (D-68 fix)", async () => {
    // The finding is grounded, high-confidence, single-file, non-systemic — the OLD
    // standalone `evaluateFastPath` gate would have called it eligible and BYPASSED
    // the contract pipeline. But its file lives in `src/shared/quota` (a path-risk
    // subsystem), so the intake risk signal rates it `high`. Folding the two
    // classifiers means the tier now governs: high ⇒ full pipeline, no lean bypass.
    await writeReadyStructuredAuditIntake(RISK_SUBSYSTEM_FIXTURE);
    await approveReviewGate();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.step_kind).not.toBe("lean_light_review");
    expect(existsSync(join(ARTIFACTS_DIR, "extracted-plan.json"))).toBe(false);
  });
});
