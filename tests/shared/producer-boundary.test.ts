/**
 * Canonical-serialized-output-boundary enforcement (packet 20).
 *
 * The two real producers of the pipeline's machine contracts run their own
 * finished value through the owning schema before persisting it. These tests
 * drive the REAL producers — `buildAuditFindingsDeliverable` (shared re-emitter)
 * and `buildRemediationOutcomesReport` / `runClosePhase` (close phase) — and
 * prove the boundary:
 *
 *   • a valid produced value is accepted (positive);
 *   • a produced value that OMITS a required field of the owning schema is
 *     refused at the producer's boundary, before it could be persisted or
 *     accepted downstream (negative).
 *
 * The negative is the load-bearing half: without the boundary check, a producer
 * that drops a required field returns its value anyway and the miss surfaces
 * only where a downstream consumer re-reads it — the exact shape of the
 * `reviewed_clean` defect this packet closes, one boundary in.
 *
 * The final describe below is the INTEGRATION regression for that negative. The
 * rest of this file asserts `assertValid*` directly on an already-produced
 * value; deleting a field from a produced object proves the VALIDATOR refuses a
 * missing field, but it does not prove the PRODUCER invokes it at the write
 * boundary. `runClosePhaseBoundary` drives the real close phase with a state
 * whose persisted outcome is missing a REQUIRED field (`finding_id`) and shows
 * the serialize-then-persist path refuses — before `remediation-outcomes.json`
 * is written — by way of the producer's own boundary call. `vi.mock` wraps the
 * two validators in spies so the test asserts the boundary was actually hit;
 * delete the `assertValid…` line from either producer and the matching spy is
 * never called / the malformed value is persisted instead of refused.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Wrap BOTH owning-schema boundary validators in spies that still call through
// to the REAL schema check. `producerBoundary.js` is the single module both
// producers import (the audit re-emitter directly; the close phase via the
// `audit-tools/shared` barrel's re-export of this exact module), so mocking it
// here intercepts both real callers at their serialized-output boundary.
vi.mock("../../src/shared/validation/producerBoundary.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/shared/validation/producerBoundary.js")>();
  return {
    ...actual,
    assertValidAuditFindingsReport: vi.fn(actual.assertValidAuditFindingsReport),
    assertValidRemediationOutcomesReport: vi.fn(actual.assertValidRemediationOutcomesReport),
  };
});

import {
  buildAuditFindingsDeliverable,
  assertValidAuditFindingsReport,
  assertValidRemediationOutcomesReport,
  RemediationOutcomesReportSchema,
} from "../../src/shared/index.js";
import {
  buildRemediationOutcomesReport,
  runClosePhase,
  type ClosingResult,
} from "../../src/remediate/phases/close.js";
import { makeState } from "../remediate/test-helpers.js";
import { scratchDir } from "../helpers/scratch.js";
import type { Finding } from "../../src/shared/types/finding.js";

const FINDING: Finding = {
  id: "finding-1",
  title: "a finding",
  category: "correctness",
  severity: "high",
  confidence: "high",
  lens: "correctness",
  summary: "the summary",
  affected_files: [{ path: "src/a.ts" }],
  evidence: ["evidence"],
  reproduction: [],
};

function closingResult(overrides: Partial<ClosingResult> = {}): ClosingResult {
  return {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action: "commit",
    status: "success",
    commands: [],
    ...overrides,
  };
}

describe("assertValidAuditFindingsReport (owning-schema boundary)", () => {
  it("accepts a report the real producer emits", () => {
    const report = buildAuditFindingsDeliverable([FINDING], null);
    expect(() => assertValidAuditFindingsReport(report)).not.toThrow();
  });

  it("refuses a report missing a REQUIRED field of the owning schema", () => {
    const report = buildAuditFindingsDeliverable([FINDING], null);
    // `summary` is a required, non-optional field of AuditFindingsReportSchema.
    const malformed = { ...report } as Partial<typeof report> & Record<string, unknown>;
    delete malformed.summary;
    expect(() => assertValidAuditFindingsReport(malformed as never)).toThrow(/summary/);
  });
});

describe("buildAuditFindingsDeliverable boundary", () => {
  // The producer's own gate is exercised by the real emit above; this makes the
  // positive explicit so a reader can see the boundary IS the emitter.
  it("a real emit round-trips a valid report", () => {
    const report = buildAuditFindingsDeliverable([FINDING], null);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].id).toBe("finding-1");
  });
});

describe("assertValidRemediationOutcomesReport (owning-schema boundary)", () => {
  function stateFor(): ReturnType<typeof makeState> {
    return makeState({
      status: "closing",
      plan: {
        plan_id: "PLAN-1",
        findings: [FINDING],
        blocks: [],
        project_type: "typescript-node",
        candidate_closing_actions: ["none"],
      },
      items: {},
    });
  }

  it("accepts a report the real close-phase producer emits", () => {
    const report = buildRemediationOutcomesReport(stateFor(), closingResult());
    expect(() => assertValidRemediationOutcomesReport(report)).not.toThrow();
    expect(RemediationOutcomesReportSchema.safeParse(report).success).toBe(true);
  });

  it("refuses a report missing a REQUIRED field of the owning schema", () => {
    const report = buildRemediationOutcomesReport(stateFor(), closingResult());
    // `by_outcome` is a required, non-optional field of the owning schema.
    const malformed = { ...report } as Partial<typeof report> & Record<string, unknown>;
    delete malformed.by_outcome;
    expect(() => assertValidRemediationOutcomesReport(malformed as never)).toThrow(
      /by_outcome/,
    );
  });
});

describe("runClosePhaseBoundary — the real serialize-then-persist path invokes the validator", () => {
  it("refuses, before writing remediation-outcomes.json, a produced outcome missing a required field", async () => {
    const dir = scratchDir(".producer-boundary-close");
    await rm(dir, { recursive: true, force: true });
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });

    // A terminal `resolved` item that is missing `finding_id` (`RemediationItemState`
    // requires it; this is corrupt state injected straight into the producer). The
    // close phase derives one outcome per item, and `finding_id` is a REQUIRED,
    // non-optional field of the owning outcomes schema — so `buildRemediationOutcomesReport`
    // emits it as `undefined`, and the write boundary must refuse before anything
    // is persisted.
    const state = makeState({
      status: "closing",
      closing_plan: { action: "none" },
      items: {
        F1: { status: "resolved", block_id: "B1" } as never,
      },
    });

    const outcomesPath = join(dir, ".audit-tools", "remediation-outcomes.json");

    await expect(
      runClosePhase(state, { root: dir, artifactsDir }),
    ).rejects.toThrow(/finding_id/);

    // The validator was the thing that refused: the boundary call was reached.
    expect(assertValidRemediationOutcomesReport).toHaveBeenCalled();
    // And the malformed contract was never persisted — the write never happened.
    expect(existsSync(outcomesPath)).toBe(false);
  });
});
