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
import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntakeSummary, IntakeOpenQuestion } from "../../src/remediate/intake.js";
import { scratchDir } from "../helpers/scratch.js";
import {
  autonomousLeftoverFindingsPath,
  autonomousLeftoverReportPath,
  decideNextStep,
  defaultInputCandidates,
  findingCarryForwardKey,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-remediate-state-inv");

// ---------------------------------------------------------------------------
// INV-remediate-state-06: blockingIntakeQuestions — blocking===true only
// ---------------------------------------------------------------------------

describe("blockingIntakeQuestions — INV-remediate-state-06: blocking===true semantics", () => {
  function makeSummary(questions: IntakeOpenQuestion[]): IntakeSummary {
    return {
      schema_version: "remediate-code-intake-summary/v1alpha1",
      ready: false,
      source_type: "documents",
      goals: [],
      non_goals: [],
      constraints: [],
      affected_files: [],
      open_questions: questions,
    };
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
        contract_version: "audit-tools/audit-findings/v1alpha1",
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
      isAuditFindingsReport({ contract_version: "audit-tools/audit-findings/v1alpha1" }),
    ).toBe(false);
  });

  it("rejects when findings is not an array", () => {
    expect(
      isAuditFindingsReport({
        contract_version: "audit-tools/audit-findings/v1alpha1",
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

// ---------------------------------------------------------------------------
// INV-remediate-state-11: Finding carry-forward identity strips plan-time bookkeeping
// (tested via the nextStep stripPlanTimeBookkeeping internals through a structural check)
// ---------------------------------------------------------------------------

describe("Finding identity — INV-remediate-state-11: plan-time bookkeeping fields are isolated from carry-forward identity", () => {
  // The carry-forward identity is `findingCarryForwardKey` in nextStep.ts:
  // canonical JSON of the finding with the plan-time bookkeeping keys stripped,
  // so a re-plan whose only delta is a recomputed file hash / grounding flag
  // carries the prior item forward, while a real change to
  // the finding does not.
  //
  // OBL-remediate-nextstep-and-final-gate-inv-7: this block used to declare its
  // OWN key set, strip function and key builder — a copy of the production trio
  // — and every assertion called the local copy. Dropping `evidence_grounded`
  // from the production set, or widening it with a real field like `severity`,
  // left the block green while re-plan carry-forward regressed, so the file's
  // claim to cover INV-remediate-state-11 was unsupported. The production symbol
  // is now exported and called directly; a test that asserts against its own
  // re-implementation pins nothing about shipped behaviour.
  const carryForwardKey = (finding: unknown): string =>
    findingCarryForwardKey(finding as Finding);

  const baseFinding = {
    id: "F-001",
    title: "First",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "Fix first.",
    affected_files: [{ path: "src/a.ts" }],
    evidence: ["src/a.ts:1 evidence"],
  };

  it("two findings differing ONLY in plan-time bookkeeping share a carry-forward key", () => {
    const planned = {
      ...baseFinding,
      affected_files: [
        { path: "src/a.ts", hash_at_plan_time: "abc123", evidence_grounded: true },
      ],
    };
    const replanned = {
      ...baseFinding,
      affected_files: [
        // Same finding, re-read at a different time → new hash, re-evaluated flag.
        { path: "src/a.ts", hash_at_plan_time: "def456", evidence_grounded: false },
      ],
    };
    expect(carryForwardKey(planned)).toBe(carryForwardKey(replanned));
  });

  it("a finding differing in a real field does NOT share a carry-forward key", () => {
    const planned = { ...baseFinding, affected_files: [{ path: "src/a.ts" }] };
    const realChange = { ...baseFinding, severity: "low" };
    expect(carryForwardKey(planned)).not.toBe(carryForwardKey(realChange));

    // A different cited file is also a real change (not bookkeeping).
    const movedFile = { ...baseFinding, affected_files: [{ path: "src/b.ts" }] };
    expect(carryForwardKey(planned)).not.toBe(carryForwardKey(movedFile));
  });

  it("key derivation is order-insensitive for object keys (canonicalization)", () => {
    const a = { ...baseFinding };
    const b = {
      evidence: baseFinding.evidence,
      affected_files: baseFinding.affected_files,
      summary: baseFinding.summary,
      lens: baseFinding.lens,
      confidence: baseFinding.confidence,
      severity: baseFinding.severity,
      category: baseFinding.category,
      title: baseFinding.title,
      id: baseFinding.id,
    };
    expect(carryForwardKey(a)).toBe(carryForwardKey(b));
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
    return {
      block_id: id,
      items: [findingId],
      parallel_safe: true,
      touched_files: [`src/${findingId}.ts`],
    } as never;
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
      "the emphasised lens must be dispatched first",
    ).toEqual(["b", "a"]);
    expect(
      ordered.blocks.map((b: { block_id: string }) => b.block_id),
      "the blocks carrying those findings move with them",
    ).toEqual(["B-002", "B-001"]);
    // ORDERING ONLY: nothing is dropped or mutated.
    expect(ordered.findings).toHaveLength(2);
    expect(ordered.blocks).toHaveLength(2);
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
    expect(ordered.blocks.map((b: { block_id: string }) => b.block_id)).toEqual([
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

describe("CP-NODE-15 inv-5/fail-6: the unusable extracted plan is archived before it is destroyed", () => {
  it("POSITIVE: the removed plan is recoverable from an archive, byte-identical to the original", async () => {
    // Every cited path is phantom, so grounding drops every finding and the plan
    // refuses — the exact failure that reaches the discard-and-re-extract
    // recovery.
    const plan = {
      plan_id: "PLAN-PHANTOM",
      findings: [extractedFinding("F-GHOST", "src/does-not-exist.ts")],
    };
    const planPath = await writeExtractedPlan(plan);
    const originalBytes = await readFile(planPath, "utf8");

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });

    expect(existsSync(planPath), "the unusable plan is removed").toBe(false);
    const archiveDir = join(dirname(planPath), "archive");
    expect(existsSync(archiveDir), "…but only after an archive was written").toBe(true);
    const archived = await readdir(archiveDir);
    expect(archived.length).toBe(1);
    expect(
      await readFile(join(archiveDir, archived[0]!), "utf8"),
      "the archive must be the plan, not a summary of it",
    ).toBe(originalBytes);
  });

  it("NEGATIVE: the deletion is not stderr-only — the run log names it and its archive", async () => {
    const planPath = await writeExtractedPlan({
      plan_id: "PLAN-PHANTOM-2",
      findings: [extractedFinding("F-GHOST", "src/nowhere/at/all.ts")],
    });

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });

    const log = await readRunLog();
    expect(
      log,
      "stderr is not captured into the artifact dir; the destruction has to be durable",
    ).toContain("extracted_plan_removed");
    const line = log
      .split("\n")
      .find((entry) => entry.includes("extracted_plan_removed"))!;
    expect(line).toContain("archive=");
    expect(line, "the reason the plan was unusable rides with it").toContain("reason=");
    expect(existsSync(planPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OBL-…-inv-6 / fail-9: high-consequence plan-path diagnostics are mirrored
// into the durable run log, and a phantom-path drop records its finding IDS.
// ---------------------------------------------------------------------------

describe("CP-NODE-15 inv-6/fail-9: grounding drops are recorded, not just printed", () => {
  it("POSITIVE: a STRICT SUBSET of phantom-path findings is dropped, with its ids and both counts logged", async () => {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "real.ts"), "export const x = 1;\n", "utf8");

    await writeExtractedPlan({
      plan_id: "PLAN-MIXED",
      findings: [
        extractedFinding("F-REAL", "src/real.ts"),
        extractedFinding("F-GHOST", "src/imaginary.ts"),
      ],
    });

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });

    const log = await readRunLog();
    const line = log
      .split("\n")
      .find((entry) => entry.includes("grounding_dropped_findings"));
    expect(
      line,
      "a caller reading a finding count across the plan boundary must be able to see the drop",
    ).toBeTruthy();
    expect(line!, "the dropped id itself, not merely a count").toContain("F-GHOST");
    expect(line!).toContain("dropped=1");
    expect(line!, "the surviving grounded count is the number that crosses").toContain(
      "grounded=1",
    );
  });

  it("NEGATIVE: EVERY diagnostic write in nextStep.ts is paired with ITS OWN durable run-log event", async () => {
    // The three lean-fast-path diagnostics (route / escalate / fallback) sit on
    // a branch that needs a `low` risk tier and a clear light review to reach,
    // so they are pinned STRUCTURALLY rather than driven. The property is the
    // one that matters and the one that decayed: stderr is not captured into the
    // artifact dir, so a diagnostic that goes only there leaves the durable tree
    // with no trace of a plan being destroyed, findings being dropped, or a run
    // being rerouted.
    //
    // Two ways the first version of this pin was FALSIFIED, both closed below:
    //   (a) "any event within N chars" is satisfiable by a NEIGHBOUR's event, so
    //       a brand-new unpaired write dropped beside a paired one passed. The
    //       nearest preceding event must now fall AFTER the previous diagnostic
    //       — a neighbour's event is on the wrong side of that boundary — AND
    //       within a tight distance, so an unrelated far-away event elsewhere in
    //       the module cannot stand in for a missing one either.
    //   (b) no anti-vacuity guard: rewriting the diagnostics as `console.error`
    //       emptied the needle and the test passed having scanned nothing. The
    //       needle is now a FAMILY, and a zero-site scan fails outright.
    const source = await readFile(
      join(__dirname, "..", "..", "src", "remediate", "steps", "nextStep.ts"),
      "utf8",
    );
    const WRITE_RE = /process\.stderr\.write\(|console\.(?:error|warn)\(/gu;
    const EVENT_RE = /runLogger\??\.event\(/gu;
    const writes = [...source.matchAll(WRITE_RE)].map((m) => m.index);
    const events = [...source.matchAll(EVENT_RE)].map((m) => m.index);

    expect(
      writes.length,
      "ANTI-VACUITY: a scan that matched no diagnostics proves nothing",
    ).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    const MAX_PAIRING_DISTANCE = 800;
    const unpaired: number[] = [];
    writes.forEach((at, index) => {
      const previousWrite = index === 0 ? -1 : writes[index - 1]!;
      const own = events.filter(
        (event) =>
          event < at && event > previousWrite && at - event <= MAX_PAIRING_DISTANCE,
      );
      if (own.length === 0) unpaired.push(source.slice(0, at).split("\n").length);
    });
    expect(
      unpaired,
      "each line number above writes a diagnostic the artifact directory never records",
    ).toEqual([]);
  });

  it("NEGATIVE: the surviving finding keeps its real path — a drop is not a plan-wide refusal", async () => {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "real.ts"), "export const x = 1;\n", "utf8");
    const planPath = await writeExtractedPlan({
      plan_id: "PLAN-MIXED-2",
      findings: [
        extractedFinding("F-REAL", "src/real.ts"),
        extractedFinding("F-GHOST", "src/imaginary.ts"),
      ],
    });

    await decideNextStep({ root: REPO_DIR, skipFinalGate: true });

    // The plan was USABLE, so the recovery path never ran: it is still on disk.
    expect(
      existsSync(planPath),
      "only an all-phantom plan refuses; a partial drop continues",
    ).toBe(true);
    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    const findingIds = (state?.plan?.findings ?? []).map((f) => f.id);
    expect(findingIds).toContain("F-REAL");
    expect(findingIds).not.toContain("F-GHOST");
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
    ] as Finding[]),
  );
}

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
    plan: {
      plan_id: "PLAN-DISPATCH",
      findings: [finding("F-001", "src/a.ts")],
      blocks: [
        {
          block_id: "B-001",
          items: ["F-001"],
          parallel_safe: true,
          touched_files: ["src/a.ts"],
          dependencies: [],
        },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
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
    await saveState(makeImplementingState());
    await writeIntentCheckpoint();
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
    await saveState(makeImplementingState());
    await writeIntentCheckpoint();
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
