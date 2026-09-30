import { executionPlanRevision } from "../../src/remediate/contractPipeline/executionPlan.js";
import { executionPlanForGraph } from "../shared/executionPlanGraphFixture.js";
import { ingestExecutionPlan, executionPlanPaths } from "../../src/remediate/contractPipeline/executionPlan.js";
import { ExecutableChangePlanSchema } from "../../src/shared/types/executionPlan.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
/**
 * INV-remediate-state-06: blockingIntakeQuestions semantics
 * INV-remediate-state-07: isAuditFindingsReport contract_version validation
 * INV-remediate-state-10: fileIntegrity TOCTOU-safe hashing + ENOENT vs io_errors
 * INV-remediate-state-11: Finding carry-forward identity strips plan-time bookkeeping
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { blockingIntakeQuestions, intakePaths } from "../../src/remediate/intake.js";
import { isAuditFindingsReport } from "../../src/remediate/phases/plan.js";
import { hashFile } from "../../src/remediate/utils/fileIntegrity.js";
import { existsSync } from "node:fs";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntakeSummary, IntakeOpenQuestion } from "../../src/remediate/intake.js";
import { scratchDir } from "../helpers/scratch.js";
import {
  autonomousLeftoverFindingsPath,
  autonomousLeftoverReportPath,
  decideNextStep,
  defaultInputCandidates,
} from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding } from "../../src/remediate/state/types.js";
import { withFileLock } from "../../src/shared/io/fileLock.js";
import { buildAuditFindingsDeliverable } from "audit-tools/shared";
import {
  auditFindingsPath,
  auditArtifactsDir,
  auditReportPath,
  promotedAuditFindingsPath,
  promotedAuditReportPath,
} from "../../src/shared/io/auditToolsPaths.js";
import {
  createNextStepHarness,
  makePlanningState,
} from "./helpers/nextStepHarness.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-remediate-state-inv");

/**
 * The text of the CALL STATEMENT enclosing offset `at` — from the opening token
 * back to the `(` that opened it, forward to its matching `)`.
 *
 * Used by the `[remediate-code]` prefix scan below, which must not depend on how
 * many lines a call happens to be formatted across. The delimiter walk is
 * string-aware at the crude level that matters here: a quote or a template
 * literal toggles a flag so a `)` inside a message string is not read as the
 * closer (these diagnostics are template literals full of parens, path
 * separators and interpolation).
 *
 * Degrades to the enclosing LINE when no opening paren can be found, which is a
 * NARROWER window than the call — the safe direction for a scan that fails on a
 * missing label.
 */


// ---------------------------------------------------------------------------
// INV-remediate-state-06: blockingIntakeQuestions — blocking===true only
// ---------------------------------------------------------------------------

