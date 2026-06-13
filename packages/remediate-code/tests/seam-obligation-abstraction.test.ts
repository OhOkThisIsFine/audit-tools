/**
 * Cross-module seam test: obligation-abstraction
 * N-TEST-SEAM-obligation-abstraction
 *
 * Verifies that the shared obligation-abstraction module (@audit-tools/shared)
 * and the remediate-code consumer (validation/contractPipeline.ts) agree on the
 * same interface. If either side diverges — shared changes required fields, or
 * the validator stops accepting the builder's output — this test fails.
 *
 * Seam boundary:
 *   - Producer: @audit-tools/shared { buildObligationLedger, detectObligationCycle,
 *               ObligationEntry, ObligationLedger, CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION }
 *   - Consumer: remediate-code/src/validation/contractPipeline.ts { validateObligationLedger }
 */

import { describe, it, expect } from "vitest";
import {
  buildObligationLedger,
  detectObligationCycle,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  type ObligationEntry,
  type ObligationLedger,
} from "@audit-tools/shared";
import { validateObligationLedger } from "../src/validation/contractPipeline.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  overrides: Partial<ObligationEntry> = {},
): ObligationEntry {
  return {
    id,
    description: `Obligation ${id}`,
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    ...overrides,
  };
}

// ── SEAM-01: round-trip — builder output passes validator ─────────────────────

