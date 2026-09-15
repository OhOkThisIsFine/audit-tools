// The charter-COMPARISON executor (steps 2–3 of the five-step charter layer):
// assembles the comparison reader's submission over the register's candidates
// and lane DAGs, routes each difference, runs the quote pre-check, and flags
// the fidelity lane. Omit paths settle the register honestly.
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
import { test, expect, describe } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import type { CharterComparisonSubmission, CharterLaneGraph } from "audit-tools/shared";

const { runCharterComparisonExecutor } = await import(
  "../../src/audit/orchestrator/charterComparisonExecutor.js"
);

function laneGraph(kind: CharterLaneGraph["kind"], node_id: string, purpose: string): CharterLaneGraph {
  return {
    kind,
    nodes: [{ node_id, purpose, premise_height: 0, files: ["src/a.ts"], provenance: [], confidence: "high" }],
    edges: [],
  };
}

/** A deep-ceiling register awaiting the comparison reader, with one tool candidate. */
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
    candidates: [
      {
        candidate_id: "cand-1",
        members: [
          { kind: "stated", node_ids: ["s1"] },
          { kind: "revealed", node_ids: ["r1"] },
        ],
        basis: "file_overlap",
        evidence_paths: ["src/a.ts"],
      },
    ],
    comparison_pending: true,
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

const submission: CharterComparisonSubmission = {
  correspondences: [
    {
      candidate_id: "cand-1",
      verdict: "confirm",
      members: [
        { kind: "stated", node_ids: ["s1"] },
        { kind: "revealed", node_ids: ["r1"] },
      ],
      evidence: [],
    },
  ],
  differences: [
    {
      correspondence: "cand-1",
      dimension: "purpose",
      relation: "incompatible",
      split: { kind: "two_against_one", odd: "revealed" },
      accounts: [
        { kind: "stated", claim: "keep one resumable core", provenance: [] },
        { kind: "revealed", claim: "run two independent cores", provenance: [] },
      ],
      gap: "the code runs two cores where the docs promise one",
    },
  ],
};

describe("runCharterComparisonExecutor", () => {
  test("ingests a confirmed correspondence and its difference, routes it, and flags the fidelity lane", () => {
    const run = runCharterComparisonExecutor(bundleWith(pendingRegister()), submission);
    const reg = run.updated.charter_register!;
    expect(reg.correspondences).toHaveLength(1);
    expect(reg.correspondences[0]!.basis).toBe("tool");
    expect(reg.differences).toHaveLength(1);
    const d = reg.differences[0]!;
    expect(d.dimension).toBe("purpose");
    expect(d.finding_candidate).toBe(true);
    expect(d.routed_to).not.toBe("none");
    // No quotes were cited, so the pre-check cannot settle anything: the lane is owed a verdict.
    expect(d.fidelity).toBeUndefined();
    expect(reg.comparison_pending).toBe(false);
    expect(reg.fidelity_pending).toBe(true);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
  });

  test("a difference resting on an unknown correspondence is refused with a named issue, never silently dropped", () => {
    const run = runCharterComparisonExecutor(bundleWith(pendingRegister()), {
      ...submission,
      differences: [{ ...submission.differences[0]!, correspondence: "cand-missing" }],
    });
    const reg = run.updated.charter_register!;
    expect(reg.differences).toHaveLength(0);
    expect(reg.validation_issues.some((m) => m.includes("cand-missing"))).toBe(true);
    expect(reg.fidelity_pending).toBe(false);
  });

  test("a pending register settled WITHOUT a submission is recorded UNCOMPARED, not affirmed-clean", () => {
    const run = runCharterComparisonExecutor(bundleWith(pendingRegister()), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.comparison_pending).toBe(false);
    expect(reg.correspondences).toHaveLength(0);
    expect(reg.validation_issues.some((m) => /UNCOMPARED/.test(m))).toBe(true);
  });

  test("a register not awaiting a comparison is settled unchanged", () => {
    const register = pendingRegister({ status: "omitted", comparison_pending: false, candidates: [], lanes: [] });
    const run = runCharterComparisonExecutor(bundleWith(register), submission);
    const reg = run.updated.charter_register!;
    expect(reg.status).toBe("omitted");
    expect(reg.comparison_pending).toBe(false);
    expect(reg.correspondences).toHaveLength(0);
    expect(reg.validation_issues).toHaveLength(0);
  });

  test("no register at all writes a settled omitted register", () => {
    const run = runCharterComparisonExecutor(bundleWith(undefined), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.status).toBe("omitted");
    expect(reg.comparison_pending).toBe(false);
  });
});
