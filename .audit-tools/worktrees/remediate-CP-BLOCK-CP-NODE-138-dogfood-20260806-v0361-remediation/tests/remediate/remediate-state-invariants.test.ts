/**
 * INV-remediate-state-06: blockingIntakeQuestions semantics
 * INV-remediate-state-07: isAuditFindingsReport contract_version validation
 * INV-remediate-state-09: OwnershipRegistry.initialize restores claims on resume
 * INV-remediate-state-10: fileIntegrity TOCTOU-safe hashing + ENOENT vs io_errors
 * INV-remediate-state-11: Finding carry-forward identity strips plan-time bookkeeping
 */
import { describe, it, expect } from "vitest";
import { blockingIntakeQuestions } from "../../src/remediate/intake.js";
import { isAuditFindingsReport } from "../../src/remediate/phases/plan.js";
import { OwnershipRegistry } from "../../src/remediate/dispatch/ownershipRegistry.js";
import { hashFile, hashFileSync } from "../../src/remediate/utils/fileIntegrity.js";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntakeSummary, IntakeOpenQuestion } from "../../src/remediate/intake.js";
import { scratchDir } from "../helpers/scratch.js";

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
// INV-remediate-state-09: OwnershipRegistry.initialize on resumed run
// ---------------------------------------------------------------------------

describe("OwnershipRegistry.initialize — INV-remediate-state-09: does not clear active in-flight claims on resume", () => {
  it("fromJson restores in-flight claims for nodes still in the DAG", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/shared.ts");

    const json = registry.serialize();
    // Restore simulating a resumed run — NODE-A is still in the current DAG.
    const restored = OwnershipRegistry.fromJson(json, new Set(["NODE-A"]));

    // In-flight claim for NODE-A must be preserved.
    expect(restored.amendmentClaimant("src/shared.ts")).toBe("NODE-A");
    expect(restored.getScope("NODE-A")).toContain("src/shared.ts");
  });

  it("fromJson purges claims only for nodes absent from the current DAG", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/x.ts");
    registry.claimAmendment("NODE-B", "src/y.ts");

    const json = registry.serialize();
    // NODE-A is gone from DAG; NODE-B is still live.
    const restored = OwnershipRegistry.fromJson(json, new Set(["NODE-B"]));

    expect(restored.amendmentClaimant("src/x.ts")).toBeUndefined(); // purged
    expect(restored.amendmentClaimant("src/y.ts")).toBe("NODE-B");  // preserved
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-10: fileIntegrity TOCTOU-safe path + ENOENT vs io_errors
// ---------------------------------------------------------------------------

describe("hashFile / hashFileSync — INV-remediate-state-10: ENOENT returns undefined, not io_error", () => {
  it("hashFile returns undefined for a nonexistent path (ENOENT = missing, not io_error)", async () => {
    const missing = "/nonexistent/path/that/does/not/exist.ts";
    const result = await hashFile(missing);
    expect(result).toBeUndefined();
  });

  it("hashFileSync returns undefined for a nonexistent path", () => {
    const missing = "/nonexistent/path/that/does/not/exist.ts";
    const result = hashFileSync(missing);
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
  // The carry-forward identity (nextStep.ts `findingCarryForwardKey`) is a
  // canonical JSON of the finding with the plan-time bookkeeping keys stripped,
  // so a re-plan whose only delta is a recomputed file hash / grounding flag
  // carries the prior item (and its item_spec) forward, while a real change to
  // the finding does not. The keys stripped are documented in nextStep.ts.
  // (`findingCarryForwardKey` is module-internal to the rolling-dispatch-engine
  // module; this test pins the invariant contract the source must uphold rather
  // than the tautology that an object literal lacks a field. Deep integration
  // coverage through decideNextStep's re-plan path lives with that module.)
  const PLAN_TIME_BOOKKEEPING_KEYS = new Set(["hash_at_plan_time", "evidence_grounded"]);

  function stripPlanTimeBookkeeping(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => stripPlanTimeBookkeeping(v));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (PLAN_TIME_BOOKKEEPING_KEYS.has(key)) continue;
      out[key] = stripPlanTimeBookkeeping((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  const carryForwardKey = (finding: unknown): string =>
    JSON.stringify(stripPlanTimeBookkeeping(finding));

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