describe("SEAM-01: builder→validator round-trip", () => {
  it("buildObligationLedger output passes validateObligationLedger with no errors", () => {
    const ledger = buildObligationLedger({
      goal_id: "goal-seam-test",
      obligations: [
        makeEntry("OBL-001"),
        makeEntry("OBL-002", { depends_on: ["OBL-001"], kind: "invariant" }),
        makeEntry("OBL-003", { depends_on: ["OBL-001", "OBL-002"], kind: "test", status: "satisfied" }),
      ],
    });

    const issues = validateObligationLedger(ledger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("buildObligationLedger with a single obligation passes validateObligationLedger", () => {
    const ledger = buildObligationLedger({
      goal_id: "goal-single",
      obligations: [makeEntry("ONLY-001", { kind: "structural" })],
    });

    const issues = validateObligationLedger(ledger);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("buildObligationLedger with an empty obligations list passes validateObligationLedger", () => {
    const ledger = buildObligationLedger({
      goal_id: "goal-empty",
      obligations: [],
    });

    const issues = validateObligationLedger(ledger);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("buildObligationLedger with priority + source optional fields passes validator", () => {
    const ledger = buildObligationLedger({
      goal_id: "goal-optional-fields",
      obligations: [
        makeEntry("OBL-A", { priority: 1, source: "design_spec" }),
        makeEntry("OBL-B", { priority: 2, source: "critique", depends_on: ["OBL-A"] }),
        makeEntry("OBL-C", { priority: 3, source: "counterexample", depends_on: ["OBL-B"] }),
        makeEntry("OBL-D", { source: "manual" }),
      ],
    });

    const issues = validateObligationLedger(ledger);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

// ── SEAM-02: contract_version constant is shared ──────────────────────────────

describe("SEAM-02: contract_version constant is single-sourced from shared", () => {
  it("buildObligationLedger embeds the canonical CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION", () => {
    const ledger = buildObligationLedger({
      goal_id: "goal-version-check",
      obligations: [],
    });

    expect(ledger.contract_version).toBe(CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION);
  });

  it("validateObligationLedger rejects a mismatched contract_version", () => {
    const ledger: unknown = {
      contract_version: "wrong-version/v99",
      goal_id: "goal-version-mismatch",
      obligations: [],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(ledger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("contract_version"))).toBe(true);
  });

  it("validateObligationLedger rejects a missing contract_version", () => {
    const ledger: unknown = {
      goal_id: "goal-no-version",
      obligations: [],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(ledger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── SEAM-03: builder cycle guard + validator structural gates agree ───────────

describe("SEAM-03: cycle detection — builder guard vs. validator gate", () => {
  it("detectObligationCycle returns null for acyclic obligations", () => {
    const obligations: ObligationEntry[] = [
      makeEntry("A"),
      makeEntry("B", { depends_on: ["A"] }),
      makeEntry("C", { depends_on: ["B"] }),
    ];
    expect(detectObligationCycle(obligations)).toBeNull();
  });

  it("detectObligationCycle returns cycle members for a 2-node cycle", () => {
    const obligations: ObligationEntry[] = [
      makeEntry("X", { depends_on: ["Y"] }),
      makeEntry("Y", { depends_on: ["X"] }),
    ];
    const cycle = detectObligationCycle(obligations);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  it("detectObligationCycle returns cycle members for a 3-node cycle", () => {
    const obligations: ObligationEntry[] = [
      makeEntry("A", { depends_on: ["C"] }),
      makeEntry("B", { depends_on: ["A"] }),
      makeEntry("C", { depends_on: ["B"] }),
    ];
    const cycle = detectObligationCycle(obligations);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
  });

  it("buildObligationLedger throws at construction time for a cyclic graph", () => {
    const obligations: ObligationEntry[] = [
      makeEntry("P", { depends_on: ["Q"] }),
      makeEntry("Q", { depends_on: ["P"] }),
    ];
    expect(() =>
      buildObligationLedger({ goal_id: "goal-cycle", obligations }),
    ).toThrow(/cycle/i);
  });
});

// ── SEAM-04: required field contract — builder produces all validator-required fields ──

describe("SEAM-04: required field contract between builder and validator", () => {
  it("ledger produced by builder has all fields that validateObligationLedger requires", () => {
    const ledger: ObligationLedger = buildObligationLedger({
      goal_id: "goal-fields",
      obligations: [makeEntry("OBL-001")],
    });

    // These are the keys validateObligationLedger inspects; all must be present.
    const requiredKeys: (keyof ObligationLedger)[] = [
      "contract_version",
      "goal_id",
      "obligations",
      "created_at",
    ];
    for (const key of requiredKeys) {
      expect(ledger).toHaveProperty(key);
      const val = ledger[key];
      expect(val !== null && val !== undefined).toBe(true);
    }
  });

  it("each obligation built by makeEntry has all fields validateObligationLedger checks", () => {
    const obligations: ObligationEntry[] = [
      makeEntry("OBL-001"),
      makeEntry("OBL-002", { kind: "invariant", depends_on: ["OBL-001"], status: "satisfied" }),
    ];

    const ledger = buildObligationLedger({ goal_id: "goal-obl-fields", obligations });
    const issues = validateObligationLedger(ledger);

    // Validator must find no errors — all required obligation fields present.
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("validateObligationLedger rejects an obligation with missing 'id'", () => {
    const brokenLedger: unknown = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "goal-broken",
      obligations: [
        { description: "no id here", kind: "behavioral", depends_on: [], status: "pending" },
      ],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(brokenLedger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("id"))).toBe(true);
  });

  it("validateObligationLedger rejects an obligation with invalid 'kind'", () => {
    const brokenLedger: unknown = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "goal-bad-kind",
      obligations: [
        {
          id: "OBL-bad",
          description: "bad kind",
          kind: "not-a-valid-kind",
          depends_on: [],
          status: "pending",
        },
      ],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(brokenLedger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("kind"))).toBe(true);
  });

  it("validateObligationLedger rejects an obligation with invalid 'status'", () => {
    const brokenLedger: unknown = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "goal-bad-status",
      obligations: [
        {
          id: "OBL-bad",
          description: "bad status",
          kind: "behavioral",
          depends_on: [],
          status: "in_progress", // not in shared enum
        },
      ],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(brokenLedger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("status"))).toBe(true);
  });

  it("validateObligationLedger rejects a missing goal_id", () => {
    const brokenLedger: unknown = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      obligations: [],
      created_at: new Date().toISOString(),
    };

    const issues = validateObligationLedger(brokenLedger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("goal_id"))).toBe(true);
  });

  it("validateObligationLedger rejects a missing created_at", () => {
    const brokenLedger: unknown = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "goal-no-created-at",
      obligations: [],
    };

    const issues = validateObligationLedger(brokenLedger);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("created_at"))).toBe(true);
  });
});

// ── SEAM-05: all four ObligationEntry.kind values accepted by both sides ──────

describe("SEAM-05: kind enum consistency between shared types and validator", () => {
  const OBLIGATION_KINDS = ["invariant", "behavioral", "structural", "test"] as const;

  for (const kind of OBLIGATION_KINDS) {
    it(`kind="${kind}" builds and validates without errors`, () => {
      const ledger = buildObligationLedger({
        goal_id: `goal-kind-${kind}`,
        obligations: [makeEntry("OBL-001", { kind })],
      });

      const issues = validateObligationLedger(ledger);
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  }
});

// ── SEAM-06: all three ObligationEntry.status values accepted by both sides ───

describe("SEAM-06: status enum consistency between shared types and validator", () => {
  const OBLIGATION_STATUSES = ["pending", "satisfied", "failed"] as const;

  for (const status of OBLIGATION_STATUSES) {
    it(`status="${status}" builds and validates without errors`, () => {
      const ledger = buildObligationLedger({
        goal_id: `goal-status-${status}`,
        obligations: [makeEntry("OBL-001", { status })],
      });

      const issues = validateObligationLedger(ledger);
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  }
});
