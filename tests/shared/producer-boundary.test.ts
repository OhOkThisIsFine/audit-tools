/**
 * Producer-boundary enforcement for `remediation-outcomes.json`.
 *
 * The real close-phase producer runs its own finished value through the owning
 * schema before persisting it. These tests drive the REAL producers —
 * `buildRemediationOutcomesReport` (unit level) and `runClosePhase`
 * (integration) — and prove the boundary:
 *
 *   • a valid produced value is accepted (positive);
 *   • a produced value that OMITS a required field of the owning schema is
 *     refused at the producer's boundary, before it could be persisted or
 *     accepted downstream (negative);
 *
 * The final describe is the INTEGRATION regression for that negative. It drives
 * the real close phase with a state whose produced outcome is missing a
 * REQUIRED field and shows the serialize-then-persist path refuses — before
 * `remediation-outcomes.json` is written — by way of the producer's own
 * boundary call. `vi.mock` wraps the validator in a spy that still calls
 * through to the REAL schema check; delete the
 * `assertValidRemediationOutcomesReport` line from the close phase and the
 * matching assertions fail — the malformed value is persisted instead of
 * refused and the spy is never called.
 *
 * The fixtures use the CURRENT state shape (execution units, PR #14): outcomes
 * are derived per SOURCE FINDING (`state.plan.findings` plus the plan's
 * coverage-ledger payloads for never-planned sources), and the runtime plan —
 * including its findings — is authority-checked against the independently
 * approved revision by `assertClosingPlanAuthority`. The integration case's
 * corrupt state therefore lives where plan authority does not reach: the
 * state-owned `plan_coverage`, whose never-planned entries carry the original
 * `Finding` payload verbatim. A payload that lost its required `id` makes
 * `buildRemediationOutcomesReport` emit one outcome with `finding_id` as
 * `undefined` — `finding_id` is a REQUIRED, non-optional field of the owning
 * outcomes schema — so the write boundary must refuse before anything is
 * persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";

// Wrap the owning-schema boundary validator in a spy that still calls through
// to the REAL schema check. `producerBoundary.js` is the single module both
// callers import (the test via the `audit-tools/shared` barrel; the close
// phase via the barrel's re-export of this exact module), so mocking it here
// intercepts the close phase's real call at its serialized-output boundary.
vi.mock("../../src/shared/validation/producerBoundary.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/shared/validation/producerBoundary.js")>();
  return {
    ...actual,
    assertValidRemediationOutcomesReport: vi.fn(actual.assertValidRemediationOutcomesReport),
  };
});

import {
  assertValidRemediationOutcomesReport,
  RemediationOutcomesReportSchema,
} from "../../src/shared/index.js";
import {
  buildRemediationOutcomesReport,
  runClosePhase,
  type ClosingResult,
} from "../../src/remediate/phases/close.js";
import { makeState } from "../remediate/test-helpers.js";
import {
  canonicalPlanFixture,
  canonicalUnitFixture,
  writeApprovedPlanFixture,
} from "../remediate/helpers/canonicalPlanFixture.js";
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

/** A current-shape closing state: one source finding, one verified unit. */
function stateFor(): ReturnType<typeof makeState> {
  return makeState({
    status: "closing",
    closing_plan: { action: "none" },
    plan: canonicalPlanFixture({
      plan_id: "PLAN-1",
      findings: [FINDING],
      units: [
        canonicalUnitFixture("UNIT-1", {
          source_finding_ids: ["finding-1"],
          requirement_ids: ["REQ-1"],
        }),
      ],
      requirements: [
        {
          id: "REQ-1",
          description: "Remediate the finding",
          source_finding_ids: ["finding-1"],
          change_kind: "structural",
          assertions: [],
        },
      ],
      project_type: "typescript-node",
      candidate_closing_actions: ["none"],
    }),
    items: { "UNIT-1": { unit_id: "UNIT-1", status: "resolved" } },
  });
}

describe("assertValidRemediationOutcomesReport (owning-schema boundary)", () => {
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

describe("runClosePhase — the real serialize-then-persist path invokes the validator", () => {
  const REPO_DIR = scratchDir(".producer-boundary-close");
  const TEST_DIR = join(REPO_DIR, ".audit-tools", "remediation");
  const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");

  beforeEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    // REPO_DIR lives inside the audit-tools working tree, so an un-init'd dir
    // would make git traverse up to the parent repo and report its (many)
    // uncommitted files — corrupting the close phase's repo-context checks.
    // Initialize an isolated, clean repo instead.
    execSync("git init", { cwd: REPO_DIR });
    execSync("git config user.email test@test.com", { cwd: REPO_DIR });
    execSync("git config user.name Test", { cwd: REPO_DIR });
    writeFileSync(join(REPO_DIR, "initial.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: REPO_DIR });
  });

  afterEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
  });

  it("refuses, before writing remediation-outcomes.json, a produced outcome missing a required field", async () => {
    // The corrupt state lives where plan authority does not reach: the state-owned
    // coverage ledger. Its never-planned entry carries the original Finding payload
    // verbatim, and this payload has LOST its required `id`. The close phase
    // derives one outcome per such payload, and `finding_id` is a REQUIRED,
    // non-optional field of the owning outcomes schema — so
    // `buildRemediationOutcomesReport` emits it as `undefined`, and the write
    // boundary must refuse before anything is persisted.
    const state = makeState({
      ...stateFor(),
      plan_coverage: {
        contract_version: "remediate-code-coverage/v1alpha1",
        plan_id: "PLAN-1",
        source_finding_count: 2,
        planned_count: 1,
        folded_count: 0,
        dropped_count: 1,
        checkpoint_dropped_count: 0,
        phantom_dropped_count: 0,
        entries: [
          {
            finding_id: "finding-1",
            title: FINDING.title,
            disposition: "planned",
            unit_ids: ["UNIT-1"],
          },
          {
            finding_id: "finding-2",
            title: "A never-planned source whose payload lost its id",
            disposition: "declined_by_review",
            rationale: "Owner declined this source at review",
            finding: { ...FINDING, id: undefined } as unknown as Finding,
          },
        ],
      },
    });

    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);

    const outcomesPath = join(OUTPUT_DIR, "remediation-outcomes.json");

    await expect(
      runClosePhase(state, { root: REPO_DIR, artifactsDir: TEST_DIR, skipFinalGate: true }),
    ).rejects.toThrow(/finding_id/);

    // The validator was the thing that refused: the boundary call was reached.
    expect(assertValidRemediationOutcomesReport).toHaveBeenCalled();
    // And the malformed contract was never persisted — the write never happened.
    expect(existsSync(outcomesPath)).toBe(false);
  });
});
