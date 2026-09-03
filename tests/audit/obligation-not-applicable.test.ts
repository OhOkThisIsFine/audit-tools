/**
 * An obligation whose INPUT SET IS EMPTY reports `not_applicable`, never
 * `satisfied`.
 *
 * Two gates in `deriveAuditState` were `satisfied` on nothing:
 * `runtime_validation_current` (`runtimeTasks.length === 0 || …`) and
 * `audit_results_ingested` (`(audit_tasks?.length ?? 0) === 0 || …`). Both
 * carried — or should have carried — an honest `reason` beside a dishonest
 * `state`, and the state vocabulary had no member that could say the true
 * thing. The measured run that prompted this recorded
 * `runtime_validation_current: satisfied` while `planning_artifacts` was still
 * `missing`: the gate passed because zero tasks existed to validate.
 *
 * The change is deliberately INERT for the drain (the engine selects only
 * `missing`/`stale`) — what it changes is what the artifact SAYS. The two
 * assertions below that are not about `state.ts` exist because "inert" is a
 * claim about every consumer, and two consumers hold the vocabulary in a shape
 * a widened union cannot break at compile time: a `Set<ObligationState>` and a
 * hand-written `z.enum([...])` projected into the SHIPPED host-facing schema.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

const { deriveAuditState } = await import(
  "../../src/audit/orchestrator/state.js"
);
const { buildAuditCodeHandoff } = await import(
  "../../src/audit/supervisor/operatorHandoff.js"
);
const { ObligationStateSchema } = await import(
  "../../src/shared/engine/obligationEngine.js"
);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function stateOf(state: AuditState, id: string): string | undefined {
  return state.obligations.find((item) => item.id === id)?.state;
}

function reasonOf(state: AuditState, id: string): string | undefined {
  return state.obligations.find((item) => item.id === id)?.reason;
}

describe("a gate with an empty input set is not_applicable", () => {
  it("reports both vacuous audit gates as not_applicable, each with its reason", () => {
    // No runtime validation tasks were planned, and no audit tasks exist. The
    // old answer was `satisfied` for both — a success-shaped empty.
    const state = deriveAuditState({} as ArtifactBundle);

    expect(stateOf(state, "runtime_validation_current")).toBe("not_applicable");
    expect(reasonOf(state, "runtime_validation_current")).toBe(
      "No deterministic runtime validation tasks were planned.",
    );
    expect(stateOf(state, "audit_results_ingested")).toBe("not_applicable");
    // The audit_results_ingested arm carried NO reason string at all, which is
    // how the same defect sat four lines above the one that was noticed.
    expect(reasonOf(state, "audit_results_ingested")).toBe(
      "No audit tasks were planned, so no results are owed.",
    );
  });

  it("still reports a NON-empty input set as satisfied", () => {
    // The member must not swallow the real success case: one planned task with
    // a non-pending result is `satisfied`, exactly as before.
    const bundle: ArtifactBundle = {
      runtime_validation_tasks: {
        tasks: [
          {
            id: "rv-task-1",
            kind: "unit-risk-check",
            target_paths: ["src/api/auth.ts"],
            reason: "Confirm auth risk mitigation.",
            priority: "medium",
          },
        ],
      },
      runtime_validation_report: {
        results: [
          { task_id: "rv-task-1", status: "confirmed", summary: "Confirmed." },
        ],
      },
    };
    expect(stateOf(deriveAuditState(bundle), "runtime_validation_current")).toBe(
      "satisfied",
    );
  });

  it("does not report a not_applicable obligation as PENDING on the operator handoff", () => {
    // `NON_PENDING_OBLIGATION_STATES` was a `Set<ObligationState>` LITERAL, so
    // widening the union is not a compile error there: a new non-actionable
    // member silently falls through to pending and ships on the host-facing
    // handoff. Pending is now DERIVED from the engine's actionable states, so
    // there is no second list to widen.
    const handoff = buildAuditCodeHandoff({
      root: "/repo",
      artifactsDir: "/repo/.audit-tools/audit",
      state: {
        status: "active",
        obligations: [
          { id: "runtime_validation_current", state: "not_applicable" },
          { id: "audit_results_ingested", state: "not_applicable" },
          { id: "synthesis_current", state: "missing" },
        ],
      } as AuditState,
      bundle: {} as ArtifactBundle,
      progressSummary: "",
    });

    expect(handoff.pending_obligations).toEqual(["synthesis_current"]);
  });

  it("keeps the SHIPPED host-facing schema's obligation enum equal to the source of truth", async () => {
    // schemas/audit-code-v1alpha1.schema.json is a GENERATED projection of
    // `ObligationViewSchema`, which hand-copied the five state names. A
    // persisted audit_state.json now carries `not_applicable` while that
    // projection would refuse it — the hand-copied-vocabulary drift class the
    // lens registry's header exists to record.
    const shipped = JSON.parse(
      await readFile(
        join(repoRoot, "schemas", "audit-code-v1alpha1.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const definitions = shipped as {
      properties: {
        audit_state: {
          properties: {
            obligations: {
              items: { properties: { state: { enum: string[] } } };
            };
          };
        };
      };
    };
    expect(
      definitions.properties.audit_state.properties.obligations.items.properties
        .state.enum,
    ).toEqual([...ObligationStateSchema.options]);
  });
});
