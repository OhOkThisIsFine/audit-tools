/**
 * `deriveAuditState` emits one obligation for EVERY id in `PRIORITY`, for every
 * bundle state.
 *
 * The engine registry derives from `PRIORITY`, and `deriveObligationState`
 * reads each id's state from the emitted list. An id that the list does not
 * hold has no state to read. Before this test, `audit_tasks_completed` was not
 * emitted while `audit_tasks.json` was absent, and the reader then reported
 * the id as `satisfied`: "every audit task is complete" before any task was
 * planned. The drain did not act on that value only because
 * `planning_artifacts` comes first in `PRIORITY`; no test held that.
 */
import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { deriveObligationState } from "../../src/audit/orchestrator/obligationDerive.js";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.js";

const BUNDLES: ReadonlyArray<readonly [string, ArtifactBundle]> = [
  ["an empty bundle", {}],
  ["a bundle whose audit-task plan is empty", { audit_tasks: [] } as unknown as ArtifactBundle],
];

describe("deriveAuditState emits every PRIORITY id", () => {
  for (const [label, bundle] of BUNDLES) {
    it(`emits each PRIORITY id exactly once for ${label}`, () => {
      const ids = deriveAuditState(bundle, { emitStaleness: false }).obligations.map((o) => o.id);
      expect([...ids].sort()).toEqual([...PRIORITY].sort());
    });
  }

  it("reports audit_tasks_completed as missing before any audit task is planned", () => {
    const state = deriveAuditState({}, { emitStaleness: false });
    expect(state.obligations.find((o) => o.id === "audit_tasks_completed")?.state).toBe("missing");
    expect(deriveObligationState("audit_tasks_completed", new WeakMap())({})).toBe("missing");
  });
});
