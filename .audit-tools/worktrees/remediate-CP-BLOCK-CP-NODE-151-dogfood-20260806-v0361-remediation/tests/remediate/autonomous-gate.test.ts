import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import {
  isValidAuditFindingsReport,
  buildAuditDeliverablePair,
} from "audit-tools/shared";
import {
  classifyChangeKind,
  evaluateAutonomousFinding,
  buildAutonomousReviewDecision,
  SAFE_CHANGE_KINDS,
} from "../../src/remediate/review/autonomousGate.js";
import { validateSessionConfig } from "../../src/audit/validation/sessionConfig.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "t",
    category: "General",
    severity: "low",
    confidence: "high",
    lens: "tests",
    summary: "s",
    affected_files: [{ path: "src/a.ts" }],
    evidence: [],
    ...over,
  };
}

describe("classifyChangeKind — fail-closed allowlist", () => {
  it("classifies an additive test as add_test (allowlisted)", () => {
    const c = classifyChangeKind(
      finding({ title: "Missing test", summary: "Add a regression test for the parser." }),
    );
    expect(c.change_kind).toBe("add_test");
    expect(c.allowlisted).toBe(true);
    expect(SAFE_CHANGE_KINDS.has(c.change_kind)).toBe(true);
  });

  it("classifies an additive doc as add_doc (allowlisted)", () => {
    const c = classifyChangeKind(
      finding({ title: "Undocumented fn", summary: "Add documentation comments to the helper." }),
    );
    expect(c.change_kind).toBe("add_doc");
    expect(c.allowlisted).toBe(true);
  });

  it("classifies a new config key as additive_config_key (allowlisted)", () => {
    const c = classifyChangeKind(
      finding({ summary: "Introduce a new config option to toggle verbose logging." }),
    );
    expect(c.change_kind).toBe("additive_config_key");
    expect(c.allowlisted).toBe(true);
  });

  it("classifies an added null/bounds guard as narrowly_localized_reversible_edit", () => {
    const c = classifyChangeKind(
      finding({ summary: "Add a null check before dereferencing the result." }),
    );
    expect(c.change_kind).toBe("narrowly_localized_reversible_edit");
    expect(c.allowlisted).toBe(true);
  });

  it("excludes an in-place semantic edit to an auth check (NOT allowlisted)", () => {
    const c = classifyChangeKind(
      finding({
        lens: "security",
        title: "Auth bypass",
        summary: "Change the default value of the authorization check to allow access.",
      }),
    );
    expect(c.change_kind).toBe("inplace_semantic_edit");
    expect(c.allowlisted).toBe(false);
  });

  it("excludes an in-place edit to a rate cap (NOT allowlisted)", () => {
    const c = classifyChangeKind(
      finding({ summary: "Modify the rate limit cap default to a higher value." }),
    );
    expect(c.change_kind).toBe("inplace_semantic_edit");
    expect(c.allowlisted).toBe(false);
  });

  it("excludes a deletion / dead-code (INV-DA-5) removal (NOT allowlisted)", () => {
    const c = classifyChangeKind(
      finding({ summary: "Remove the unused dead-code deletion_candidate flagged by the graph." }),
    );
    expect(c.change_kind).toBe("deletion");
    expect(c.allowlisted).toBe(false);
  });

  it("deletion disqualifies even when the text also mentions adding a test", () => {
    const c = classifyChangeKind(
      finding({ summary: "Add a test, then remove the legacy parser." }),
    );
    expect(c.change_kind).toBe("deletion");
    expect(c.allowlisted).toBe(false);
  });

  it("fails closed to unknown for an unrecognized substantive change", () => {
    const c = classifyChangeKind(
      finding({ lens: "correctness", summary: "Refactor the scheduling algorithm." }),
    );
    expect(c.change_kind).toBe("unknown");
    expect(c.allowlisted).toBe(false);
  });
});

describe("evaluateAutonomousFinding — tier + allowlist selection", () => {
  it("auto-approves a tier-safe additive test", () => {
    const v = evaluateAutonomousFinding(
      finding({ lens: "tests", severity: "low", confidence: "high", summary: "Add a missing test." }),
    );
    expect(v.tier).toBe("safe");
    expect(v.change_kind).toBe("add_test");
    expect(v.approved).toBe(true);
  });

  it("does NOT auto-approve a tier-safe-but-destructive in-place auth edit", () => {
    // High-confidence + low-severity → classifyFindingRisk tier is "safe", BUT the
    // change-kind is an in-place semantic auth edit → excluded by the allowlist.
    const v = evaluateAutonomousFinding(
      finding({
        lens: "config", // safe lens → tier "safe"
        severity: "low",
        confidence: "high",
        title: "Tighten default",
        summary: "Change the default authorization policy value in place.",
      }),
    );
    expect(v.tier).toBe("safe");
    expect(v.change_kind).toBe("inplace_semantic_edit");
    expect(v.approved).toBe(false);
    expect(v.reason).toMatch(/auth|semantic|allowlist|live/i);
  });

  it("does NOT auto-approve an allowlisted change-kind when the tier is not safe", () => {
    // Low confidence forces tier context_dependent even for an additive test.
    const v = evaluateAutonomousFinding(
      finding({ confidence: "low", summary: "Add a regression test." }),
    );
    expect(v.tier).not.toBe("safe");
    expect(v.approved).toBe(false);
  });
});