describe("blockingIntakeQuestions — INV-remediate-state-06: blocking===true semantics", () => {
  function makeSummary(questions: IntakeOpenQuestion[]): IntakeSummary {
    return intakeSummaryFixture({
      ready: false,
      goals: [],
      affected_files: [],
      open_questions: questions,
    });
  }

  it("treats blocking===true as blocking", () => {
    const summary = makeSummary([
      { id: "Q1", question: "Is this critical?", blocking: true },
    ]);
    expect(blockingIntakeQuestions(summary)).toHaveLength(1);
  });

  it("treats blocking===false as non-blocking", () => {
    const summary = makeSummary([
      { id: "Q1", question: "Advisory note.", blocking: false },
    ]);
    expect(blockingIntakeQuestions(summary)).toHaveLength(0);
  });

  it("treats missing blocking field as non-blocking (INV-06 behavior change)", () => {
    // Previously `!== false` treated undefined as blocking.
    // The correct semantics: only explicit `true` is blocking.
    const summary = makeSummary([
      { id: "Q1", question: "No blocking field at all." },
    ]);
    expect(blockingIntakeQuestions(summary)).toHaveLength(0);
  });

  it("handles an empty questions list", () => {
    expect(blockingIntakeQuestions(makeSummary([]))).toHaveLength(0);
  });

  it("handles undefined summary", () => {
    expect(blockingIntakeQuestions(undefined)).toHaveLength(0);
  });

  it("filters correctly when mixing blocking and non-blocking questions", () => {
    const summary = makeSummary([
      { id: "Q1", question: "Blocking?", blocking: true },
      { id: "Q2", question: "Advisory?", blocking: false },
      { id: "Q3", question: "Implicit non-blocking." },
    ]);
    const result = blockingIntakeQuestions(summary);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("Q1");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-07: isAuditFindingsReport — contract_version required
// ---------------------------------------------------------------------------

describe("isAuditFindingsReport — INV-remediate-state-07: contract_version must be present", () => {
  it("accepts a report with the canonical contract_version and findings array", () => {
    expect(
      isAuditFindingsReport({
        contract_version: "audit-tools/audit-findings/v1alpha2",
        findings: [],
        work_blocks: [],
        summary: {},
      }),
    ).toBe(true);
  });

  it("rejects a non-canonical contract_version (mismatch is an error, not a warning)", () => {
    // INV-remediate-state-07 / OBL-C002-VERSION-TRUST: a present-but-mismatched
    // contract_version is rejected exactly like an absent one — the report
    // cannot be processed safely under a foreign contract version.
    expect(
      isAuditFindingsReport({
        contract_version: "audit-findings/v1alpha1",
        findings: [],
      }),
    ).toBe(false);
  });

  it("rejects a report where contract_version is absent (INV-07)", () => {
    expect(
      isAuditFindingsReport({ findings: [], work_blocks: [] }),
    ).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isAuditFindingsReport(null)).toBe(false);
    expect(isAuditFindingsReport(42)).toBe(false);
    expect(isAuditFindingsReport("not an object")).toBe(false);
  });

  it("rejects when findings field is absent (even with contract_version)", () => {
    expect(
      isAuditFindingsReport({ contract_version: "audit-tools/audit-findings/v1alpha2" }),
    ).toBe(false);
  });

  it("rejects when findings is not an array", () => {
    expect(
      isAuditFindingsReport({
        contract_version: "audit-tools/audit-findings/v1alpha2",
        findings: "not-an-array",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-10: fileIntegrity TOCTOU-safe path + ENOENT vs io_errors
// ---------------------------------------------------------------------------

describe("hashFile — INV-remediate-state-10: ENOENT returns undefined, not io_error", () => {
  it("hashFile returns undefined for a nonexistent path (ENOENT = missing, not io_error)", async () => {
    const missing = "/nonexistent/path/that/does/not/exist.ts";
    const result = await hashFile(missing);
    expect(result).toBeUndefined();
  });

  it("hashFile returns a hex string for an existing file", async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, "test.ts");
    await writeFile(filePath, "const x = 1;", "utf8");
    try {
      const hash = await hashFile(filePath);
      expect(typeof hash).toBe("string");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("hashFile produces the same hash for the same content", async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, "stable.ts");
    const content = "export const VERSION = 1;";
    await writeFile(filePath, content, "utf8");
    try {
      const hash1 = await hashFile(filePath);
      const hash2 = await hashFile(filePath);
      expect(hash1).toBe(hash2);
    } finally {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// INV-remediate-state-11: semantic execution identity is independent of presentation order.
describe("reviewed execution identity", () => {
  it("reordered requirements and units retain the same semantic revision", () => {
    const plan = executionPlanForGraph([["A", []], ["B", ["A"]]]);
    const reordered = { ...plan, requirements: [...plan.requirements].reverse(), units: [...plan.units].reverse() };
    expect(executionPlanRevision(plan, "a".repeat(64))).toBe(executionPlanRevision(reordered, "a".repeat(64)));
  });
  it("changed execution meaning or source provenance requires a different review", () => {
    const plan = executionPlanForGraph([["A", []]]);
    const changed = { ...plan, units: [{ ...plan.units[0]!, description: "A different operation" }] };
    expect(executionPlanRevision(plan, "a".repeat(64))).not.toBe(executionPlanRevision(changed, "a".repeat(64)));
    expect(executionPlanRevision(plan, "a".repeat(64))).not.toBe(executionPlanRevision(plan, "b".repeat(64)));
  });
});

// ---------------------------------------------------------------------------
// CP-NODE-15 pointer A: the checkpoint's interpreted intent reaches the plan.
//
// `applyIntentOrdering` had NO production caller. The checkpoint's intent was
// written and never read back, so "the work the user emphasised is dispatched
// first" was a property the code could state but not deliver — a write-only
// data flow. These pin the wiring end to end through the real ordering.
// ---------------------------------------------------------------------------

describe("CP-NODE-15: checkpoint intent orders the finalized plan", () => {
  function finding(id: string, lens: string, severity: string) {
    return {
      id,
      title: `Fix ${id}`,
      category: "correctness",
      severity,
      confidence: "high",
      lens,
      summary: `Summary ${id}`,
      affected_files: [{ path: `src/${id}.ts` }],
      evidence: [`src/${id}.ts:1`],
    } as never;
  }

  function block(id: string, findingId: string) {
    return canonicalUnitFixture(id, { source_finding_ids: [findingId], allowed_files: [`src/${findingId}.ts`] });
  }

  it("reorders findings and their blocks by the interpreted intent", async () => {
    const { applyIntentOrdering } = await import(
      "../../src/remediate/intent/intentOrdering.js"
    );
    const { interpretFreeFormIntent } = await import("audit-tools/shared");
    // `security` is second in input order; the intent emphasises it.
    const findings = [finding("a", "maintainability", "low"), finding("b", "security", "high")];
    const blocks = [block("B-001", "a"), block("B-002", "b")];

    const intent = interpretFreeFormIntent("focus on security, it is urgent");
    const ordered = applyIntentOrdering(findings, blocks, intent);

    expect(
      ordered.findings.map((f: { id: string }) => f.id),
      "immutable source order stays unchanged",
    ).toEqual(["a", "b"]);
    expect(
      ordered.units.map((b: { id: string }) => b.id),
      "the blocks carrying those findings move with them",
    ).toEqual(["B-002", "B-001"]);
    // ORDERING ONLY: nothing is dropped or mutated.
    expect(ordered.findings).toHaveLength(2);
    expect(ordered.units).toHaveLength(2);
  });

  it("returns the plan untouched when the checkpoint carries no intent", async () => {
    const { applyIntentOrdering } = await import(
      "../../src/remediate/intent/intentOrdering.js"
    );
    const { interpretFreeFormIntent } = await import("audit-tools/shared");
    const findings = [finding("a", "maintainability", "low"), finding("b", "security", "high")];
    const blocks = [block("B-001", "a"), block("B-002", "b")];

    const ordered = applyIntentOrdering(findings, blocks, interpretFreeFormIntent(""));

    expect(
      ordered.findings.map((f: { id: string }) => f.id),
      "no intent means no reordering — the default path must stay identity",
    ).toEqual(["a", "b"]);
    expect(ordered.units.map((b: { id: string }) => b.id)).toEqual([
      "B-001",
      "B-002",
    ]);
  });

  it("is WIRED: nextStep applies checkpoint ordering where the plan is finalized", async () => {
    // The unit above proves the function orders. This proves the production
    // module CALLS it — the half that was missing, and the half a unit test of
    // the pure function can never establish.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      join(__dirname, "..", "..", "src", "remediate", "steps", "nextStep.ts"),
      "utf8",
    );
    expect(
      source,
      "nextStep.ts must import the ordering it is supposed to apply",
    ).toContain("applyIntentOrdering");
    // The ASSIGNMENT form, not a bare name match: the helper's own declaration
    // contains `applyCheckpointIntentOrdering(` too, so matching the name alone
    // stays green with the call site deleted — which is exactly the unwired
    // state this test exists to catch.
    expect(
      source,
      "and must call it on the finalized plan, not merely define it",
    ).toMatch(/plan\s*=\s*await\s+applyCheckpointIntentOrdering\s*\(/u);
  });
});

// ---------------------------------------------------------------------------
// CP-NODE-15 pointer B (INV-RNF-NO-CANONICAL-PAIR-WRITE / fail-8): the
// autonomous leftover emit must not overwrite the canonical audit pair.
// ---------------------------------------------------------------------------

// The two source-text scans that used to live here are GONE, deliberately.
// They asserted the shape of `emitAutonomousLeftoverDeliverable`'s body and of
// `defaultInputCandidates`' body — prose about the code rather than the code's
// behaviour, and green against any rewrite that kept the words. Both properties
// are now carried by derived siblings: the emit is DRIVEN and its real
// run.log.jsonl read (below, in the harness-backed section), and the candidate
// ORDER is read off the array `defaultInputCandidates` actually returns.
describe("CP-NODE-15: the leftover emit leaves the canonical audit pair alone", () => {
  it("keeps the round-trip: the leftover pair is the LAST candidate, so a real audit always wins", () => {
    // Read off the RETURNED array, not the function's source text. Two
    // properties in one derived assertion: the leftover pair is still reachable
    // (drop it and the next unattended run stops round-tripping its own
    // leftovers), and it is strictly last (promote it and this run's leftovers
    // outrank a real audit at index 0).
    const root = join(scratchDir(".test-leftover-order"), "repo");
    const candidates = defaultInputCandidates(root);
    const findingsIndex = candidates.indexOf(autonomousLeftoverFindingsPath(root));
    const reportIndex = candidates.indexOf(autonomousLeftoverReportPath(root));
    expect(findingsIndex, "the leftover pair must still be a candidate").toBeGreaterThan(
      -1,
    );
    expect(reportIndex).toBeGreaterThan(-1);
    const auditDir = auditArtifactsDir(root);
    for (const canonical of [
      promotedAuditFindingsPath(auditDir),
      auditFindingsPath(auditDir),
      promotedAuditReportPath(auditDir),
      auditReportPath(auditDir),
    ]) {
      const canonicalIndex = candidates.indexOf(canonical);
      expect(canonicalIndex, `${canonical} must be a candidate`).toBeGreaterThan(-1);
      expect(
        canonicalIndex,
        "a real audit must outrank this run's own leftovers",
      ).toBeLessThan(findingsIndex);
    }
    expect(
      Math.max(findingsIndex, reportIndex),
      "the leftover pair is LAST in the discovery order",
    ).toBe(candidates.length - 1);
  });

  it("inv-4: the leftover paths are DISJOINT from every canonical audit path, by construction", () => {
    // The path-level statement of the same property, derived rather than read
    // out of the emit's body: whatever the emit writes, it cannot be a file the
    // run is being fed by path. `defaultInputCandidates` resolves the canonical
    // pair FIRST, so an overwrite there destroys the run's own audit source.
    const root = join(scratchDir(".test-leftover-paths"), "repo");
    const auditDir = auditArtifactsDir(root);
    const canonical = new Set([
      promotedAuditFindingsPath(auditDir),
      auditFindingsPath(auditDir),
      promotedAuditReportPath(auditDir),
      auditReportPath(auditDir),
    ]);
    for (const leftover of [
      autonomousLeftoverFindingsPath(root),
      autonomousLeftoverReportPath(root),
    ]) {
      expect(canonical.has(leftover), `${leftover} must not be a canonical path`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CP-NODE-15, the plan path and the serial advance, driven through the real
// decideNextStep. One harness, its own scratch repo.
// ---------------------------------------------------------------------------

const harness = createNextStepHarness(".test-remediate-state-inv-nextstep");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } =
  harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

function extractedFinding(id: string, path: string): Record<string, unknown> {
  return {
    id,
    title: `Finding ${id}`,
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: `Fix ${id}.`,
    affected_files: [{ path }],
    evidence: [`${path}:1 evidence`],
  };
}

/** Write an extracted plan the pre-intake fast path will pick up and normalize. */
async function writeExtractedPlan(plan: unknown): Promise<string> {
  const planPath = intakePaths(ARTIFACTS_DIR).extractedPlan;
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  await writeIntentCheckpoint();
  return planPath;
}

async function readRunLog(): Promise<string> {
  const logPath = join(ARTIFACTS_DIR, "run.log.jsonl");
  return existsSync(logPath) ? readFile(logPath, "utf8") : "";
}

// ---------------------------------------------------------------------------
// OBL-…-inv-5 / fail-6: no irreversible delete runs before its archive is
// written and verified — and the destruction is visible in the durable log.
// ---------------------------------------------------------------------------

describe("canonical plan changes preserve authored evidence", () => {
  it("leaves a retired extracted plan byte-exact and unconsumed", async () => {
    const path = await writeExtractedPlan({ plan_id: "PLAN-retired", findings: [extractedFinding("F-GHOST", "src/nonexistent.ts")] });
    const bytes = await readFile(path, "utf8");
    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await new StateStore(ARTIFACTS_DIR).loadState())?.plan).toBeUndefined();
    expect(await readRunLog()).toContain("collect_starting_point");
  });

  it("refuses an invalid semantic amendment without losing the prior plan or submitted evidence", async () => {
    const state = makeImplementingState();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
    const paths = executionPlanPaths(ARTIFACTS_DIR);
    const before = await readFile(paths.canonical, "utf8");
    const amendment = ExecutableChangePlanSchema.strip().parse(state.plan);
    amendment.units[0]!.allowed_files = ["../outside.ts"];
    const bytes = JSON.stringify({ base_revision_sha256: state.plan!.review_revision_sha256, plan: amendment });
    await writeFile(paths.submission, bytes);
    const result = await ingestExecutionPlan({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.changed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(await readFile(paths.canonical, "utf8")).toBe(before);
    expect(await readFile(paths.submission, "utf8")).toBe(bytes);
  });

  it("archives accepted predecessor revisions and keeps original source findings unchanged", async () => {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src/a.ts"), "export const source = true;\n");
    const state = makeImplementingState();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
    const paths = executionPlanPaths(ARTIFACTS_DIR);
    const before = JSON.parse(await readFile(paths.canonical, "utf8"));
    const sourceBefore = await readFile(paths.source, "utf8");
    const amendment = ExecutableChangePlanSchema.strip().parse(state.plan);
    amendment.units[0]!.description = "Implement the same source requirement with an explicit boundary";
    await writeFile(paths.submission, JSON.stringify({ base_revision_sha256: state.plan!.review_revision_sha256, plan: amendment }));
    const result = await ingestExecutionPlan({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.issues).toEqual([]);
    expect(result.changed).toBe(true);
    expect(JSON.parse(await readFile(join(paths.directory, "history", `${state.plan!.review_revision_sha256}.json`), "utf8"))).toEqual(before);
    expect(await readFile(paths.source, "utf8")).toBe(sourceBefore);
    expect(existsSync(paths.submission)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-12 / fail-8, BEHAVIOURALLY: drive the autonomous review branch and
// read what actually landed on disk and in the real run log.
// ---------------------------------------------------------------------------

/** Two findings, one of which the autonomous allowlist will not auto-approve. */
function autonomousAuditReport(): string {
  return JSON.stringify(
    buildAuditFindingsDeliverable([
      {
        id: "ARC-leftover-001",
        title: "Module boundaries leak persistence concerns",
        category: "architecture",
        severity: "high",
        confidence: "medium",
        lens: "architecture",
        summary: "The store layer reaches across module seams.",
        affected_files: [{ path: "src/store.ts" }],
        evidence: ["src/store.ts:1 evidence"],
      },
      {
        id: "TST-leftover-002",
        title: "Missing regression coverage",
        category: "tests",
        severity: "low",
        confidence: "high",
        lens: "tests",
        summary: "The parser has no failing-input test.",
        affected_files: [{ path: "src/parser.ts" }],
        evidence: ["src/parser.ts:9 evidence"],
      },
    ] as Finding[], LEFTOVER_SOURCE_AUDIT_READ),
  );
}

/**
 * What the ORIGINAL audit read. The placeholder id resolves in no repository,
 * so it can only reach the leftover pair by being carried — never by a read of
 * the commit current when the remediator re-emits.
 */
const LEFTOVER_SOURCE_AUDIT_READ = {
  commit: "d".repeat(40),
  dirty_paths: ["src/parser.ts"],
};

describe("CP-NODE-15 inv-12/fail-8: the leftover emit, driven", () => {
  it("emits the remediation-owned pair, logs it, and leaves the canonical pair BYTE-IDENTICAL", async () => {
    // Autonomous review mode is what reaches the leftover emit at all.
    const auditDir = join(REPO_DIR, ".audit-tools", "audit");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "session-config.json"),
      JSON.stringify({ review_mode: "autonomous", observability: "standard" }),
      "utf8",
    );

    // The canonical pair, pre-existing with SENTINEL bytes. This is the audit
    // source `defaultInputCandidates` resolves first; the emit used to overwrite
    // it unarchived, so the run destroyed the contract it was reading.
    const canonicalFindings = join(REPO_DIR, ".audit-tools", "audit-findings.json");
    const canonicalReport = join(REPO_DIR, ".audit-tools", "audit-report.md");
    await writeFile(canonicalFindings, autonomousAuditReport(), "utf8");
    await writeFile(canonicalReport, "# The original audit render\n", "utf8");
    const findingsBefore = await readFile(canonicalFindings);
    const reportBefore = await readFile(canonicalReport);

    const auditPath = join(REPO_DIR, "my-audit.json");
    await writeFile(auditPath, autonomousAuditReport(), "utf8");
    await harness.writeReadyStructuredAuditIntake(auditPath);
    await acknowledgeResume();

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });

    // 1. The emit landed on the remediation-owned path.
    expect(
      existsSync(autonomousLeftoverFindingsPath(REPO_DIR)),
      "the leftover pair must be emitted somewhere",
    ).toBe(true);
    expect(existsSync(autonomousLeftoverReportPath(REPO_DIR))).toBe(true);

    // 2. The canonical pair is untouched, byte for byte.
    expect(
      Buffer.compare(await readFile(canonicalFindings), findingsBefore),
      "the run's own audit source must survive the run",
    ).toBe(0);
    expect(Buffer.compare(await readFile(canonicalReport), reportBefore)).toBe(0);

    // 3. The emit is in the REAL run log, not merely in the source text.
    const line = (await readRunLog())
      .split("\n")
      .find((entry) => entry.includes("autonomous_leftover_deliverable"));
    expect(
      line,
      "a leftover emit that left no run-log event was invisible after the fact",
    ).toBeTruthy();
    expect(line!, "the event names where it wrote").toContain(
      "autonomous-leftovers-findings.json",
    );

    // 4. The leftovers were read by the ORIGINAL audit, so the pair re-states
    // its `audit_read`. The next run consumes this file as its findings
    // contract; a remediation-side commit here would become its `B`.
    const leftover = JSON.parse(
      await readFile(autonomousLeftoverFindingsPath(REPO_DIR), "utf8"),
    ) as { audit_read: unknown };
    expect(leftover.audit_read).toEqual(LEFTOVER_SOURCE_AUDIT_READ);
  });
});

// ---------------------------------------------------------------------------
// OBL-…-fail-1 / fail-2 / fail-4: the implement-dispatch preconditions throw
// rather than degrade, and decideNextStep logs an error event and re-throws.
// ---------------------------------------------------------------------------

function makeImplementingState(): RemediationState {
  const finding = (id: string, path: string): Finding =>
    ({
      id,
      title: `Finding ${id}`,
      category: "correctness",
      severity: "high",
      confidence: "high",
      lens: "correctness",
      summary: `Fix ${id}.`,
      affected_files: [{ path }],
      evidence: [`${path}:1 evidence`],
    }) as Finding;
  return {
    status: "implementing",
    plan: canonicalPlanFixture({
      plan_id: "PLAN-DISPATCH", findings: [finding("F-001", "src/a.ts")],
      units: [canonicalUnitFixture("F-001", { source_finding_ids: ["F-001"], allowed_files: ["src/a.ts"] })],
      requirements: [{ id: "REQ-F-001", description: "Fix the original issue", source_finding_ids: ["F-001"], change_kind: "structural", assertions: [], inapplicable_reason: "Fixture tests dispatch boundary" }],
      candidate_closing_actions: ["none"],
    }),
    items: {
      "F-001": { unit_id: "F-001", status: "pending" },
    },
    closing_plan: { action: "none" },
  };
}

describe("CP-NODE-15 fail-1/fail-2/fail-4: the dispatch preconditions refuse loudly", () => {
  it("NEGATIVE (fail-1): a retired dispatch-shaped state throws instead of crossing the boundary", async () => {
    // A key outside the current state contract is exactly what the host-handoff
    // boundary treats as a retired shape. It must not be coerced into an empty
    // summary or an empty workload, and a blind retry must reproduce it.
    await saveState({
      ...makeImplementingState(),
      retired_dispatch_pool: { workers: [] },
    } as unknown as RemediationState);
    await writeIntentCheckpoint();
    await acknowledgeResume();

    await expect(
      decideNextStep({ root: REPO_DIR, skipFinalGate: true }),
    ).rejects.toThrow(/retired dispatch shape/u);
    await expect(
      decideNextStep({ root: REPO_DIR, skipFinalGate: true }),
    ).rejects.toThrow(/retired dispatch shape/u);
  });

  it("NEGATIVE (fail-4): the throw is LOGGED as an error event before it is re-thrown", async () => {
    await saveState({
      ...makeImplementingState(),
      retired_dispatch_pool: { workers: [] },
    } as unknown as RemediationState);
    await writeIntentCheckpoint();
    await acknowledgeResume();

    await expect(
      decideNextStep({ root: REPO_DIR, skipFinalGate: true }),
    ).rejects.toThrow();

    const errorLines = (await readRunLog())
      .split("\n")
      .filter((line) => line.includes(`"kind":"error"`));
    expect(errorLines.length, "a swallowed error leaves no trail at all").toBeGreaterThan(
      0,
    );
    expect(errorLines.join("\n")).toContain("retired dispatch shape");
  });

  it("POSITIVE (fail-2): a current-shaped state in a real checkout prepares a workload bound to HEAD", async () => {
    const state = makeImplementingState();
    await writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
    await saveState(state);
    await acknowledgeResume();

    const step = await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    expect(step.step_kind).toBe("dispatch_implement");
    const workloadPath = step.artifact_paths.host_workload;
    expect(workloadPath).toBeTruthy();
    const workload = JSON.parse(await readFile(workloadPath!, "utf8")) as {
      work_items: { baseline_commit: string }[];
    };
    expect(workload.work_items.length).toBeGreaterThan(0);
    expect(
      workload.work_items[0]!.baseline_commit,
      "a real 40-hex HEAD, never a synthesized baseline",
    ).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("NEGATIVE (fail-2): outside a git checkout the run refuses rather than synthesizing a baseline", async () => {
    const state = makeImplementingState();
    await writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state);
    await saveState(state);
    await acknowledgeResume();
    await rm(join(REPO_DIR, ".git"), { recursive: true, force: true });

    await expect(
      decideNextStep({ root: REPO_DIR, skipFinalGate: true }),
    ).rejects.toThrow(/without a repository HEAD commit/u);
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-11 / fail-3: one bounded step per invocation, and the WHOLE serial
// advance — pre-intake included — is mutex-guarded.
// ---------------------------------------------------------------------------

describe("CP-NODE-15 inv-11/fail-3: one bounded step per invocation, serialized end to end", () => {
  it("POSITIVE: a single invocation emits one step and increments step_count exactly once", async () => {
    await saveState(makePlanningState());
    await writeIntentCheckpoint();
    await acknowledgeResume();
    const store = new StateStore(ARTIFACTS_DIR);
    const before = (await store.loadState())?.step_count ?? 0;

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    expect((await store.loadState())?.step_count).toBe(before + 1);

    // A second host invocation counts exactly once more — never twice for one
    // call, however many obligations the fold drained inside it.
    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    expect((await store.loadState())?.step_count).toBe(before + 2);
  });

  it("NEGATIVE: the PRE-INTAKE segment is inside the mutex — a peer's hold yields phase_busy, not a gate run", async () => {
    // No state at all, so this call lands squarely in the pre-intake
    // obligations — which is where the review-approval gate and its leftover
    // deliverable emit live. That whole segment used to run OUTSIDE the phase
    // lock (only the main advance was inside it), so two concurrent next-step
    // calls could both take the autonomous branch. With the lock held by a peer
    // the call must now yield instead of executing any of it.
    let signalAcquired!: () => void;
    let releasePeer!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    const held = withFileLock(join(ARTIFACTS_DIR, "phase.lock"), async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    const step = await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    releasePeer();
    await held;

    expect(
      step.step_kind,
      "an unguarded pre-intake would have emitted its own real step here",
    ).toBe("phase_busy");
    expect(step.status).toBe("ready");
    expect(existsSync(join(ARTIFACTS_DIR, "state.json"))).toBe(false);
  });
});
