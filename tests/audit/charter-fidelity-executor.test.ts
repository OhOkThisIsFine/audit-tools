// The charter-FIDELITY executor (step 4, judgment half, plus step 5's finding
// half): stamps the separate lane's verdicts, settles every unanswered finding
// candidate as `unverifiable` (never assumed supported), and surfaces only the
// `supported` records as grounded Finding leads.
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
import { test, expect, describe } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import type { CharterDifference, CharterLaneGraph } from "audit-tools/shared";

const { runCharterFidelityExecutor } = await import(
  "../../src/audit/orchestrator/charterFidelityExecutor.js"
);

function laneGraph(kind: CharterLaneGraph["kind"], node_id: string, purpose: string): CharterLaneGraph {
  return {
    kind,
    nodes: [{ node_id, purpose, premise_height: 0, files: ["src/a.ts"], provenance: [], confidence: "high" }],
    edges: [],
  };
}

function difference(difference_id: string): CharterDifference {
  return {
    difference_id,
    correspondence_id: "corr-1",
    dimension: "purpose",
    relation: "incompatible",
    split: { kind: "two_against_one", odd: "revealed" },
    accounts: [
      { kind: "stated", claim: "keep one resumable core", provenance: [] },
      { kind: "revealed", claim: "run two independent cores", provenance: [] },
    ],
    gap: "the code runs two cores where the docs promise one",
    routed_to: "remediator",
    finding_candidate: true,
  };
}

/** A register awaiting the fidelity lane with two open finding candidates. */
function pendingRegister(over: Partial<CharterRegister> = {}): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter",
    ceiling: { rung: "deep" },
    ...EMPTY_REGISTER_BODY,
    lanes: [
      laneGraph("stated", "s1", "keep one resumable core"),
      laneGraph("revealed", "r1", "run two independent cores"),
    ],
    correspondences: [
      {
        correspondence_id: "corr-1",
        members: [
          { kind: "stated", node_ids: ["s1"] },
          { kind: "revealed", node_ids: ["r1"] },
        ],
        basis: "tool",
        candidate_id: "cand-1",
        evidence: [],
      },
    ],
    differences: [difference("diff-1"), difference("diff-2")],
    fidelity_pending: true,
    ...over,
  };
}

function bundleWith(register: CharterRegister | undefined): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    ...(register ? { charter_register: register } : {}),
  };
}

describe("runCharterFidelityExecutor", () => {
  test("a supported verdict surfaces a grounded finding; an unanswered candidate is settled unverifiable", () => {
    const run = runCharterFidelityExecutor(bundleWith(pendingRegister()), {
      verdicts: [{ difference_id: "diff-1", verdict: "supported", rationale: "both slices say so" }],
    });
    const reg = run.updated.charter_register!;
    expect(reg.fidelity_pending).toBe(false);
    const byId = new Map(reg.differences.map((d) => [d.difference_id, d]));
    expect(byId.get("diff-1")!.fidelity).toEqual({
      verdict: "supported",
      rationale: "both slices say so",
      decided_by: "lane",
    });
    expect(byId.get("diff-2")!.fidelity?.verdict).toBe("unverifiable");
    expect(byId.get("diff-2")!.fidelity?.decided_by).toBe("tool");
    expect(reg.findings).toHaveLength(1);
    expect(reg.findings[0]!.affected_files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  test("an interpretation verdict names the over-read side and yields NO finding", () => {
    const run = runCharterFidelityExecutor(bundleWith(pendingRegister()), {
      verdicts: [
        { difference_id: "diff-1", verdict: "interpretation", over_read_side: "stated", rationale: "the doc line is weaker than the claim" },
        { difference_id: "diff-2", verdict: "interpretation", over_read_side: "revealed", rationale: "the code line is weaker than the claim" },
      ],
    });
    const reg = run.updated.charter_register!;
    expect(reg.findings).toHaveLength(0);
    expect(reg.differences.every((d) => d.fidelity?.verdict === "interpretation")).toBe(true);
    expect(reg.differences[0]!.fidelity?.over_read_side).toBe("stated");
  });

  test("a verdict for an unknown difference is dropped with a named issue", () => {
    const run = runCharterFidelityExecutor(bundleWith(pendingRegister()), {
      verdicts: [{ difference_id: "diff-ghost", verdict: "supported", rationale: "x" }],
    });
    const reg = run.updated.charter_register!;
    expect(reg.validation_issues.some((m) => m.includes("diff-ghost"))).toBe(true);
    expect(reg.findings).toHaveLength(0);
  });

  test("a pending register settled WITHOUT a submission stamps every candidate unverifiable and records why", () => {
    const run = runCharterFidelityExecutor(bundleWith(pendingRegister()), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.fidelity_pending).toBe(false);
    expect(reg.differences.every((d) => d.fidelity?.verdict === "unverifiable")).toBe(true);
    expect(reg.findings).toHaveLength(0);
    expect(reg.validation_issues.some((m) => /without a lane submission/.test(m))).toBe(true);
  });

  test("a register not awaiting fidelity is settled unchanged", () => {
    const register = pendingRegister({ fidelity_pending: false });
    const run = runCharterFidelityExecutor(bundleWith(register), {
      verdicts: [{ difference_id: "diff-1", verdict: "supported", rationale: "x" }],
    });
    const reg = run.updated.charter_register!;
    expect(reg.fidelity_pending).toBe(false);
    expect(reg.differences[0]!.fidelity).toBeUndefined();
    expect(reg.findings).toHaveLength(0);
  });

  test("no register at all writes a settled omitted register", () => {
    const run = runCharterFidelityExecutor(bundleWith(undefined), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.status).toBe("omitted");
    expect(reg.fidelity_pending).toBe(false);
  });
});