describe("buildAutonomousReviewDecision", () => {
  const survivors: Finding[] = [
    finding({ id: "OK-TEST", lens: "tests", confidence: "high", severity: "low", summary: "Add a test for the new path." }),
    finding({ id: "AUTH", lens: "config", confidence: "high", severity: "low", summary: "Change the default auth check value in place." }),
    finding({ id: "DEL", lens: "maintainability", confidence: "high", severity: "info", summary: "Remove the unused dead-code helper." }),
    finding({ id: "SUBST", lens: "correctness", confidence: "high", severity: "high", summary: "Rework the scheduler algorithm." }),
  ];

  it("approves only tier-safe + allowlisted findings; everything else is a leftover", () => {
    const d = buildAutonomousReviewDecision(survivors);
    expect(d.approved_ids).toEqual(["OK-TEST"]);
    expect(d.leftover_ids.sort()).toEqual(["AUTH", "DEL", "SUBST"]);
  });

  it("leftovers carry NO declined disposition (no durable rejection)", () => {
    // The decision exposes only approved + leftover sets — there is no "declined"
    // field at all, so a leftover can never be recorded as durably rejected.
    const d = buildAutonomousReviewDecision(survivors);
    expect(d).not.toHaveProperty("declined");
    for (const id of d.leftover_ids) {
      expect(d.approved_ids).not.toContain(id);
    }
  });

  it("re-evaluates FRESH each call: a leftover that drifts to safe is re-approved next run", () => {
    const drifting = finding({
      id: "DRIFT",
      lens: "correctness",
      confidence: "low", // run 1: not safe → leftover
      severity: "low",
      summary: "Add a null check before use.",
    });
    const run1 = buildAutonomousReviewDecision([drifting]);
    expect(run1.leftover_ids).toEqual(["DRIFT"]);

    // Next nightly run: same finding now arrives high-confidence (drifted across
    // the "safe" boundary) — a fresh evaluation re-approves it.
    const drifted = { ...drifting, confidence: "high" as const };
    const run2 = buildAutonomousReviewDecision([drifted]);
    expect(run2.approved_ids).toEqual(["DRIFT"]);
  });

  it("is deterministic / idempotent: same input → same split", () => {
    const a = buildAutonomousReviewDecision(survivors);
    const b = buildAutonomousReviewDecision(survivors);
    expect(b.approved_ids).toEqual(a.approved_ids);
    expect(b.leftover_ids).toEqual(a.leftover_ids);
  });
});

describe("shared audit-deliverable emitter round-trips through intake", () => {
  it("emits a valid, re-consumable audit-findings.json pair (deliverables on disk without a remote)", () => {
    const leftovers: Finding[] = [
      finding({ id: "L-1", summary: "Remove the dead helper." }),
      finding({ id: "L-2", lens: "security", summary: "Change auth default in place." }),
    ];
    const pair = buildAuditDeliverablePair(leftovers, { title: "Leftovers" });
    // The machine contract validates as a real AuditFindingsReport → the next
    // remediation run consumes it losslessly via defaultInputCandidates.
    expect(isValidAuditFindingsReport(pair.findings_report)).toBe(true);
    expect(pair.findings_report.findings.map((f) => f.id)).toEqual(["L-1", "L-2"]);
    expect(pair.report_markdown).toContain("L-1");
    expect(pair.report_markdown).toContain("L-2");
  });

  it("emits a valid (empty) pair when there are no leftovers", () => {
    const pair = buildAuditDeliverablePair([]);
    expect(isValidAuditFindingsReport(pair.findings_report)).toBe(true);
    expect(pair.findings_report.findings).toEqual([]);
  });
});

describe("validateSessionConfig — autonomous_mode flag", () => {
  it("accepts a boolean autonomous_mode (peer of host_can_dispatch_subagents)", () => {
    expect(validateSessionConfig({ autonomous_mode: true })).toEqual([]);
    expect(validateSessionConfig({ autonomous_mode: false })).toEqual([]);
  });

  it("rejects a non-boolean autonomous_mode", () => {
    const issues = validateSessionConfig({ autonomous_mode: "yes" });
    expect(issues.some((i) => i.path === "autonomous_mode")).toBe(true);
  });
});
